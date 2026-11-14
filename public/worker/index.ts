// Background worker: picks jobs from Postgres and runs the pipeline steps.
// Start with `npm run worker`. Safe to restart: running jobs are re-queued and
// video requests already sent to fal are resumed, not paid for twice.
import { pool as pg, one, q } from "../lib/db";
import { config } from "../lib/config";
import { migrate } from "../scripts/migrate";
import { RetryLater, setProject } from "./shared";
import { analyzeStep, charactersStep, clipsStep, framesStep, renderStep, writeStep } from "./steps";

let stopping = false;

async function claim() {
  return one(
    `UPDATE jobs SET status='running', started_at=now(), attempts=attempts+1
     WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_after <= now()
                 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING *`,
  );
}

async function handle(job: any) {
  const payload = job.payload || {};
  switch (job.type) {
    case "analyze": return analyzeStep(job.reference_id);
    case "write": return writeStep(job.project_id, payload);
    case "characters": return charactersStep(job.project_id, payload);
    case "frames": return framesStep(job.project_id, payload);
    case "clips": return clipsStep(job.project_id, payload);
    case "render": return renderStep(job.project_id);
    default: throw new Error(`Unknown job type ${job.type}`);
  }
}

async function loop(slot: number) {
  while (!stopping) {
    const job = await claim().catch((e) => {
      console.error("claim failed", e.message);
      return null;
    });
    if (!job) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    const t0 = Date.now();
    console.log(`[w${slot}] #${job.id} ${job.type} start`);
    try {
      await handle(job);
      await q(`UPDATE jobs SET status='done', finished_at=now(), error=NULL WHERE id=$1`, [job.id]);
      console.log(`[w${slot}] #${job.id} ${job.type} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e: any) {
      if (e instanceof RetryLater) {
        await q(`UPDATE jobs SET status='queued', run_after=now() + ($2 || ' seconds')::interval, error=$3 WHERE id=$1`, [
          job.id, String(e.seconds), e.message,
        ]);
        continue;
      }
      const msg = (e?.message || String(e)).slice(0, 4000);
      console.error(`[w${slot}] #${job.id} ${job.type} failed: ${msg}`);
      await q(`UPDATE jobs SET status='failed', finished_at=now(), error=$2 WHERE id=$1`, [job.id, msg]);
      if (job.project_id) await setProject(job.project_id, { status: "failed", error: `${job.type}: ${msg}` }).catch(() => {});
    }
  }
}

async function main() {
  await migrate();
  // Jobs that were running when the worker stopped go back in the queue.
  const reset = await q(`UPDATE jobs SET status='queued' WHERE status='running' RETURNING id`);
  if (reset.length) console.log(`Re-queued ${reset.length} interrupted job(s)`);
  if (!config.falKey) console.warn("Warning: FAL_KEY is not set — images, video (and analysis/writing without their own keys) will fail.");
  console.log(
    `Analysis via ${config.geminiKey ? "Gemini API" : `fal.ai (${config.falVideoLlmModel})`}, ` +
      `writing via ${config.anthropicKey ? "Anthropic API" : `fal.ai (${config.falLlmModel})`}`,
  );
  console.log(`Worker started with ${config.workerConcurrency} slot(s)`);
  await Promise.all(Array.from({ length: config.workerConcurrency }, (_, i) => loop(i + 1)));
  await pg.end();
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  console.log("Stopping after current jobs…");
  stopping = true;
  // Jobs still running are re-queued on the next start, and paid fal requests are resumed.
  setTimeout(() => process.exit(0), 10_000).unref();
});

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
