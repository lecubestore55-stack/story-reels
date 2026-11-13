import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

export const dataRoot = () => path.resolve(config.dataDir);

/** Absolute path for a path stored in the DB (always relative to DATA_DIR). */
export function abs(rel: string): string {
  const root = dataRoot();
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("Path escapes data dir");
  return full;
}

export async function ensureDir(rel: string) {
  await mkdir(abs(rel), { recursive: true });
}

export async function saveBuffer(rel: string, data: Buffer | Uint8Array) {
  await mkdir(path.dirname(abs(rel)), { recursive: true });
  await writeFile(abs(rel), data);
  return rel;
}

export async function downloadTo(url: string, rel: string) {
  if (url.startsWith("mock://")) {
    const { renderMockUrl } = await import("./mock");
    await renderMockUrl(url, abs(rel));
    return rel;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return saveBuffer(rel, buf);
}

/** Public URL the dashboard uses to show a stored file. */
export const fileUrl = (rel?: string | null) => (rel ? `/api/files/${rel.split(path.sep).join("/")}` : null);

export function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-80) || "file";
}
