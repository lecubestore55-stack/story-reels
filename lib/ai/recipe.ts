import Anthropic from "@anthropic-ai/sdk";
import { config, type ProjectSettings } from "../config";
import { StorySchema, type Analysis, type Story } from "../types";
import { isMock, mockRecipe } from "../mock";
import { routerJson } from "./router";
import { STORY_TOOL, ensureEnglish, normalize } from "./claude";

/**
 * Recipe reels reuse the story pipeline: the dish is the only "character" (one reference photo keeps it
 * identical in every shot), the scenes are food shots (cut, lift, pour, cross-section…), and nobody talks.
 */
// Built lazily: claude.ts and this file import each other.
const recipeTool = () => ({
  name: "save_story",
  description: "Save the recipe reel plan and its shot list.",
  input_schema: {
    ...STORY_TOOL.input_schema,
    properties: {
      ...STORY_TOOL.input_schema.properties,
      title: { type: "string", description: "Dish name. ENGLISH." },
      logline: { type: "string", description: "One sentence: the dish and the satisfying moment the reel shows. ENGLISH." },
      hook_text: {
        type: "string",
        description: "Text burned at the top of the reel, max 60 characters, in the requested language. Craving/curiosity, e.g. 'The dessert everyone asks me for 😍'. Can include 1 emoji.",
      },
      end_text: {
        type: "string",
        description: "Card over the last 2-3 seconds, max 70 characters, in the requested language, sending viewers to the full recipe, e.g. 'Full recipe in the comments 👇'.",
      },
      setting: {
        type: "string",
        description: "Kitchen and props reused in every shot: counter material, background (soft-focus kitchen), light, the cook's hands (skin tone, sleeves, no face). ENGLISH.",
      },
      characters: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: {
          type: "object",
          properties: {
            key: { type: "string", description: "Always 'dish'" },
            name: { type: "string", description: "Short dish name in ENGLISH, e.g. 'Oreo cream poke cake'" },
            role: { type: "string", description: "Always 'dish'" },
            visual: {
              type: "string",
              description:
                "Exact look of the finished dish for image generation: the dish/pan/plate, every layer from bottom to top with colors and thickness, textures, toppings, garnish, portion size. Reused in every shot. ENGLISH only.",
            },
          },
          required: ["key", "name", "role", "visual"],
        },
      },
      voiceover: {
        type: ["string", "null"],
        description:
          "Narration spoken over the whole reel, in the requested language, or null when the reference has no voice-over. " +
          "Short, warm, natural home-cook voice; must fit the reel length (about 2.3 words per second).",
      },
      scenes: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "0-based" },
            beat: { type: "string", description: "What the shot shows, e.g. 'spatula lifts the first slice'. ENGLISH." },
            characters: {
              type: "array",
              items: { type: "string" },
              description:
                "['dish'] ONLY when the FINISHED dish is in the shot (opening money shot, final plate, cutting/tasting the finished dish). " +
                "[] for every preparation step (raw ingredients, cooking in the pan, filling, topping, going into the oven).",
            },
            frame_prompt: {
              type: "string",
              description:
                "FIRST frame = the moment just BEFORE the action (knife above the cake, spoon resting on the surface, full pan before the cut). " +
                "Describe the food EXACTLY in its state at this step (e.g. 'raw ground beef just added to a hot black skillet', " +
                "'six empty tortilla cones standing in a baking tray', 'filled cones with no cheese yet'). Never put the finished dish " +
                "in a preparation step. Close framing, the food fills most of the vertical 9:16 frame, shallow depth of field, " +
                "only the cook's hands may appear (no faces). ENGLISH.",
            },
            motion_prompt: {
              type: "string",
              description:
                "One slow satisfying food action in the clip: cutting, lifting a slice to show the layers, pouring sauce, cheese pull, crunch, fork breaking a piece; slow push-in or gentle handheld camera. Physically realistic food behavior. ENGLISH.",
            },
            dialogue: { type: "null", description: "Always null: recipe reels have no talking" },
            speaker: { type: "null", description: "Always null" },
          },
          required: ["index", "beat", "characters", "frame_prompt", "motion_prompt", "dialogue", "speaker"],
        },
      },
    },
  },
});

const SYSTEM_REMAKE = `You REMAKE short vertical RECIPE reels for a Facebook food page that sends viewers to recipes on its website.
A remake keeps the SAME recipe and the SAME sequence of shots as the reference, but everything you see is new,
so the reel is original footage and not a repost.

Keep exactly:
- the same dish and the same recipe steps, in the same order;
- one scene per reference shot, same action in each shot (e.g. browning beef in a pan, spooning filling into a cone,
  sprinkling cheese, tray into the oven, cheese pull on the plate), similar framing and length;
- the same hook idea (if it opens on the finished dish / cheese pull, so does yours) and the same ending.
Change everything visual: the cook's hands (skin tone, nail color, jewelry, sleeves), the kitchen and counter, the cookware,
plates and props, the light, small plating details. Never copy text from the reference.

Sound: the reel keeps natural cooking sounds (sizzle, crunch, knife, oven door) — mention the sound in each motion_prompt.
Voice-over: if the reference has a narrator (see its audio/transcript), write "voiceover" = the same narration adapted
(not word for word) into the requested language and fitted to the reel length. If it has no voice, voiceover = null.

Each step shows the food in its real state at that moment (raw beef browning, empty cones, filled cones without cheese,
unbaked tray going into the oven); the finished dish appears ONLY in the shots where the reference shows it finished.
Rules: only hands, never faces. Nobody speaks on camera (dialogue and speaker null).
title, logline, setting, character fields, beat, frame_prompt and motion_prompt in ENGLISH; hook_text, end_text and voiceover
in the requested language. The dish is the only "character" and its look stays identical in every shot where it is finished.`;

