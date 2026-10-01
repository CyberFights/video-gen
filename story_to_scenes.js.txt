import crypto from "crypto";

const CAMERA_TYPES = ["close_up", "medium_shot", "wide"];
const CAMERA_MOVES = ["static", "pan_left", "pan_right", "dolly_forward", "dolly_back"];
const CAMERA_ANGLES = ["eye_level", "slightly_low", "high"];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function storyToScenes(story, characterKey) {
  const rawScenes = story
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.trim().length > 0);

  const scenes = rawScenes.map((text, i) => {
    const id = `scene_${String(i + 1).padStart(2, "0")}`;

    const camera = {
      type: pick(CAMERA_TYPES),
      movement: pick(CAMERA_MOVES),
      angle: pick(CAMERA_ANGLES)
    };

    const lower = text.toLowerCase();

    let preset = "cinematic";
    if (lower.includes("city") || lower.includes("neon")) preset = "hyper_realistic";
    if (lower.includes("quiet") || lower.includes("soft")) preset = "documentary";
    if (lower.includes("magic") || lower.includes("spirit")) preset = "anime";

    let style = "cyberpunk";
    if (lower.includes("forest") || lower.includes("dark")) style = "dark_fantasy";
    if (lower.includes("anime")) style = "anime";

    const duration = Math.max(3, Math.min(8, Math.floor(text.length / 40)));
    const fps = 15;

    const seedHex = crypto.createHash("md5").update(characterKey).digest("hex").slice(0, 6);
    const seed = parseInt(seedHex, 16);

    const breathing = lower.includes("calm") || lower.includes("breath") ? true : false;

    let expression_profile = "neutral";
    if (lower.includes("happy") || lower.includes("smile")) expression_profile = "happy";
    if (lower.includes("angry") || lower.includes("rage")) expression_profile = "angry";
    if (lower.includes("sad") || lower.includes("cry")) expression_profile = "sad";

    return {
      id,
      prompt: text.trim(),
      camera,
      duration,
      fps,
      preset,
      style,
      seed,
      breathing,
      expression_profile
    };
  });

  return { character: characterKey, scenes };
}
