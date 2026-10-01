import crypto from "node:crypto";

const CAMERA_TYPES = ["close_up", "medium_shot", "wide"];
const CAMERA_MOVES = ["static", "pan_left", "pan_right", "dolly_forward", "dolly_back"];
const CAMERA_ANGLES = ["eye_level", "slightly_low", "high"];

function deterministicPick(values, text) {
  const digest = crypto.createHash("sha256").update(text).digest();
  return values[digest[0] % values.length];
}

function splitLongScene(text, maximumLength = 2_500) {
  if (text.length <= maximumLength) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > maximumLength) {
    const breakAt = remaining.lastIndexOf(" ", maximumLength);
    const end = breakAt > maximumLength / 2 ? breakAt : maximumLength;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function storyToScenes(story, characterKey) {
  if (typeof story !== "string" || !story.trim()) {
    throw new Error("Story cannot be empty.");
  }

  const rawScenes = story
    .trim()
    .split(/(?<=[.!?])\s+|\n+/)
    .map(scene => scene.trim())
    .filter(Boolean)
    .flatMap(scene => splitLongScene(scene))
    .slice(0, 12);

  const scenes = rawScenes.map((text, index) => {
    const id = `scene_${String(index + 1).padStart(2, "0")}`;
    const key = `${characterKey}:${index}:${text}`;
    const lower = text.toLowerCase();

    let preset = "cinematic";
    if (lower.includes("city") || lower.includes("neon")) preset = "hyper_realistic";
    if (lower.includes("quiet") || lower.includes("soft")) preset = "documentary";
    if (lower.includes("magic") || lower.includes("spirit")) preset = "anime";

    let style = "cyberpunk";
    if (lower.includes("forest") || lower.includes("dark")) style = "dark_fantasy";
    if (lower.includes("anime")) style = "anime";

    let expressionProfile = "neutral";
    if (lower.includes("happy") || lower.includes("smile")) expressionProfile = "happy";
    if (lower.includes("angry") || lower.includes("rage")) expressionProfile = "angry";
    if (lower.includes("sad") || lower.includes("cry")) expressionProfile = "sad";

    return {
      id,
      prompt: text,
      camera: {
        type: deterministicPick(CAMERA_TYPES, `${key}:type`),
        movement: deterministicPick(CAMERA_MOVES, `${key}:movement`),
        angle: deterministicPick(CAMERA_ANGLES, `${key}:angle`)
      },
      duration: Math.max(3, Math.min(8, Math.ceil(text.length / 40))),
      fps: 15,
      preset,
      style,
      seed: Number.parseInt(crypto.createHash("md5").update(key).digest("hex").slice(0, 6), 16),
      breathing: lower.includes("calm") || lower.includes("breath"),
      expression_profile: expressionProfile
    };
  });

  return { character: characterKey, scenes };
}
