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
      end_text: { type: "string", description: "Card shown over the last 2-3 seconds that sends viewers to the full story, max 80 characters, in the requested language, e.g. 'What she found in that room… Full story in the comments 👇'. Must create curiosity, never reveal the answer." },
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
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "0-based" },
            beat: { type: "string", description: "What happens in story terms" },
            characters: { type: "array", items: { type: "string" }, description: "keys of characters visible" },
            frame_prompt: { type: "string", description: "The FIRST frame of the clip = the moment just BEFORE the action (never the peak or result): who is where, poses, expressions, framing, camera angle, and continuity details from the previous scene. Vertical 9:16. No text in image." },
            motion_prompt: { type: "string", description: "What moves during the clip: actions, expressions, camera movement. Physically simple and realistic." },
            dialogue: { type: ["string", "null"], description: "Optional short spoken line (max 12 words) or null. ONE speaker only." },
            speaker: { type: ["string", "null"], description: "Key of the character who says the dialogue (must be in this scene's characters and visible), or null when there is no dialogue" },
          },
          required: ["index", "beat", "characters", "frame_prompt", "motion_prompt", "dialogue", "speaker"],
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
    required: ["title", "logline", "hook_text", "end_text", "setting", "characters", "scenes", "originality"],
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
- frame_prompt is the FIRST FRAME of the shot = the moment just BEFORE the action. The action itself happens in
  motion_prompt. Never put the peak or the result of the action in frame_prompt, and never freeze anyone mid-air.
  Examples: diving → frame: Rosa running to the pool edge, arms starting to lift; motion: she dives in.
  Slap → frame: the two women face to face, Camila's hand starting to rise; motion: the slap and the reaction.
  Stroller falls → frame: the stroller rolling near the edge; motion: it tips over and splashes.
- Continuity: each frame_prompt must match how the previous scene ENDED (positions, who holds the baby, wet
  clothes after the pool, objects already in the water, time of day). Write these details explicitly.
- Each scene shows ONE clear action that a viewer understands in 2 seconds, and the scenes follow cause → effect
  in a logical order (no action shown twice, no jumps that skip what the viewer needs to understand).
- Dialogue: at most ONE speaker per scene. Set "speaker" to that character's key, make sure they are in the scene's
  characters, and in frame_prompt/motion_prompt keep the speaker's face visible and the camera on them while they talk
  (the listener can be in the blurred foreground). Never give a line to one character while the shot is about another.
- Frame every shot like a TV drama: emotional close-ups and medium close-ups of faces, over-the-shoulder shots with the
  other person softly blurred in the foreground, reaction shots, and only a few wide shots to set the place.
  Name the shot type at the start of each frame_prompt (e.g. "Close-up, over the husband's shoulder: …").
- frame_prompt and motion_prompt go to image/video models with strict safety filters that block distressed children.
  In those two fields describe children as calm, serious, sad or worried — never crying, tears, trembling, scared,
  shouted at, on the floor eating scraps, or near anyone acting aggressively. Show conflict between adults with
  posture and looks (arms crossed, pointing, stepping back). Put the emotional intensity in the dialogue instead.
- Scene 0 must hook within 2 seconds.`;

const SYSTEM_REMAKE = `You adapt a competitor's viral short vertical video into a REMAKE for a Facebook Reels page.
Keep the SAME story: the same events in the same order, the same conflict and the same twist — but end the reel on a cliffhanger right before the final payoff (see Ending).
Keep the dialogue: reuse the spoken lines from the transcript (translate them if another language is requested;
you may shorten a line to fit the clip length).

Change the LOOK completely so it is a new production, not a re-upload:
- New characters: different names, different faces, ages within the same role, hair, skin tone and outfits.
- A different location look: different house/room style, decor, colors, lighting and time of day.
- Your own camera framing and angles for each shot; never copy the reference compositions.
- New hook text in your own words (same promise, different wording).
- No real people, brands, logos, celebrities or copyrighted characters.

Content rules (Facebook monetization + ad safety) — these override the reference:
- No violence, hitting, tackling, injuries, blood or weapons on screen. If the reference has a physical fight,
  stage it without contact: the protector steps in between, raises a hand to stop them, or holds a wrist firmly.
- No nudity or sexual content. Children may appear but are never harmed on screen.

Production rules (AI video):
- Each scene is ONE continuous shot that starts from a still image (frame_prompt) and animates it (motion_prompt).
- Map the reference beats onto the requested number of scenes in order. Keep actions simple and physically plausible.
- Keep the same characters, outfits and setting across scenes so they look continuous.
- frame_prompt is the FIRST FRAME of the shot = the moment just BEFORE the action. The action itself happens in
  motion_prompt. Never put the peak or the result of the action in frame_prompt, and never freeze anyone mid-air.
  Examples: diving → frame: Rosa running to the pool edge, arms starting to lift; motion: she dives in.
  Slap → frame: the two women face to face, Camila's hand starting to rise; motion: the slap and the reaction.
  Stroller falls → frame: the stroller rolling near the edge; motion: it tips over and splashes.
- Continuity: each frame_prompt must match how the previous scene ENDED (positions, who holds the baby, wet
  clothes after the pool, objects already in the water, time of day). Write these details explicitly.
- Each scene shows ONE clear action that a viewer understands in 2 seconds, and the scenes follow cause → effect
  in a logical order (no action shown twice, no jumps that skip what the viewer needs to understand).
- Dialogue: at most ONE speaker per scene. Set "speaker" to that character's key, make sure they are in the scene's
  characters, and in frame_prompt/motion_prompt keep the speaker's face visible and the camera on them while they talk
  (the listener can be in the blurred foreground). Never give a line to one character while the shot is about another.
