import path from "node:path";
import { one, q } from "@/lib/db";
import { fail, isUuid, json, route } from "@/lib/http";
import { saveBuffer } from "@/lib/storage";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Background music mixed under the reel at low volume (use music you have rights to). */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id) || !(await one(`SELECT id FROM projects WHERE id=$1`, [id]))) return fail("Not found", 404);
  const form = await req.formData();
  const file = form.get("music");
  if (!(file instanceof File) || file.size === 0) return fail("Choose an audio file");
  if (file.size > 30 * 1024 * 1024) return fail("Audio file is larger than 30 MB");
  const ext = path.extname(file.name).toLowerCase();
  if (![".mp3", ".m4a", ".wav", ".aac", ".ogg"].includes(ext)) return fail("Upload MP3, M4A, WAV, AAC or OGG");
  const rel = `projects/${id}/music${ext}`;
  await saveBuffer(rel, Buffer.from(await file.arrayBuffer()));
  await q(`UPDATE projects SET music_path=$2, updated_at=now() WHERE id=$1`, [id, rel]);
  return json({ ok: true });
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!isUuid(id)) return fail("Bad id", 404);
  await q(`UPDATE projects SET music_path=NULL, updated_at=now() WHERE id=$1`, [id]);
  return json({ ok: true });
});
