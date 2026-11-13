// Central place for API keys, model IDs and prices. Every model ID can be overridden in .env,
// so when fal or Google ship a new version you change one line, not the code.

export const config = {
  dataDir: process.env.DATA_DIR || "./data",
  falKey: process.env.FAL_KEY || "",
  geminiKey: process.env.GEMINI_API_KEY || "",
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
  // Used when GEMINI_API_KEY / ANTHROPIC_API_KEY are empty: everything goes through fal.ai.
  falLlmEndpoint: process.env.FAL_LLM_ENDPOINT || "openrouter/router",
  falLlmModel: process.env.FAL_LLM_MODEL || "anthropic/claude-sonnet-5",
  falVideoLlmEndpoint: process.env.FAL_VIDEO_LLM_ENDPOINT || "openrouter/router/video",
  falVideoLlmModel: process.env.FAL_VIDEO_LLM_MODEL || "google/gemini-3.8-flash",
  fontFile: process.env.FONT_FILE || "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY || 2),
};

// ---------------------------------------------------------------- images
export type ImageTierId = "standard" | "lite";

export interface ImageTier {
  id: ImageTierId;
  label: string;
  textToImage: string;   // used for character photos and scenes with nobody in them
  edit: string;          // used for scenes, with the character photos as references
  priceUsd: number;      // approximate, only for the cost counter
}

export const IMAGE_TIERS: Record<ImageTierId, ImageTier> = {
  standard: {
    id: "standard",
    label: "Nano Banana 2 (sharper, ~$0.08/image)",
    textToImage: process.env.FAL_IMAGE_MODEL || "fal-ai/nano-banana-2",
    edit: process.env.FAL_IMAGE_EDIT_MODEL || "fal-ai/nano-banana-2/edit",
    priceUsd: Number(process.env.FAL_IMAGE_PRICE_USD || 0.08),
  },
  lite: {
    id: "lite",
    label: "Nano Banana Lite (cheaper, 1K images, ~$0.05/image)",
    // The lite edit endpoint also works with no reference images, so it covers both jobs.
    textToImage: process.env.FAL_IMAGE_LITE_MODEL || "google/nano-banana-lite/edit",
    edit: process.env.FAL_IMAGE_LITE_MODEL || "google/nano-banana-lite/edit",
    priceUsd: Number(process.env.FAL_IMAGE_LITE_PRICE_USD || 0.05),
  },
};

// ---------------------------------------------------------------- video
export type VideoModelId = "veo3.1-lite" | "kling-2.5-turbo" | "kling-v3-turbo" | "kling-v3-pro" | "veo3.1";

export interface VideoModel {
  id: VideoModelId;
  label: string;
  endpoint: string;
  minSeconds: number;
  maxSeconds: number;
  supportsAudio: boolean;
  /** Snap a requested clip length to what the model accepts. */
  snapSeconds: (s: number) => number;
  buildInput: (a: { prompt: string; imageUrl: string; seconds: number; audio: boolean; negative?: string }) => Record<string, unknown>;
  pricePerSecond: (audio: boolean) => number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));
const veoSeconds = (s: number) => (s <= 5 ? 4 : s <= 7 ? 6 : 8);
const NEG = "blur, distort, low quality, text, subtitles, watermark, extra fingers";

