import path from "node:path";
import { one } from "@/lib/db";
import { fail, isUuid, json, route } from "@/lib/http";
import { saveBuffer } from "@/lib/storage";
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
  if (!(file instanceof File) || file.size === 0) return fail("Choose an image");
  if (file.size > 20 * 1024 * 1024) return fail("Image is larger than 20 MB");
  const ext = path.extname(file.name).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return fail("Upload a JPG, PNG or WEBP image");
  const rel = `projects/${id}/${kind === "character" ? "characters" : "frames"}/${ref}_upload_${Date.now().toString(36)}${ext}`;
  await saveBuffer(rel, Buffer.from(await file.arrayBuffer()));
  await upsertAsset(id, kind, ref, { status: "ready", path: rel, remote_url: null, prompt: "Uploaded image", fal_endpoint: null, fal_request_id: null, error: null });
  return json({ ok: true });
});