- Frame every shot like a TV drama: emotional close-ups and medium close-ups of faces, over-the-shoulder shots with the
  other person softly blurred in the foreground, reaction shots, and only a few wide shots to set the place.
  Name the shot type at the start of each frame_prompt (e.g. "Close-up, over the husband's shoulder: …").
- frame_prompt and motion_prompt go to image/video models with strict safety filters that block distressed children.
  In those two fields describe children as calm, serious, sad or worried — never crying, tears, trembling, scared,
  shouted at, on the floor eating scraps, or near anyone acting aggressively. Show conflict between adults with
  posture and looks (arms crossed, pointing, stepping back). Put the emotional intensity in the dialogue instead.
- In "originality": kept_from_reference = what you kept (plot, dialogue…), changed = every visual change, and
  risk_notes = an honest note that this is a remake of the same story.`;

// Replaces the content rules above when the page owner picks "Strong drama".
const STRONG_DRAMA = `
DRAMA LEVEL: STRONG — this replaces the content rules above.
- Physical drama between ADULTS is allowed and should be visible: a slap, a shove, grabbing an arm, someone falling
  into a pool, a dramatic fall to the ground. Keep it short and theatrical: no blood, no wounds, no weapons, no gore.
- Danger to a child or baby must be IMPLIED, never shown, using the competitor's shot trick:
  * show the threat without the child in frame (an EMPTY stroller rolling into the pool, a door slamming, an
    off-screen sound, the adults' shocked faces);
  * show the child only when safe (held in someone's arms, standing behind the protector, sleeping calmly).
  * A child and an aggressive adult or a dangerous object are never in the same shot.
- The scene's "characters" list must contain ONLY who is visible in that shot. Leave the child out of every
  scene where the danger or the physical conflict happens.
- In frame_prompt/motion_prompt describe children as calm or safe; the shock comes from the adults and the
  situation. Dialogue can be intense.
- Monetization note: keep at most one physical action per reel, and never show anyone lying hurt.`;

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
  const remake = settings.storyMode === "remake";
  const system = (remake ? SYSTEM_REMAKE : SYSTEM) + (settings.drama === "strong" ? STRONG_DRAMA : "");

  const parts = [
    remake
      ? `Reference video to remake (keep its story, beats, twist and dialogue; change every visual):\n${JSON.stringify(analysis, null, 2)}`
      : `Reference breakdown (competitor video, for inspiration only):\n${JSON.stringify(analysis, null, 2)}`,
    analysis.shots
      ? `Reference rhythm (measured): ${analysis.shots.duration}s long, ${analysis.shots.count} shots, shot lengths in seconds: ${analysis.shots.durations.join(", ")}. Match this pacing with your scenes.`
      : "",
    remake && analysis.transcript?.trim() ? `Dialogue to keep (transcript of the reference):\n${analysis.transcript.trim()}` : "",
    args.notes?.trim() ? `Uploader notes about the reference:\n${args.notes.trim()}` : "",
    (() => {
      const shown = settings.shotSeconds > 0 && settings.shotSeconds < settings.clipSeconds ? settings.shotSeconds : settings.clipSeconds;
      const fast = shown < settings.clipSeconds;
      return (
        `Requirements:\n- Exactly ${settings.sceneCount} scenes (index 0..${settings.sceneCount - 1}).` +
        (fast
          ? `\n- FAST CUTS: each clip is generated at ${settings.clipSeconds}s but only its first ${shown}s are shown. Put the key action in the first ${shown} seconds of each shot, one simple action per shot, like a quickly edited TV drama (reaction shots, close-ups, wide shots).` +
            `\n- Spoken lines must fit in ${shown}s: at most ${Math.max(4, Math.round(shown * 2.5))} words, or null.`
          : `\n- About ${settings.clipSeconds} seconds per scene.`) +
        `\n- Hook text and any dialogue in ${settings.language}.\n- Total reel length about ${Math.round(settings.sceneCount * shown)} seconds.`
      );
    })(),
    `Ending (very important): the reel is a TEASER for the full story on our website. The last scene must stop at the moment of highest tension, right BEFORE the answer or the payoff (a shocked face, a door about to open, a hidden object half-seen, a line cut off). Do not resolve the story in the video. The end_text card then invites viewers to read what happened next in the comments.`,
    settings.instructions.trim() ? `Page owner's direction:\n${settings.instructions.trim()}` : "",
    args.avoid.length && !remake ? `Stories already made from this reference — yours must be clearly different from all of them:\n- ${args.avoid.join("\n- ")}` : "",
    args.previous && args.feedback
      ? `Your previous draft:\n${JSON.stringify(args.previous, null, 2)}\n\nRewrite it following this feedback from the page owner:\n${args.feedback}`
      : "",
  ].filter(Boolean);

  // No Anthropic key: use Claude through fal.ai (same FAL_KEY as images and video).
  if (!config.anthropicKey) {
    if (!config.falKey) throw new Error("Set FAL_KEY (or ANTHROPIC_API_KEY) to write stories");
    const { data, cost } = await routerJson({
      kind: "text",
      system,
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
    system,
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
    .map((s, i) => {
      const characters = s.characters.filter((k) => keys.has(k));
      const dialogue = s.dialogue?.trim() ? s.dialogue.trim() : null;
      let speaker = dialogue && s.speaker && keys.has(s.speaker) ? s.speaker : null;
      if (speaker && !characters.includes(speaker)) characters.push(speaker); // the speaker must be on screen
      return { ...s, index: i, characters, dialogue, speaker };
    });
  return story;
}
