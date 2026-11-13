import { one } from "@/lib/db";
import { enqueue } from "@/lib/jobs";
import { fail, isUuid, json, route } from "@/lib/http";

export const runtime = "nodejs";

export const POST = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!isUuid(id) || !(await one(`SELECT id FROM story_references WHERE id=$1`, [id]))) return fail("Not found", 404);
  await enqueue("analyze", { referenceId: id });
  return json({ ok: true });
});
