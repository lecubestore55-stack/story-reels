// Text + video-understanding models through fal.ai's OpenRouter endpoints,
// so the whole platform can run on a single FAL_KEY.
import { config } from "../config";
import { falError, run, uploadLocal } from "./fal";

interface RouterOut {
  output?: string;
  error?: string;
  usage?: { cost?: number };
}

/** Pull the first JSON object out of a model reply (handles ```json fences and extra text). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return JSON");
  return JSON.parse(body.slice(start, end + 1));
}

async function call(endpoint: string, input: Record<string, unknown>): Promise<{ text: string; cost: number }> {
  let out: RouterOut;
  try {
    out = await run<RouterOut>(endpoint, input);
  } catch (e) {
    throw new Error(falError(e));
  }
  if (out.error) throw new Error(out.error);
  return { text: out.output || "", cost: Number(out.usage?.cost || 0) };
}

/**
 * Ask for JSON and validate it. If the reply doesn't parse or validate, ask once more
 * and tell the model exactly what was wrong.
 */
export async function routerJson<T>(opts: {
  kind: "text" | "video";
  system: string;
  prompt: string;
  parse: (data: unknown) => T;
  videoPath?: string;
}): Promise<{ data: T; cost: number }> {
  const endpoint = opts.kind === "video" ? config.falVideoLlmEndpoint : config.falLlmEndpoint;
  const model = opts.kind === "video" ? config.falVideoLlmModel : config.falLlmModel;
  const base: Record<string, unknown> = {
    model,
    system_prompt: opts.system,
    temperature: opts.kind === "video" ? 0.4 : 0.9,
    max_tokens: 8000,
  };
  if (opts.videoPath) base.video_urls = [await uploadLocal(opts.videoPath)];

  let cost = 0;
  let prompt = opts.prompt;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await call(endpoint, { ...base, prompt });
    cost += res.cost;
    try {
      return { data: opts.parse(extractJson(res.text)), cost };
    } catch (e: any) {
      lastError = e?.message || String(e);
      prompt =
        `${opts.prompt}\n\nYour previous reply could not be used (${lastError.slice(0, 500)}). ` +
        `Reply again with ONLY the corrected JSON object, nothing else.`;
    }
  }
  throw new Error(`The model returned invalid JSON twice: ${lastError.slice(0, 800)}`);
}
