// Detect the shots (cuts) in a reference video with ffmpeg, so the platform knows how many
// scenes it needs and how long each shot is shown.
import { spawn } from "node:child_process";
import type { ShotStats } from "./types";

function ffmpegStderr(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", () => resolve(err));
  });
}

export async function detectShots(file: string, threshold = 0.3): Promise<ShotStats> {
  const log = await ffmpegStderr(["-hide_banner", "-i", file, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"]);
  const dur = Number(log.match(/Duration: (\d+):(\d+):([\d.]+)/)?.slice(1).reduce((a, v, i) => a + Number(v) * [3600, 60, 1][i], 0) || 0);
  const raw = [...log.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.3 && t < dur - 0.3);
  // Merge cuts closer than 0.5s (flashes, fast pans) so we don't count fake shots.
  const cuts: number[] = [];
  for (const t of raw) if (!cuts.length || t - cuts[cuts.length - 1] >= 0.5) cuts.push(t);
  const bounds = [0, ...cuts, dur];
  const durations = bounds.slice(1).map((b, i) => Math.round((b - bounds[i]) * 10) / 10);
  return {
    duration: Math.round(dur * 10) / 10,
    count: durations.length,
    avg: durations.length ? Math.round((dur / durations.length) * 10) / 10 : dur,
    durations,
  };
}
