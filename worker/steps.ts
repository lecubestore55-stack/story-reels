import path from "node:path";
import { one, q } from "../lib/db";
import { IMAGE_TIERS, LOOKS, VIDEO_MODELS } from "../lib/config";
import { abs, downloadTo } from "../lib/storage";
import { enqueue } from "../lib/jobs";
import { analyzeReference } from "../lib/ai/gemini";
import { writeStory } from "../lib/ai/claude";
import { falError, firstImageUrl, run, submit, uploadLocal, videoUrl, waitFor } from "../lib/ai/fal";
import { renderReel } from "../lib/ffmpeg";
import { detectShots } from "../lib/shots";
import type { Analysis, Story, StoryCharacter, StoryScene } from "../lib/types";
import {
  RetryLater, addCost, removeFile, getAsset, getAssets, getProject, pool, requireStory, setProject, upsertAsset, type ProjectRow,
} from "./shared";

const stamp = () => Date.now().toString(36);

// ---------------------------------------------------------------- analyze
export async function analyzeStep(referenceId: string) {
  const ref = await one(`SELECT * FROM story_references WHERE id=$1`, [referenceId]);
  if (!ref) throw new Error("Reference not found");
  await q(`UPDATE story_references SET status='analyzing', error=NULL, updated_at=now() WHERE id=$1`, [referenceId]);
  try {
    const ext = path.extname(ref.video_path).toLowerCase();
    const mime = ext === ".mov" ? "video/quicktime" : ext === ".webm" ? "video/webm" : "video/mp4";
    const { analysis, cost } = await analyzeReference(ref.video_path, abs(ref.video_path), ref.notes, mime);
    // Count the real cuts with ffmpeg (more reliable than the AI's guess).
    try {
      (analysis as any).shots = await detectShots(abs(ref.video_path));
    } catch (e: any) {
      console.warn("shot detection failed:", e?.message);
    }
    await q(
      `UPDATE story_references SET status='ready', analysis=$2, cost_usd=cost_usd+$3, updated_at=now() WHERE id=$1`,
      [referenceId, JSON.stringify(analysis), cost],
    );
  } catch (e: any) {
    await q(`UPDATE story_references SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [referenceId, e.message]);
    throw e;
  }
}

// ---------------------------------------------------------------- write
export async function writeStep(projectId: string, payload: { feedback?: string }) {
  const p = await getProject(projectId);
  const ref = await one(`SELECT status, analysis, notes FROM story_references WHERE id=$1`, [p.reference_id]);
  if (!ref) throw new Error("Reference not found");
  if (ref.status === "failed") throw new Error("The reference video analysis failed. Re-run the analysis first.");
  if (ref.status !== "ready") throw new RetryLater(10, "Waiting for the reference analysis");
  // Write stories from the same reference one at a time, so each sees the others and stays different.
  const busy = await one(
    `SELECT 1 FROM jobs j JOIN projects o ON o.id=j.project_id
      WHERE j.type='write' AND j.status='running' AND o.reference_id=$1 AND o.id<>$2 AND o.created_at < $3`,
    [p.reference_id, projectId, (p as any).created_at],
  );
  if (busy) throw new RetryLater(5, "Waiting for another story from the same reference");

  await setProject(projectId, { status: "writing", error: null });
  const siblings = await q(
    `SELECT story->>'logline' AS logline FROM projects WHERE reference_id=$1 AND id<>$2 AND story IS NOT NULL`,
    [p.reference_id, projectId],
  );
  const { story, cost } = await writeStory({
    analysis: ref.analysis as Analysis,
    notes: ref.notes,
    settings: p.settings,
    avoid: siblings.map((s) => s.logline).filter(Boolean),
    feedback: payload.feedback,
    previous: payload.feedback ? p.story : null,
  });
  if (cost) await addCost(projectId, cost);
  await setProject(projectId, { story, title: story.title, status: "story_review" });
  if (p.settings.autoRun) await enqueue("characters", { projectId });
}

// ---------------------------------------------------------------- characters
function characterPrompt(c: StoryCharacter) {
  return (
    `Photorealistic casting photo of an actor for a TV drama. Three-quarter body, standing, facing the camera, calm natural expression, ` +
    `plain soft grey background, soft window light, 85mm lens, sharp focus on the face. ${c.visual}. ` +
    `Ordinary real person, not a model: real skin texture with pores, natural hair, believable clothes. ` +
    `Unedited photo, muted natural colors, no retouching, no plastic skin, no CGI look. No text, no logo, no watermark.`
  );
}

export async function charactersStep(projectId: string, payload: { only?: string; note?: string }) {
  const p = await getProject(projectId);
  const story = requireStory(p);
  await setProject(projectId, { status: "characters", error: null });
  const list = story.characters.filter((c) => !payload.only || c.key === payload.only);
  const tier = IMAGE_TIERS[p.settings.imageTier];

  const errors = await pool(list, 3, async (c) => {
    const prompt = characterPrompt(c) + (payload.note ? ` ${payload.note}` : "");
    await upsertAsset(projectId, "character", c.key, { status: "generating", error: null, prompt, fal_endpoint: tier.textToImage });
    try {
      const out = await run(tier.textToImage, tier.buildInput({ prompt, aspect: "3:4" }));
      const url = firstImageUrl(out);
      const rel = `projects/${projectId}/characters/${c.key}_${stamp()}.png`;
      await downloadTo(url, rel);
      await addCost(projectId, tier.priceUsd);
      await upsertAsset(projectId, "character", c.key, { status: "ready", path: rel, remote_url: url });
    } catch (e) {
      const msg = `${c.name}: ${falError(e)}`;
      await upsertAsset(projectId, "character", c.key, { status: "failed", error: msg });
      throw new Error(msg);
    }
  });
  if (errors.length) throw new Error(errors.join("\n"));

  await setProject(projectId, { status: "characters_review" });
  if (p.settings.autoRun && !payload.only) await enqueue("frames", { projectId });
}


// ---------------------------------------------------------------- safety retries
// Image/video models (especially with children in frame) refuse tense family scenes.
// When that happens we retry automatically with calmer wording, another model, and finally
// with the children left out of that one image.
const isPolicyError = (msg: string) => /content_policy|flagged|moderat|safety|not allowed|violat/i.test(msg);

const SOFTEN: [RegExp, string][] = [
  [/\btear[- ]?(filled|streaked|stained)\s+eyes\b/gi, "sad eyes"],
  [/\blips\s+(trembling|quivering)\b/gi, "lips pressed together"],
  [/\b(to\s+)?silence\s+(her|him)\b/gi, "to interrupt"],
  [/\b(at\s+)?floor[- ]level\b/gi, "at eye level"],
  [/\b(tear[- ]?(filled|streaked|stained)|tears?|tearful(ly)?|crying|cries|cry|sobbing|sobs?|weeping)\b/gi, "sad expression"],
  [/\b(trembling|shaking|shakes|quivering)\b/gi, "serious"],
  [/\b(terrified|scared|afraid|fear(ful)?|frightened|panic(ked)?)\b/gi, "worried"],
  [/\b(shout(s|ing|ed)?|scream(s|ing|ed)?|yell(s|ing|ed)?)\b/gi, "speaks firmly"],
  [/\b(lunge(s|d)?|lunging|charge(s|d)?|grab(s|bed|bing)?|shove(s|d)?|push(es|ed)?\s+(her|him))(\s+forward)?\b/gi, "steps forward"],
  [/\b(starv(ed|ing|e)|hungry|scraps|leftovers?|trash( can)?|garbage( can)?|bin)\b/gi, "simple plate"],
  [/\b(abuse(d|r|s)?|abusive|cruel(ty)?|mistreat(ed|ment)?|neglect(ed)?|punish(ed|ment)?)\b/gi, "tension"],
  [/\b(hit(s|ting)?|slap(s|ped)?|attack(s|ed)?|fight(s|ing)?|tackle(s|d)?|violent(ly)?|violence)\b/gi, "confrontation"],
  [/\b(on the floor|floor level|on the ground)\b/gi, "in the room"],
];

export function soften(text: string): string {
  let out = text;
  for (const [re, rep] of SOFTEN) out = out.replace(re, rep);
  return out + "\nCalm, family-friendly drama: everyone is safe and unharmed, no distress, no violence.";
}

const isChild = (c: StoryCharacter) =>
  /\b(child|kid|girl|boy|daughter|son|toddler|baby|little)\b/i.test(`${c.role} ${c.visual}`) ||
  /\b([1-9]|1[0-2])[- ]?(year|yr)s?[- ]?old\b/i.test(c.visual);

// ---------------------------------------------------------------- frames
function framePrompt(p: ProjectRow, scene: StoryScene, refs: StoryCharacter[]) {
  const story = requireStory(p);
  const people = refs.length
    ? `\nCharacters — keep each person's face, hair, skin tone, body and outfit exactly as in their reference image:\n` +
      refs.map((c, i) => `- Reference image ${i + 1}: ${c.name} (${c.role}) — ${c.visual}`).join("\n")
    : "";
  return (
    `Create a photorealistic vertical 9:16 cinematic film still. It is the first frame of a video shot.\n` +
    `Setting: ${story.setting}\nShot: ${scene.frame_prompt}${people}\n` +
    `${LOOKS[p.settings.look].prompt}\nNo text, no captions, no watermark, no split screen.`
  );
}

async function freshUrl(rel: string) {
  // fal media URLs can expire, so re-upload our stored copy each time we feed it to a model.
  return uploadLocal(rel);
}

export async function framesStep(projectId: string, payload: { only?: number; note?: string }) {
  const p = await getProject(projectId);
  const story = requireStory(p);
  const chars = await getAssets(projectId, "character");
  const byKey = new Map(chars.filter((a) => a.status === "ready" && a.path).map((a) => [a.ref, a]));
  const missing = story.characters.filter((c) => !byKey.has(c.key));
  if (missing.length) throw new Error(`Generate the character images first (missing: ${missing.map((c) => c.name).join(", ")})`);

  await setProject(projectId, { status: "frames", error: null });
  const scenes = story.scenes.filter((s) => payload.only === undefined || s.index === payload.only);
  const tier = IMAGE_TIERS[p.settings.imageTier];
  const refUrls = new Map<string, string>();
  for (const c of story.characters) refUrls.set(c.key, await freshUrl(byKey.get(c.key)!.path!));

  const errors = await pool(scenes, 3, async (scene) => {
    const allRefs = story.characters.filter((c) => scene.characters.includes(c.key));
    const note = payload.note ? `\nExtra direction: ${payload.note}` : "";
    const ref = String(scene.index);
    const others = Object.values(IMAGE_TIERS).filter((t) => t.id !== tier.id);
    const adults = allRefs.filter((c) => !isChild(c));
    const noKidsScene = { ...scene, frame_prompt: scene.frame_prompt + " Only the adults are in this shot; any child is out of frame." };

    // Attempts, cheapest and most faithful first: same model, calmer words, other models, then no kids in frame.
    const attempts: { refs: StoryCharacter[]; prompt: string; tier: typeof tier }[] = [
      { refs: allRefs, prompt: framePrompt(p, scene, allRefs) + note, tier },
      { refs: allRefs, prompt: soften(framePrompt(p, scene, allRefs) + note), tier },
      ...others.map((t) => ({ refs: allRefs, prompt: soften(framePrompt(p, scene, allRefs) + note), tier: t })),
    ];
    if (adults.length && adults.length < allRefs.length) {
      attempts.push({ refs: adults, prompt: soften(framePrompt(p, noKidsScene, adults) + note), tier });
    }

    await upsertAsset(projectId, "frame", ref, { status: "generating", error: null, prompt: attempts[0].prompt, fal_endpoint: tier.edit });
    let lastMsg = "";
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      const endpoint = a.refs.length ? a.tier.edit : a.tier.textToImage;
      try {
        const imageUrls = a.refs.map((c) => refUrls.get(c.key)!).filter(Boolean);
        const url = firstImageUrl(await run(endpoint, a.tier.buildInput({ prompt: a.prompt, aspect: "9:16", imageUrls })));
        const rel = `projects/${projectId}/frames/scene${scene.index}_${stamp()}.png`;
        await downloadTo(url, rel);
        await addCost(projectId, a.tier.priceUsd);
        await upsertAsset(projectId, "frame", ref, {
          status: "ready", path: rel, remote_url: url, prompt: a.prompt, fal_endpoint: endpoint,
          error: i > 0 ? `Note: the first try was blocked by the safety filter; made with a calmer version (attempt ${i + 1}).` : null,
        });
        return;
      } catch (e) {
        lastMsg = falError(e);
        if (!isPolicyError(lastMsg)) break; // a real error: don't keep retrying
        console.warn(`Scene ${scene.index + 1} frame blocked by safety filter (attempt ${i + 1}/${attempts.length})`);
      }
    }
    const msg = `Scene ${scene.index + 1}: ${isPolicyError(lastMsg)
      ? "blocked by the image model's safety filter even after calmer retries. Edit this scene's start frame (less distress, or uncheck the child) and regenerate."
      : lastMsg}`;
    await upsertAsset(projectId, "frame", ref, { status: "failed", error: msg });
    throw new Error(msg);
  });
  if (errors.length) throw new Error(errors.join("\n"));

  await setProject(projectId, { status: "frames_review" });
  if (p.settings.autoRun && payload.only === undefined) await enqueue("clips", { projectId });
}

// ---------------------------------------------------------------- clips
function shortLook(visual: string) {
  return visual.split(/[.;]/)[0].slice(0, 140);
}

export function motionPrompt(scene: StoryScene, story?: Story | null) {
  let line = "";
  if (scene.dialogue) {
    const sp = story?.characters.find((c) => c.key === scene.speaker);
    if (sp) {
      const others = story!.characters.filter((c) => c.key !== sp.key && scene.characters.includes(c.key));
      line =
        ` DIALOGUE — only ${sp.name} (${shortLook(sp.visual)}) speaks, facing the camera with clear lip movement, saying: "${scene.dialogue}".` +
        (others.length ? ` ${others.map((c) => c.name).join(" and ")} stay silent with mouths closed and only react.` : "");
    } else {
      line = ` One person speaks, saying: "${scene.dialogue}". Everyone else stays silent.`;
    }
  }
  return (
    `${scene.motion_prompt}${line} Realistic natural human motion and expressions, faces and clothing stay consistent ` +
    `with the first frame, vertical framing, cinematic but believable. No on-screen text or subtitles.`
  );
}

export async function clipsStep(projectId: string, payload: { only?: number }) {
  const p = await getProject(projectId);
  const story = requireStory(p);
  const model = VIDEO_MODELS[p.settings.videoModel];
  const frames = new Map((await getAssets(projectId, "frame")).filter((a) => a.status === "ready" && a.path).map((a) => [a.ref, a]));
  const scenes = story.scenes.filter((s) => payload.only === undefined || s.index === payload.only);
  const missing = scenes.filter((s) => !frames.has(String(s.index)));
  if (missing.length) throw new Error(`Generate the start frames first (missing scenes: ${missing.map((s) => s.index + 1).join(", ")})`);

  await setProject(projectId, { status: "clips", error: null });
  const seconds = model.snapSeconds(p.settings.clipSeconds);

  const errors = await pool(scenes, 4, async (scene) => {
    const ref = String(scene.index);
    let asset = await getAsset(projectId, "clip", ref);
    let endpoint = model.endpoint;
    let requestId: string;
    // Resume a request that was already paid for if the worker restarted mid-generation.
    if (asset?.status === "generating" && asset.fal_request_id && asset.fal_endpoint) {
      requestId = asset.fal_request_id;
      endpoint = asset.fal_endpoint;
    } else {
      const prompt = motionPrompt(scene, story);
      const imageUrl = await freshUrl(frames.get(ref)!.path!);
      const input = model.buildInput({ prompt, imageUrl, seconds, audio: p.settings.audio });
      try {
        requestId = await submit(endpoint, input);
      } catch (e) {
        const msg = `Scene ${scene.index + 1}: ${falError(e)}`;
        await upsertAsset(projectId, "clip", ref, { status: "failed", error: msg });
        throw new Error(msg);
      }
      await upsertAsset(projectId, "clip", ref, {
        status: "generating", error: null, prompt, fal_endpoint: endpoint, fal_request_id: requestId,
      });
      await addCost(projectId, seconds * model.pricePerSecond(p.settings.audio));
    }
    try {
      let out: any;
      try {
        out = await waitFor(endpoint, requestId);
      } catch (e) {
        if (!isPolicyError(falError(e))) throw e;
        // Blocked by the video model's safety filter: one retry with calmer wording.
        console.warn(`Scene ${scene.index + 1} clip blocked by safety filter, retrying with calmer prompt`);
        const prompt = soften(motionPrompt(scene, story));
        const imageUrl = await freshUrl(frames.get(ref)!.path!);
        requestId = await submit(endpoint, model.buildInput({ prompt, imageUrl, seconds, audio: p.settings.audio }));
        await upsertAsset(projectId, "clip", ref, { status: "generating", prompt, fal_endpoint: endpoint, fal_request_id: requestId });
        await addCost(projectId, seconds * model.pricePerSecond(p.settings.audio));
        out = await waitFor(endpoint, requestId);
      }
      const url = videoUrl(out);
      const rel = `projects/${projectId}/clips/scene${scene.index}_${stamp()}.mp4`;
      await downloadTo(url, rel);
      await upsertAsset(projectId, "clip", ref, { status: "ready", path: rel, remote_url: url, fal_request_id: null });
    } catch (e) {
      const msg = `Scene ${scene.index + 1}: ${falError(e)}`;
      await upsertAsset(projectId, "clip", ref, { status: "failed", error: msg, fal_request_id: null });
      throw new Error(msg);
    }
  });
  if (errors.length) throw new Error(errors.join("\n"));

  // Rendering is free and fast, so always rebuild the reel after new clips.
  await enqueue("render", { projectId });
}

// ---------------------------------------------------------------- render
export async function renderStep(projectId: string) {
  const p = await getProject(projectId);
  const story = requireStory(p);
  const clips = new Map((await getAssets(projectId, "clip")).filter((a) => a.status === "ready" && a.path).map((a) => [a.ref, a]));
  const missing = story.scenes.filter((s) => !clips.has(String(s.index)));
  if (missing.length) throw new Error(`Some clips are not ready (scenes: ${missing.map((s) => s.index + 1).join(", ")})`);

  await setProject(projectId, { status: "rendering", error: null });
  const rel = `projects/${projectId}/final_${stamp()}.mp4`;
  await renderReel({
    clips: story.scenes.map((s) => abs(clips.get(String(s.index))!.path!)),
    output: abs(rel),
    hookText: p.settings.hookText ? story.hook_text : null,
    subtitles: p.settings.subtitles ? story.scenes.map((s) => s.dialogue ?? null) : undefined,
    shotSeconds: p.settings.shotSeconds || undefined,
    endText: p.settings.endCard ? story.end_text || "What happened next? Full story in the comments 👇" : null,
    music: p.music_path ? abs(p.music_path) : null,
    workDir: abs(`projects/${projectId}/tmp`),
  });
  await setProject(projectId, { status: "done", final_path: rel });
  await removeFile(p.final_path);
}
