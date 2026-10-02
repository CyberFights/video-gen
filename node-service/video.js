import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateMinimaxVideo, minimaxConfig } from "./minimax.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const uploadsDir = path.join(dataDir, "uploads");
const generatedDir = path.join(dataDir, "generated");
const charactersFile = path.join(dataDir, "characters.json");
const defaultCharactersFile = path.join(__dirname, "characters.json");

for (const directory of [dataDir, uploadsDir, generatedDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

const RENDERER_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.PYTHON_API_TIMEOUT_MS || "600000", 10);
const RENDERER_HEALTH_TIMEOUT_MS = Number.parseInt(process.env.PYTHON_API_HEALTH_TIMEOUT_MS || "5000", 10);
const RENDERER_CONNECT_ATTEMPTS = Math.max(1, Number.parseInt(process.env.PYTHON_API_RETRIES || "3", 10));
const RETRYABLE_CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET"
]);

/** Hostnames that mean "this very container", so a renderer there is a misconfiguration. */
function ownHostnames() {
  const names = new Set();
  const privateDomain = process.env.RAILWAY_PRIVATE_DOMAIN?.trim();
  const serviceName = process.env.RAILWAY_SERVICE_NAME?.trim();
  if (privateDomain) names.add(privateDomain.toLowerCase());
  if (serviceName) {
    names.add(serviceName.toLowerCase());
    names.add(`${serviceName.toLowerCase()}.railway.internal`);
  }
  return names;
}

/**
 * Railway private hostnames are exactly `<service-name>.railway.internal`.
 * A configured host like `renderer.video-gen.railway.internal` carries extra
 * labels — usually a project name typed into the hostname — and can never
 * resolve. The name the caller almost certainly meant is the first label plus
 * `.railway.internal`: `renderer.railway.internal` in that example.
 */
function likelyPrivateHostname(hostname) {
  if (!hostname?.endsWith(".railway.internal")) return null;
  const labels = hostname.slice(0, -".railway.internal".length).split(".");
  if (labels.length < 2 || labels.some(label => !label)) return null;
  return `${labels[0]}.railway.internal`;
}

/**
 * Resolves the renderer base URL from the environment.
 *
 * `source` is "url" or "host" when the renderer was configured explicitly and
 * "fallback" when nothing was configured. The fallback only makes sense for
 * local development, where the renderer runs beside the app on the same host.
 *
 * `selfReference` is true when the configured address is this service's own
 * private domain: the app would dial itself, which is the usual cause of an
 * ECONNREFUSED against a `*.railway.internal` host that resolves fine.
 */
export function rendererConfig() {
  const base = resolveRendererUrl();
  let hostname = null;
  let port = null;
  try {
    const parsed = new URL(base.url);
    hostname = parsed.hostname.toLowerCase();
    port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    // Leave hostname/port null; the fetch below will surface the bad URL.
  }

  const own = ownHostnames();
  const appPort = (process.env.PORT || "3000").trim();
  const selfReference = Boolean(
    hostname && own.has(hostname) && base.source !== "fallback"
  );

  return {
    ...base,
    hostname,
    port,
    selfReference,
    // Pointing at our own private domain *and* our own port is doubly wrong.
    selfLoop: selfReference && port === appPort,
    privateNetwork: Boolean(hostname?.endsWith(".railway.internal")),
    // Set when the private hostname has extra labels (e.g. a project segment)
    // and therefore cannot resolve; holds the `<service>.railway.internal`
    // name the caller most likely meant.
    expectedPrivateHostname: likelyPrivateHostname(hostname)
  };
}

function resolveRendererUrl() {
  const configuredUrl = process.env.PYTHON_API_URL?.trim();
  if (configuredUrl) {
    return { url: configuredUrl.replace(/\/+$/, ""), source: "url", configured: true };
  }

  const host = process.env.PYTHON_API_HOST?.trim();
  if (host) {
    const scheme = host.startsWith("http://") || host.startsWith("https://") ? "" : "http://";
    const hasPort = /^https?:\/\/[^/]+:\d+$/.test(`${scheme}${host}`);
    const port = hasPort ? "" : `:${process.env.PYTHON_API_PORT?.trim() || "8000"}`;
    return { url: `${scheme}${host}${port}`.replace(/\/+$/, ""), source: "host", configured: true };
  }

  return { url: "http://127.0.0.1:8000", source: "fallback", configured: false };
}

