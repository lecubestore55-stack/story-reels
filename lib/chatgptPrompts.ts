import type { Story, StoryCharacter, StoryScene } from "./types";

/**
 * Ready-to-paste prompts for making the images yourself in ChatGPT (free with your plan), then uploading them
 * with "Upload my image". Same wording as the platform's own image prompts.
 */
const NO_TEXT = "No text, no captions, no logo, no brand packaging, no watermark.";

export function chatgptCharacterPrompt(c: StoryCharacter, story: Story): string {
  if (c.role === "dish") {
    return (
      `Photorealistic close-up food photo of a homemade dish, vertical 9:16, the dish fills most of the frame, three-quarter angle, ` +
      `soft natural window light, shallow depth of field, real home kitchen softly blurred behind (${story.setting}). ` +
      `${c.name}: ${c.visual}. Real food with real textures, appetizing, generous, slightly imperfect homemade look, ` +
      `not plastic, not CGI, not overly styled. No people. ${NO_TEXT}`
    );
  }
  return (
    `Photorealistic casting photo of an actor for a TV drama, vertical 3:4. Three-quarter body, standing, facing the camera, ` +
    `calm natural expression, plain soft grey background, soft window light, 85mm lens. ${c.name} (${c.role}): ${c.visual}. ` +
    `Ordinary real person, real skin texture, natural hair, believable clothes. ${NO_TEXT}`
  );
}

export function chatgptFramePrompt(scene: StoryScene, story: Story, recipe: boolean): string {
  const refs = story.characters.filter((c) => scene.characters.includes(c.key));
  if (recipe) {
    const dish = refs.find((c) => c.role === "dish");
    return (
      `Scene ${scene.index + 1}. Vertical 9:16 photorealistic close-up still, the FIRST frame of a short cooking clip ` +
      `(the moment just before the action).\n${scene.frame_prompt}\n` +
      (dish
        ? `The finished dish must look exactly like the dish photo I attached.`
        : `This is a preparation step: show only the ingredients in their state at this step. The finished dish is NOT in this image.`) +
      ` Same kitchen and same hands as the previous images. Only hands, no faces. ${NO_TEXT}`
    );
  }
  return (
    `Scene ${scene.index + 1}. Vertical 9:16 photorealistic still from a TV drama, the FIRST frame of the shot ` +
    `(the moment just before the action).\nPlace: ${story.setting}\n${scene.frame_prompt}\n` +
    (refs.length ? `People (same faces and outfits as the photos I attached): ${refs.map((c) => `${c.name}: ${c.visual}`).join("; ")}.\n` : "") +
    `Natural light, real skin texture, not CGI. ${NO_TEXT}`
  );
}

/** One message to start the ChatGPT conversation, so every image keeps the same kitchen / people. */
export function chatgptStartMessage(story: Story, recipe: boolean): string {
  return recipe
    ? `I am making a vertical 9:16 recipe reel: "${story.title}". For every image in this chat keep exactly the same ` +
        `kitchen (${story.setting}), the same cookware, the same cook's hands (no face ever), natural daylight, shallow depth ` +
        `of field, photorealistic real food, vertical 9:16, ${NO_TEXT.toLowerCase()} Each image is the FIRST frame of a short ` +
        `clip: the moment just before the action. Reply "ready" and wait for my scenes.`
    : `I am making a vertical 9:16 TV-drama reel: "${story.title}". For every image in this chat keep exactly the same ` +
        `place (${story.setting}) and the same people with the same faces and outfits as the photos I attach. Photorealistic, ` +
        `natural light, vertical 9:16, ${NO_TEXT.toLowerCase()} Each image is the FIRST frame of a shot: the moment just before ` +
        `the action. Reply "ready" and wait for my scenes.`;
}

export function chatgptAll(story: Story, recipe: boolean): string {
  return [
    `--- 1) First message ---\n${chatgptStartMessage(story, recipe)}`,
    ...story.characters.map((c) => `--- ${recipe ? "Dish photo" : `Character: ${c.name}`} ---\n${chatgptCharacterPrompt(c, story)}`),
    ...story.scenes.map((s) => `--- Scene ${s.index + 1} ---\n${chatgptFramePrompt(s, story, recipe)}`),
  ].join("\n\n");
}
