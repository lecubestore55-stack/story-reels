// MOCK_AI=1 runs the whole pipeline with fake AI results and locally generated media,
// so you can try the dashboard and test the worker without spending anything.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ProjectSettings } from "./config";
import type { Analysis, Story } from "./types";

export const isMock = () => process.env.MOCK_AI === "1";

function ffmpeg(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(err))));
  });
}

/** Mock fal URLs look like mock://image/<w>x<h>/<color> or mock://video/<seconds>. */
export async function renderMockUrl(url: string, file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const [, kind, a, b] = url.replace("mock://", "/").split("/");
  if (kind === "image") {
    const [w, h] = a.split("x");
    await ffmpeg(["-f", "lavfi", "-i", `color=c=${b || "gray"}:s=${w}x${h}`, "-frames:v", "1", file]);
  } else {
    await ffmpeg([
      "-f", "lavfi", "-i", `testsrc2=s=720x1280:r=30:d=${a || 5}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${a || 5}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file,
    ]);
  }
}

export function mockAnalysis(): Analysis {
  return {
    summary: "A father comes home early and finds his daughter eating scraps on the floor while the stepmother's children eat at the table.",
    duration_seconds: 24,
    genre: "family injustice / karma",
    emotional_pattern: "A powerless person is mistreated in secret; a protector discovers it by surprise; roles are reversed at the end.",
    hook: "A child alone on the floor next to the trash can in the first second.",
    twist: "The mistreating adult ends up on the floor; no explanation given.",
    why_viral: ["Injustice against a child", "Surprise discovery", "Unexplained reversal creates curiosity"],
    characters: [
      { role: "protector", description: "man in uniform, 30s" },
      { role: "victim", description: "girl about 6 in pink dress" },
      { role: "antagonist", description: "woman in navy outfit, arms crossed" },
    ],
    setting: "Bright modern kitchen with white marble island",
    beats: [
      { start: 0, end: 8, action: "Father enters, sees girl on floor", camera: "wide then pan down", emotion: "shock" },
      { start: 8, end: 16, action: "Father kneels, stepmother watches", camera: "medium", emotion: "tension" },
      { start: 16, end: 24, action: "Stepmother now on the floor, girl points", camera: "wide", emotion: "karma" },
    ],
    visual_style: "Photorealistic, vertical 9:16, bright daylight",
    audio: "Soft ambient sound, no narration",
    on_screen_text: [],
    transcript: "",
  };
}

export function mockStory(s: ProjectSettings): Story {
  const n = s.sceneCount;
  return {
    title: "The Coat on the Hook",
    logline: "A grandson visits his grandmother's care home early and finds her coat given to a staff member's daughter.",
    hook_text: "He visited his grandma 2 hours early… and froze at the door",
    end_text: "What he found in her room changed everything… Full story in the comments 👇",
    setting: "Small care home common room, warm afternoon light, beige walls, wooden chairs, a coat rack by the window",
    characters: [
      { key: "grandson", name: "Daniel", role: "grandson", visual: "man, 28, short dark hair, light stubble, grey hoodie, blue jeans" },
      { key: "grandma", name: "Rose", role: "grandmother", visual: "woman, 82, white bun, thin, cardigan too light for winter, wool skirt" },
      { key: "manager", name: "Karen", role: "care home manager", visual: "woman, 45, blonde bob, burgundy blazer, lanyard" },
    ],
    scenes: Array.from({ length: n }, (_, i) => ({
      index: i,
      beat: `Beat ${i + 1}`,
      characters: i === 0 ? ["grandson", "grandma"] : ["grandson", "grandma", "manager"],
      frame_prompt: `Scene ${i + 1} start frame`,
      motion_prompt: `Scene ${i + 1} motion`,
      dialogue: i === 0 ? "Grandma? Why are you so cold?" : i === n - 1 ? "Daniel… don't open that door." : null,
    })),
    originality: {
      kept_from_reference: ["surprise discovery", "role reversal ending"],
      changed: ["care home instead of kitchen", "grandmother instead of child", "coat instead of food"],
      risk_notes: "none",
    },
  };
}
