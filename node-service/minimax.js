import fs from "node:fs";

const DEFAULT_BASE_URL = "https://api.minimax.io";
const DEFAULT_MODEL = "MiniMax-H3-Max";
const DEFAULT_RESOLUTION = "768P";
const DEFAULT_DURATION = 15;
const DEFAULT_RATIO = "16:9";
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_POLL_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_PROMPT_CHARS = 2_000;

function integerFromEnv(name, fallback, { minimum = 1 } = {}) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

/**
 * Read the MiniMax settings without ever returning the API key to callers that
 * only need to report configuration in /health.
 */
export function minimaxConfig({ includeSecret = false } = {}) {
  const apiKey = process.env.MINIMAX_API_KEY?.trim() || "";
  const baseUrl = (process.env.MINIMAX_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const config = {
    baseUrl,
    configured: Boolean(apiKey),
    model: process.env.MINIMAX_MODEL?.trim() || DEFAULT_MODEL,
    resolution: process.env.MINIMAX_RESOLUTION?.trim() || DEFAULT_RESOLUTION,
    duration: integerFromEnv("MINIMAX_DURATION", DEFAULT_DURATION),
    ratio: process.env.MINIMAX_RATIO?.trim() || DEFAULT_RATIO,
    pollIntervalMs: integerFromEnv("MINIMAX_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS),
    pollTimeoutMs: integerFromEnv("MINIMAX_POLL_TIMEOUT_MS", DEFAULT_POLL_TIMEOUT_MS),
    httpTimeoutMs: integerFromEnv("MINIMAX_HTTP_TIMEOUT_MS", DEFAULT_HTTP_TIMEOUT_MS),
    downloadTimeoutMs: integerFromEnv("MINIMAX_DOWNLOAD_TIMEOUT_MS", DEFAULT_DOWNLOAD_TIMEOUT_MS),
    maxPromptChars: integerFromEnv("MINIMAX_MAX_PROMPT_CHARS", DEFAULT_MAX_PROMPT_CHARS),
    queryPath: process.env.MINIMAX_QUERY_PATH?.trim() || "/v2/query/video_generation/{task_id}"
  };

  if (includeSecret) config.apiKey = apiKey;
  return config;
}

function apiErrorMessage(body, status) {
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 1_000);
  return (
    body?.error?.message ||
    body?.error?.type ||
    body?.base_resp?.status_msg ||
    body?.message ||
    `HTTP ${status}`
  );
}

async function readJsonResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const error = new Error(`MiniMax API request failed (${response.status}): ${apiErrorMessage(body, response.status)}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function requestJson(url, options, timeoutMs) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (cause) {
    const error = new Error(`MiniMax API request failed: ${cause.message}`, { cause });
    error.code = cause.cause?.code || cause.code;
    throw error;
  }
  return readJsonResponse(response);
}

function authorizationHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

function taskIdFromResponse(body) {
  const taskId = body?.task_id || body?.task?.id || body?.id;
  if (!taskId) {
    throw new Error("MiniMax did not return a video generation task ID.");
  }
  return String(taskId);
}

function queryUrl(config, taskId) {
  return `${config.baseUrl}${config.queryPath.replace("{task_id}", encodeURIComponent(taskId))}`;
}

async function queryTask(config, taskId) {
  try {
    return await requestJson(
      queryUrl(config, taskId),
      { method: "GET", headers: authorizationHeaders(config.apiKey) },
      config.httpTimeoutMs
    );
  } catch (error) {
    // Older MiniMax accounts expose the v1 query shape even when the task was
    // created through the v2 endpoint. Keep the v2 path primary, but make that
    // migration transparent when it returns 404.
    if (error.status !== 404 || config.queryPath !== "/v2/query/video_generation/{task_id}") throw error;
    const legacyUrl = `${config.baseUrl}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`;
    return requestJson(
      legacyUrl,
      { method: "GET", headers: authorizationHeaders(config.apiKey) },
      config.httpTimeoutMs
    );
  }
}

function normalizedStatus(body) {
  const value = body?.task?.status || body?.status || "";
  return String(value).trim().toLowerCase().replaceAll(" ", "_");
}

function videoUrlFromTask(body) {
  const task = body?.task || body;
  return task?.content?.url || task?.video_url || body?.video_url || null;
}

function fileIdFromTask(body) {
  const task = body?.task || body;
  return task?.file_id || body?.file_id || null;
}

async function downloadUrlFromFileId(config, fileId) {
  const body = await requestJson(
    `${config.baseUrl}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
    { method: "GET", headers: { Authorization: `Bearer ${config.apiKey}` } },
    config.httpTimeoutMs
  );
  const url = body?.file?.download_url || body?.download_url;
  if (!url) throw new Error("MiniMax returned a file ID but no video download URL.");
  return url;
}

