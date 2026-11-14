// Central place for API keys, model IDs and prices. Every model ID can be overridden in .env,
// so when fal or Google ship a new version you change one line, not the code.

export const config = {
  dataDir: process.env.DATA_DIR || "./data",
  falKey: process.env.FAL_KEY || "",
  geminiKey: process.env.GEMINI_API_KEY || "",
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  // Tried in order when the main model is busy (503) or not available for your key.
  geminiFallbackModels: (process.env.GEMINI_FALLBACK_MODELS || "")
    .split(",").map((m) => m.trim()).filter(Boolean),
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
export type ImageTierId = "flux2-pro" | "seedream" | "seedream-pro" | "standard" | "lite";
export type Aspect = "9:16" | "3:4";

export interface ImageTier {
  id: ImageTierId;
  label: string;
  textToImage: string;   // used for character photos and scenes with nobody in them
  edit: string;          // used for scenes, with the character photos as references
  priceUsd: number;      // approximate, only for the cost counter
  /** Each model family names its size fields differently. */
  buildInput: (a: { prompt: string; aspect: Aspect; imageUrls?: string[] }) => Record<string, unknown>;
}

const SEEDREAM_SIZE: Record<Aspect, { width: number; height: number }> = {
  "9:16": { width: 1440, height: 2560 },
  "3:4": { width: 1920, height: 2560 },
};

// Seedream 5.0 Pro is billed $0.0675 up to 1536x1536 pixels of area, so stay just under it.
const SEEDREAM_PRO_SIZE: Record<Aspect, { width: number; height: number }> = {
  "9:16": { width: 1152, height: 2048 },
  "3:4": { width: 1296, height: 1728 },
};

// FLUX.2 is billed per megapixel: ~1.3 MP keeps it cheap and still above Veo's 720p minimum.
const FLUX_SIZE: Record<Aspect, { width: number; height: number }> = {
  "9:16": { width: 864, height: 1536 },
  "3:4": { width: 960, height: 1280 },
};

const nanoInput: ImageTier["buildInput"] = ({ prompt, aspect, imageUrls }) => ({
  prompt, aspect_ratio: aspect, num_images: 1, output_format: "png",
  ...(imageUrls?.length ? { image_urls: imageUrls } : {}),
});

export const IMAGE_TIERS: Record<ImageTierId, ImageTier> = {
  "flux2-pro": {
    id: "flux2-pro",
    label: "FLUX.2 Pro — most realistic people (~$0.05/image)",
    textToImage: process.env.FAL_FLUX2_T2I || "fal-ai/flux-2-pro",
    edit: process.env.FAL_FLUX2_EDIT || "fal-ai/flux-2-pro/edit",
    priceUsd: Number(process.env.FAL_FLUX2_PRICE_USD || 0.05),
    buildInput: ({ prompt, aspect, imageUrls }) => ({
      prompt,
      image_size: FLUX_SIZE[aspect],
      output_format: "png",
      // 1 = strictest, 5 = most permissive: dramatic (non-graphic) scenes get blocked less often.
      safety_tolerance: process.env.FAL_FLUX2_SAFETY || "5",
      ...(imageUrls?.length ? { image_urls: imageUrls.slice(-8) } : {}),
    }),
  },
  seedream: {
    id: "seedream",
    label: "Seedream 5.0 Lite — cheapest, realistic ($0.035/image)",
    textToImage: process.env.FAL_SEEDREAM_T2I || "fal-ai/bytedance/seedream/v5/lite/text-to-image",
    edit: process.env.FAL_SEEDREAM_EDIT || "fal-ai/bytedance/seedream/v5/lite/edit",
    priceUsd: Number(process.env.FAL_SEEDREAM_PRICE_USD || 0.035),
    buildInput: ({ prompt, aspect, imageUrls }) => ({
      prompt, image_size: SEEDREAM_SIZE[aspect], num_images: 1, output_format: "png",
      ...(imageUrls?.length ? { image_urls: imageUrls } : {}),
    }),
  },
  "seedream-pro": {
    id: "seedream-pro",
    label: "Seedream 5.0 Pro — best realism (~$0.07/image)",
    textToImage: process.env.FAL_SEEDREAM_PRO_T2I || "bytedance/seedream/v5/pro/text-to-image",
    edit: process.env.FAL_SEEDREAM_PRO_EDIT || "bytedance/seedream/v5/pro/edit",
    priceUsd: Number(process.env.FAL_SEEDREAM_PRO_PRICE_USD || 0.075),
    buildInput: ({ prompt, aspect, imageUrls }) => ({
      prompt, image_size: SEEDREAM_PRO_SIZE[aspect], num_images: 1, output_format: "png",
      ...(imageUrls?.length ? { image_urls: imageUrls } : {}),
    }),
  },
  standard: {
    id: "standard",
    label: "Nano Banana 2 — sharp, stricter filter (~$0.08/image)",
    textToImage: process.env.FAL_IMAGE_MODEL || "fal-ai/nano-banana-2",
    edit: process.env.FAL_IMAGE_EDIT_MODEL || "fal-ai/nano-banana-2/edit",
    priceUsd: Number(process.env.FAL_IMAGE_PRICE_USD || 0.08),
    buildInput: nanoInput,
  },
  lite: {
    id: "lite",
    label: "Nano Banana Lite — 1K images (~$0.05/image)",
    // The lite edit endpoint also works with no reference images, so it covers both jobs.
    textToImage: process.env.FAL_IMAGE_LITE_MODEL || "google/nano-banana-lite/edit",
    edit: process.env.FAL_IMAGE_LITE_MODEL || "google/nano-banana-lite/edit",
    priceUsd: Number(process.env.FAL_IMAGE_LITE_PRICE_USD || 0.05),
    buildInput: nanoInput,
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
  shotSeconds: number;     // 0 = use whole clip; otherwise keep only the first N seconds of each clip (fast cuts)
  clipSeconds: number;     // seconds per clip
  audio: boolean;          // model-generated sound (ambience, sfx, short lines)
  hookText: boolean;       // burn the hook text at the top of the reel
  subtitles: boolean;      // burn each scene's dialogue as subtitles
  endCard: boolean;        // curiosity card over the last seconds, pointing to the full story
  autoRun: boolean;        // run every step without stopping for review
  language: string;        // language of the hook text and any dialogue
  instructions: string;    // extra direction for the writer (audience, country, tone…)
  storyMode: StoryMode;    // original = new story with the same emotion; remake = same story, new look
  drama: DramaLevel;       // safe = no physical conflict; strong = slaps/pushes between adults, kids only implied in danger
  look: LookId;            // photographic style added to every image prompt
}

export type LookId = "tv-drama" | "natural" | "golden";

/** Photography style added to every image prompt. This is what makes stills look like a real TV drama. */
export const LOOKS: Record<LookId, { label: string; prompt: string }> = {
  "tv-drama": {
    label: "TV drama — cinematic, blurred background (recommended)",
    prompt:
      "Shot like a high-end American TV drama: cinema camera with an 85mm lens at f/1.8, shallow depth of field with a softly " +
      "blurred background, soft natural daylight, gentle contrast, realistic color grade. Real skin texture with pores and fine " +
      "lines, natural hair strands, detailed fabric. Expressive, believable acting. Sharp focus on the main face. " +
      "Unedited look: muted natural color grading like Kodak Portra film, no beauty retouching, no plastic or waxy skin, " +
      "no HDR, no over-sharpening, no glossy CGI look.",
  },
  natural: {
    label: "Natural — realistic everyday look",
    prompt:
      "Realistic everyday photo look, 35mm lens, natural indoor or outdoor light, true-to-life colors, real skin texture, " +
      "candid believable expressions, sharp focus on the faces. Unedited photo, no retouching, no plastic skin, no HDR, no CGI look.",
  },
  golden: {
    label: "Golden hour — warm emotional light",
    prompt:
      "Cinematic golden-hour light, warm backlight and soft glow, 85mm lens, shallow depth of field, real skin texture, " +
      "emotional film still with a gentle film grain. No retouching, no plastic skin, no CGI look.",
  },
};

export type DramaLevel = "safe" | "strong";

export type StoryMode = "original" | "remake";

export const DEFAULT_SETTINGS: ProjectSettings = {
  videoModel: "veo3.1-lite",
  imageTier: "flux2-pro",
  sceneCount: 3,
  shotSeconds: 0,
  clipSeconds: 6,
  audio: true,
  hookText: true,
  subtitles: true,
  endCard: true,
  autoRun: false,
  language: "English",
  instructions: "",
  storyMode: "original",
  drama: "safe",
  look: "tv-drama",
};

export function normalizeSettings(input: Partial<ProjectSettings> | null | undefined): ProjectSettings {
  const s = { ...DEFAULT_SETTINGS, ...(input || {}) };
  const model = VIDEO_MODELS[s.videoModel] ? s.videoModel : DEFAULT_SETTINGS.videoModel;
  return {
    ...s,
    videoModel: model,
    imageTier: IMAGE_TIERS[s.imageTier] ? s.imageTier : DEFAULT_SETTINGS.imageTier,
    sceneCount: clamp(Number(s.sceneCount) || 3, 1, 12),
    shotSeconds: Math.max(0, Math.min(15, Math.round((Number(s.shotSeconds) || 0) * 2) / 2)),
    clipSeconds: VIDEO_MODELS[model].snapSeconds(Number(s.clipSeconds) || 6),
    audio: Boolean(s.audio) && VIDEO_MODELS[model].supportsAudio,
    hookText: Boolean(s.hookText),
    subtitles: s.subtitles === undefined ? true : Boolean(s.subtitles),
    endCard: s.endCard === undefined ? true : Boolean(s.endCard),
    autoRun: Boolean(s.autoRun),
    language: String(s.language || "English").slice(0, 40),
    instructions: String(s.instructions || "").slice(0, 2000),
    storyMode: s.storyMode === "remake" ? "remake" : "original",
    drama: s.drama === "strong" ? "strong" : "safe",
    look: LOOKS[s.look as LookId] ? (s.look as LookId) : "tv-drama",
  };
}

export function estimateVideoCost(s: ProjectSettings, characterCount = 3): number {
  const m = VIDEO_MODELS[s.videoModel];
  const clips = s.sceneCount * s.clipSeconds * m.pricePerSecond(s.audio);
  const images = (characterCount + s.sceneCount) * IMAGE_TIERS[s.imageTier].priceUsd;
  return Math.round((clips + images) * 100) / 100;
}
