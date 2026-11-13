import { rm } from "node:fs/promises";
import { one, q } from "@/lib/db";
import { activeJobs } from "@/lib/jobs";
import { VIDEO_MODELS, estimateVideoCost, normalizeSettings } from "@/lib/config";
import { fail, isUuid, json, route } from "@/lib/http";
import { abs, fileUrl } from "@/lib/storage";
import { StorySchema } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id)) return fail("Bad id", 404);
  const p = await one(`SELECT * FROM projects WHERE id=$1`, [id]);
  if (!p) return fail("Not found", 404);
  const ref = await one(`SELECT id, title, status, video_path, analysis FROM story_references WHERE id=$1`, [p.reference_id]);
  const assets = await q(`SELECT kind, ref, status, path, error, updated_at FROM assets WHERE project_id=$1`, [id]);
  const settings = normalizeSettings(p.settings);
  return json({
    ...p,
    settings,
    final_url: fileUrl(p.final_path),
    music_url: fileUrl(p.music_path),
    reference: ref && { id: ref.id, title: ref.title, status: ref.status, video_url: fileUrl(ref.video_path), analysis: ref.analysis },
    assets: assets.map((a) => ({ ...a, url: fileUrl(a.path) })),
    jobs: await activeJobs(id),
    estimate_usd: estimateVideoCost(settings, p.story?.characters?.length ?? 3),
    video_models: Object.values(VIDEO_MODELS).map((m) => ({ id: m.id, label: m.label, min: m.minSeconds, max: m.maxSeconds })),
  });
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id)) return fail("Bad id", 404);
  const p = await one(`SELECT id, settings FROM projects WHERE id=$1`, [id]);
  if (!p) return fail("Not found", 404);
  const body = await req.json();

  if (body.story !== undefined) {
    const parsed = StorySchema.safeParse(body.story);
    if (!parsed.success) return fail("Story is not valid: " + parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
    const story = parsed.data;
    story.scenes = story.scenes.map((s, i) => ({ ...s, index: i }));
    await q(`UPDATE projects SET story=$2, title=$3, updated_at=now() WHERE id=$1`, [id, JSON.stringify(story), story.title]);
    // Drop images/clips for scenes or characters that no longer exist.
    await q(`DELETE FROM assets WHERE project_id=$1 AND kind IN ('frame','clip') AND ref::int >= $2`, [id, story.scenes.length]);
    await q(`DELETE FROM assets WHERE project_id=$1 AND kind='character' AND NOT (ref = ANY($2))`, [id, story.characters.map((c) => c.key)]);
  }
  if (body.settings !== undefined) {
    const settings = normalizeSettings({ ...p.settings, ...body.settings });
    await q(`UPDATE projects SET settings=$2, updated_at=now() WHERE id=$1`, [id, JSON.stringify(settings)]);
  }
  return json({ ok: true });
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id)) return fail("Bad id", 404);
  await q(`DELETE FROM projects WHERE id=$1`, [id]);
  await rm(abs(`projects/${id}`), { recursive: true, force: true });
  return json({ ok: true });
});