async function waitForVideo(config, taskId) {
  const deadline = Date.now() + config.pollTimeoutMs;
  let lastStatus = "";

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise(resolve => setTimeout(resolve, Math.min(config.pollIntervalMs, remaining)));
    const body = await queryTask(config, taskId);
    const status = normalizedStatus(body);
    lastStatus = status || lastStatus;

    if (["succeeded", "success", "completed", "finished"].includes(status)) {
      const directUrl = videoUrlFromTask(body);
      if (directUrl) return directUrl;
      const fileId = fileIdFromTask(body);
      if (!fileId) throw new Error("MiniMax marked the task successful but did not return a video URL.");
      return downloadUrlFromFileId(config, fileId);
    }

    if (["failed", "fail", "cancelled", "canceled", "expired"].includes(status)) {
      const detail = apiErrorMessage(body?.task?.error || body?.error || body, status);
      const error = new Error(`MiniMax video generation ${status}: ${detail}`);
      error.status = 502;
      throw error;
    }
  }

  const error = new Error(
    `MiniMax video generation timed out after ${Math.round(config.pollTimeoutMs / 60_000)} minutes` +
    (lastStatus ? ` (last status: ${lastStatus})` : ".")
  );
  error.status = 504;
  throw error;
}

async function downloadVideo(url, destination, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    throw new Error(`MiniMax video download failed: ${cause.message}`, { cause });
  }
  if (!response.ok) {
    throw new Error(`MiniMax video download failed (${response.status}).`);
  }
  await fs.promises.writeFile(destination, Buffer.from(await response.arrayBuffer()));
  return destination;
}

/**
 * Submit the primary text-to-video request, poll its asynchronous task, and
 * save the resulting MP4 into the app's generated directory.
 */
export async function generateMinimaxVideo(prompt, destination) {
  const config = minimaxConfig({ includeSecret: true });
  if (!config.configured) {
    const error = new Error("MiniMax is the primary video generator, but MINIMAX_API_KEY is not configured.");
    error.status = 503;
    error.code = "MINIMAX_NOT_CONFIGURED";
    throw error;
  }

  const text = String(prompt || "").trim();
  if (!text) throw new Error("MiniMax requires a non-empty video prompt.");
  if (text.length > config.maxPromptChars) {
    const error = new Error(`MiniMax prompts must be ${config.maxPromptChars.toLocaleString()} characters or fewer.`);
    error.status = 400;
    throw error;
  }

  const payload = {
    model: config.model,
    content: [{ type: "text", text }],
    resolution: config.resolution,
    duration: config.duration,
    ratio: config.ratio
  };
  const created = await requestJson(
    `${config.baseUrl}/v2/video_generation`,
    {
      method: "POST",
      headers: authorizationHeaders(config.apiKey),
      body: JSON.stringify(payload)
    },
    config.httpTimeoutMs
  );
  const taskId = taskIdFromResponse(created);
  const videoUrl = await waitForVideo(config, taskId);
  return downloadVideo(videoUrl, destination, config.downloadTimeoutMs);
}
