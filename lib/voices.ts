import { ALL_VOICES, CHILD_VOICES, FEMALE_VOICES, MALE_VOICES } from "./config";
import type { Story, StoryCharacter } from "./types";

const childWords = /\b(child|kid|girl|boy|daughter|son|toddler|baby|little)\b/i;
const femaleWords = /\b(woman|girl|female|mother|mom|daughter|wife|nanny|grandma|grandmother|sister|aunt|stepmother|she|her|lady)\b/i;

export const isKid = (c: StoryCharacter) =>
  typeof c.age === "number" ? c.age < 13 : childWords.test(`${c.role} ${c.visual}`) || /\b([1-9]|1[0-2])[- ]?(year|yr)s?[- ]?old\b/i.test(c.visual);
export const isFemale = (c: StoryCharacter) => (c.gender ? c.gender === "female" : femaleWords.test(`${c.role} ${c.visual}`));

/** A different ElevenLabs voice for each character (or the one chosen in the story editor). */
export function voiceMap(story: Pick<Story, "characters">): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const c of story.characters) if (c.voice && ALL_VOICES.includes(c.voice)) { out.set(c.key, c.voice); used.add(c.voice); }
  for (const c of story.characters) {
    if (out.has(c.key)) continue;
    const list = isKid(c) ? CHILD_VOICES : isFemale(c) ? FEMALE_VOICES : MALE_VOICES;
    const v = list.find((x) => !used.has(x)) || list[0];
    used.add(v);
    out.set(c.key, v);
  }
  return out;
}
