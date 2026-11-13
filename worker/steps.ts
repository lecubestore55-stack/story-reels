import path from "node:path";
import { one, q } from "../lib/db";
import { IMAGE_TIERS, VIDEO_MODELS } from "../lib/config";
import { abs, downloadTo } from "../lib/storage";
import { enqueue } from "../lib/jobs";
import { analyzeReference } from "../lib/ai/gemini";
import { writeStory } from "../lib/ai/claude";
import { falError, firstImageUrl, run, submit, uploadLocal, videoUrl, waitFor } from "../lib/ai/fal";
import { renderReel } from "../lib/ffmpeg";
import type { Analysis, StoryCharacter, StoryScene } from "../lib/types";
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
    `Photorealistic character reference photo for a film. Full body, standing, facing the camera, calm expression, ` +
    `plain light grey studio background, soft even lighting, sharp focus. ${c.visual}. ` +
    `Ordinary real person, natural skin texture. No text, no logo, no watermark.`
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
      const out = await run(tier.textToImage, { prompt, aspect_ratio: "3:4", num_images: 1, output_format: "png" });
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
    `Natural light, realistic skin and fabric, believable home or street photography look, no text, no captions, no watermark.`
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
    const refs = story.characters.filter((c) => scene.characters.includes(c.key));
    const prompt = framePrompt(p, scene, refs) + (payload.note ? `\nExtra direction: ${payload.note}` : "");
    const endpoint = refs.length ? tier.edit : tier.textToImage;
    const ref = String(scene.index);
    await upsertAsset(projectId, "frame", ref, { status: "generating", error: null, prompt, fal_endpoint: endpoint });
    try {
      const input: Record<string, unknown> = { prompt, aspect_ratio: "9:16", num_images: 1, output_format: "png" };
      if (refs.length) input.image_urls = refs.map((c) => refUrls.get(c.key));
      const url = firstImageUrl(await run(endpoint, input));
      const rel = `projects/${projectId}/frames/scene${scene.index}_${stamp()}.png`;
      await downloadTo(url, rel);
      await addCost(projectId, tier.priceUsd);
      await upsertAsset(projectId, "frame", ref, { status: "ready", path: rel, remote_url: url });
    } catch (e) {
      const msg = `Scene ${scene.index + 1}: ${falError(e)}`;
      await upsertAsset(projectId, "frame", ref, { status: "failed", error: msg });
      throw new Error(msg);
    }
  });
  if (errors.length) throw new Error(errors.join("\n"));

  await setProject(projectId, { status: "frames_review" });
  if (p.settings.autoRun && payload.only === undefined) await enqueue("clips", { projectId });
}

// ---------------------------------------------------------------- clips
function motionPrompt(scene: StoryScene) {
  const line = scene.dialogue ? ` Spoken line, said naturally: "${scene.dialogue}".` : "";
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
      const prompt = motionPrompt(scene);
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
      const out = await waitFor(endpoint, requestId);
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
    endText: p.settings.endCard ? story.end_text || "What happened next? Full story in the comments 👇" : null,
    music: p.music_path ? abs(p.music_path) : null,
    workDir: abs(`projects/${projectId}/tmp`),
  });
  await setProject(projectId, { status: "done", final_path: rel });
  await removeFile(p.final_path);
}
