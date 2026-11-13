import { z } from "zod";

// ---------- Gemini: breakdown of the competitor reference video ----------
export const AnalysisSchema = z.object({
  summary: z.string(),
  duration_seconds: z.number(),
  genre: z.string(),                      // e.g. "family injustice / karma"
  emotional_pattern: z.string(),          // the abstract trope that makes it work
  hook: z.string(),                       // what grabs attention in the first 2 seconds
  twist: z.string(),                      // how it ends / what is left unexplained
  why_viral: z.array(z.string()),
  characters: z.array(z.object({ role: z.string(), description: z.string() })),
  setting: z.string(),
  beats: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      action: z.string(),
      camera: z.string(),
      emotion: z.string(),
    }),
  ),
  visual_style: z.string(),
  audio: z.string(),                      // music, sfx, narration
  on_screen_text: z.array(z.string()),
  transcript: z.string(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

// ---------- Claude: the new original story ----------
export const CharacterSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/),  // stable id, e.g. "grandma"
  name: z.string(),
  role: z.string(),
  visual: z.string(),                     // exact look: age, skin, hair, face, outfit — reused in every image
});

export const SceneSchema = z.object({
  index: z.number().int(),
  beat: z.string(),                       // what happens in story terms
  characters: z.array(z.string()),        // character keys visible in this scene
  frame_prompt: z.string(),               // the still image the clip starts from
  motion_prompt: z.string(),              // what moves: action + camera, for the video model
  dialogue: z.string().nullable().optional(),
});

export const StorySchema = z.object({
  title: z.string(),
  logline: z.string(),
  hook_text: z.string(),                  // burned at the top of the reel
  end_text: z.string().default("What happened next? Full story in the comments 👇"), // card over the last seconds
  setting: z.string(),                    // place + look, reused in every frame
  characters: z.array(CharacterSchema).min(1).max(5),
  scenes: z.array(SceneSchema).min(1).max(8),
  originality: z.object({
    kept_from_reference: z.array(z.string()),   // only abstract structure
    changed: z.array(z.string()),               // concrete differences
    risk_notes: z.string(),
  }),
});
export type Story = z.infer<typeof StorySchema>;
export type StoryCharacter = z.infer<typeof CharacterSchema>;
export type StoryScene = z.infer<typeof SceneSchema>;

export type JobType = "analyze" | "write" | "characters" | "frames" | "clips" | "render";

export interface AssetRow {
  id: number;
  project_id: string;
  kind: "character" | "frame" | "clip";
  ref: string;
  status: "pending" | "generating" | "ready" | "failed";
  path: string | null;
  remote_url: string | null;
  fal_endpoint: string | null;
  fal_request_id: string | null;
  prompt: string | null;
  error: string | null;
}
