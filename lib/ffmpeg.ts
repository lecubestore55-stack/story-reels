import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (${code}): ${err.slice(-1500)}`))));
  });
}

export async function probe(file: string): Promise<{ duration: number; hasAudio: boolean }> {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file]);
  const j = JSON.parse(out);
  return {
    duration: Number(j.format?.duration || 0),
    hasAudio: (j.streams || []).some((s: any) => s.codec_type === "audio"),
  };
}

/** Break hook text into short lines so it fits a 1080 px wide reel. */
export function wrapText(text: string, maxChars = 24, maxLines = 4): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars && line) {
      lines.push(line);
      line = w;
    } else line = (line + " " + w).trim();
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/[.,!?]*$/, "") + "…";
    return kept;
  }
  return lines;
}

// Paths inside a filtergraph need ':' and '\' and quotes escaped.
const esc = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

export async function renderReel(opts: {
  clips: string[];          // absolute paths, in order
  output: string;           // absolute path
  hookText?: string | null;
  music?: string | null;    // absolute path
  workDir: string;          // absolute temp dir for text files
}) {
  if (!opts.clips.length) throw new Error("No clips to render");
  await mkdir(opts.workDir, { recursive: true });
  await mkdir(path.dirname(opts.output), { recursive: true });

  const infos = await Promise.all(opts.clips.map(probe));
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const c of opts.clips) args.push("-i", c);
  const musicIndex = opts.music ? opts.clips.length : -1;
  if (opts.music) args.push("-stream_loop", "-1", "-i", opts.music);

  const f: string[] = [];
  const concatInputs: string[] = [];
  infos.forEach((info, i) => {
    f.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1,format=yuv420p[v${i}]`);
    if (info.hasAudio) f.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    else f.push(`aevalsrc=0:channel_layout=stereo:sample_rate=44100:d=${info.duration.toFixed(3)},aformat=sample_fmts=fltp[a${i}]`);
    concatInputs.push(`[v${i}][a${i}]`);
  });
  f.push(`${concatInputs.join("")}concat=n=${infos.length}:v=1:a=1[vc][ac]`);

  // Hook text: one centred drawtext per line, white box, black bold text (classic story-reel look).
  let vLabel = "vc";
  const lines = opts.hookText ? wrapText(opts.hookText) : [];
  if (lines.length) {
    const fontSize = 62;
    const lineH = 92;
    const top = 210;
    const chain: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const tf = path.join(opts.workDir, `hook_${i}.txt`);
      await writeFile(tf, lines[i], "utf8");
      chain.push(
        `drawtext=fontfile='${esc(config.fontFile)}':textfile='${esc(tf)}':fontsize=${fontSize}:fontcolor=black:` +
          `box=1:boxcolor=white@0.96:boxborderw=18:x=(w-text_w)/2:y=${top + i * lineH}`,
      );
    }
    f.push(`[vc]${chain.join(",")}[vt]`);
    vLabel = "vt";
  }

  let aLabel = "ac";
  if (musicIndex >= 0) {
    f.push(`[${musicIndex}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.25[mu]`);
    f.push(`[ac][mu]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[am]`);
    aLabel = "am";
  }

  args.push(
    "-filter_complex", f.join(";"),
    "-map", `[${vLabel}]`, "-map", `[${aLabel}]`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    opts.output,
  );
  await run("ffmpeg", args);
  return probe(opts.output);
}
