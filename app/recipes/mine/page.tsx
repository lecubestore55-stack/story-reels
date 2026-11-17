"use client";

import { useState } from "react";
import { Badge, api, usePolling } from "../../ui";
import { IMAGE_TIERS, MARKETS, VIDEO_MODELS } from "@/lib/config";

interface Source {
  id: string;
  title: string;
  image_url: string;
  created_at: string;
  projects: { id: string; title: string; status: string }[];
}

export default function MyRecipesPage() {
  const { data } = usePolling<Source[]>("/api/sources", (d) => d.some((s) => s.projects.some((p) => p.status === "writing")));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [market, setMarket] = useState("us");
  const [videoModel, setVideoModel] = useState("happy-horse");
  const [imageTier, setImageTier] = useState("seedream-pro");
  const [scenes, setScenes] = useState(6);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const m = MARKETS.find((x) => x.id === market)!;
    const model = VIDEO_MODELS[videoModel as keyof typeof VIDEO_MODELS];
    fd.set(
      "settings",
      JSON.stringify({
        country: m.country,
        language: m.language,
        videoModel,
        imageTier,
        sceneCount: scenes,
        clipSeconds: model.minSeconds,
        shotSeconds: 1.5,
        audio: true,
        hookText: true,
        endCard: true,
        subtitles: false,
      }),
    );
    setBusy(true);
    setMsg("Reading the recipe…");
    try {
      const r = await api<{ ids: string[] }>("/api/sources", { method: "POST", body: fd });
      window.location.href = `/projects/${r.ids[0]}`;
    } catch (err: any) {
      setMsg(err.message);
      setBusy(false);
    }
  }

  const model = VIDEO_MODELS[videoModel as keyof typeof VIDEO_MODELS];
  const estimate = scenes * model.minSeconds * model.pricePerSecond(true) + (scenes + 1) * (IMAGE_TIERS[imageTier as keyof typeof IMAGE_TIERS]?.priceUsd ?? 0.08);

  return (
    <main>
      <h1>Reel from my recipe</h1>
      <p className="muted">
        Paste the link of a recipe on your blog (or the recipe text + a photo of the dish). Claude picks the most visual steps of
        YOUR recipe, the blog photo keeps the finished dish identical, and the end card sends viewers to the full recipe.
      </p>

      <form className="panel" onSubmit={submit}>
        <div className="field">
          <label>Recipe link (your blog post)</label>
          <input type="url" name="url" placeholder="https://yourblog.com/taco-cones-recipe/" />
          <p className="muted small">Works with WordPress recipe cards (WP Recipe Maker, Tasty…). Facebook links need a login, so paste the blog link or the text.</p>
        </div>
        <div className="field">
          <label>…or the recipe text (ingredients + steps). With a link, anything here is added as extra notes.</label>
          <textarea name="text" rows={6} placeholder={"Taco cones\nIngredients: 500 g ground beef, 6 tortillas, cheddar…\n1. Brown the beef with spices…\n2. Roll tortillas into cones…"} />
        </div>
        <div className="grid g2">
          <div className="field">
            <label>Photo of the finished dish (optional with a link — the page photo is used)</label>
            <input type="file" name="image" accept="image/jpeg,image/png,image/webp" />
          </div>
          <div className="field">
            <label>Title (optional)</label>
            <input type="text" name="title" placeholder="Taco cones" />
          </div>
        </div>
        <div className="grid g2">
          <div className="field">
            <label>Market (hook and end card language)</label>
            <select value={market} onChange={(e) => setMarket(e.target.value)}>
              {MARKETS.map((m) => <option key={m.id} value={m.id}>{m.flag} {m.country} — {m.language}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Steps (scenes, about 1.5 s each)</label>
            <input type="number" min={3} max={16} value={scenes} onChange={(e) => setScenes(Math.max(3, Math.min(16, Number(e.target.value) || 6)))} />
          </div>
          <div className="field">
            <label>Video model</label>
            <select value={videoModel} onChange={(e) => setVideoModel(e.target.value)}>
              {Object.values(VIDEO_MODELS).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Image model (cooking steps)</label>
            <select value={imageTier} onChange={(e) => setImageTier(e.target.value)}>
              {Object.values(IMAGE_TIERS).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
        </div>
        <div className="row">
          <button className="primary" disabled={busy}>{busy ? "Working…" : `Make the reel (~$${estimate.toFixed(2)})`}</button>
          {msg && <span className="muted small">{msg}</span>}
        </div>
      </form>

      <h2 style={{ marginTop: 28 }}>My recipe reels</h2>
      {!data?.length && <p className="muted">Nothing yet.</p>}
      <div className="grid g4">
        {data?.map((s) => (
          <div className="card" key={s.id}>
            <img src={s.image_url} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 8 }} />
            <strong>{s.title}</strong>
            {s.projects.map((p) => (
              <div key={p.id} className="row small" style={{ justifyContent: "space-between" }}>
                <a href={`/projects/${p.id}`}>Open reel</a>
                <Badge status={p.status} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </main>
  );
}
