"use client";

import { use, useState } from "react";
import { DEFAULT_SETTINGS, IMAGE_TIERS, VIDEO_MODELS, estimateVideoCost, normalizeSettings, type ProjectSettings } from "@/lib/config";
import type { Analysis } from "@/lib/types";
import { Badge, api, money, postJson, usePolling } from "../../ui";

interface RefDetail {
  id: string;
  title: string;
  status: string;
  error: string | null;
  notes: string | null;
  video_url: string;
  analysis: Analysis | null;
  projects: { id: string; title: string; status: string; error: string | null; cost_usd: string; final_url: string | null; logline: string | null }[];
}

const RUNNING = new Set(["uploaded", "analyzing", "writing", "characters", "frames", "clips", "rendering"]);

export default function ReferencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, reload } = usePolling<RefDetail>(
    `/api/references/${id}`,
    (d) => RUNNING.has(d.status) || d.projects.some((p) => RUNNING.has(p.status)),
  );
  const [settings, setSettings] = useState<ProjectSettings>(DEFAULT_SETTINGS);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  if (error) return <div className="alert bad">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  const a = data.analysis;
  const s = normalizeSettings(settings);
  const model = VIDEO_MODELS[s.videoModel];
  const set = (patch: Partial<ProjectSettings>) => setSettings((old) => ({ ...old, ...patch }));

  async function create() {
    setBusy(true);
    setMsg("");
    try {
      const res = await postJson("/api/projects", { referenceId: id, settings: s, count });
      if (res.ids.length === 1) window.location.href = `/projects/${res.ids[0]}`;
      else {
        await reload();
        setBusy(false);
      }
    } catch (e: any) {
      setMsg(e.message);
      setBusy(false);
    }
  }

  return (
    <>
      <p className="small"><a href="/">← All proven stories</a></p>
      <div className="row between">
        <h1>{data.title}</h1>
        <div className="row">
          <Badge status={data.status} />
          {(data.status === "failed" || data.status === "ready") && (
            <button onClick={() => api(`/api/references/${id}/analyze`, { method: "POST" }).then(reload)}>Re-analyze</button>
          )}
          <button
            className="danger"
            onClick={async () => {
              if (!confirm("Delete this reference and all reels made from it?")) return;
              await api(`/api/references/${id}`, { method: "DELETE" });
              window.location.href = "/";
            }}
          >
            Delete
          </button>
        </div>
      </div>
      {data.error && <div className="alert bad">Analysis failed: {data.error}</div>}

      <div className="cols" style={{ marginTop: 14 }}>
        <div>
          <video className="media vert" src={data.video_url} controls preload="metadata" />
          {data.notes && <p className="muted small" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{data.notes}</p>}
        </div>

        <div>
          <div className="panel">
            <h2>Why it works</h2>
            {!a && <p className="muted"><span className="spin" /> Gemini is watching the video…</p>}
            {a && (
              <>
                <p>{a.summary}</p>
                <div className="kv" style={{ margin: "12px 0" }}>
                  <div>Pattern</div><div>{a.emotional_pattern}</div>
                  <div>Hook</div><div>{a.hook}</div>
                  <div>Twist</div><div>{a.twist}</div>
                  <div>Genre</div><div>{a.genre}</div>
                  <div>Length</div><div>{Math.round(a.duration_seconds)} s</div>
                  <div>Style</div><div>{a.visual_style}</div>
                  <div>Audio</div><div>{a.audio}</div>
                </div>
                <h3>Why it went viral</h3>
                <ul className="clean">{a.why_viral.map((w, i) => <li key={i}>{w}</li>)}</ul>
                <details style={{ marginTop: 10 }}>
                  <summary className="muted small">Beat by beat</summary>
                  <ul className="clean small" style={{ marginTop: 6 }}>
                    {a.beats.map((b, i) => (
                      <li key={i}>
                        <b>{b.start.toFixed(0)}–{b.end.toFixed(0)}s</b> {b.action} <span className="muted">({b.camera}; {b.emotion})</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </>
            )}
          </div>

          <div className="panel">
            <h2>Make new original reels from this</h2>
            <p className="muted small">Claude keeps only the emotional pattern and invents new characters, setting, conflict and twist. Each reel gets its own different story.</p>
            <div className="grid g3" style={{ marginTop: 12 }}>
              <div className="field">
                <label>Video model</label>
                <select value={s.videoModel} onChange={(e) => set({ videoModel: e.target.value as any })}>
                  {Object.values(VIDEO_MODELS).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Image model</label>
                <select value={s.imageTier} onChange={(e) => set({ imageTier: e.target.value as any })}>
                  {Object.values(IMAGE_TIERS).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Scenes (clips)</label>
                <input type="number" min={1} max={8} value={settings.sceneCount} onChange={(e) => set({ sceneCount: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Seconds per clip ({model.minSeconds}–{model.maxSeconds})</label>
                <input type="number" min={model.minSeconds} max={model.maxSeconds} value={settings.clipSeconds} onChange={(e) => set({ clipSeconds: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Language of hook text / dialogue</label>
                <input type="text" value={settings.language} onChange={(e) => set({ language: e.target.value })} />
              </div>
              <div className="field">
                <label>How many different reels</label>
                <input type="number" min={1} max={5} value={count} onChange={(e) => setCount(Number(e.target.value))} />
              </div>
              <div>
                {model.supportsAudio
                  ? <label className="check"><input type="checkbox" checked={settings.audio} onChange={(e) => set({ audio: e.target.checked })} /> AI sound (ambience, short lines)</label>
                  : <p className="muted small">This model makes silent clips — add music on the final step.</p>}
                <label className="check"><input type="checkbox" checked={settings.hookText} onChange={(e) => set({ hookText: e.target.checked })} /> Hook text on top</label>
                <label className="check"><input type="checkbox" checked={settings.autoRun} onChange={(e) => set({ autoRun: e.target.checked })} /> Run all steps without review</label>
              </div>
            </div>
            <div className="field">
              <label>Direction for the writer (optional): audience, country, tone, things to avoid</label>
              <textarea value={settings.instructions} onChange={(e) => set({ instructions: e.target.value })} placeholder="e.g. US audience, older characters, ending must feel rewarding, no police" />
            </div>
            {msg && <div className="alert bad">{msg}</div>}
            <div className="row">
              <button className="primary" disabled={busy || data.status === "failed"} onClick={create}>
                {busy ? "Creating…" : `Write ${count} new stor${count === 1 ? "y" : "ies"}`}
              </button>
              <span className="muted small">
                Writing is nearly free. Video for one reel: about {money(estimateVideoCost(s))} ({s.sceneCount} × {s.clipSeconds}s), charged only when you generate.
              </span>
            </div>
          </div>

          <div className="panel">
            <h2>Reels from this story ({data.projects.length})</h2>
            {data.projects.length === 0 && <p className="muted">None yet.</p>}
            <div className="grid g3">
              {data.projects.map((p) => (
                <div className="card" key={p.id}>
                  {p.final_url ? <video className="media vert" src={p.final_url} preload="metadata" muted /> : <div className="placeholder">No video yet</div>}
                  <a className="title" href={`/projects/${p.id}`}>{p.title}</a>
                  {p.logline && <p className="muted small">{p.logline}</p>}
                  <div className="row between"><Badge status={p.status} /><span className="muted small">{money(p.cost_usd)}</span></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
