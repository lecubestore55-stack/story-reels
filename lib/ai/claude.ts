import Anthropic from "@anthropic-ai/sdk";
import { config, type ProjectSettings } from "../config";
import { StorySchema, type Analysis, type Story } from "../types";
import { isMock, mockStory } from "../mock";
import { routerJson } from "./router";

const STORY_TOOL = {
  name: "save_story",
  description: "Save the new original story and its shot list.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "Internal title of the new story" },
      logline: { type: "string", description: "One-sentence summary" },
      hook_text: { type: "string", description: "Text burned at the top of the reel, max 70 characters, creates curiosity, in the requested language" },
      setting: { type: "string", description: "Place, time of day, decor, lighting, color palette. Reused in every frame so it must be specific." },
      characters: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            key: { type: "string", description: "lowercase id with letters, digits, underscore, e.g. grandma" },
            name: { type: "string" },
            role: { type: "string" },
            visual: { type: "string", description: "Exact look for image generation: age, gender, skin tone, build, face, hair, outfit with colors. Same outfit in every scene." },
          },
          required: ["key", "name", "role", "visual"],
        },
      },
      scenes: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "0-based" },
            beat: { type: "string", description: "What happens in story terms" },
            characters: { type: "array", items: { type: "string" }, description: "keys of characters visible" },
            frame_prompt: { type: "string", description: "The still image this clip STARTS from: who is where, poses, expressions, framing, camera angle. Vertical 9:16. No text in image." },
            motion_prompt: { type: "string", description: "What moves during the clip: actions, expressions, camera movement. Physically simple and realistic." },
            dialogue: { type: ["string", "null"], description: "Optional short spoken line (max 12 words) or null" },
          },
          required: ["index", "beat", "characters", "frame_prompt", "motion_prompt", "dialogue"],
        },
      },
      originality: {
        type: "object",
        properties: {
          kept_from_reference: { type: "array", items: { type: "string" }, description: "Only abstract structure kept (e.g. 'surprise discovery', 'role reversal ending')" },
          changed: { type: "array", items: { type: "string" }, description: "Concrete differences from the reference" },
          risk_notes: { type: "string", description: "Anything still close to the reference that the user should change, or 'none'" },
        },
        required: ["kept_from_reference", "changed", "risk_notes"],
      },
    },
    required: ["title", "logline", "hook_text", "setting", "characters", "scenes", "originality"],
  },
};

const SYSTEM = `You write ORIGINAL short vertical video stories for a Facebook Reels page.
You are given a breakdown of a competitor's viral video. Use it only to learn the emotional mechanics.
Then write a NEW story that a viewer would never recognise as a copy.

Originality rules (strict):
- Keep only the abstract pattern (e.g. hidden injustice -> surprise discovery -> reversal). Never keep the plot.
- Change ALL of: the relationship between characters, the setting/location, the injustice itself, the key object or detail, how it is discovered, and how the ending reverses it.
- Use different ages, looks, outfits and names from the reference. Do not reuse any line of dialogue, caption or hook text from it.
- Do not reproduce the reference's shot compositions; design your own framing.
- No real people, brands, logos, celebrities or copyrighted characters.

Content rules (Facebook monetization + ad safety):
- No violence, injuries, blood, weapons, abuse shown on screen, nudity or sexual content.
- Conflict is emotional (unfairness, humiliation, betrayal, kindness rewarded). Children may appear but are never harmed on screen.
- The final scene is a strong visual twist that is NOT explained, so viewers want the full story.

Production rules (AI video):
- Each scene is ONE continuous shot that starts from a still image (frame_prompt) and animates it (motion_prompt).
- Keep actions simple and physically plausible: walking in, kneeling, turning, pointing, faces reacting. No fast action, no crowds, no text on screen.
- Keep the same characters, outfits and setting across scenes so they look continuous.
- Scene 0 must hook within 2 seconds.`;

export async function writeStory(args: {
  analysis: Analysis;
  notes: string | null;
  settings: ProjectSettings;
  avoid: string[];        // loglines of earlier stories made from the same reference
  feedback?: string;      // user's notes for a rewrite
  previous?: Story | null;
}): Promise<{ story: Story; cost: number }> {
  if (isMock()) return { story: mockStory(args.settings), cost: 0 };
  const { analysis, settings } = args;

  const parts = [
    `Reference breakdown (competitor video, for inspiration only):\n${JSON.stringify(analysis, null, 2)}`,
    args.notes?.trim() ? `Uploader notes about the reference:\n${args.notes.trim()}` : "",
    `Requirements:\n- Exactly ${settings.sceneCount} scenes of about ${settings.clipSeconds} seconds each (index 0..${settings.sceneCount - 1}).\n- Hook text and any dialogue in ${settings.language}.\n- Total length about ${settings.sceneCount * settings.clipSeconds} seconds.`,
    settings.instructions.trim() ? `Page owner's direction:\n${settings.instructions.trim()}` : "",
    args.avoid.length ? `Stories already made from this reference — yours must be clearly different from all of them:\n- ${args.avoid.join("\n- ")}` : "",
    args.previous && args.feedback
      ? `Your previous draft:\n${JSON.stringify(args.previous, null, 2)}\n\nRewrite it following this feedback from the page owner:\n${args.feedback}`
      : "",
  ].filter(Boolean);

  // No Anthropic key: use Claude through fal.ai (same FAL_KEY as images and video).
  if (!config.anthropicKey) {
    if (!config.falKey) throw new Error("Set FAL_KEY (or ANTHROPIC_API_KEY) to write stories");
    const { data, cost } = await routerJson({
      kind: "text",
      system: SYSTEM,
      prompt:
        parts.join("\n\n") +
        `\n\nAnswer with ONLY a JSON object (no markdown, no comments) that matches this JSON Schema:\n` +
        JSON.stringify(STORY_TOOL.input_schema),
      parse: (d) => StorySchema.parse(d),
    });
    return { story: normalize(data), cost };
  }

  const client = new Anthropic({ apiKey: config.anthropicKey });
  parts.push("Call save_story with the result.");
  const msg = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 6000,
    system: SYSTEM,
    tools: [STORY_TOOL],
    tool_choice: { type: "tool", name: "save_story" },
    messages: [{ role: "user", content: parts.join("\n\n") }],
  });

  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Claude did not return a story");
  return { story: normalize(StorySchema.parse(block.input)), cost: 0 };
}

function normalize(story: Story): Story {
  // Normalise scene indexes and character references.
  const keys = new Set(story.characters.map((c) => c.key));
  story.scenes = story.scenes
    .sort((a, b) => a.index - b.index)
    .map((s, i) => ({ ...s, index: i, characters: s.characters.filter((k) => keys.has(k)), dialogue: s.dialogue ?? null }));
  return story;
}
