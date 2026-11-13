import { GoogleGenAI, createPartFromUri, createUserContent } from "@google/genai";
import { config } from "../config";
import { AnalysisSchema, type Analysis } from "../types";
import { isMock, mockAnalysis } from "../mock";

const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    duration_seconds: { type: "number" },
    genre: { type: "string" },
    emotional_pattern: { type: "string" },
    hook: { type: "string" },
    twist: { type: "string" },
    why_viral: { type: "array", items: { type: "string" } },
    characters: {
      type: "array",
      items: { type: "object", properties: { role: { type: "string" }, description: { type: "string" } }, required: ["role", "description"] },
    },
    setting: { type: "string" },
    beats: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "number" }, end: { type: "number" }, action: { type: "string" },
          camera: { type: "string" }, emotion: { type: "string" },
        },
        required: ["start", "end", "action", "camera", "emotion"],
      },
    },
    visual_style: { type: "string" },
    audio: { type: "string" },
    on_screen_text: { type: "array", items: { type: "string" } },
    transcript: { type: "string" },
  },
  required: [
    "summary", "duration_seconds", "genre", "emotional_pattern", "hook", "twist", "why_viral",
    "characters", "setting", "beats", "visual_style", "audio", "on_screen_text", "transcript",
  ],
};

const PROMPT = `You are a short-form video analyst for a Facebook Reels story page.
Watch this viral short story video (picture AND sound) and break down WHY it works, so a writer
can make a completely different, original story that uses the same emotional mechanics.

Fill every field:
- summary: what literally happens, in 3-4 sentences.
- emotional_pattern: the abstract trope, with no names or specifics (e.g. "a powerless person is mistreated in secret; a protector discovers it by surprise; roles are reversed").
- hook: what grabs attention in the first 2 seconds and why.
- twist: how the video ends and what it deliberately leaves unexplained to make people want the rest.
- why_viral: 3-6 concrete reasons (emotion, curiosity gap, injustice, relatability...).
- characters: roles and visible look (age range, clothes) — no real-person identification.
- beats: timestamped beats in seconds covering the whole video, with camera movement and emotion.
- visual_style: realism, lighting, colors, framing (vertical?), pacing.
- audio: music, sound effects, voices.
- on_screen_text: every caption/text overlay, verbatim (empty list if none).
- transcript: any spoken words or narration, verbatim (empty string if none).`;

export async function analyzeVideo(filePath: string, notes: string | null, mimeType = "video/mp4"): Promise<Analysis> {
  if (isMock()) return mockAnalysis();
  if (!config.geminiKey) throw new Error("GEMINI_API_KEY is not set");
  const ai = new GoogleGenAI({ apiKey: config.geminiKey });

  let file = await ai.files.upload({ file: filePath, config: { mimeType } });
  // Videos must finish processing before they can be used.
  for (let i = 0; i < 60 && file.state === "PROCESSING"; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    file = await ai.files.get({ name: file.name! });
  }
  if (file.state === "FAILED") throw new Error("Gemini could not process this video");

  try {
    const extra = notes?.trim() ? `\n\nNotes from the uploader (caption, story text, stats):\n${notes.trim()}` : "";
    const response = await ai.models.generateContent({
      model: config.geminiModel,
      contents: createUserContent([createPartFromUri(file.uri!, file.mimeType || mimeType), PROMPT + extra]),
      config: { responseMimeType: "application/json", responseJsonSchema: ANALYSIS_JSON_SCHEMA, temperature: 0.4 },
    });
    const text = response.text || "";
    return AnalysisSchema.parse(JSON.parse(text));
  } finally {
    // Don't leave competitor videos sitting in your Google project.
    if (file.name) await ai.files.delete({ name: file.name }).catch(() => {});
  }
}
