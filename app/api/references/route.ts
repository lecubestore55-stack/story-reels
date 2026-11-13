import { randomUUID } from "node:crypto";
import path from "node:path";
import { one, q } from "@/lib/db";
import { enqueue } from "@/lib/jobs";
import { fail, json, route } from "@/lib/http";
import { fileUrl, saveBuffer } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const rows = await q(
    `SELECT r.id, r.title, r.status, r.error, r.video_path, r.created_at,
            r.analysis->>'emotional_pattern' AS pattern,
            (SELECT count(*)::int FROM projects p WHERE p.reference_id=r.id) AS reels
       FROM story_references r ORDER BY r.created_at DESC`,
  );
  return json(rows.map((r) => ({ ...r, video_url: fileUrl(r.video_path) })));
});

const ALLOWED = new Set([".mp4", ".mov", ".webm", ".m4v"]);

export const POST = route(async (req: Request) => {
  const form = await req.formData();
  const video = form.get("video");
  if (!(video instanceof File) || video.size === 0) return fail("Choose a video file");
  if (video.size > 300 * 1024 * 1024) return fail("Video is larger than 300 MB");
  const ext = (path.extname(video.name) || ".mp4").toLowerCase();
  if (!ALLOWED.has(ext)) return fail("Upload an MP4, MOV, WEBM or M4V video");

  const id = randomUUID();
  const rel = `references/${id}/source${ext === ".m4v" ? ".mp4" : ext}`;
  await saveBuffer(rel, Buffer.from(await video.arrayBuffer()));
  const title = String(form.get("title") || "").trim() || video.name.replace(/\.[^.]+$/, "").slice(0, 80);
  const notes = String(form.get("notes") || "").trim() || null;

  const ref = await one(
    `INSERT INTO story_references(id, title, video_path, notes) VALUES ($1,$2,$3,$4) RETURNING id`,
    [id, title, rel, notes],
  );
  await enqueue("analyze", { referenceId: id });
  return json(ref, 201);
});
