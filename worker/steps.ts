import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { one, q } from "../lib/db";
import {
  IMAGE_TIERS, LIPSYNC_ENDPOINT, LIPSYNC_PRICE_PER_SECOND, LOOKS,
  TTS_ENDPOINT, TTS_PRICE_PER_CHAR, LIPSYNC_FALLBACK, LIPSYNC_MODEL, STEMS_ENDPOINT, STEMS_PRICE_PER_SECOND, VIDEO_MODELS, languageCode, useDub, type ProjectSettings,
} from "../lib/config";
import { abs, downloadTo } from "../lib/storage";
import { enqueue } from "../lib/jobs";
import { analyzeReference } from "../lib/ai/gemini";
import { ensureEnglish, needsEnglish, softenLine, writeStory } from "../lib/ai/claude";
import { falError, firstImageUrl, run, submit, uploadLocal, videoUrl, waitFor } from "../lib/ai/fal";
import { extractAudio, fitVoice, mixAudio, probe, renderReel, replaceAudio } from "../lib/ffmpeg";
import { detectShots } from "../lib/shots";
import { childPitch, voiceMap } from "../lib/voices";
import type { Analysis, Story, StoryCharacter, StoryScene } from "../lib/types";
import {
  RetryLater, addCost, removeFile, getAsset, getAssets, getProject, pool, requireStory, setProject, upsertAsset, type ProjectRow,
} from "./shared";

const stamp = () => Date.now().toString(36);

/** Older stories (or a writer that ignored the rule) may have production fields in Romanian/Polish: translate them once. */
async function englishStory(projectId: string, p: ProjectRow): Promise<Story> {
  const story = requireStory(p);
  if (!needsEnglish(story)) return story;
  const { story: fixed, cost } = await ensureEnglish(story);
  if (cost) await addCost(projectId, cost);
  await setProject(projectId, { story: fixed });
  p.story = fixed;
  return fixed;
}

// ---------------------------------------------------------------- analyze
export async function analyzeStep(referenceId: string) {
  const ref = await one(`SELECT * FROM story_references WHERE id=$1`, [referenceId]);
  if (!ref) throw new Error("Reference not found");
  await q(`UPDATE story_references SET status='analyzing', error=NULL, updated_at=now() WHERE id=$1`, [referenceId]);
  try {
    const ext = path.extname(ref.video_path).toLowerCase();
    const mime = ext === ".mov" ? "video/quicktime" : ext === ".webm" ? "video/webm" : "video/mp4";
    const { analysis, cost } = await analyzeReference(ref.video_path, abs(ref.video_path), ref.notes, mime, ref.kind === "recipe" ? "recipe" : "story");
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
  const ref = await one(`SELECT status, analysis, notes, kind, video_path FROM story_references WHERE id=$1`, [p.reference_id]);
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
    photo: ref.kind === "source" ? abs(ref.video_path) : null,
  });
  if (cost) await addCost(projectId, cost);
  await setProject(projectId, { story, title: story.title, status: "story_review" });
  if (p.settings.autoRun) await enqueue("characters", { projectId });
}

// ---------------------------------------------------------------- characters
function characterPrompt(c: StoryCharacter) {
  if (c.role === "dish") {
    return (
      `Photorealistic close-up food photo of a homemade dish just out of the oven, vertical 9:16. CLOSE framing: the dish fills ` +
      `85% of the frame, camera at 45 degrees, almost no background (only a blurred hint of the kitchen at the very top). ` +
      `${c.visual}. Every item keeps its real recognizable shape. One portion already scooped out so the inside and the sauce ` +
      `are visible, a little steam rising. Soft natural window light, shallow depth of field. Real food with real textures, ` +
      `appetizing, generous, slightly messy homemade look, not plastic, not CGI, not overly styled. ` +
      `No people, no text, no logo, no brand packaging, no watermark.`
    );
  }
  return (
    `Photorealistic casting photo of an actor for a TV drama. Three-quarter body, standing, facing the camera, calm natural expression, ` +
    `plain soft grey background, soft window light, 85mm lens, sharp focus on the face. ${c.visual}. ` +
    `Ordinary real person, not a model: real skin texture with pores, natural hair, believable clothes. ` +
    `Unedited photo, muted natural colors, no retouching, no plastic skin, no CGI look. No text, no logo, no watermark.`
  );
}