function pythonApiUrl() {
  return rendererConfig().url;
}

/**
 * MiniMax is the primary generator. The existing private renderer remains
 * available as an explicit local/renderer fallback for deployments that do
 * not want to use the hosted provider.
 */
export function generatorConfig() {
  const provider = (process.env.VIDEO_PROVIDER || "minimax").trim().toLowerCase();
  if (provider === "minimax") {
    const minimax = minimaxConfig();
    return {
      provider,
      configured: minimax.configured,
      model: minimax.model,
      resolution: minimax.resolution,
      duration: minimax.duration,
      ratio: minimax.ratio
    };
  }

  if (["renderer", "local", "cpu"].includes(provider)) {
    return { provider: "renderer", ...rendererConfig() };
  }

  return { provider, configured: false, error: `Unknown VIDEO_PROVIDER: ${provider}.` };
}

function connectErrorCode(error) {
  for (let current = error; current; current = current.cause) {
    if (typeof current.code === "string") return current.code;
  }
  return null;
}

/**
 * Turns a connection failure into an explanation of the likely cause.
 *
 * ECONNREFUSED against a `*.railway.internal` name means DNS worked and the
 * TCP connect was rejected, so the address is reachable but nothing is
 * listening there. The two causes worth calling out are dialing the wrong
 * service (often the app itself) and a renderer bound to IPv4 only in an
 * IPv6-only private network.
 */
function rendererDiagnosis(code, config) {
  const hints = [];

  if (config.selfReference) {
    hints.push(
      `${config.hostname} is this app service's own private domain, not the renderer's, ` +
      "so the app is dialing itself. Set PYTHON_API_HOST=${{renderer.RAILWAY_PRIVATE_DOMAIN}} " +
      "(reference the renderer service, not this one) and redeploy."
    );
  }

  if (code === "ECONNREFUSED" && config.privateNetwork && !config.selfReference) {
    hints.push(
      `DNS for ${config.hostname} resolved but port ${config.port} refused the connection: either no renderer ` +
      "service answers on that name, or it is listening on IPv4 only while Railway private networking is IPv6. " +
      "The renderer must bind :: (python-service/serve.py does this); check its deploy logs for " +
      `"Renderer listening on [::]:${config.port}".`
    );
  }

  if ((code === "ENOTFOUND" || code === "EAI_AGAIN") && config.privateNetwork) {
    if (config.expectedPrivateHostname) {
      hints.push(
        `${config.hostname} is not a name Railway private DNS will ever answer: private hostnames are ` +
        "exactly `<service-name>.railway.internal` — the project name is not part of the hostname — " +
        `so the renderer's private domain is ${config.expectedPrivateHostname}, not ${config.hostname}. ` +
        "Set PYTHON_API_HOST=${{renderer.RAILWAY_PRIVATE_DOMAIN}} (or hard-code " +
        `${config.expectedPrivateHostname}) and redeploy.`
      );
    } else {
      hints.push(
        `${config.hostname} did not resolve. Private DNS only resolves for services in the same project and ` +
        "environment, and only at runtime, so confirm the renderer is deployed there and the variable reference resolved."
      );
    }
  }

  return hints;
}

/**
 * When a private hostname fails to resolve and looks like a
 * `<service>.<project>.railway.internal` mistake, checks whether the correct
 * `<service>.railway.internal` form resolves — and, if so, whether it answers
 * `/health` as this app's renderer. Returns a confirmation hint, or null when
 * there is nothing to correct.
 */
async function privateHostnameCorrection(config) {
  if (!config.expectedPrivateHostname) return null;

  try {
    await dns.lookup(config.expectedPrivateHostname, { all: true });
  } catch {
    // The corrected name does not resolve either; stay with the generic hints.
    return null;
  }

  let confirmation = "";
  try {
    const response = await fetch(`http://${config.expectedPrivateHostname}:${config.port}/health`, {
      signal: AbortSignal.timeout(RENDERER_HEALTH_TIMEOUT_MS)
    });
    if (response.ok) {
      const body = await response.json().catch(() => null);
      confirmation = body?.service === "renderer"
        ? " and answered /health as the Video Gen renderer"
        : " and answered /health";
    }
  } catch {
    // The name resolving is already strong evidence; /health is best-effort.
  }

  return (
    `Confirmed: ${config.expectedPrivateHostname} resolves${confirmation}. That is the renderer's real ` +
    "private domain. Railway private hostnames are `<service-name>.railway.internal` and never include the " +
    "project name, so set PYTHON_API_HOST=${{renderer.RAILWAY_PRIVATE_DOMAIN}} (or hard-code " +
    `${config.expectedPrivateHostname}) and redeploy.`
  );
}

