import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { storyToScenes } from "./story_to_scenes.js";
import {
  checkGenerator,
  checkRenderer,
  generateTimeline,
  generatorConfig,
  loadCharacters,
  rendererConfig,
  saveCharacters
} from "./video.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const uploadsDir = path.join(dataDir, "uploads");
const generatedDir = path.join(dataDir, "generated");
const publicDir = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, "public"));

for (const directory of [dataDir, uploadsDir, generatedDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const allowedAudioTypes = new Set([
  "audio/aac",
  "audio/flac",
  "audio/m4a",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/x-m4a",
  "audio/x-wav"
]);

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => callback(null, uploadsDir),
  filename: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, "");
    callback(null, `${crypto.randomUUID()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use("/generated", express.static(generatedDir, { fallthrough: false }));
app.use("/uploads", express.static(uploadsDir, { fallthrough: false }));

app.get("/health", (_request, response) => {
  const renderer = rendererConfig();
  const generator = generatorConfig();
  response.json({
    status: "ok",
    service: "video-gen",
    generator: {
      provider: generator.provider,
      configured: generator.configured,
      model: generator.model,
      resolution: generator.resolution,
      duration: generator.duration,
      ratio: generator.ratio
    },
    renderer: {
      url: renderer.url,
      source: renderer.source,
      configured: renderer.configured,
      expectedPrivateHostname: renderer.expectedPrivateHostname
    }
  });
});

// Deep check: verifies the renderer is actually reachable from this service.
app.get("/health/renderer", async (_request, response, next) => {
  try {
    const renderer = await checkRenderer();
    response.status(renderer.reachable ? 200 : 503).json(renderer);
  } catch (error) {
    next(error);
  }
});

app.get("/health/generator", async (_request, response, next) => {
  try {
    const generator = await checkGenerator();
    response.status(generator.reachable ? 200 : 503).json(generator);
  } catch (error) {
    next(error);
  }
});

app.get("/api/characters", async (_request, response, next) => {
  try {
    response.json(await loadCharacters());
  } catch (error) {
    next(error);
  }
});

// Kept for compatibility with the original frontend.
app.get("/characters.json", async (_request, response, next) => {
  try {
    response.json(await loadCharacters());
  } catch (error) {
    next(error);
  }
});

app.post("/api/character/upload", upload.single("image"), async (request, response, next) => {
  try {
    const name = request.body.name?.trim();
    const tag = request.body.tag?.trim();

    if (!name || !tag) {
      if (request.file) await fs.promises.rm(request.file.path, { force: true });
      return response.status(400).json({ error: "Name and description are required." });
    }
    if (name.length > 80 || tag.length > 1_000) {
      if (request.file) await fs.promises.rm(request.file.path, { force: true });
      return response.status(400).json({ error: "Keep the name under 80 characters and the description under 1,000 characters." });
    }

    if (request.file && !allowedImageTypes.has(request.file.mimetype)) {
      await fs.promises.rm(request.file.path, { force: true });
      return response.status(415).json({ error: "Upload a PNG, JPEG, or WebP image." });
    }

    const baseId = name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "character";
    const characters = await loadCharacters();
    let id = baseId;
    let suffix = 2;
    while (characters[id]) id = `${baseId}_${suffix++}`;

    const character = {
      name,
      tag,
      seed: Math.floor(Math.random() * 1_000_000),
      image: request.file ? `/uploads/${request.file.filename}` : ""
    };

    characters[id] = character;
    await saveCharacters(characters);
    response.status(201).json({ id, ...character });
  } catch (error) {
    if (request.file) await fs.promises.rm(request.file.path, { force: true }).catch(() => {});
    next(error);
  }
});

app.post("/api/story", upload.single("audio"), async (request, response, next) => {
  try {
    const story = request.body.story?.trim();
    const character = request.body.character?.trim();

    if (!story || !character) {
      if (request.file) await fs.promises.rm(request.file.path, { force: true });
      return response.status(400).json({ error: "A story and character are required." });
    }
    if (story.length > 12_000) {
      if (request.file) await fs.promises.rm(request.file.path, { force: true });
      return response.status(400).json({ error: "Keep the story under 12,000 characters." });
    }

    if (request.file && !allowedAudioTypes.has(request.file.mimetype)) {
      await fs.promises.rm(request.file.path, { force: true });
      return response.status(415).json({ error: "The uploaded file must be audio." });
    }

    const characters = await loadCharacters();
    if (!characters[character]) {
      if (request.file) await fs.promises.rm(request.file.path, { force: true });
      return response.status(400).json({ error: "Select a valid character." });
    }

    const generator = await checkGenerator();
    if (!generator.reachable) {
      if (request.file) await fs.promises.rm(request.file.path, { force: true });
      return response.status(generator.error?.includes("not configured") ? 503 : 502).json({ error: generator.error });
    }

    const spec = storyToScenes(story, character);
    const file = await generateTimeline(
      spec.scenes,
      spec.character,
      request.file?.path || null
    );

    response.json({ file, spec });
  } catch (error) {
    next(error);
  } finally {
    if (request.file) {
      await fs.promises.rm(request.file.path, { force: true }).catch(() => {});
    }
  }
});

if (fs.existsSync(path.join(publicDir, "index.html"))) {
  app.use(express.static(publicDir));
  app.get("*", (request, response, next) => {
    if (request.path.startsWith("/api/") || request.path.startsWith("/generated/") || request.path.startsWith("/uploads/")) {
      return next();
    }
    response.sendFile(path.join(publicDir, "index.html"));
  });
}

app.use((error, _request, response, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE" ? "The upload is larger than 50 MB." : error.message;
    return response.status(400).json({ error: message });
  }
  const status = error.status || 500;
  response.status(status).json({
    error: status < 500 || process.env.NODE_ENV !== "production"
      ? error.message
      : "Video generation failed. Check the service logs."
  });
});

const port = Number.parseInt(process.env.PORT || "3000", 10);
const server = app.listen(port, "0.0.0.0", async () => {
  console.log(`Video Gen is listening on 0.0.0.0:${port}`);

  const generator = generatorConfig();
  if (generator.provider === "minimax") {
    if (generator.configured) {
      console.log(
        `MiniMax is the primary video generator (${generator.model}, ${generator.resolution}, ` +
        `${generator.duration}s, ${generator.ratio}).`
      );
    } else {
      console.warn(
        "MiniMax is the primary video generator, but MINIMAX_API_KEY is not configured. " +
        "Set it as a deployment secret before generating a video."
      );
    }
  } else {
    const renderer = rendererConfig();
    if (!renderer.configured) {
      console.warn(
        `No renderer configured. Falling back to ${renderer.url}. ` +
        "Set PYTHON_API_URL, or PYTHON_API_HOST and PYTHON_API_PORT, to reach the renderer service " +
        "(on Railway: PYTHON_API_HOST=${{renderer.RAILWAY_PRIVATE_DOMAIN}}, PYTHON_API_PORT=8000)."
      );
    } else {
      console.log(`Renderer configured at ${renderer.url} (from PYTHON_API_${renderer.source.toUpperCase()}).`);
    }

    if (renderer.selfReference) {
      console.warn(
        `PYTHON_API_* points at ${renderer.hostname}, which is this service's own private domain, ` +
        "so renders will fail with ECONNREFUSED. Point it at the renderer service: " +
        "PYTHON_API_HOST=${{renderer.RAILWAY_PRIVATE_DOMAIN}}, PYTHON_API_PORT=8000."
      );
    }

    if (renderer.expectedPrivateHostname) {
      console.warn(
        `PYTHON_API_HOST is ${renderer.hostname}, but Railway private hostnames are exactly ` +
        "`<service-name>.railway.internal` — the project name is not part of the hostname — so this " +
        `address cannot resolve. The renderer's private domain is ${renderer.expectedPrivateHostname}. ` +
        "Set PYTHON_API_HOST=${{renderer.RAILWAY_PRIVATE_DOMAIN}}, PYTHON_API_PORT=8000, and redeploy."
      );
    }
  }

  const status = await checkGenerator();
  if (status.reachable) {
    console.log(`Primary generator is configured (${status.provider}).`);
  } else {
    console.warn(`Primary generator preflight failed: ${status.error}`);
  }
});

// MiniMax is asynchronous; do not let Node's default five-minute request
// timeout terminate a healthy generation task while it is being polled.
server.requestTimeout = Number.parseInt(process.env.HTTP_REQUEST_TIMEOUT_MS || "1200000", 10);
server.timeout = 0;