export async function charactersStep(projectId: string, payload: { only?: string; note?: string }) {
  const p = await getProject(projectId);
  const story = await englishStory(projectId, p);
  await setProject(projectId, { status: "characters", error: null });
  let list = story.characters.filter((c) => !payload.only || c.key === payload.only);
  const tier = IMAGE_TIERS[p.settings.imageTier];

  // Own recipe: the blog photo IS the dish reference (unless the user asks to regenerate it).
  const src = await one(`SELECT kind, video_path FROM story_references WHERE id=$1`, [p.reference_id]);
  if (src?.kind === "source" && !payload.only && !payload.note) {
    for (const c of list.filter((x) => x.role === "dish")) {
      const rel = `projects/${projectId}/characters/${c.key}_${stamp()}${path.extname(src.video_path) || ".jpg"}`;
      await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
      await fs.copyFile(abs(src.video_path), abs(rel));
      await upsertAsset(projectId, "character", c.key, {
        status: "ready", path: rel, remote_url: null, prompt: "Photo from the recipe page", fal_endpoint: null, error: null,
      });
    }
    list = list.filter((x) => x.role !== "dish");
  }

  const errors = await pool(list, 3, async (c) => {
    const base = characterPrompt(c) + (payload.note ? ` ${payload.note}` : "");
    // Children's portraits get an explicitly wholesome framing; blocked prompts are retried calmer and on other models.
    const kid = isChild(c) ? " Wholesome family photo of a happy, healthy, well-cared-for child, fully dressed, standing next to nothing dangerous." : "";
    const fallbackOrder = ["flux2-pro", "gpt-image", "seedream-pro", "seedream", "standard", "nano-pro", "lite"];
    const others = fallbackOrder.map((id) => IMAGE_TIERS[id as keyof typeof IMAGE_TIERS]).filter((t) => t && t.id !== tier.id).slice(0, 2);
    const attempts = [
      { prompt: base, tier },
      { prompt: soften(base) + kid, tier },
      ...others.map((t) => ({ prompt: soften(base) + kid, tier: t })),
    ];
    await upsertAsset(projectId, "character", c.key, { status: "generating", error: null, prompt: base, fal_endpoint: tier.textToImage });
    let lastMsg = "";
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      try {
        const out = await run(a.tier.textToImage, a.tier.buildInput({ prompt: a.prompt, aspect: "3:4" }));
        const url = firstImageUrl(out);
        const rel = `projects/${projectId}/characters/${c.key}_${stamp()}.png`;
        await downloadTo(url, rel);
        await addCost(projectId, a.tier.priceUsd);
        await upsertAsset(projectId, "character", c.key, {
          status: "ready", path: rel, remote_url: url, prompt: a.prompt, fal_endpoint: a.tier.textToImage,
          error: i > 0 ? `Note: first try was blocked by the safety filter; made on attempt ${i + 1}.` : null,
        });
        return;
      } catch (e) {
        lastMsg = falError(e);
        if (!isPolicyError(lastMsg)) break;
        console.warn(`Character ${c.name} blocked by safety filter (attempt ${i + 1}/${attempts.length})`);
      }
    }
    const msg = `${c.name}: ${isPolicyError(lastMsg)
      ? "blocked by the image safety filter even after calmer retries. Edit this character's look (neutral words, in English) and regenerate."
      : lastMsg.slice(0, 400)}`;
    await upsertAsset(projectId, "character", c.key, { status: "failed", error: msg });
    throw new Error(msg);
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
  if (p.settings.kind === "recipe") {
    const dish = refs.find((c) => c.role === "dish");
    if (!dish) {
      // A cooking STEP: the finished dish must not appear (otherwise the model pastes the final plate everywhere).
      return (
        `Create a photorealistic vertical 9:16 close-up cooking video still for a recipe reel. It is the FIRST frame of the shot: ` +
        `the moment just before the action.\nKitchen: ${story.setting}\nShot: ${scene.frame_prompt}\n` +
        `This is a preparation step: show ONLY the ingredients and cookware in their state at this step (raw, cooking or ` +
        `unbaked as described). The finished, plated dish is NOT in this image — no plate of finished food anywhere. ` +
        `CLOSE framing: the food fills 85% of the vertical frame, camera at 45 degrees, almost no background. Real textures, ` +
        `soft natural light, shallow depth of field. Only hands may appear, no faces. ` +
        `No text, no captions, no logo, no brand packaging, no watermark.`
      );
    }
    return (
      `Create a photorealistic vertical 9:16 close-up food video still for a recipe reel. It is the FIRST frame of the shot: ` +
      `the moment just before the action (the utensil is resting or just touching the food, nothing is lifted yet).\n` +
      `Kitchen: ${story.setting}\nShot: ${scene.frame_prompt}\n` +
      (dish ? `The dish must look exactly like the reference image: ${dish.visual}\n` : "") +
      `CLOSE framing: the food fills 85% of the vertical frame, camera at 45 degrees, almost no background. ` +
      `Every item keeps its real recognizable shape. Appetizing real textures, slightly messy homemade look, soft natural light, ` +
      `shallow depth of field. Only hands may appear, no faces. No text, no captions, no logo, no brand packaging, no watermark.`
    );
  }
  const people = refs.length
    ? `\nCharacters — keep each person's face, hair, skin tone, body and outfit exactly as in their reference image:\n` +
      refs.map((c, i) => `- Reference image ${i + 1}: ${c.name} (${c.role}) — ${c.visual}`).join("\n")
    : "";
  return (
    `Create a photorealistic vertical 9:16 cinematic film still. It is the FIRST frame of a video shot: show the ` +
    `moment just before the action starts (the action will happen in the video). Everyone stands, sits or moves ` +
    `naturally with their feet on the ground; no one frozen mid-air, no motion blur.\n` +
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
  const story = await englishStory(projectId, p);
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
    // When a Google model blocks a scene, the permissive FLUX/Seedream models are tried first.
    const fallbackOrder = ["flux2-pro", "gpt-image", "seedream-pro", "seedream", "standard", "nano-pro", "lite"];
    const others = fallbackOrder.map((id) => IMAGE_TIERS[id as keyof typeof IMAGE_TIERS]).filter((t) => t && t.id !== tier.id).slice(0, 2);
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

export function motionPrompt(scene: StoryScene, story?: Story | null, opts: { language?: string; dub?: boolean } = {}) {
  let line = "";
  if (scene.dialogue) {
    const sp = story?.characters.find((c) => c.key === scene.speaker);
    const others = sp ? story!.characters.filter((c) => c.key !== sp.key && scene.characters.includes(c.key)) : [];
    const quiet = others.length ? ` ${others.map((c) => c.name).join(" and ")} ${others.length > 1 ? "stay" : "stays"} silent with ${others.length > 1 ? "mouths" : "mouth"} closed and only ${others.length > 1 ? "react" : "reacts"}.` : "";
    const who = sp ? `${sp.name} (${shortLook(sp.visual)})` : "one person";
    if (opts.dub) {
      // The voice is added afterwards (TTS + lip sync): just keep the speaker's face clear and talking.
      line = ` ${who} is talking: face clearly visible to the camera, natural lip movement, no other sound.${quiet}`;
    } else {
      const lang = opts.language && !/^english/i.test(opts.language) ? ` in ${opts.language}` : "";
      line = ` DIALOGUE — only ${who} speaks${lang}, facing the camera with clear lip movement, saying: "${scene.dialogue}".${quiet}`;
    }
  }
  const recipe = story?.characters.some((c) => c.role === "dish");
  if (recipe) {
    return (
      `${scene.motion_prompt} Slow, smooth and satisfying, real food physics (soft layers, crumbs, creamy texture), ` +
      `the camera stays close on the food with a gentle push-in. Only the cook's hands, no faces. No voice, no talking, ` +
      `no music; only natural kitchen sounds (utensil, plate, crunch). No on-screen text.`
    );
  }
  if (!scene.dialogue) {
    // No line in this scene: stop the model from making someone talk (it otherwise invents English speech).
    line = " Nobody speaks in this shot: mouths stay closed, only facial expressions and body language.";
  }
  return (
    `${scene.motion_prompt}${line} Realistic natural human motion and expressions, faces and clothing stay consistent ` +
    `with the first frame, vertical framing, cinematic but believable. No on-screen text or subtitles.`
  );
}

// ---------------------------------------------------------------- voices (dubbing)
/** Say the scene's line with ElevenLabs in the story language and lip-sync the clip to it. */
async function saveDialogue(projectId: string, index: number, dialogue: string) {
  const fresh = await getProject(projectId);
  if (!fresh.story) return;
  const story = structuredClone(fresh.story) as Story;
  const sc = story.scenes.find((x) => x.index === index);
  if (sc) sc.dialogue = dialogue;
  await setProject(projectId, { story });
}

async function dubClip(
  projectId: string, settings: ProjectSettings, story: Story, scene: StoryScene, clipRel: string, effects: string | null,
): Promise<string> {
  const voice = voiceMap(story).get(scene.speaker || "") || "Sarah";
  let text = scene.dialogue!.trim();
  const code = languageCode(settings.language);
  // Several ElevenLabs models on fal: if one's content checker refuses, the next may accept.
  const engines: { endpoint: string; input: (t: string) => Record<string, unknown> }[] = [
    { endpoint: TTS_ENDPOINT, input: (t) => ({ text: t, voice, language_code: code, stability: 0.5 }) },
    { endpoint: "fal-ai/elevenlabs/tts/turbo-v2.5", input: (t) => ({ text: t, voice, language_code: code, stability: 0.5 }) },
    { endpoint: "fal-ai/elevenlabs/tts/multilingual-v2", input: (t) => ({ text: t, voice, stability: 0.5 }) },
  ];
  const sayAll = async (t: string) => {
    let last: unknown;
    for (const e of engines) {
      try {
        return await run(e.endpoint, e.input(t));
      } catch (err) {
        last = err;
        if (!isPolicyError(falError(err))) throw err;
        console.warn(`Scene ${scene.index + 1}: ${e.endpoint} refused the line, trying the next voice model`);
      }
    }
    throw last;
  };
  let tts: any;
  try {
    tts = await sayAll(text);
  } catch (e) {
    // fal's content checker blocks words like "kill/die/poison" (even in Romanian). Say the same thing
    // in a softer way that keeps the drama, retry, and update the line so the subtitle matches the voice.
    if (!isPolicyError(falError(e))) throw e;
    const softer = await softenLine(text, settings.language);
    if (!softer || softer === text) throw new Error(`The voice checker refused the line "${text}". Rewrite it without words like kill/die/poison and press Redo voice.`);
    console.warn(`Scene ${scene.index + 1}: line blocked by the voice checker, softened: "${text}" → "${softer}"`);
    try {
      tts = await sayAll(softer);
    } catch (e2) {
      if (!isPolicyError(falError(e2))) throw e2;
      throw new Error(`The voice checker refused "${text}" and the softer "${softer}". Change the line in the story editor and press Redo voice.`);
    }
    text = softer;
    await saveDialogue(projectId, scene.index, softer);
    scene.dialogue = softer;
  }
  await addCost(projectId, Math.max(text.length, 50) * TTS_PRICE_PER_CHAR);
  const audioUrl = tts?.audio?.url;
  if (!audioUrl) throw new Error("the voice model returned no audio");

  const base = `projects/${projectId}/voice/scene${scene.index}_${stamp()}`;
  await downloadTo(audioUrl, `${base}.mp3`);
  const clipSeconds = (await probe(abs(clipRel))).duration || settings.clipSeconds;
  const pitch = childPitch(story.characters.find((c) => c.key === scene.speaker));
  const speech = await fitVoice(abs(`${base}.mp3`), abs(`${base}.wav`), clipSeconds, 0.3, pitch);
  if (speech + 0.3 > clipSeconds) console.warn(`Scene ${scene.index + 1}: the line is longer than the clip and will be cut`);

  let out: any;
  try {
    out = await run(LIPSYNC_ENDPOINT, {
      video_url: await freshUrl(clipRel),
      audio_url: await freshUrl(`${base}.wav`),
      model: LIPSYNC_MODEL,
      sync_mode: "cut_off",
    });
    await addCost(projectId, clipSeconds * LIPSYNC_PRICE_PER_SECOND);
  } catch (e) {
    if (isPolicyError(falError(e))) throw e;
    console.warn(`Scene ${scene.index + 1}: lipsync-2 failed (${falError(e).slice(0, 120)}), using lipsync 1.9`);
    out = await run(LIPSYNC_FALLBACK, {
      video_url: await freshUrl(clipRel),
      audio_url: await freshUrl(`${base}.wav`),
      model: "lipsync-1.9.0-beta",
      sync_mode: "cut_off",
    });
    await addCost(projectId, (clipSeconds * 0.7) / 60);
  }
  const synced = `${base}_sync.mp4`;
  await downloadTo(videoUrl(out), synced);
  // Final soundtrack = the new voice + the model's sound effects (its own voice removed).
  const rel = `projects/${projectId}/clips/scene${scene.index}_dub_${stamp()}.mp4`;
  const fx = effects ? abs(effects) : null;
  await replaceAudio(abs(synced), [{ file: abs(`${base}.wav`), volume: 1 }, ...(fx ? [{ file: fx, volume: 0.9 }] : [])], abs(rel));
  for (const f of [`${base}.mp3`, `${base}.wav`, synced]) await removeFile(f);
  return rel;
}

/**
 * The video model's soundtrack without voices: slaps, steps, glass, doors, room tone. Saved next to the clip so
 * "Redo voice" can reuse it. Returns null when the clip has no sound or the split fails (then only the voice is used).
 */
async function effectsTrack(projectId: string, scene: StoryScene, clipRel: string): Promise<string | null> {
  const dir = `projects/${projectId}/voice`;
  const fxRel = `${dir}/scene${scene.index}_fx_${stamp()}.wav`;
  const src = `${dir}/scene${scene.index}_src_${stamp()}.wav`;
  try {
    if (!(await extractAudio(abs(clipRel), abs(src)))) return null;
    const seconds = (await probe(abs(src))).duration || 6;
    const out = await run(STEMS_ENDPOINT, {
      audio_url: await freshUrl(src),
      model: "htdemucs",
      stems: ["vocals", "drums", "bass", "other"],
      output_format: "wav",
    });
    await addCost(projectId, seconds * STEMS_PRICE_PER_SECOND);
    const parts: string[] = [];
    for (const k of ["drums", "bass", "other"]) {
      const u = out?.[k]?.url;
      if (!u) continue;
      const r = `${dir}/scene${scene.index}_${k}_${stamp()}.wav`;
      await downloadTo(u, r);
      parts.push(r);
    }
    if (!parts.length) return null;
    await mixAudio(parts.map(abs), abs(fxRel));
    for (const f of parts) await removeFile(f);
    return fxRel;
  } catch (e) {
    console.warn(`Scene ${scene.index + 1}: could not separate sound effects (${falError(e).slice(0, 150)}) — voice only`);
    return null;
  } finally {
    await removeFile(src);
  }
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
  // Dub only stories that actually have lines; recipe reels keep the model's natural kitchen sounds.
  const dub = useDub(p.settings) && story.scenes.some((sc) => sc.dialogue);
  // Recipe reels keep the cooking sounds but lose any voice the video model invents (the voice-over is added at render).
  const recipe = p.settings.kind === "recipe";

  const errors = await pool(scenes, 4, async (scene) => {
    const ref = String(scene.index);
    let asset = await getAsset(projectId, "clip", ref);
    let endpoint = model.endpoint;
    let requestId: string;
    const dubThis = dub && Boolean(scene.dialogue);
    // Dub mode keeps the model's sound: we let the speaker really talk (natural lips, gestures, slaps, steps),
    // then remove only the voices from the soundtrack and put the ElevenLabs voice + lip sync on top.
    const audio = p.settings.audio;
    const mp = (soft = false) => {
      const t = motionPrompt(scene, story, { language: p.settings.language });
      return soft ? soften(t) : t;
    };
    // Resume a request that was already paid for if the worker restarted mid-generation.
    if (asset?.status === "generating" && asset.fal_request_id && asset.fal_endpoint) {
      requestId = asset.fal_request_id;
      endpoint = asset.fal_endpoint;
    } else {
      const prompt = mp();
      const imageUrl = await freshUrl(frames.get(ref)!.path!);
      const input = model.buildInput({ prompt, imageUrl, seconds, audio });
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
      await addCost(projectId, seconds * model.pricePerSecond(audio));
    }
    try {
      let out: any;
      try {
        out = await waitFor(endpoint, requestId);
      } catch (e) {
        if (!isPolicyError(falError(e))) throw e;
        // Blocked by the video model's safety filter: one retry with calmer wording.
        console.warn(`Scene ${scene.index + 1} clip blocked by safety filter, retrying with calmer prompt`);
        const prompt = mp(true);
        const imageUrl = await freshUrl(frames.get(ref)!.path!);
        requestId = await submit(endpoint, model.buildInput({ prompt, imageUrl, seconds, audio }));
        await upsertAsset(projectId, "clip", ref, { status: "generating", prompt, fal_endpoint: endpoint, fal_request_id: requestId });
        await addCost(projectId, seconds * model.pricePerSecond(audio));
        out = await waitFor(endpoint, requestId);
      }
      const url = videoUrl(out);
      const rel = `projects/${projectId}/clips/scene${scene.index}_${stamp()}.mp4`;
      await downloadTo(url, rel);
      if (!dub && !(recipe && audio)) {
        await upsertAsset(projectId, "clip", ref, { status: "ready", path: rel, remote_url: url, fal_request_id: null });
        return;
      }
      await upsertAsset(projectId, "clip", ref, { status: "generating", path: rel, remote_url: url, fal_request_id: null, error: "Adding the voice…" });
      const effects = audio ? await effectsTrack(projectId, scene, rel) : null;
      if (!dubThis) {
        // No line here: keep the effects, drop any words the model invented.
        let final = rel;
        if (effects) {
          final = `projects/${projectId}/clips/scene${scene.index}_fx_${stamp()}.mp4`;
          await replaceAudio(abs(rel), [{ file: abs(effects) }], abs(final));
        }
        await upsertAsset(projectId, "clip", ref, { status: "ready", path: final, remote_url: null, error: null });
        return;
      }
      // Add the voice in the story language + lip sync. If that fails, keep the clip and say why.
      try {
        const dubbed = await dubClip(projectId, p.settings, story, scene, rel, effects);
        await upsertAsset(projectId, "clip", ref, { status: "ready", path: dubbed, remote_url: null, error: null });
      } catch (e) {
        await upsertAsset(projectId, "clip", ref, {
          status: "ready", path: rel, remote_url: url,
          error: `Voice not added (${falError(e).slice(0, 200)}). Press "Redo voice".`,
        });
      }
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

async function latestEffects(projectId: string, index: number): Promise<string | null> {
  const dir = `projects/${projectId}/voice`;
  try {
    const files = (await fs.readdir(abs(dir))).filter((f) => f.startsWith(`scene${index}_fx_`)).sort();
    return files.length ? `${dir}/${files[files.length - 1]}` : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- voice (redo dubbing only)
// Re-voices existing clips without paying for new video: after editing a line, a speaker or a voice.
export async function voiceStep(projectId: string, payload: { only?: number }) {
  const p = await getProject(projectId);
  const story = requireStory(p);
  const clips = new Map((await getAssets(projectId, "clip")).filter((a) => a.status === "ready" && a.path).map((a) => [a.ref, a]));
  const scenes = story.scenes.filter((s) => s.dialogue && (payload.only === undefined || s.index === payload.only));
  if (!scenes.length) throw new Error("No scene with dialogue to voice");
  const missing = scenes.filter((s) => !clips.has(String(s.index)));
  if (missing.length) throw new Error(`Generate the clips first (scenes: ${missing.map((s) => s.index + 1).join(", ")})`);
  await setProject(projectId, { status: "clips", error: null });
  const errors = await pool(scenes, 3, async (scene) => {
    const ref = String(scene.index);
    try {
      const dubbed = await dubClip(projectId, p.settings, story, scene, clips.get(ref)!.path!, await latestEffects(projectId, scene.index));
      await upsertAsset(projectId, "clip", ref, { status: "ready", path: dubbed, remote_url: null, error: null });
    } catch (e) {
      const msg = `Scene ${scene.index + 1} voice: ${falError(e).slice(0, 300)}`;
      await upsertAsset(projectId, "clip", ref, { error: msg });
      throw new Error(msg);
    }
  });
  if (errors.length) throw new Error(errors.join("\n"));
  await enqueue("render", { projectId });
}

// ---------------------------------------------------------------- render
/** Narration for recipe reels: one ElevenLabs file for the whole reel, reused while the text and voice stay the same. */
async function voiceoverFile(projectId: string, p: ProjectRow, story: Story): Promise<string | null> {
  const text = story.voiceover?.trim();
  if (!text) return null;
  const voice = p.settings.narrator || "Jessica";
  const key = createHash("sha1").update(`${voice}|${p.settings.language}|${text}`).digest("hex").slice(0, 12);
  const rel = `projects/${projectId}/voice/voiceover_${key}.mp3`;
  try {
    await fs.access(abs(rel));
    return rel;
  } catch {}
  const code = languageCode(p.settings.language);
  const engines = [
    { endpoint: TTS_ENDPOINT, input: (t: string) => ({ text: t, voice, language_code: code, stability: 0.5 }) },
    { endpoint: "fal-ai/elevenlabs/tts/turbo-v2.5", input: (t: string) => ({ text: t, voice, language_code: code, stability: 0.5 }) },
    { endpoint: "fal-ai/elevenlabs/tts/multilingual-v2", input: (t: string) => ({ text: t, voice, stability: 0.5 }) },
  ];
  let last: unknown;
  for (const e of engines) {
    try {
      const out = await run(e.endpoint, e.input(text));
      await addCost(projectId, Math.max(text.length, 50) * TTS_PRICE_PER_CHAR);
      if (!out?.audio?.url) throw new Error("the voice model returned no audio");
      await downloadTo(out.audio.url, rel);
      return rel;
    } catch (err) {
      last = err;
      if (!isPolicyError(falError(err))) break;
    }
  }
  throw new Error(`Voice-over failed: ${falError(last).slice(0, 200)}. Edit the voice-over text in the story and render again.`);
}

export async function renderStep(projectId: string) {
  const p = await getProject(projectId);
  const story = requireStory(p);
  const clips = new Map((await getAssets(projectId, "clip")).filter((a) => a.status === "ready" && a.path).map((a) => [a.ref, a]));
  const missing = story.scenes.filter((s) => !clips.has(String(s.index)));
  if (missing.length) throw new Error(`Some clips are not ready (scenes: ${missing.map((s) => s.index + 1).join(", ")})`);

  await setProject(projectId, { status: "rendering", error: null });
  const vo = await voiceoverFile(projectId, p, story);
  const rel = `projects/${projectId}/final_${stamp()}.mp4`;
  await renderReel({
    voiceover: vo ? abs(vo) : null,
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
