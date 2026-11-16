import path from "node:path";
import { randomUUID } from "node:crypto";
import { one, q } from "@/lib/db";
import { enqueue } from "@/lib/jobs";
import { normalizeSettings } from "@/lib/config";
import { fail, json, route } from "@/lib/http";
import { downloadTo, fileUrl, saveBuffer } from "@/lib/storage";
import { fetchRecipe } from "@/lib/recipeSource";

export const runtime = "nodejs";
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** My own recipes (from my blog) turned into preparation reels. */
export const GET = route(async () => {
  const rows = await q(
    `SELECT r.id, r.title, r.video_path, r.created_at,
            COALESCE(json_agg(json_build_object('id', p.id, 'title', p.title, 'status', p.status) ORDER BY p.created_at)
                     FILTER (WHERE p.id IS NOT NULL), '[]') AS projects
       FROM story_references r LEFT JOIN projects p ON p.reference_id = r.id
      WHERE r.kind='source' GROUP BY r.id ORDER BY r.created_at DESC LIMIT 100`,
  );
  return json(rows.map((r: any) => ({ ...r, image_url: fileUrl(r.video_path) })));
});

/**
 * Body (multipart): url (blog post) and/or text (recipe), optional image (dish photo), title, settings (JSON), count.
 * Creates a hidden "source" reference that holds the recipe + photo, then the reel projects.
 */
export const POST = route(async (req: Request) => {
  const form = await req.formData();
  const url = String(form.get("url") || "").trim();
  let text = String(form.get("text") || "").trim();
  let title = String(form.get("title") || "").trim();
  const image = form.get("image");
  let imageUrl: string | null = null;

  if (url) {
    const r = await fetchRecipe(url);
    text = [r.text, text ? `Extra notes from the page owner:\n${text}` : ""].filter(Boolean).join("\n\n");
    title = title || r.title;
    imageUrl = r.imageUrl;
  }
  if (!text) return fail("Paste the recipe link or the recipe text");

  const id = randomUUID();
  let rel: string;
  if (image instanceof File && image.size > 0) {
    if (image.size > 20 * 1024 * 1024) return fail("The photo is larger than 20 MB");
    const ext = (path.extname(image.name) || ".jpg").toLowerCase();
    if (!IMAGE_EXT.has(ext)) return fail("Upload a JPG, PNG or WEBP photo");
    rel = `references/${id}/dish${ext}`;
    await saveBuffer(rel, Buffer.from(await image.arrayBuffer()));
  } else if (imageUrl) {
    const ext = (path.extname(new URL(imageUrl).pathname) || ".jpg").toLowerCase();
    rel = `references/${id}/dish${IMAGE_EXT.has(ext) ? ext : ".jpg"}`;
    try {
      await downloadTo(imageUrl, rel);
    } catch {
      return fail("Could not download the recipe photo from the page. Upload the photo yourself.");
    }
  } else {
    return fail("Add a photo of the finished dish (or a link to a page that has one)");
  }
  title = (title || text.split("\n")[0].replace(/^Recipe:\s*/i, "")).slice(0, 120);

  // The writer works from an "analysis"; for my own recipe it just describes a standard preparation reel.
  const analysis = {
    summary: `Own recipe from the page owner's blog: ${title}`,
    duration_seconds: 12,
    genre: "own recipe",
    emotional_pattern: "step-by-step preparation that ends on an irresistible close-up of the finished dish",
    hook: "the finished dish big in frame in the first second (cheese pull, cut, pour or close-up of the texture)",
    twist: "final money shot of the finished dish, then the end card sends viewers to the full recipe",
    why_viral: ["fast satisfying cuts", "real textures in close-up", "clear easy steps viewers want to try"],
    characters: [{ role: "hands", description: "only the cook's hands, no faces" }],
    setting: "real home kitchen",
    beats: [],
    visual_style: "close-up, natural light, shallow depth of field, fast cuts of about 1.5 s",
    audio: "natural cooking sounds (sizzle, knife, crunch, oven door), no talking",
    on_screen_text: [],
    transcript: "",
  };
  await one(
    `INSERT INTO story_references(id, title, video_path, notes, kind, status, analysis) VALUES ($1,$2,$3,$4,'source','ready',$5) RETURNING id`,
    [id, title, rel, url ? `Source: ${url}` : null, JSON.stringify(analysis)],
  );

  let settingsIn: any = {};
  try {
    settingsIn = JSON.parse(String(form.get("settings") || "{}"));
  } catch {}
  const settings = normalizeSettings({ ...settingsIn, kind: "recipe", storyMode: "original", instructions: text });
  const count = Math.max(1, Math.min(3, Number(form.get("count")) || 1));
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = await one<{ id: string }>(
      `INSERT INTO projects(reference_id, settings, status, title) VALUES ($1,$2,'writing',$3) RETURNING id`,
      [id, JSON.stringify(settings), title],
    );
    ids.push(p!.id);
  }
  for (const pid of ids) await enqueue("write", { projectId: pid });
  return json({ id, ids }, 201);
});
