import { useEffect, useState } from "react";

const API_BASE = (import.meta.env.VITE_NODE_API_URL || "").replace(/\/$/, "");
const apiUrl = path => `${API_BASE}${path}`;

const inputStyle = {
  boxSizing: "border-box",
  width: "100%",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  padding: 10,
  font: "inherit"
};

function CharacterCreator({ onCreated, onError }) {
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [image, setImage] = useState(null);
  const [loading, setLoading] = useState(false);

  async function createCharacter() {
    setLoading(true);
    onError("");
    try {
      const form = new FormData();
      form.append("name", name);
      form.append("tag", tag);
      if (image) form.append("image", image);
      const response = await fetch(apiUrl("/api/character/upload"), { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create the character.");
      onCreated(data);
      setName("");
      setTag("");
      setImage(null);
    } catch (error) {
      onError(error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section style={{ marginTop: 36, borderTop: "1px solid #e2e8f0", paddingTop: 24 }}>
      <h2>Create a character</h2>
      <input
        placeholder="Character name"
        value={name}
        onChange={event => setName(event.target.value)}
        maxLength={80}
        style={{ ...inputStyle, marginBottom: 10 }}
      />
      <textarea
        placeholder="Describe the character"
        value={tag}
        onChange={event => setTag(event.target.value)}
        maxLength={1000}
        rows={3}
        style={{ ...inputStyle, marginBottom: 10, resize: "vertical" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => setImage(event.target.files[0] || null)} />
        <button onClick={createCharacter} disabled={loading || !name.trim() || !tag.trim()}>
          {loading ? "Creating…" : "Create character"}
        </button>
      </div>
    </section>
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
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadCharacters() {
      try {
        const response = await fetch(apiUrl("/api/characters"));
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load characters.");
        const list = Object.entries(data).map(([id, value]) => ({ id, ...value }));
        setCharacters(list);
        setCharacter(current => current || list[0]?.id || "");
      } catch (loadError) {
        setError(loadError.message);
      }
    }
    loadCharacters();
  }, []);

  async function generateFromStory() {
    setLoading(true);
    setError("");
    setVideoUrl("");
    setSpec(null);
    try {
      const form = new FormData();
      form.append("story", story);
      form.append("character", character);
      if (audio) form.append("audio", audio);
      const response = await fetch(apiUrl("/api/story"), { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Video generation failed.");
      setVideoUrl(apiUrl(data.file));
      setSpec(data.spec);
    } catch (generationError) {
      setError(generationError.message);
    } finally {
      setLoading(false);
    }
  }

  const currentCharacter = characters.find(item => item.id === character);

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px 64px", fontFamily: "Inter, system-ui, sans-serif", color: "#0f172a" }}>
      <header>
        <p style={{ margin: 0, color: "#6366f1", fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase" }}>Video Gen</p>
        <h1 style={{ margin: "6px 0" }}>Turn a story into a video</h1>
        <p style={{ color: "#475569", marginTop: 0 }}>Each sentence becomes an animated scene. Add narration to synchronize the finished timeline.</p>
      </header>

      {error && (
        <div role="alert" style={{ margin: "20px 0", padding: 12, borderRadius: 8, background: "#fee2e2", color: "#991b1b" }}>
          {error}
        </div>
      )}

      <label style={{ display: "block", fontWeight: 650, marginTop: 24 }}>
        Story
        <textarea
          value={story}
          onChange={event => setStory(event.target.value)}
          rows={7}
          maxLength={12000}
          style={{ ...inputStyle, marginTop: 8, resize: "vertical" }}
          placeholder="Type a short story. Separate scenes with sentences or line breaks…"
        />
      </label>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 20, marginTop: 18 }}>
        <label style={{ fontWeight: 650 }}>
          Character
          <select value={character} onChange={event => setCharacter(event.target.value)} style={{ ...inputStyle, marginTop: 8 }}>
            {characters.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label style={{ fontWeight: 650 }}>
          Narration (optional)
          <input type="file" accept="audio/*" onChange={event => setAudio(event.target.files[0] || null)} style={{ display: "block", marginTop: 12, maxWidth: "100%" }} />
        </label>
      </div>

      {currentCharacter?.image && (
        <img src={apiUrl(currentCharacter.image)} alt={currentCharacter.name} style={{ width: 120, height: 80, objectFit: "cover", marginTop: 16, borderRadius: 8 }} />
      )}

      <button
        onClick={generateFromStory}
        disabled={loading || !story.trim() || !character}
        style={{ marginTop: 22, padding: "11px 18px", border: 0, borderRadius: 8, background: "#4f46e5", color: "white", font: "inherit", fontWeight: 700, cursor: "pointer" }}
      >
        {loading ? "Generating scenes…" : "Generate video"}
      </button>

      {videoUrl && (
        <section style={{ marginTop: 30 }}>
          <h2>Result</h2>
          <video src={videoUrl} controls style={{ width: "100%", maxHeight: 500, background: "#000", borderRadius: 10 }} />
          <p><a href={videoUrl} download>Download video</a></p>
        </section>
      )}

      {spec && (
        <details style={{ marginTop: 24 }}>
          <summary style={{ cursor: "pointer", fontWeight: 650 }}>Scene specification</summary>
          <pre style={{ background: "#111827", color: "#e5e7eb", padding: 14, borderRadius: 8, fontSize: 12, overflowX: "auto" }}>
            {JSON.stringify(spec, null, 2)}
          </pre>
        </details>
      )}

      <CharacterCreator
        onError={setError}
        onCreated={created => {
          setCharacters(previous => [...previous, created]);
          setCharacter(created.id);
        }}
      />
    </main>
  );
}

export default App;