function rendererUnreachableError(url, cause, correction = null) {
  const config = rendererConfig();
  const { configured } = config;
  const code = connectErrorCode(cause) || "unknown error";
  const base = configured
    ? `The renderer at ${url} is unreachable (${code}). Confirm the renderer service is running and that PYTHON_API_URL or PYTHON_API_HOST/PYTHON_API_PORT point at it.`
    : `No renderer is configured, so the app tried ${url} and failed (${code}). Set PYTHON_API_URL, or set PYTHON_API_HOST and PYTHON_API_PORT, to the renderer service (on Railway: PYTHON_API_HOST=\${{renderer.RAILWAY_PRIVATE_DOMAIN}} and PYTHON_API_PORT=8000).`;
  const hints = rendererDiagnosis(code, config);
  if (correction) hints.push(correction);
  const message = hints.length ? `${base} ${hints.join(" ")}` : base;

  const error = new Error(message, { cause });
  error.status = 503;
  error.code = "RENDERER_UNREACHABLE";
  return error;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * fetch with a request timeout plus retries for connection-level failures.
 * Railway private networking (and docker compose startup) can refuse
 * connections for a few seconds after a deploy, so a transient ECONNREFUSED
 * should not fail a whole render.
 */
async function rendererFetch(url, options, { timeoutMs = RENDERER_REQUEST_TIMEOUT_MS, attempts = RENDERER_CONNECT_ATTEMPTS } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      lastError = error;
      const code = connectErrorCode(error);
      const retryable = RETRYABLE_CONNECT_CODES.has(code);
      if (!retryable || attempt === attempts) break;
      console.warn(`Renderer request to ${url} failed with ${code}; retry ${attempt}/${attempts - 1}.`);
      await sleep(attempt * 1000);
    }
  }

  // A private hostname with extra labels never resolves; check whether the
  // corrected `<service>.railway.internal` form does, so the error can say so.
  const finalCode = connectErrorCode(lastError);
  let correction = null;
  if (finalCode === "ENOTFOUND" || finalCode === "EAI_AGAIN") {
    correction = await privateHostnameCorrection(rendererConfig()).catch(() => null);
  }
  throw rendererUnreachableError(pythonApiUrl(), lastError, correction);
}

/** Cheap preflight so misconfiguration surfaces before any ffmpeg work. */
export async function checkRenderer() {
  const config = rendererConfig();
  const { url, source, configured } = config;
  try {
    const response = await rendererFetch(`${url}/health`, { method: "GET" }, {
      timeoutMs: RENDERER_HEALTH_TIMEOUT_MS,
      attempts: 1
    });
    if (!response.ok) {
      return { url, source, configured, expectedPrivateHostname: config.expectedPrivateHostname, reachable: false, error: `Renderer health check returned ${response.status}.` };
    }
    return { url, source, configured, expectedPrivateHostname: config.expectedPrivateHostname, reachable: true };
  } catch (error) {
    return { url, source, configured, expectedPrivateHostname: config.expectedPrivateHostname, reachable: false, error: error.message };
  }
}

/** Check the configured primary generator before accepting a render request. */
export async function checkGenerator() {
  const config = generatorConfig();
  if (config.provider === "minimax") {
    return config.configured
      ? { provider: "minimax", configured: true, reachable: true, model: config.model }
      : {
          provider: "minimax",
          configured: false,
          reachable: false,
          error: "MiniMax is the primary video generator, but MINIMAX_API_KEY is not configured."
        };
  }
  if (config.provider === "renderer") {
    const status = await checkRenderer();
    return { provider: "renderer", ...status };
  }
  return {
    provider: config.provider,
    configured: false,
    reachable: false,
    error: config.error
  };
}

