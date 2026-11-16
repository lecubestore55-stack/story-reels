"use client";

import { use, useEffect, useState } from "react";
import { ALL_VOICES, IMAGE_TIERS, LIPSYNC_PRICE_PER_SECOND, VIDEO_MODELS, useDub, type ProjectSettings } from "@/lib/config";
import { voiceMap, voiceNote } from "@/lib/voices";
import { chatgptAll, chatgptCharacterPrompt, chatgptFramePrompt } from "@/lib/chatgptPrompts";
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
  reference: { id: string; kind?: string; title: string; status: string; video_url: string } | null;
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
  voice: "Adding the voices (text-to-speech + lip sync)",
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
  const recipe = s.kind === "recipe";
  const dubbing = useDub(s) && Boolean(data.story?.scenes.some((x) => x.dialogue));
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
        <a href={data.reference?.kind === "source" ? "/recipes/mine" : data.reference ? `/references/${data.reference.id}` : "/"}>← {data.reference?.kind === "source" ? "My recipes" : data.reference?.title ?? "Back"}</a>
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
              window.location.href = data.reference?.kind === "source" ? "/recipes/mine" : data.reference ? `/references/${data.reference.id}` : "/";
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
            <h2>{recipe ? "2. Dish photo" : "2. Characters"}</h2>
            <button className={current === "characters" ? "primary" : ""} disabled={busy} onClick={() => run("characters")}>
              {reached.characters ? "Regenerate all" : recipe ? "Generate dish photo" : "Generate characters"} (~{money(story.characters.length * imgPrice)})
            </button>
          </div>
          <p className="muted small">
            {recipe
              ? "One photo of the finished dish. Every shot is built from it, so the layers and toppings stay the same."
              : "One reference photo per character. Every scene image is built from these, so faces and outfits stay the same."}
          </p>
          <div className="row small" style={{ margin: "8px 0 4px" }}>
            <span className="muted">Make the images in ChatGPT instead (free):</span>
            <CopyButton text={chatgptAll(story, recipe)} label="📋 Copy all prompts for ChatGPT" />
          </div>
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
                  <CopyButton text={chatgptCharacterPrompt(c, story)} />
                  <UploadButton projectId={data.id} kind="character" refKey={c.key} disabled={busy} onDone={reload} />
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
          <div className="alert ok small" style={{ marginTop: 10 }}>
            Want to make the images yourself in ChatGPT (free with your plan)? Copy all the prompts, paste them one by one in a
            single ChatGPT chat (attach the {s.kind === "recipe" ? "dish photo" : "character photos"} to the first message),
            then put each image on its scene with &quot;Upload my image&quot;.
            <div style={{ marginTop: 8 }}><CopyButton text={chatgptAll(story, s.kind === "recipe")} label="📋 Copy all prompts for ChatGPT" /></div>
          </div>
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
                  <CopyButton text={chatgptFramePrompt(sc, story, s.kind === "recipe")} />
                  <UploadButton projectId={data.id} kind="frame" refKey={String(sc.index)} disabled={busy} onDone={reload} />
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
          {reached.clips && dubbing && (
            <div className="row" style={{ margin: "6px 0" }}>
              <button disabled={busy} onClick={() => run("voice")}>Redo all voices (no new video)</button>
              <span className="muted small">Use this after you change a line, a speaker or a voice.</span>
            </div>
          )}
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
            <label className="row" style={{ gap: 6, margin: 0 }}>
              Voices
              <select value={s.voice} disabled={busy} style={{ width: "auto" }}
                onChange={(e) => saveSettings({ voice: e.target.value as ProjectSettings["voice"] })}>
                <option value="auto">Auto (dub when not English)</option>
                <option value="dub">Dub: real {s.language} voice + lip sync</option>
                <option value="native">Video model speaks (English only)</option>
              </select>
            </label>
          </div>
          {dubbing && (
            <p className="muted small">
              The video model makes the scene with its sound effects; its voices are removed, an ElevenLabs voice says the line in {s.language} and lip-sync 2 moves the speaker&apos;s mouth (~{money(s.clipSeconds * LIPSYNC_PRICE_PER_SECOND + 0.01)} extra per line). Use 5 seconds or more for scenes with a line. Pick each character&apos;s voice in the story editor.
            </p>
          )}
          {reached.clips && !data.final_url && (
            <div className="row" style={{ margin: "8px 0" }}>
              <button className="primary" disabled={busy} onClick={() => run("render")}>Render final MP4 (free)</button>
              <span className="muted small">Joins the clips you already paid for — no new generation.</span>
            </div>
          )}
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
                  {dubbing && sc.dialogue && a?.status === "ready" && (
                    <button disabled={busy} onClick={() => run("voice", { only: sc.index })}>Redo voice (~{money(s.clipSeconds * LIPSYNC_PRICE_PER_SECOND + 0.01)})</button>
                  )}
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
          <label className="check">
            <input type="checkbox" checked={data.settings.subtitles} disabled={busy}
              onChange={async (e) => { await saveSettings({ subtitles: e.target.checked }); run("render"); }} />
            Subtitles (each scene&apos;s spoken line)
          </label>
          <label className="check">
            <input type="checkbox" checked={data.settings.endCard} disabled={busy}
              onChange={async (e) => { await saveSettings({ endCard: e.target.checked }); run("render"); }} />
            End card: “{data.story?.end_text || "What happened next? Full story in the comments 👇"}”
          </label>
          <div className="row small" style={{ margin: "8px 0" }}>
            <span>Shot length:</span>
            <select value={String(data.settings.shotSeconds)} disabled={busy} style={{ width: "auto" }}
              onChange={async (e) => { await saveSettings({ shotSeconds: Number(e.target.value) }); run("render"); }}>
              <option value="0">Whole clip ({data.settings.clipSeconds}s)</option>
              {[1.5, 2, 2.5, 3, 4, 5].filter((v) => v < data.settings.clipSeconds).map((v) => <option key={v} value={v}>{v}s per shot</option>)}
            </select>
            <span className="muted">Shorter = faster cuts, re-render is free.</span>
          </div>
          <p className="muted small">Changed the hook, end card or dialogue in the story? Save it, then press Re-render (free).</p>
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
  const recipe = data.settings.kind === "recipe";
  const narrator = data.settings.narrator || "";
  const onNarrator = async (v: string) => {
    await postJson(`/api/projects/${data.id}`, { settings: { narrator: v } }, "PATCH").catch((e) => setMsg(e.message));
    reload();
  };
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
          <div className="field"><label>End card (last seconds — sends viewers to the full story)</label><input type="text" value={draft.end_text ?? ""} onChange={(e) => edit({ end_text: e.target.value })} placeholder="What happened next? Full story in the comments 👇" /></div>
          {recipe && (
            <div className="field">
              <label>Voice-over (spoken over the whole reel, leave empty for none)</label>
              <textarea rows={3} value={draft.voiceover ?? ""} onChange={(e) => edit({ voiceover: e.target.value || null })}
                placeholder="Narration in the reel language" />
              <div className="row" style={{ gap: 8, marginTop: 6 }}>
                <span className="muted small">Narrator voice</span>
                <select style={{ width: "auto" }} value={narrator} onChange={(e) => onNarrator(e.target.value)}>
                  <option value="">Jessica (default)</option>
                  {ALL_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            </div>
          )}
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
                <label>Voice (when dubbed)</label>
                <select value={c.voice ?? ""} onChange={(e) => editChar(i, { voice: e.target.value })}>
                  <option value="">Auto ({voiceMap({ characters: draft.characters.map((x) => (x.key === c.key ? { ...x, voice: null } : x)) }).get(c.key)}{voiceNote(c)})</option>
                  {ALL_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
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
                <label>Spoken line (optional) and who says it</label>
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <select value={sc.speaker ?? ""} style={{ width: 150, flex: "none" }}
                    onChange={(e) => editScene(i, { speaker: e.target.value || null, characters: e.target.value && !sc.characters.includes(e.target.value) ? [...sc.characters, e.target.value] : sc.characters })}>
                    <option value="">— speaker —</option>
                    {draft.characters.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                  </select>
                  <input type="text" value={sc.dialogue ?? ""} onChange={(e) => editScene(i, { dialogue: e.target.value || null })} />
                </div>
                {sc.dialogue && !sc.speaker && <span className="small" style={{ color: "var(--warn)" }}>Choose who says this line, or the video may give it to the wrong person.</span>}
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


/** Use your own image (made in ChatGPT, a photo…) instead of generating one. */
function UploadButton(props: { projectId: string; kind: "character" | "frame"; refKey: string; disabled?: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <label className="btn" style={{ justifyContent: "center", cursor: "pointer", opacity: props.disabled || busy ? 0.5 : 1 }}>
      {busy ? "Uploading…" : "Upload my image (free)"}
      <input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: "none" }} disabled={props.disabled || busy}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setBusy(true);
          const fd = new FormData();
          fd.set("kind", props.kind);
          fd.set("ref", props.refKey);
          fd.set("image", f);
          try {
            await api(`/api/projects/${props.projectId}/upload`, { method: "POST", body: fd });
            props.onDone();
          } catch (err: any) {
            alert(err.message);
          } finally {
            setBusy(false);
            e.target.value = "";
          }
        }} />
    </label>
  );
}


function CopyButton({ text, label = "📋 Copy prompt for ChatGPT" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const t = document.createElement("textarea");
        t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove();
      }
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    }}>{done ? "✓ Copied" : label}</button>
  );
}
