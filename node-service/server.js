import express from "express"; import fs from "fs"; import multer from "multer"; import { storyToScenes } from "./story_to_scenes.js"; import { generateTimelineWithLipsync, loadCharacters } from "./video.js";

const app = express(); const upload = multer({ dest: "uploads/" });

if (!fs.existsSync("./generated")) fs.mkdirSync("./generated"); if (!fs.existsSync("./uploads")) fs.mkdirSync("./uploads");

app.use(express.json()); app.use("/generated", express.static("generated")); app.use("/uploads", express.static("uploads"));

app.get("/characters.json", async (req, res) => { const chars = await loadCharacters(); res.send(chars); });

app.post("/api/character/upload", upload.single("image"), async (req, res) => { const { name, tag } = req.body; if (!name || !tag) return res.status(400).send({ error: "name and tag required" });

const id = name.toLowerCase().replace(/\s+/g, "_"); const seed = Math.floor(Math.random() * 999999); const imagePath = req.file ? /uploads/${req.file.filename} : "";

const characters = await loadCharacters(); characters[id] = { name, tag, seed, image: imagePath }; fs.writeFileSync("./characters.json", JSON.stringify(characters, null, 2)); res.send({ id, name, tag, seed, image: imagePath }); });

app.post("/api/story", upload.single("audio"), async (req, res) => { try { const { story, character } = req.body; const audioPath = req.file ? ./uploads/${req.file.filename} : ""; const spec = storyToScenes(story, character); const file = await generateTimelineWithLipsync(spec.scenes, spec.character, audioPath, story); res.send({ file, spec }); } catch { res.status(500).send({ error: "generation failed" }); } });

app.listen(process.env.PORT || 3001);
