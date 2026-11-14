import { ALL_VOICES, CHILD_VOICES, FEMALE_VOICES, MALE_VOICES } from "./config";
import type { Story, StoryCharacter } from "./types";

// "son"/"daughter" say nothing about age (a 32-year-old son), so they are not child words.
const childWords = /\b(child|kid|toddler|baby|girl|boy|schoolgirl|schoolboy|little)\b/i;
const femaleWords = /\b(woman|girl|female|mother|mom|daughter|wife|nanny|grandma|grandmother|sister|aunt|stepmother|she|her|lady)\b/i;

export function statedAge(c: StoryCharacter): number | undefined {
  if (typeof c.age === "number" && c.age > 0) return c.age;
  const m = `${c.visual} ${c.role}`.match(/\b(\d{1,2})[- ]?(?:year|yr)s?[- ]?old\b|\b(?:age|aged)\s*(\d{1,2})\b|,\s*(\d{1,2})\s*,/i);
  const n = m ? Number(m[1] || m[2] || m[3]) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export const isKid = (c: StoryCharacter) => {
  const age = statedAge(c);
  if (age !== undefined) return age < 13;
  return childWords.test(`${c.role} ${c.visual}`) && !/\b(man|woman|adult|teen|teenage)\b/i.test(c.visual);
};
export const isFemale = (c: StoryCharacter) => (c.gender ? c.gender === "female" : femaleWords.test(`${c.role} ${c.visual}`));

/**
 * ElevenLabs has no real child voices, so a child's line is spoken by a light young voice and then raised in pitch
 * (speed unchanged): about +5 semitones for small children, +3 for older kids.
 */
export function childPitch(c: StoryCharacter | undefined): number {
  if (!c || !isKid(c)) return 1;
  const age = statedAge(c) ?? 8;
  return age <= 7 ? 1.33 : 1.2;
}

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
