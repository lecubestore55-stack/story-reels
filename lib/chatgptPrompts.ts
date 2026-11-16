import type { Story, StoryCharacter, StoryScene } from "./types";

/**
 * Ready-to-paste prompts for making the images yourself in ChatGPT (free with your plan), then uploading them
 * with "Upload my image". Every prompt repeats the fixed details (dish, kitchen, hands, framing) so all images match.
 */
const NO_TEXT = "No text, no captions, no logo, no brand packaging, no watermark.";
const FOOD_LOOK =
  "Photorealistic, real homemade food with real textures, slightly messy, not styled, not plastic, not CGI. " +
  "Soft natural window light, shallow depth of field.";
const CLOSE =
  "CLOSE framing: the food fills 85% of the vertical 9:16 frame, camera at 45 degrees, almost no background " +
  "(only a blurred hint of the kitchen at the very top).";

const dishOf = (story: Story) => story.characters.find((c) => c.role === "dish");

export function chatgptCharacterPrompt(c: StoryCharacter, story: Story): string {
  if (c.role === "dish") {
    return (
      `Make the photo of the FINISHED dish, just out of the oven, vertical 9:16.\n` +
      `Dish: ${c.name}. ${c.visual}\n` +
      `Every item keeps its real, instantly recognizable shape.\n` +
      `${CLOSE}\n` +
      `One portion already scooped out so the inside and the sauce are visible, a little steam rising.\n` +
      `Kitchen: ${story.setting}\n` +
      `${FOOD_LOOK} No people. ${NO_TEXT}`
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
      `Scene ${scene.index + 1} of the same reel — first frame of a short clip (the moment just before the action), vertical 9:16.\n` +
      `${scene.frame_prompt}\n` +
      (dish
        ? `The finished dish is EXACTLY the dish of the photo I made earlier in this chat (same vessel, same items, same toppings): ${dish.visual}\n`
        : `This is a preparation step: show only the ingredients in their real state at this step. The finished dish is NOT in this image.\n`) +
      `Same kitchen, same cookware and same hands as the previous images: ${story.setting}\n` +
      `${CLOSE} Only hands may appear, never a face.\n${FOOD_LOOK} ${NO_TEXT}`
    );
  }
  return (
    `Scene ${scene.index + 1}. Vertical 9:16 photorealistic still from a TV drama, the FIRST frame of the shot ` +
    `(the moment just before the action).\nPlace: ${story.setting}\n${scene.frame_prompt}\n` +
    (refs.length ? `People (same faces and outfits as the photos I attached): ${refs.map((c) => `${c.name}: ${c.visual}`).join("; ")}.\n` : "") +
    `Natural light, real skin texture, not CGI. ${NO_TEXT}`
  );
}

/** First message of the ChatGPT conversation: fixes the dish, kitchen, hands and framing for every image. */
export function chatgptStartMessage(story: Story, recipe: boolean): string {
  const dish = dishOf(story);
  return recipe
    ? `I am making a vertical 9:16 recipe reel: "${story.title}". I will ask you for several images in this chat. ` +
        `In EVERY image keep exactly the same:\n` +
        `- Kitchen, cookware and the cook's hands: ${story.setting}\n` +
        (dish ? `- The finished dish (when it appears): ${dish.visual}\n` : "") +
        `- Framing: ${CLOSE}\n` +
        `- Style: ${FOOD_LOOK} Only hands, never a face. ${NO_TEXT}\n` +
        `Each image is the first frame of a short video clip: the moment just before the action. ` +
        `Reply "ready" and wait for my images.`
    : `I am making a vertical 9:16 TV-drama reel: "${story.title}". For every image in this chat keep exactly the same ` +
        `place (${story.setting}) and the same people with the same faces and outfits as the photos I attach. Photorealistic, ` +
        `natural light, vertical 9:16. ${NO_TEXT} Each image is the FIRST frame of a shot: the moment just before ` +
        `the action. Reply "ready" and wait for my scenes.`;
}

export function chatgptAll(story: Story, recipe: boolean): string {
  return [
    `--- 1) First message ---\n${chatgptStartMessage(story, recipe)}`,
    ...story.characters.map((c) => `--- ${recipe ? "2) Dish photo" : `Character: ${c.name}`} ---\n${chatgptCharacterPrompt(c, story)}`),
    ...story.scenes.map((s) => `--- Scene ${s.index + 1} ---\n${chatgptFramePrompt(s, story, recipe)}`),
  ].join("\n\n");
}
