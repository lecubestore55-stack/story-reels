import { readFile } from "node:fs/promises";
import path from "node:path";
import { createFalClient } from "@fal-ai/client";
import { config } from "../config";
import { abs } from "../storage";
import { isMock } from "../mock";

const mockRequests = new Map<string, any>();

let client: ReturnType<typeof createFalClient> | null = null;
export function fal() {
  if (!config.falKey) throw new Error("FAL_KEY is not set");
  if (!client) client = createFalClient({ credentials: config.falKey });
  return client;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4" };

/** Upload a local file to fal storage and return a URL fal models can read. */
export async function uploadLocal(rel: string): Promise<string> {
  if (isMock()) return `mock-upload://${rel}`;
  const buf = await readFile(abs(rel));
  const type = MIME[path.extname(rel).toLowerCase()] || "application/octet-stream";
  return fal().storage.upload(new Blob([new Uint8Array(buf)], { type }));
}

/** Submit to the fal queue; returns the request id so the job can resume after a restart. */
export async function submit(endpoint: string, input: Record<string, unknown>): Promise<string> {
  if (isMock()) {
    const id = `mock_${Math.random().toString(36).slice(2)}`;
    const isVideo = /video|veo|kling/.test(endpoint);
    const secs = parseInt(String(input.duration ?? "5"), 10) || 5;
    const portrait = input.aspect_ratio === "3:4";
    mockRequests.set(id, isVideo
      ? { video: { url: `mock://video/${secs}` } }
      : { images: [{ url: `mock://image/${portrait ? "768x1024" : "720x1280"}/${portrait ? "teal" : "navy"}` }] });
    return id;
  }
  const res = await fal().queue.submit(endpoint, { input });
  return res.request_id;
}

/** Poll a queued request until it completes, then return its output. */
export async function waitFor<T = any>(endpoint: string, requestId: string, timeoutMs = 20 * 60_000): Promise<T> {
  if (isMock()) {
    await new Promise((r) => setTimeout(r, 1500));
    const out = mockRequests.get(requestId);
    if (!out) throw new Error(`mock request ${requestId} lost (worker restarted)`);
    return out as T;
  }
  const start = Date.now();
  let delay = 3000;
  while (Date.now() - start < timeoutMs) {
    const status = await fal().queue.status(endpoint, { requestId, logs: false });
    if (status.status === "COMPLETED") {
      const result = await fal().queue.result(endpoint, { requestId });
      return result.data as T;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 2000, 10_000);
  }
  throw new Error(`fal request ${requestId} timed out`);
}

/** Run a model and wait (used for images, which take seconds). */
export async function run<T = any>(endpoint: string, input: Record<string, unknown>): Promise<T> {
  const id = await submit(endpoint, input);
  return waitFor<T>(endpoint, id, 5 * 60_000);
}

export function firstImageUrl(out: any): string {
  const url = out?.images?.[0]?.url || out?.image?.url;
  if (!url) throw new Error("Image model returned no image");
  return url;
}

export function videoUrl(out: any): string {
  const url = out?.video?.url || out?.videos?.[0]?.url;
  if (!url) throw new Error("Video model returned no video");
  return url;
}

/** fal errors often carry a useful JSON body; surface it. */
export function falError(err: unknown): string {
  const e = err as any;
  const body = e?.body ? JSON.stringify(e.body).slice(0, 600) : "";
  return [e?.message || String(err), body].filter(Boolean).join(" — ");
}
