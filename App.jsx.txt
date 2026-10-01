import { useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_NODE_API_URL || "http://localhost:3001";

function CharacterCreator({ onCreated }) {
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [image, setImage] = useState(null);
  const [loading, setLoading] = useState(false);

  async function createCharacter() {
    setLoading(true);
    const form = new FormData();
    form.append("name", name);
    form.append("tag", tag);
    if (image) form.append("image", image);
    const res = await fetch(`${API_BASE}/api/character/upload`, { method: "POST", body: form });
    const data = await res.json();
    onCreated(data);
    setLoading(false);
  }

  return (
    <div style={{ marginTop: 32 }}>
      <h2>Create Character</h2>
      <input
        placeholder="Character Name"
        value={name}
        onChange={e => setName(e.target.value)}
        style={{ width: "100%", marginBottom: 8 }}
      />
      <textarea
        placeholder="Describe the character"
        value={tag}
        onChange={e => setTag(e.target.value)}
        rows={3}
        style={{ width: "100%", marginBottom: 8 }}
      />
      <input type="file" accept="image/*" onChange={e => setImage(e.target.files[0])} />
      <button onClick={createCharacter} disabled={loading}>
        {loading ? "Creating..." : "Create Character"}
      </button>
    </div>
  );
}

function App() {
  const [story, setStory] = useState("");
  const [character, setCharacter] = useState("");
  const [characters, setCharacters] = useState([]);
  const [audio, setAudio] = useState(null);
  const [loading, setLoading] = useState(false);
  const [videoUrl, setVideoUrl] = useState("");
  const [spec, setSpec] = useState(null);

  useEffect(() => {
    async function loadCharacters() {
      const res = await fetch(`${API_BASE}/characters.json`);
      const data = await res.json();
      const list = Object.entries(data).map(([id, c]) => ({ id, ...c }));
      setCharacters(list);
      if (!character && list.length) setCharacter(list[0].id);
    }
    loadCharacters();
  }, []);

  async function generateFromStory() {
    setLoading(true);
    setVideoUrl("");
    const form = new FormData();
    form.append("story", story);
    form.append("character", character);
    if (audio) form.append("audio", audio);
    const res = await fetch(`${API_BASE}/api/story`, { method: "POST", body: form });
    const data = await res.json();
    setVideoUrl(`${API_BASE}${data.file.replace(".", "")}`);
    setSpec(data.spec);
    setLoading(false);
  }

  const currentChar = characters.find(c => c.id === character);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 24, fontFamily: "system-ui" }}>
      <h1>Story → Lipsynced Video</h1>

      <textarea
        value={story}
        onChange={e => setStory(e.target.value)}
        rows={6}
        style={{ width: "100%", marginTop: 8 }}
        placeholder="Type a short story..."
      />

      <div style={{ marginTop: 16 }}>
        <label>
          Character
          <select value={character} onChange={e => setCharacter(e.target.value)} style={{ marginLeft: 8 }}>
            {characters.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {currentChar?.image && (
          <img
            src={`${API_BASE}${currentChar.image}`}
            alt="Character"
            style={{ width: 120, marginTop: 12, borderRadius: 8 }}
          />
        )}
      </div>

      <input
        type="file"
        accept="audio/*"
        onChange={e => setAudio(e.target.files[0])}
        style={{ marginTop: 8 }}
      />

      <button
        onClick={generateFromStory}
        disabled={loading || !story.trim() || !character}
        style={{ marginTop: 16 }}
      >
        {loading ? "Generating..." : "Generate Video"}
      </button>

      {videoUrl && (
        <div style={{ marginTop: 24 }}>
          <h2>Result</h2>
          <video src={videoUrl} controls style={{ width: "100%", maxHeight: 480, background: "#000" }} />
        </div>
      )}

      {spec && (
        <div style={{ marginTop: 24 }}>
          <h3>SceneSpec</h3>
          <pre
            style={{
              background: "#111",
              color: "#eee",
              padding: 12,
              borderRadius: 4,
              fontSize: 12,
              overflowX: "auto"
            }}
          >
            {JSON.stringify(spec, null, 2)}
          </pre>
        </div>
      )}

      <CharacterCreator
        onCreated={char => {
          setCharacters(prev => [...prev, { id: char.id, ...char }]);
          if (!character) setCharacter(char.id);
        }}
      />
    </div>
  );
}

export default App;