async function ensureCharactersFile() {
  try {
    await fs.promises.access(charactersFile);
  } catch {
    await fs.promises.copyFile(defaultCharactersFile, charactersFile);
  }
}

export async function loadCharacters() {
  await ensureCharactersFile();
  return JSON.parse(await fs.promises.readFile(charactersFile, "utf8"));
}

export async function saveCharacters(characters) {
  await ensureCharactersFile();
  const temporaryFile = `${charactersFile}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporaryFile, `${JSON.stringify(characters, null, 2)}\n`);
  await fs.promises.rename(temporaryFile, charactersFile);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk.toString()));
    child.stderr.on("data", chunk => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", code => {
      const duration = Number.parseFloat(stdout);
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error(`Could not read audio duration: ${stderr.trim()}`));
    });
  });
}

function sceneDurations(scenes, totalAudioDuration) {
  if (!totalAudioDuration) return scenes.map(scene => scene.duration);

  const weights = scenes.map(scene => Math.max(1, scene.prompt.split(/\s+/).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map(weight => totalAudioDuration * weight / totalWeight);
}

function characterImagePath(character) {
  if (!character.image?.startsWith("/uploads/")) return null;
  const candidate = path.resolve(dataDir, character.image.slice(1));
  return candidate.startsWith(`${uploadsDir}${path.sep}`) && fs.existsSync(candidate) ? candidate : null;
}

async function postForFile(url, options, destination) {
  const response = await rendererFetch(url, options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Renderer returned ${response.status}: ${body.slice(0, 1000)}`);
  }
  await fs.promises.writeFile(destination, Buffer.from(await response.arrayBuffer()));
  return destination;
}

async function generateScene(scene, character, duration) {
  const fps = Math.max(1, Math.min(scene.fps, Math.floor(300 / duration) || 1));
  const frames = Math.max(1, Math.min(300, Math.round(duration * fps)));
  const query = new URLSearchParams({
    prompt: scene.prompt,
    frames: String(frames),
    fps: String(fps),
    guidance: String(scene.guidance || 7.5),
    seed: String(character.seed || scene.seed || 0),
    preset: scene.preset || "cinematic",
    character_tag: character.tag || "",
    style_tag: scene.style || "",
    breathing: String(Boolean(scene.breathing)),
    expression_profile: scene.expression_profile || "neutral"
  });

  const form = new FormData();
  const imagePath = characterImagePath(character);
  if (imagePath) {
    const image = await fs.promises.readFile(imagePath);
    form.append("image", new Blob([image]), path.basename(imagePath));
  }

  const destination = path.join(generatedDir, `${scene.id}_${crypto.randomUUID()}.mp4`);
  return postForFile(`${pythonApiUrl()}/scene?${query}`, { method: "POST", body: form }, destination);
}

async function cutAudio(input, start, duration, output) {
  await run("ffmpeg", [
    "-y",
    "-ss", start.toFixed(3),
    "-t", duration.toFixed(3),
    "-i", input,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    output
  ]);
}

async function addAudio(videoPath, audioPath) {
  const form = new FormData();
  form.append("video", new Blob([await fs.promises.readFile(videoPath)]), path.basename(videoPath));
  form.append("audio", new Blob([await fs.promises.readFile(audioPath)]), path.basename(audioPath));

  const destination = path.join(generatedDir, `synced_${crypto.randomUUID()}.mp4`);
  return postForFile(`${pythonApiUrl()}/lipsync`, { method: "POST", body: form }, destination);
}

function escapeConcatPath(file) {
  return file.replaceAll("'", "'\\''");
}

async function pruneGeneratedVideos(maximumFiles = 25) {
  const entries = await fs.promises.readdir(generatedDir, { withFileTypes: true });
  const videos = await Promise.all(
    entries
      .filter(entry => entry.isFile() && /^(?:video|synced)_[a-f0-9-]+\.mp4$/.test(entry.name))
      .map(async entry => {
        const file = path.join(generatedDir, entry.name);
        const stats = await fs.promises.stat(file);
        return { file, modified: stats.mtimeMs };
      })
  );

  videos.sort((first, second) => second.modified - first.modified);
  await Promise.all(
    videos.slice(maximumFiles).map(video => fs.promises.rm(video.file, { force: true }))
  );
}

