import { one, q } from "@/lib/db";
import { enqueue } from "@/lib/jobs";
import { fail, isUuid, json, route } from "@/lib/http";
import type { JobType } from "@/lib/types";

export const runtime = "nodejs";

const STEPS: JobType[] = ["write", "characters", "frames", "clips", "render"];

/**
 * Run one pipeline step.
 * body: { step, only?: characterKey | sceneIndex, feedback?: string (rewrite notes), note?: string (image direction) }
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!isUuid(id)) return fail("Bad id", 404);
  const p = await one(`SELECT id, story FROM projects WHERE id=$1`, [id]);
  if (!p) return fail("Not found", 404);
  const body = await req.json();
  const step = body.step as JobType;
  if (!STEPS.includes(step)) return fail("Unknown step");
  if (step !== "write" && !p.story) return fail("Write the story first");

  const payload: Record<string, unknown> = {};
  if (typeof body.feedback === "string" && body.feedback.trim()) payload.feedback = body.feedback.trim().slice(0, 2000);
  if (typeof body.note === "string" && body.note.trim()) payload.note = body.note.trim().slice(0, 1000);
  if (body.only !== undefined && body.only !== null && body.only !== "") {
    payload.only = step === "characters" ? String(body.only) : Number(body.only);
  }

  if (step === "write") await q(`UPDATE projects SET status='writing', error=NULL WHERE id=$1`, [id]);
  await enqueue(step, { projectId: id }, payload);
  return json({ ok: true });
});