// Prices are fal.ai list prices per second of output (720p) at the time of writing.
export const VIDEO_MODELS: Record<VideoModelId, VideoModel> = {
  "veo3.1-lite": {
    id: "veo3.1-lite",
    label: "Veo 3.1 Lite — cheapest with sound ($0.05/s, $0.03/s silent)",
    endpoint: process.env.FAL_VEO_LITE_ENDPOINT || "fal-ai/veo3.1/lite/image-to-video",
    minSeconds: 4,
    maxSeconds: 8,
    supportsAudio: true,
    snapSeconds: veoSeconds,
    buildInput: ({ prompt, imageUrl, seconds, audio, negative }) => ({
      image_url: imageUrl,
      prompt,
      duration: `${veoSeconds(seconds)}s`,
      aspect_ratio: "9:16",
      resolution: "720p",
      generate_audio: audio,
      negative_prompt: negative || NEG,
    }),
    pricePerSecond: (audio) => (audio ? 0.05 : 0.03),
  },
  "kling-2.5-turbo": {
    id: "kling-2.5-turbo",
    label: "Kling 2.5 Turbo Pro — good motion, no sound ($0.07/s)",
    endpoint: process.env.FAL_KLING25_ENDPOINT || "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    minSeconds: 5,
    maxSeconds: 10,
    supportsAudio: false,
    snapSeconds: (s) => (s <= 7 ? 5 : 10),
    buildInput: ({ prompt, imageUrl, seconds, negative }) => ({
      image_url: imageUrl,
      prompt,
      duration: seconds <= 7 ? "5" : "10",
      negative_prompt: negative || NEG,
    }),
    pricePerSecond: () => 0.07,
  },
  "kling-v3-turbo": {
    id: "kling-v3-turbo",
    label: "Kling 3 Turbo — people + sound ($0.112/s)",
    endpoint: process.env.FAL_KLING3_TURBO_ENDPOINT || "fal-ai/kling-video/v3/turbo/standard/image-to-video",
    minSeconds: 3,
    maxSeconds: 15,
    supportsAudio: true,
    snapSeconds: (s) => clamp(s, 3, 15),
    buildInput: ({ prompt, imageUrl, seconds }) => ({
      image_url: imageUrl,
      prompt,
      duration: String(clamp(seconds, 3, 15)),
    }),
    pricePerSecond: () => 0.112,
  },
  "kling-v3-pro": {
    id: "kling-v3-pro",
    label: "Kling 3 Pro — premium people ($0.168/s, $0.112/s silent)",
    endpoint: process.env.FAL_KLING_ENDPOINT || "fal-ai/kling-video/v3/pro/image-to-video",
    minSeconds: 3,
    maxSeconds: 15,
    supportsAudio: true,
    snapSeconds: (s) => clamp(s, 3, 15),
    buildInput: ({ prompt, imageUrl, seconds, audio, negative }) => ({
      start_image_url: imageUrl,
      prompt,
      duration: String(clamp(seconds, 3, 15)),
      generate_audio: audio,
      negative_prompt: negative || NEG,
    }),
    pricePerSecond: (audio) => (audio ? 0.168 : 0.112),
  },
  "veo3.1": {
    id: "veo3.1",
    label: "Veo 3.1 — premium cinematic ($0.40/s, $0.20/s silent)",
    endpoint: process.env.FAL_VEO_ENDPOINT || "fal-ai/veo3.1/image-to-video",
    minSeconds: 4,
    maxSeconds: 8,
    supportsAudio: true,
    snapSeconds: veoSeconds,
    buildInput: ({ prompt, imageUrl, seconds, audio, negative }) => ({
      image_url: imageUrl,
      prompt,
      duration: `${veoSeconds(seconds)}s`,
      aspect_ratio: "9:16",
      resolution: "720p",
      generate_audio: audio,
      negative_prompt: negative || "text, subtitles, watermark, blur",
    }),
    pricePerSecond: (audio) => (audio ? 0.4 : 0.2),
  },
};

export interface ProjectSettings {
  videoModel: VideoModelId;
  imageTier: ImageTierId;
  sceneCount: number;      // number of clips
  clipSeconds: number;     // seconds per clip
  audio: boolean;          // model-generated sound (ambience, sfx, short lines)
  hookText: boolean;       // burn the hook text at the top of the reel
  autoRun: boolean;        // run every step without stopping for review
  language: string;        // language of the hook text and any dialogue
  instructions: string;    // extra direction for the writer (audience, country, tone…)
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  videoModel: "veo3.1-lite",
  imageTier: "standard",
  sceneCount: 3,
  clipSeconds: 6,
  audio: true,
  hookText: true,
  autoRun: false,
  language: "English",
  instructions: "",
};

export function normalizeSettings(input: Partial<ProjectSettings> | null | undefined): ProjectSettings {
  const s = { ...DEFAULT_SETTINGS, ...(input || {}) };
  const model = VIDEO_MODELS[s.videoModel] ? s.videoModel : DEFAULT_SETTINGS.videoModel;
  return {
    ...s,
    videoModel: model,
    imageTier: IMAGE_TIERS[s.imageTier] ? s.imageTier : DEFAULT_SETTINGS.imageTier,
    sceneCount: clamp(Number(s.sceneCount) || 3, 1, 8),
    clipSeconds: VIDEO_MODELS[model].snapSeconds(Number(s.clipSeconds) || 6),
    audio: Boolean(s.audio) && VIDEO_MODELS[model].supportsAudio,
    hookText: Boolean(s.hookText),
    autoRun: Boolean(s.autoRun),
    language: String(s.language || "English").slice(0, 40),
    instructions: String(s.instructions || "").slice(0, 2000),
  };
}

export function estimateVideoCost(s: ProjectSettings, characterCount = 3): number {
  const m = VIDEO_MODELS[s.videoModel];
  const clips = s.sceneCount * s.clipSeconds * m.pricePerSecond(s.audio);
  const images = (characterCount + s.sceneCount) * IMAGE_TIERS[s.imageTier].priceUsd;
  return Math.round((clips + images) * 100) / 100;
}
