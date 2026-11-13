import { one } from "@/lib/db";
import { enqueue } from "@/lib/jobs";
import { normalizeSettings } from "@/lib/config";
import { fail, isUuid, json, route } from "@/lib/http";

export const runtime = "nodejs";

/** Create one or more new reels from a reference. Each gets its own original story. */
export const POST = route(async (req: Request) => {
  const body = await req.json();
  const referenceId = String(body.referenceId || "");
  if (!isUuid(referenceId)) return fail("Missing reference");
  const ref = await one(`SELECT id, status FROM story_references WHERE id=$1`, [referenceId]);
  if (!ref) return fail("Reference not found", 404);
  if (ref.status === "failed") return fail("This reference failed analysis. Re-run the analysis first.");

  const settings = normalizeSettings(body.settings);
  const count = Math.max(1, Math.min(5, Number(body.count) || 1));
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = await one<{ id: string }>(
      `INSERT INTO projects(reference_id, settings, status) VALUES ($1,$2,'writing') RETURNING id`,
      [referenceId, JSON.stringify(settings)],
    );
    ids.push(p!.id);
  }
  // Write them one after another so each story knows the previous ones and stays different.
  for (const id of ids) await enqueue("write", { projectId: id });
  return json({ ids }, 201);
});
