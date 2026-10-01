import fetch from "node-fetch"; import fs from "fs"; import { spawn } from "child_process";

const PYTHON_API = process.env.PYTHON_API_URL || "http://localhost:8000";

export async function loadCharacters() { const raw = fs.readFileSync("./characters.json"); return JSON.parse(raw.toString()); }

function framesFromScene(scene) { return scene.duration * scene.fps; }

async function downloadImage(url) { const res = await fetch(url); const buffer = await res.buffer(); const file = ./uploads/frame_${Date.now()}.png; fs.writeFileSync(file, buffer); return file; }

export async function generateScene(scene, characterKey) { const characters = await loadCharacters(); const char = characters[characterKey] || {};

let imagePath = ""; if (scene.imageUrl) { imagePath = await downloadImage(scene.imageUrl); } else if (char.image) { imagePath = "." + char.image; }

const params = new URLSearchParams({ prompt: scene.prompt, frames: framesFromScene(scene), fps: scene.fps || 15, guidance: scene.guidance || 7.5, seed: (char.seed || scene.seed || "").toString(), preset: scene.preset || "", character_tag: char.tag || "", style_tag: scene.style || "", image_path: imagePath, breathing: scene.breathing ? "true" : "false", expression_profile: scene.expression_profile || "neutral" });

const res = await fetch(${PYTHON_API}/scene? + params.toString(), { method: "POST" }); const buffer = await res.buffer(); const file = ./generated/${scene.id}_${Date.now()}.mp4; fs.writeFileSync(file, buffer); return file; }

async function cutAudio(input, start, duration, out) { await new Promise((resolve, reject) => { const ff = spawn("ffmpeg", [ "-y", "-i", input, "-ss", start.toString(), "-t", duration.toString(), "-acodec", "copy", out ]); ff.on("close", code => (code === 0 ? resolve() : reject(code))); }); }

async function getAlignment(audioPath, transcript) { const res = await fetch(${PYTHON_API}/align, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio_path: audioPath, transcript }) }); return await res.json(); }

function mapScenesToAudio(scenes, alignment) { const sceneAudioMap = {}; let currentTime = 0;

for (const scene of scenes) { const words = scene.prompt.split(/\s+/); const duration = words.reduce((acc, w) => { const match = alignment.words?.find(a => a.word === w.toLowerCase()); return acc + (match ? match.end - match.start : 0.4); }, 0); sceneAudioMap[scene.id] = { start: currentTime, duration }; currentTime += duration; }

return sceneAudioMap; }

async function lipsyncScene(videoPath, audioPath) { const res = await fetch(${PYTHON_API}/lipsync, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ video_path: videoPath, audio_path: audioPath }) }); const buffer = await res.buffer(); const file = ./generated/lipsynced_${Date.now()}.mp4; fs.writeFileSync(file, buffer); return file; }

export async function generateTimelineWithLipsync(scenes, characterKey, audioPath, transcript) { const alignment = await getAlignment(audioPath, transcript); const sceneMap = mapScenesToAudio(scenes, alignment);

const files = []; for (const scene of scenes) { const rawVideo = await generateScene(scene, characterKey); const { start, duration } = sceneMap[scene.id]; const sceneAudio = ./uploads/${scene.id}_audio.wav; await cutAudio(audioPath, start, duration, sceneAudio); const synced = await lipsyncScene(rawVideo, sceneAudio); files.push(synced); }

const listFile = "./generated/list.txt"; fs.writeFileSync(listFile, files.map(f => file '${f}').join("\n")); const output = ./generated/final_lipsynced_${Date.now()}.mp4;

await new Promise((resolve, reject) => { const ff = spawn("ffmpeg", [ "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", output ]); ff.on("close", code => (code === 0 ? resolve() : reject(code))); });

return output; }