async function concatenate(files) {
  const id = crypto.randomUUID();
  const listFile = path.join(generatedDir, `list_${id}.txt`);
  const output = path.join(generatedDir, `video_${id}.mp4`);
  await fs.promises.writeFile(listFile, files.map(file => `file '${escapeConcatPath(file)}'`).join("\n"));

  try {
    await run("ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listFile,
      "-c", "copy",
      "-movflags", "+faststart",
      output
    ]);
  } finally {
    await fs.promises.rm(listFile, { force: true });
  }

  return output;
}

function minimaxPrompt(scenes) {
  if (scenes.length === 1) return scenes[0].prompt;

  const sequence = scenes
    .map((scene, index) => `Scene ${index + 1}: ${scene.prompt}`)
    .join("\n");
  return `Create one coherent cinematic video that follows this sequence from beginning to end:\n${sequence}`;
}

async function muxNarration(videoPath, audioPath) {
  const destination = path.join(generatedDir, `synced_${crypto.randomUUID()}.mp4`);
  await run("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    "-movflags", "+faststart",
    destination
  ]);
  return destination;
}

async function generateMinimaxTimeline(scenes, audioPath = null) {
  if (audioPath) {
    const audioDuration = await probeDuration(audioPath);
    if (audioDuration > 300) {
      const error = new Error("Keep narration under five minutes.");
      error.status = 400;
      throw error;
    }
  }

  const generatedVideo = path.join(generatedDir, `video_${crypto.randomUUID()}.mp4`);
  let finalVideo = generatedVideo;
  try {
    await generateMinimaxVideo(minimaxPrompt(scenes), generatedVideo);
    if (audioPath) {
      finalVideo = await muxNarration(generatedVideo, audioPath);
      await fs.promises.rm(generatedVideo, { force: true });
    }
    await pruneGeneratedVideos();
    return `/generated/${path.basename(finalVideo)}`;
  } catch (error) {
    await fs.promises.rm(generatedVideo, { force: true }).catch(() => {});
    if (finalVideo !== generatedVideo) await fs.promises.rm(finalVideo, { force: true }).catch(() => {});
    throw error;
  }
}

export async function generateTimeline(scenes, characterKey, audioPath = null) {
  if (!scenes.length) throw new Error("The story did not contain any scenes.");

  const characters = await loadCharacters();
  const character = characters[characterKey];
  if (!character) throw new Error("Unknown character.");

  const selectedGenerator = generatorConfig();
  if (selectedGenerator.provider === "minimax") {
    return generateMinimaxTimeline(scenes, audioPath);
  }
  if (selectedGenerator.provider !== "renderer") {
    const error = new Error(selectedGenerator.error);
    error.status = 500;
    throw error;
  }

  let audioDuration = null;
  if (audioPath) {
    try {
      audioDuration = await probeDuration(audioPath);
    } catch (cause) {
      const error = new Error("The narration file could not be read.", { cause });
      error.status = 400;
      throw error;
    }
  }
  if (audioDuration && audioDuration > 300) {
    const error = new Error("Keep narration under five minutes.");
    error.status = 400;
    throw error;
  }
  const durations = sceneDurations(scenes, audioDuration);
  const timelineFiles = [];
  const temporaryFiles = [];
  let audioOffset = 0;

  try {
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = { ...scenes[index], duration: durations[index] };
      const rawVideo = await generateScene(scene, character, durations[index]);
      temporaryFiles.push(rawVideo);

      if (audioPath) {
        const sceneAudio = path.join(uploadsDir, `${scene.id}_${crypto.randomUUID()}.wav`);
        await cutAudio(audioPath, audioOffset, durations[index], sceneAudio);
        temporaryFiles.push(sceneAudio);

        const synced = await addAudio(rawVideo, sceneAudio);
        temporaryFiles.push(synced);
        timelineFiles.push(synced);
        audioOffset += durations[index];
      } else {
        timelineFiles.push(rawVideo);
      }
    }

    const output = await concatenate(timelineFiles);
    await pruneGeneratedVideos();
    return `/generated/${path.basename(output)}`;
  } finally {
    await Promise.all(temporaryFiles.map(file => fs.promises.rm(file, { force: true }).catch(() => {})));
  }
}
