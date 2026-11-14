import { rm } from "node:fs/promises";
import { one, q } from "@/lib/db";
import { fail, isUuid, json, route } from "@/lib/http";
import { abs, fileUrl } from "@/lib/storage";
import { detectShots } from "@/lib/shots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id)) return fail("Bad id", 404);
  const ref = await one(`SELECT * FROM story_references WHERE id=$1`, [id]);
  if (!ref) return fail("Not found", 404);
  // References analyzed before shot detection existed: measure their cuts once and save.
  if (ref.analysis && !ref.analysis.shots) {
    try {
      ref.analysis.shots = await detectShots(abs(ref.video_path));
      await q(`UPDATE story_references SET analysis=$2 WHERE id=$1`, [id, JSON.stringify(ref.analysis)]);
    } catch {
      /* ffmpeg missing or file gone: skip */
    }
  }
  const projects = await q(
    `SELECT id, title, status, error, cost_usd, final_path, created_at, story->>'logline' AS logline
       FROM projects WHERE reference_id=$1 ORDER BY created_at DESC`,
    [id],
  );
  return json({
    ...ref,
    video_url: fileUrl(ref.video_path),
    projects: projects.map((p) => ({ ...p, final_url: fileUrl(p.final_path) })),
  });
});

export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id)) return fail("Bad id", 404);
  const body = await req.json();
  await q(
    `UPDATE story_references SET title=COALESCE($2,title), notes=COALESCE($3,notes), updated_at=now() WHERE id=$1`,
    [id, body.title ?? null, body.notes ?? null],
  );
  return json({ ok: true });
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id)) return fail("Bad id", 404);
  const projects = await q(`SELECT id FROM projects WHERE reference_id=$1`, [id]);
  await q(`DELETE FROM story_references WHERE id=$1`, [id]);
  await rm(abs(`references/${id}`), { recursive: true, force: true });
  for (const p of projects) await rm(abs(`projects/${p.id}`), { recursive: true, force: true });
  return json({ ok: true });
});
