"use client";

import { useState } from "react";
import { Badge, api, usePolling } from "./ui";

interface Ref {
  id: string;
  title: string;
  status: string;
  error: string | null;
  video_url: string;
  pattern: string | null;
  reels: number;
  created_at: string;
}

export function Library({ kind }: { kind: "story" | "recipe" }) {
  const recipe = kind === "recipe";
  const { data, error, reload } = usePolling<Ref[]>(`/api/references?kind=${kind}`, (d) => d.some((r) => r.status === "uploaded" || r.status === "analyzing"));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setMsg("");
    try {
      const ref = await api<{ id: string }>("/api/references", { method: "POST", body: new FormData(form) });
      form.reset();
      window.location.href = `/references/${ref.id}`;
    } catch (err: any) {
      setMsg(err.message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row between" style={{ marginBottom: 16 }}>
        <div>
          <h1>{recipe ? "Proven recipe reels" : "Proven stories"}</h1>
          <p className="muted">
            {recipe
              ? "Upload a food reel that already went viral. Gemini studies the shots and rhythm, then you make reels for YOUR recipes (no talking, close-up satisfying shots, end card → your blog)."
              : "Upload a competitor reel that already went viral. Gemini studies why it works, then you generate new original reels from it."}
          </p>
        </div>
      </div>

      <form className="panel" onSubmit={upload}>
        <input type="hidden" name="kind" value={kind} />
        <h2>{recipe ? "Add a reference food reel" : "Add a reference video"}</h2>
        <div className="grid g2">
          <div>
            <div className="field">
              <label>Video (MP4, MOV, WEBM — up to 300 MB)</label>
              <input type="file" name="video" accept="video/mp4,video/quicktime,video/webm,.m4v" required />
            </div>
            <div className="field">
              <label>Name (optional)</label>
              <input type="text" name="title" placeholder={recipe ? "e.g. Oreo cake slice — 2.1M views" : "e.g. Dad comes home early — 4.2M views"} />
            </div>
          </div>
          <div className="field">
            <label>{recipe ? "Notes (optional): caption, recipe name, views" : "Notes (optional): the caption, the blog story text, views, why you think it worked"}</label>
            <textarea name="notes" rows={5} />
          </div>
        </div>
        {msg && <div className="alert bad">{msg}</div>}
        <button className="primary" disabled={busy}>{busy ? "Uploading…" : "Upload and analyze"}</button>
      </form>

      {error && <div className="alert bad">{error}</div>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && data.length === 0 && <p className="muted">No reference videos yet.</p>}

      <div className="grid g4">
        {data?.map((r) => (
          <div className="card" key={r.id}>
            <video className="media vert" src={r.video_url} preload="metadata" muted />
            <a className="title" href={`/references/${r.id}`}>{r.title}</a>
            <div className="row between">
              <Badge status={r.status} />
              <span className="muted small">{r.reels} reel{r.reels === 1 ? "" : "s"}</span>
            </div>
            {r.pattern && <p className="muted small">{r.pattern}</p>}
            {r.error && <p className="small" style={{ color: "var(--bad)" }}>{r.error}</p>}
          </div>
        ))}
      </div>
      <button className="link small" style={{ marginTop: 16 }} onClick={reload}>Refresh</button>
    </>
  );
}
