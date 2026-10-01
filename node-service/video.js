import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

/**
 * Resolves the renderer base URL from the environment.
 *
 * `source` is "url" or "host" when the renderer was configured explicitly and
 * "fallback" when nothing was configured. The fallback only makes sense for
 * local development, where the renderer runs beside the app on the same host.
 */
export function rendererConfig() {
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

function connectErrorCode(error) {
  for (let current = error; current; current = current.cause) {
    if (typeof current.code === "string") return current.code;
  }
  return null;
}

function rendererUnreachableError(url, cause) {
  const { configured } = rendererConfig();
  const code = connectErrorCode(cause) || "unknown error";
  const message = configured
    ? `The renderer at ${url} is unreachable (${code}). Confirm the renderer service is running and that PYTHON_API_URL or PYTHON_API_HOST/PYTHON_API_PORT point at it.`
    : `No renderer is configured, so the app tried ${url} and failed (${code}). Set PYTHON_API_URL, or set PYTHON_API_HOST and PYTHON_API_PORT, to the renderer service (on Railway: PYTHON_API_HOST=\${{renderer.RAILWAY_PRIVATE_DOMAIN}} and PYTHON_API_PORT=8000).`;

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

  throw rendererUnreachableError(pythonApiUrl(), lastError);
}

/** Cheap preflight so misconfiguration surfaces before any ffmpeg work. */
export async function checkRenderer() {
  const { url, source, configured } = rendererConfig();
  try {
    const response = await rendererFetch(`${url}/health`, { method: "GET" }, {
      timeoutMs: RENDERER_HEALTH_TIMEOUT_MS,
      attempts: 1
    });
    if (!response.ok) {
      return { url, source, configured, reachable: false, error: `Renderer health check returned ${response.status}.` };
    }
    return { url, source, configured, reachable: true };
  } catch (error) {
    return { url, source, configured, reachable: false, error: error.message };
  }
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
      .filter(entry => entry.isFile() && /^video_[a-f0-9-]+\.mp4$/.test(entry.name))
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

export async function generateTimeline(scenes, characterKey, audioPath = null) {
  if (!scenes.length) throw new Error("The story did not contain any scenes.");

  const characters = await loadCharacters();
  const character = characters[characterKey];
  if (!character) throw new Error("Unknown character.");

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
