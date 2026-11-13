"use client";

import { use, useEffect, useState } from "react";
import { IMAGE_TIERS, VIDEO_MODELS, type ProjectSettings } from "@/lib/config";
import type { Story, StoryScene } from "@/lib/types";
import { Badge, api, money, postJson, usePolling } from "../../ui";

interface Asset { kind: "character" | "frame" | "clip"; ref: string; status: string; url: string | null; error: string | null; updated_at: string }
interface Project {
  id: string;
  title: string;
  status: string;
  error: string | null;
  settings: ProjectSettings;
  story: Story | null;
  cost_usd: string;
  final_url: string | null;
  music_url: string | null;
  reference: { id: string; title: string; status: string; video_url: string } | null;
  assets: Asset[];
  jobs: { id: number; type: string; status: string; error: string | null }[];
  estimate_usd: number;
}

const STEP_ORDER = ["story", "characters", "frames", "clips", "final"] as const;
const JOB_LABEL: Record<string, string> = {
  write: "Claude is writing a new original story",
  characters: "Generating character reference images",
  frames: "Generating the start frame of each scene",
  clips: "Generating video clips (usually 2–6 minutes)",
  render: "Joining clips into the final MP4",
};

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, reload } = usePolling<Project>(`/api/projects/${id}`, (d) => d.jobs.length > 0);
  const [msg, setMsg] = useState("");

  if (error) return <div className="alert bad">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;

  const busy = data.jobs.length > 0;
  const asset = (kind: Asset["kind"], ref: string) => data.assets.find((a) => a.kind === kind && a.ref === ref);
  const story = data.story;
  const s = data.settings;
  const model = VIDEO_MODELS[s.videoModel];
  const clipCost = s.clipSeconds * model.pricePerSecond(s.audio);
  const imgPrice = IMAGE_TIERS[s.imageTier].priceUsd;

  const allReady = (kind: Asset["kind"], refs: string[]) => refs.length > 0 && refs.every((r) => asset(kind, r)?.status === "ready");
  const charRefs = story?.characters.map((c) => c.key) ?? [];
  const sceneRefs = story?.scenes.map((sc) => String(sc.index)) ?? [];
  const reached = {
    story: !!story,
    characters: allReady("character", charRefs),
    frames: allReady("frame", sceneRefs),
    clips: allReady("clip", sceneRefs),
    final: !!data.final_url,
  };
  const current = STEP_ORDER.find((k) => !reached[k]) ?? "final";

  async function run(step: string, extra: Record<string, unknown> = {}) {
    setMsg("");
    try {
      await postJson(`/api/projects/${id}/run`, { step, ...extra });
      await reload();
    } catch (e: any) {
      setMsg(e.message);
    }
  }
  async function saveSettings(patch: Partial<ProjectSettings>) {
    await postJson(`/api/projects/${id}`, { settings: patch }, "PATCH").catch((e) => setMsg(e.message));
    await reload();
  }

  return (
    <>
      <p className="small">
        <a href={data.reference ? `/references/${data.reference.id}` : "/"}>← {data.reference?.title ?? "Back"}</a>
      </p>
      <div className="row between">
        <h1>{data.title}</h1>
        <div className="row">
          <Badge status={data.status} />
          <span className="muted small">Spent {money(data.cost_usd)}</span>
          <button
            className="danger"
            onClick={async () => {
              if (!confirm("Delete this reel and its files?")) return;
              await api(`/api/projects/${id}`, { method: "DELETE" });
              window.location.href = data.reference ? `/references/${data.reference.id}` : "/";
            }}
          >
            Delete
          </button>
        </div>
      </div>
      <div className="steps">
        {STEP_ORDER.map((k) => (
          <span key={k} className={`s ${reached[k] ? "done" : k === current ? "now" : ""}`}>
            {reached[k] ? "✓ " : ""}{k[0].toUpperCase() + k.slice(1)}
          </span>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        {data.jobs.map((j) => (
          <div className="alert run" key={j.id}>
            <span className="spin" /> {JOB_LABEL[j.type] ?? j.type}…{j.error ? ` (${j.error})` : ""}
          </div>
        ))}
        {data.status === "failed" && data.error && <div className="alert bad">{data.error}</div>}
        {msg && <div className="alert bad">{msg}</div>}
      </div>

      {data.final_url && (
        <FinalPanel data={data} busy={busy} run={run} saveSettings={saveSettings} reload={reload} />
      )}

      <StoryPanel data={data} busy={busy} run={run} reload={reload} setMsg={setMsg} />

      {story && (
        <div className="panel">
          <div className="row between">
            <h2>2. Characters</h2>
            <button className={current === "characters" ? "primary" : ""} disabled={busy} onClick={() => run("characters")}>
              {reached.characters ? "Regenerate all" : "Generate characters"} (~{money(story.characters.length * imgPrice)})
            </button>
          </div>
          <p className="muted small">One reference photo per character. Every scene image is built from these, so faces and outfits stay the same.</p>
          <div className="grid g4" style={{ marginTop: 10 }}>
            {story.characters.map((c) => {
              const a = asset("character", c.key);
              return (
                <div className="card" key={c.key}>
                  <Media a={a} portrait />
                  <b>{c.name}</b>
                  <span className="muted small">{c.role}</span>
                  <AssetStatus a={a} />
                  <button disabled={busy} onClick={() => {
                    const note = prompt(`Regenerate ${c.name}. Optional change (e.g. "older, grey hair"):`, "");
                    if (note !== null) run("characters", { only: c.key, note });
                  }}>Regenerate</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {story && reached.characters && (
        <div className="panel">
          <div className="row between">
            <h2>3. Start frames</h2>
            <button className={current === "frames" ? "primary" : ""} disabled={busy} onClick={() => run("frames")}>
              {reached.frames ? "Regenerate all" : "Generate start frames"} (~{money(story.scenes.length * imgPrice)})
            </button>
          </div>
          <p className="muted small">The first image of each clip. Check them carefully: a good frame is the cheapest way to get a good video.</p>
          <div className="grid g4" style={{ marginTop: 10 }}>
            {story.scenes.map((sc) => {
              const a = asset("frame", String(sc.index));
              return (
                <div className="card" key={sc.index}>
                  <Media a={a} />
                  <b>Scene {sc.index + 1}</b>
                  <span className="muted small">{sc.beat}</span>
                  <AssetStatus a={a} />
                  <button disabled={busy} onClick={() => {
                    const note = prompt(`Regenerate scene ${sc.index + 1} frame. Optional change:`, "");
                    if (note !== null) run("frames", { only: sc.index, note });
                  }}>Regenerate</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {story && reached.frames && (
        <div className="panel">
          <div className="row between">
            <h2>4. Video clips</h2>
            <button className={current === "clips" ? "primary" : ""} disabled={busy} onClick={() => {
              const total = clipCost * story.scenes.length;
              if (confirm(`Generate ${story.scenes.length} clips with ${model.label}? About ${money(total)} on fal.ai.`)) run("clips");
            }}>
              {reached.clips ? "Regenerate all clips" : "Generate video clips"} (~{money(clipCost * story.scenes.length)})
            </button>
          </div>
          <div className="row small" style={{ margin: "6px 0" }}>
            <select value={s.videoModel} disabled={busy} style={{ width: "auto" }}
              onChange={(e) => saveSettings({ videoModel: e.target.value as any, clipSeconds: s.clipSeconds })}>
              {Object.values(VIDEO_MODELS).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <label className="row" style={{ gap: 6, margin: 0 }}>
              Seconds
              <input type="number" min={model.minSeconds} max={model.maxSeconds} value={s.clipSeconds} disabled={busy}
                style={{ width: 70 }} onChange={(e) => saveSettings({ clipSeconds: Number(e.target.value) })} />
            </label>
            {model.supportsAudio && (
              <label className="check" style={{ margin: 0 }}>
                <input type="checkbox" checked={s.audio} disabled={busy} onChange={(e) => saveSettings({ audio: e.target.checked })} /> Sound
              </label>
            )}
          </div>
          <p className="muted small">The final MP4 is rebuilt automatically when clips finish.{!s.audio && " Clips are silent — add music on the final step."}</p>
          <div className="grid g4" style={{ marginTop: 10 }}>
            {story.scenes.map((sc) => {
              const a = asset("clip", String(sc.index));
              return (
                <div className="card" key={sc.index}>
                  <Media a={a} video />
                  <b>Scene {sc.index + 1}</b>
                  <AssetStatus a={a} />
                  <button disabled={busy} onClick={() => {
                    if (confirm(`Regenerate clip ${sc.index + 1}? About ${money(clipCost)}.`)) run("clips", { only: sc.index });
                  }}>Regenerate clip</button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ final
function FinalPanel({ data, busy, run, saveSettings, reload }: {
  data: Project; busy: boolean; run: (s: string) => void; saveSettings: (p: Partial<ProjectSettings>) => Promise<void>; reload: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  return (
    <div className="panel">
      <h2>5. Final reel</h2>
      <div className="cols">
        <video className="media vert" src={data.final_url!} controls preload="metadata" key={data.final_url} />
        <div>
          <p>Ready to post as a Facebook Reel. Turn on the <b>AI info</b> label when you upload it.</p>
          <div className="row" style={{ margin: "12px 0" }}>
            <a className="btn primary" href={`${data.final_url}?download=1`}>Download MP4</a>
            <button disabled={busy} onClick={() => run("render")}>Re-render</button>
          </div>
          <hr />
          <label className="check">
            <input type="checkbox" checked={data.settings.hookText} disabled={busy}
              onChange={async (e) => { await saveSettings({ hookText: e.target.checked }); run("render"); }} />
            Hook text on top: “{data.story?.hook_text}”
          </label>
          <div className="field" style={{ marginTop: 12 }}>
            <label>Background music (optional, use music you have the rights to)</label>
            {data.music_url && (
              <div className="row" style={{ marginBottom: 8 }}>
                <audio src={data.music_url} controls />
                <button className="danger" disabled={busy} onClick={async () => {
                  await api(`/api/projects/${data.id}/music`, { method: "DELETE" });
                  run("render");
                }}>Remove</button>
              </div>
            )}
            <input type="file" accept="audio/*" disabled={uploading || busy} onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setUploading(true);
              const fd = new FormData();
              fd.append("music", f);
              try {
                await api(`/api/projects/${data.id}/music`, { method: "POST", body: fd });
                run("render");
              } catch (err: any) {
                alert(err.message);
              }
              setUploading(false);
              reload();
            }} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ story editor
function StoryPanel({ data, busy, run, reload, setMsg }: {
  data: Project; busy: boolean; run: (s: string, x?: Record<string, unknown>) => void; reload: () => void; setMsg: (m: string) => void;
}) {
  const [draft, setDraft] = useState<Story | null>(data.story);
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [open, setOpen] = useState(!data.final_url);

  useEffect(() => {
    if (!dirty) setDraft(data.story);
  }, [data.story, dirty]);

  if (!draft) {
    return (
      <div className="panel">
        <h2>1. Story</h2>
        <p className="muted">{busy ? "Writing a new original story from the reference…" : "No story yet."}</p>
        {!busy && <button className="primary" onClick={() => run("write")}>Write story</button>}
      </div>
    );
  }

  const edit = (patch: Partial<Story>) => { setDraft({ ...draft, ...patch }); setDirty(true); };
  const editChar = (i: number, patch: Record<string, string>) =>
    edit({ characters: draft.characters.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const editScene = (i: number, patch: Partial<StoryScene>) =>
    edit({ scenes: draft.scenes.map((sc, j) => (j === i ? { ...sc, ...patch } : sc)) });

  async function save() {
    try {
      await postJson(`/api/projects/${data.id}`, { story: draft }, "PATCH");
      setDirty(false);
      reload();
    } catch (e: any) {
      setMsg(e.message);
    }
  }

  return (
    <div className="panel">
      <div className="row between">
        <h2 style={{ margin: 0 }}>1. Story</h2>
        <div className="row">
          {dirty && <button className="primary" onClick={save}>Save changes</button>}
          {dirty && <button onClick={() => { setDraft(data.story); setDirty(false); }}>Discard</button>}
          <button className="link" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} story</button>
        </div>
      </div>
      {!open && <p className="muted" style={{ marginTop: 8 }}>{draft.logline}</p>}
      {open && (
        <div style={{ marginTop: 12 }}>
          <div className="grid g2">
            <div className="field"><label>Title</label><input type="text" value={draft.title} onChange={(e) => edit({ title: e.target.value })} /></div>
            <div className="field"><label>Hook text (top of the reel)</label><input type="text" value={draft.hook_text} onChange={(e) => edit({ hook_text: e.target.value })} /></div>
          </div>
          <div className="field"><label>Logline</label><textarea rows={2} value={draft.logline} onChange={(e) => edit({ logline: e.target.value })} /></div>
          <div className="field"><label>Setting (used in every image)</label><textarea rows={2} value={draft.setting} onChange={(e) => edit({ setting: e.target.value })} /></div>

          <h3>Characters</h3>
          <div className="grid g2">
            {draft.characters.map((c, i) => (
              <div className="card" key={c.key}>
                <div className="row">
                  <input type="text" value={c.name} onChange={(e) => editChar(i, { name: e.target.value })} style={{ flex: 1 }} />
                  <input type="text" value={c.role} onChange={(e) => editChar(i, { role: e.target.value })} style={{ flex: 1 }} />
                </div>
                <label>Look (age, face, hair, outfit)</label>
                <textarea rows={3} value={c.visual} onChange={(e) => editChar(i, { visual: e.target.value })} />
              </div>
            ))}
          </div>

          <h3 style={{ marginTop: 16 }}>Scenes</h3>
          <div className="grid g2">
            {draft.scenes.map((sc, i) => (
              <div className="card" key={i}>
                <b>Scene {i + 1}</b>
                <label>What happens</label>
                <textarea rows={2} value={sc.beat} onChange={(e) => editScene(i, { beat: e.target.value })} />
                <label>Start frame (still image)</label>
                <textarea rows={3} value={sc.frame_prompt} onChange={(e) => editScene(i, { frame_prompt: e.target.value })} />
                <label>Motion (what moves, camera)</label>
                <textarea rows={3} value={sc.motion_prompt} onChange={(e) => editScene(i, { motion_prompt: e.target.value })} />
                <label>Spoken line (optional)</label>
                <input type="text" value={sc.dialogue ?? ""} onChange={(e) => editScene(i, { dialogue: e.target.value || null })} />
                <div className="row small">
                  {draft.characters.map((c) => (
                    <label key={c.key} className="check" style={{ margin: 0 }}>
                      <input type="checkbox" checked={sc.characters.includes(c.key)} onChange={(e) =>
                        editScene(i, { characters: e.target.checked ? [...sc.characters, c.key] : sc.characters.filter((k) => k !== c.key) })} />
                      {c.name}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h3>Originality check</h3>
            <div className="kv">
              <div>Kept (structure)</div><div>{draft.originality.kept_from_reference.join("; ")}</div>
              <div>Changed</div><div>{draft.originality.changed.join("; ")}</div>
              <div>Risks</div><div>{draft.originality.risk_notes}</div>
            </div>
          </div>

          <div className="field" style={{ marginTop: 16 }}>
            <label>Not happy? Tell Claude what to change and rewrite</label>
            <textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="e.g. make the twist stronger, change the setting to a restaurant, characters older" />
          </div>
          <div className="row">
            <button disabled={busy || dirty} onClick={() => { run("write", { feedback }); setFeedback(""); }}>
              {feedback.trim() ? "Rewrite with my notes" : "Write a completely new story"}
            </button>
            {dirty && <span className="muted small">Save or discard your edits first.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ small parts
function Media({ a, video, portrait }: { a?: Asset; video?: boolean; portrait?: boolean }) {
  if (a?.status === "ready" && a.url) {
    return video
      ? <video className="media vert" src={a.url} controls preload="metadata" key={a.url} />
      : <img className={`media ${portrait ? "portrait" : "vert"}`} src={a.url} alt="" />;
  }
  return (
    <div className={`placeholder ${portrait ? "p34" : ""}`}>
      {a?.status === "generating" ? <span><span className="spin" /> generating</span> : a?.status === "failed" ? "failed" : "not generated"}
    </div>
  );
}

function AssetStatus({ a }: { a?: Asset }) {
  if (!a) return null;
  if (a.status === "failed") return <span className="small" style={{ color: "var(--bad)" }}>{a.error}</span>;
  return null;
}
