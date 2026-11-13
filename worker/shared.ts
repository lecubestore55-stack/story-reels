import { rm } from "node:fs/promises";
import { one, q } from "../lib/db";
import { abs } from "../lib/storage";
import { normalizeSettings, type ProjectSettings } from "../lib/config";
import type { AssetRow, Story } from "../lib/types";

/** Thrown when a job should run again later instead of failing (e.g. waiting for analysis). */
export class RetryLater extends Error {
  constructor(public seconds: number, message = "retry later") {
    super(message);
  }
}

export interface ProjectRow {
  id: string;
  reference_id: string;
  title: string;
  status: string;
  settings: ProjectSettings;
  story: Story | null;
  music_path: string | null;
  final_path: string | null;
}

export async function getProject(id: string): Promise<ProjectRow> {
  const p = await one(`SELECT * FROM projects WHERE id=$1`, [id]);
  if (!p) throw new Error(`Project ${id} not found`);
  return { ...p, settings: normalizeSettings(p.settings) } as ProjectRow;
}

export async function setProject(id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(", ");
  const values = keys.map((k) => {
    const v = fields[k];
    return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
  });
  await q(`UPDATE projects SET ${sets}, updated_at=now() WHERE id=$1`, [id, ...values]);
}

export async function addCost(projectId: string, usd: number) {
  await q(`UPDATE projects SET cost_usd = cost_usd + $2 WHERE id=$1`, [projectId, usd]);
}

export async function getAssets(projectId: string, kind: AssetRow["kind"]): Promise<AssetRow[]> {
  return q<AssetRow>(`SELECT * FROM assets WHERE project_id=$1 AND kind=$2 ORDER BY ref`, [projectId, kind]);
}

export async function getAsset(projectId: string, kind: AssetRow["kind"], ref: string): Promise<AssetRow | null> {
  return one<AssetRow>(`SELECT * FROM assets WHERE project_id=$1 AND kind=$2 AND ref=$3`, [projectId, kind, ref]);
}

export async function upsertAsset(projectId: string, kind: AssetRow["kind"], ref: string, fields: Partial<AssetRow>) {
  // When a regenerated file replaces an old one, delete the old file to save disk space.
  if (fields.path) {
    const old = await one<{ path: string | null }>(`SELECT path FROM assets WHERE project_id=$1 AND kind=$2 AND ref=$3`, [projectId, kind, ref]);
    if (old?.path && old.path !== fields.path) await removeFile(old.path);
  }
  const cols = ["status", "path", "remote_url", "fal_endpoint", "fal_request_id", "prompt", "error"] as const;
  const present = cols.filter((c) => c in fields);
  const insertCols = ["project_id", "kind", "ref", ...present];
  const placeholders = insertCols.map((_, i) => `$${i + 1}`);
  const updates = present.map((c) => `${c}=EXCLUDED.${c}`).concat("updated_at=now()");
  await q(
    `INSERT INTO assets(${insertCols.join(",")}) VALUES (${placeholders.join(",")})
     ON CONFLICT (project_id, kind, ref) DO UPDATE SET ${updates.join(", ")}`,
    [projectId, kind, ref, ...present.map((c) => (fields as any)[c] ?? null)],
  );
}

export function requireStory(p: ProjectRow): Story {
  if (!p.story) throw new Error("This project has no story yet. Run the writer first.");
  return p.story;
}

/** Run async tasks with a small concurrency limit; collects errors instead of stopping. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<string[]> {
  const errors: string[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        await fn(item);
      } catch (e: any) {
        errors.push(e?.message || String(e));
      }
    }
  });
  await Promise.all(workers);
  return errors;
}

export async function removeFile(rel: string | null | undefined) {
  if (!rel) return;
  try {
    await rm(abs(rel), { force: true });
  } catch {
    /* ignore */
  }
}
