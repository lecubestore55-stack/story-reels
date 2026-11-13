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
    p.on("close", (code, signal) => {
      if (code === 0) return resolve(out);
      const why = signal ? `killed by ${signal}${signal === "SIGKILL" ? " — probably out of memory" : ""}` : `exit code ${code}`;
      reject(new Error(`${cmd} failed (${why}): ${err.slice(-1500)}`));
    });
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

/** The burn-in font has no emoji: turn pointing emoji into arrows and drop the rest. */
export function plainText(text: string): string {
  return text
    .replace(/👇|⬇️?/gu, "↓").replace(/👉|➡️?/gu, "→").replace(/👆|⬆️?/gu, "↑")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Break hook text into short lines so it fits a 1080 px wide reel. */
export function wrapText(text: string, maxChars = 24, maxLines = 4): string[] {
  const words = plainText(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
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

type RenderOpts = {
  clips: string[];          // absolute paths, in order
  output: string;           // absolute path
  hookText?: string | null;
  music?: string | null;    // absolute path
  workDir: string;          // absolute temp dir for text files
  subtitles?: (string | null)[]; // one line of dialogue per clip (null = none), shown while that clip plays
  endText?: string | null;  // curiosity card shown over the last seconds ("Full story in the comments 👇")
};

/**
 * Render the reel at 1080x1920. If the container kills ffmpeg (low memory on small cloud
 * plans), try again at 720x1280 with a single thread, which needs far less memory.
 */
export async function renderReel(opts: RenderOpts) {
  try {
    return await renderAt(opts, 1080, Number(process.env.FFMPEG_THREADS || 2));
  } catch (e: any) {
    if (!/killed by|out of memory|Cannot allocate/i.test(String(e?.message))) throw e;
    console.warn("ffmpeg was killed, retrying at 720x1280 with 1 thread");
    return renderAt(opts, 720, 1);
  }
}

async function renderAt(opts: RenderOpts, width: number, threads: number) {
  const W = width, H = Math.round((width * 16) / 9);
  const k = width / 1080; // scale text with the frame
  if (!opts.clips.length) throw new Error("No clips to render");
  await mkdir(opts.workDir, { recursive: true });
  await mkdir(path.dirname(opts.output), { recursive: true });

  const infos = await Promise.all(opts.clips.map(probe));
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error", "-filter_complex_threads", "1"];
  for (const c of opts.clips) args.push("-i", c);
  const musicIndex = opts.music ? opts.clips.length : -1;
  if (opts.music) args.push("-stream_loop", "-1", "-i", opts.music);

  const f: string[] = [];
  const concatInputs: string[] = [];
  infos.forEach((info, i) => {
    f.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=30,setsar=1,format=yuv420p[v${i}]`);
    if (info.hasAudio) f.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    else f.push(`aevalsrc=0:channel_layout=stereo:sample_rate=44100:d=${info.duration.toFixed(3)},aformat=sample_fmts=fltp[a${i}]`);
    concatInputs.push(`[v${i}][a${i}]`);
  });
  f.push(`${concatInputs.join("")}concat=n=${infos.length}:v=1:a=1[vc][ac]`);

  // ---- Text overlays: hook (top), subtitles (bottom), end card (centre, last seconds).
  const total = infos.reduce((a, b) => a + b.duration, 0);
  const endDur = opts.endText ? Math.min(3, Math.max(1.5, (infos.at(-1)?.duration || 3) * 0.5)) : 0;
  const endAt = Math.max(0, total - endDur);
  const font = `fontfile='${esc(config.fontFile)}'`;
  const chain: string[] = [];
  let n = 0;
  const textFile = async (text: string) => {
    const tf = path.join(opts.workDir, `t_${n++}.txt`);
    await writeFile(tf, text, "utf8");
    return `textfile='${esc(tf)}'`;
  };
  const when = (a: number, b: number) => `enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`;

  // Hook text: white box, black bold text (classic story-reel look). Hidden while the end card shows.
  const hook = opts.hookText ? wrapText(opts.hookText) : [];
  for (let i = 0; i < hook.length; i++) {
    chain.push(
      `drawtext=${font}:${await textFile(hook[i])}:fontsize=${Math.round(62 * k)}:fontcolor=black:` +
        `box=1:boxcolor=white@0.96:boxborderw=${Math.round(18 * k)}:x=(w-text_w)/2:y=${Math.round((210 + i * 92) * k)}` +
        (endDur ? `:${when(0, endAt)}` : ""),
    );
  }

  // Subtitles: each clip's dialogue, low on the screen but above Facebook's caption area.
  let t0 = 0;
  for (let c = 0; c < infos.length; c++) {
    const d = infos[c].duration;
    const line = opts.subtitles?.[c]?.trim();
    if (line) {
      const sub = wrapText(`“${line.replace(/^["“]|["”]$/g, "")}”`, 30, 3);
      const from = t0 + 0.2, to = Math.min(t0 + d - 0.1, endDur ? endAt : t0 + d);
      const base = Math.round(1330 * k) - (sub.length - 1) * Math.round(70 * k);
      for (let i = 0; i < sub.length; i++) {
        chain.push(
          `drawtext=${font}:${await textFile(sub[i])}:fontsize=${Math.round(50 * k)}:fontcolor=white:` +
            `borderw=${Math.round(4 * k)}:bordercolor=black@0.9:box=1:boxcolor=black@0.45:boxborderw=${Math.round(10 * k)}:` +
            `x=(w-text_w)/2:y=${base + i * Math.round(70 * k)}:${when(from, to)}`,
        );
      }
    }
    t0 += d;
  }

  // End card: darken the last seconds and ask viewers to continue the story on the website.
  if (opts.endText && endDur) {
    chain.push(`drawbox=x=0:y=0:w=iw:h=ih:color=black@0.55:t=fill:${when(endAt, total + 1)}`);
    const card = wrapText(opts.endText, 20, 5);
    const lineH = Math.round(96 * k);
    const top = Math.round(H / 2 - (card.length * lineH) / 2);
    for (let i = 0; i < card.length; i++) {
      chain.push(
        `drawtext=${font}:${await textFile(card[i])}:fontsize=${Math.round(70 * k)}:fontcolor=white:` +
          `borderw=${Math.round(5 * k)}:bordercolor=black:x=(w-text_w)/2:y=${top + i * lineH}:${when(endAt, total + 1)}`,
      );
    }
  }

  let vLabel = "vc";
  if (chain.length) {
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
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-threads", String(threads),
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    opts.output,
  );
  await run("ffmpeg", args);
  return probe(opts.output);
}
