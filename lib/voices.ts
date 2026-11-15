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

export type AgeGroup = "child" | "teen" | "adult";

/** child < 13, teen 13–17, adult 18+. Without a stated age, words decide; a son/daughter with no adult words counts as a teen. */
export function ageGroup(c: StoryCharacter): AgeGroup {
  const age = statedAge(c);
  if (age !== undefined) return age < 13 ? "child" : age < 18 ? "teen" : "adult";
  const text = `${c.role} ${c.visual}`;
  const adult = /\b(man|woman|adult|husband|wife|father|mother|dad|mom|grandfather|grandmother|businessman)\b/i.test(c.visual);
  if (/\b(teen|teenage|teenager|adolescent|high[- ]school(er)?)\b/i.test(text)) return "teen";
  if (childWords.test(text) && !adult) return "child";
  if (/\b(son|daughter|grandson|granddaughter|stepson|stepdaughter)\b/i.test(c.role) && !adult) return "teen";
  return "adult";
}

export const isKid = (c: StoryCharacter) => ageGroup(c) === "child";
export const isFemale = (c: StoryCharacter) => (c.gender ? c.gender === "female" : femaleWords.test(`${c.role} ${c.visual}`));

/**
 * ElevenLabs has no real child or teen voices, so young characters get a light young voice raised in pitch
 * (speed unchanged): small children +5 semitones, kids +3, young teens +1.7, older teens +1.
 */
export function childPitch(c: StoryCharacter | undefined): number {
  if (!c) return 1;
  const g = ageGroup(c);
  if (g === "adult") return 1;
  const age = statedAge(c) ?? (g === "child" ? 8 : 15);
  if (age <= 7) return 1.33;
  if (age <= 12) return 1.2;
  if (age <= 15) return 1.1;
  return 1.06;
}

/** What the editor shows next to the auto voice. */
export function voiceNote(c: StoryCharacter): string {
  const g = ageGroup(c);
  return g === "child" ? " → child voice" : g === "teen" ? " → teen voice" : "";
}

// Young-sounding base voices for teens (then slightly raised).
const TEEN_MALE = ["Liam", "Will", "Callum", "Charlie"];
const TEEN_FEMALE = ["Jessica", "Alice", "Laura"];

/** A different ElevenLabs voice for each character (or the one chosen in the story editor). */
export function voiceMap(story: Pick<Story, "characters">): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const c of story.characters) if (c.voice && ALL_VOICES.includes(c.voice)) { out.set(c.key, c.voice); used.add(c.voice); }
  for (const c of story.characters) {
    if (out.has(c.key)) continue;
    const g = ageGroup(c);
    const list = g === "child" ? CHILD_VOICES : g === "teen" ? (isFemale(c) ? TEEN_FEMALE : TEEN_MALE) : isFemale(c) ? FEMALE_VOICES : MALE_VOICES;
    const v = list.find((x) => !used.has(x)) || list[0];
    used.add(v);
    out.set(c.key, v);
  }
  return out;
}
