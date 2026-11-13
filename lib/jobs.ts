import { q, one } from "./db";
import type { JobType } from "./types";

export async function enqueue(type: JobType, ids: { referenceId?: string; projectId?: string }, payload: object = {}) {
  // Don't stack the same step twice for the same project/reference.
  const existing = await one(
    `SELECT id FROM jobs WHERE type=$1 AND status IN ('queued','running')
       AND reference_id IS NOT DISTINCT FROM $2 AND project_id IS NOT DISTINCT FROM $3`,
    [type, ids.referenceId ?? null, ids.projectId ?? null],
  );
  if (existing) return existing.id as number;
  const row = await one<{ id: number }>(
    `INSERT INTO jobs(type, reference_id, project_id, payload) VALUES ($1,$2,$3,$4) RETURNING id`,
    [type, ids.referenceId ?? null, ids.projectId ?? null, JSON.stringify(payload)],
  );
  return row!.id;
}

export async function activeJobs(projectId: string) {
  return q(`SELECT id, type, status, payload, error, created_at FROM jobs
            WHERE project_id=$1 AND status IN ('queued','running') ORDER BY id`, [projectId]);
}