const SYSTEM = `You plan short vertical RECIPE reels for a Facebook food page that sends viewers to recipes on its website.
The reels are "food porn": no talking, no faces, one appetizing dish, slow satisfying actions in close-up
(cutting into it, lifting a tall slice to show every layer, gooey/creamy/crunchy textures, a final cross-section money shot).

Rules:
- Cooking STEPS show the food in its real state at that moment (raw, browning, unfilled, unbaked); the finished dish
  appears ONLY in the money shots (usually the first and last). Steps follow the real order of the recipe.
- One dish only. Its look (layers, toppings, pan, plate) must be described precisely and stay identical in every shot.
- Make it look homemade but irresistible: real food, generous portions, natural light in a real home kitchen.
- Each shot = one simple action that a video model can do realistically. No text, no logos, no brand packaging in the image.
- Only hands may appear, never faces. Nobody speaks.
- The first second must already show the dish big in frame (that is the hook).
- The last shot is the money shot (best close-up of the inside/texture). The end card then sends people to the full recipe.
- title, logline, setting, character fields, beat, frame_prompt and motion_prompt in ENGLISH; only hook_text and end_text in the requested language.
- Do not copy the reference: use a DIFFERENT dish (or the dish the page owner asks for), a different kitchen, different dish/plate and props; keep only the satisfying rhythm.`;

export async function writeRecipe(args: {
  analysis: Analysis;
  notes: string | null;
  settings: ProjectSettings;
  avoid: string[];
  feedback?: string;
  previous?: Story | null;
}): Promise<{ story: Story; cost: number }> {
  if (isMock()) return { story: mockRecipe(args.settings), cost: 0 };
  const { analysis, settings } = args;
  const remake = settings.storyMode === "remake";
  const total = settings.sceneCount * (settings.shotSeconds || settings.clipSeconds);
  const parts = [
    `Reference recipe reel (competitor${remake ? "" : ", for rhythm and style only"}):\n${JSON.stringify(analysis, null, 2)}`,
    analysis.shots
      ? `Reference rhythm (measured): ${analysis.shots.duration}s long, ${analysis.shots.count} shot(s), lengths: ${analysis.shots.durations.join(", ")}s.`
      : "",
    args.notes?.trim() ? `Uploader notes:\n${args.notes.trim()}` : "",
    `Requirements:\n- Exactly ${settings.sceneCount} shots (index 0..${settings.sceneCount - 1}), about ${settings.clipSeconds} seconds each.` +
      `\n- hook_text and end_text in ${settings.language}, natural for ${settings.country || "the audience"}.` +
      (settings.country
        ? `\n- Audience: ${settings.country}. Choose a dish people there love or crave (or a local twist), kitchen and tableware that feel local.`
        : "") +
      `\n- dialogue and speaker are always null.` +
      (remake && analysis.shots && analysis.shots.count === settings.sceneCount
        ? `\n- Follow the reference shots one by one: scene i = reference shot i (lengths ${analysis.shots.durations.join(", ")}s).`
        : "") +
      `\n- The final reel is about ${Math.round(total)} seconds: a voiceover (if any) must be at most ${Math.round(total * 2.3)} words.` +
      (remake ? "" : `\n- voiceover: null unless the page owner asks for narration.`),
    settings.instructions.trim()
      ? `Page owner's direction (the recipe to show, from their blog — follow it exactly):\n${settings.instructions.trim()}`
      : "",
    args.avoid.length ? `Dishes already made from this reference — choose a clearly different one:\n- ${args.avoid.join("\n- ")}` : "",
    args.previous && args.feedback
      ? `Your previous draft:\n${JSON.stringify(args.previous, null, 2)}\n\nRewrite it following this feedback:\n${args.feedback}`
      : "",
  ].filter(Boolean);

  let story: Story;
  let cost = 0;
  if (!config.anthropicKey) {
    if (!config.falKey) throw new Error("Set FAL_KEY (or ANTHROPIC_API_KEY) to write recipe reels");
    const r = await routerJson({
      kind: "text",
      system: remake ? SYSTEM_REMAKE : SYSTEM,
      prompt:
        parts.join("\n\n") +
        `\n\nAnswer with ONLY a JSON object (no markdown) that matches this JSON Schema:\n${JSON.stringify(recipeTool().input_schema)}`,
      parse: (d) => StorySchema.parse(d),
    });
    story = r.data;
    cost = r.cost;
  } else {
    const client = new Anthropic({ apiKey: config.anthropicKey });
    parts.push("Call save_story with the result.");
    const msg = await client.messages.create({
      model: config.claudeModel,
      max_tokens: 4000,
      system: remake ? SYSTEM_REMAKE : SYSTEM,
      tools: [recipeTool() as any],
      tool_choice: { type: "tool", name: "save_story" },
      messages: [{ role: "user", content: parts.join("\n\n") }],
    });
    const block = msg.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") throw new Error("Claude did not return a recipe plan");
    story = StorySchema.parse(block.input);
  }
  // Force the recipe shape whatever the model returned.
  story.characters = story.characters.slice(0, 1).map((c) => ({ ...c, key: "dish", role: "dish", gender: null, age: null, voice: null }));
  story.scenes = story.scenes.map((s) => ({ ...s, characters: s.characters.includes("dish") ? ["dish"] : [], dialogue: null, speaker: null }));
  const fixed = await ensureEnglish(normalize(story));
  return { story: fixed.story, cost: cost + fixed.cost };
}
