import path from "node:path";
import { one } from "@/lib/db";
import { fail, isUuid, json, route } from "@/lib/http";
import { abs, saveBuffer } from "@/lib/storage";
import { grabFrame, probe } from "@/lib/ffmpeg";
import { upsertAsset } from "@/worker/shared";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

/** Use your own image (e.g. made in ChatGPT) as a character/dish photo or as a scene's start frame. Free: no AI call. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id) || !(await one(`SELECT id FROM projects WHERE id=$1`, [id]))) return fail("Not found", 404);
  const form = await req.formData();
  const kind = String(form.get("kind"));
  const ref = String(form.get("ref") || "");
  const file = form.get("image");
  if (kind !== "character" && kind !== "frame") return fail("Bad kind");
  if (!ref || !/^[\w-]{1,64}$/.test(ref)) return fail("Bad ref");

  // Take a frame of the reference video instead of a file (e.g. the finished dish of a recipe remake).
  const at = form.get("fromReference");
  if (at !== null) {
    const p = await one(`SELECT r.video_path, r.kind FROM projects p JOIN story_references r ON r.id=p.reference_id WHERE p.id=$1`, [id]);
    if (!p || p.kind === "source") return fail("This project has no reference video");
    const dur = (await probe(abs(p.video_path))).duration || 0;
    const t = Math.min(Math.max(0, Number(at) || 0), Math.max(0, dur - 0.1));
    const rel = `projects/${id}/${kind === "character" ? "characters" : "frames"}/${ref}_ref_${Date.now().toString(36)}.jpg`;
    await grabFrame(abs(p.video_path), t, abs(rel));
    await upsertAsset(id, kind, ref, { status: "ready", path: rel, remote_url: null, prompt: `Frame at ${t.toFixed(1)}s of the reference`, fal_endpoint: null, fal_request_id: null, error: null });
    return json({ ok: true });
  }
  if (!(file instanceof File) || file.size === 0) return fail("Choose an image");
  if (file.size > 20 * 1024 * 1024) return fail("Image is larger than 20 MB");
  const ext = path.extname(file.name).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return fail("Upload a JPG, PNG or WEBP image");
  const rel = `projects/${id}/${kind === "character" ? "characters" : "frames"}/${ref}_upload_${Date.now().toString(36)}${ext}`;
  await saveBuffer(rel, Buffer.from(await file.arrayBuffer()));
  await upsertAsset(id, kind, ref, { status: "ready", path: rel, remote_url: null, prompt: "Uploaded image", fal_endpoint: null, fal_request_id: null, error: null });
  return json({ ok: true });
});
