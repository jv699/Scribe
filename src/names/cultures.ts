/**
 * The cultures `generate_names` understands, and where each one's names come
 * from. The model names a culture in plain words ("Norse", "elven"); this table
 * is the only way that text becomes a Behind the Name usage code, so a model's
 * string never reaches the request URL.
 *
 * `usage` is a Behind the Name usage code (https://www.behindthename.com/api/
 * lists them). A code Behind the Name doesn't recognise is not fatal: the
 * request fails and the tool falls back to `style`, saying so.
 *
 * `style` is the offline generator used when Behind the Name isn't available.
 * Real cultures only get one where a style is a fair stand-in (Norse for
 * Icelandic, Latin for Italian); without one, offline requests are declined
 * rather than answered with names from the wrong culture.
 */
import type { StyleId } from "./generator.ts";

export interface Culture {
  label: string;
  aliases: readonly string[];
  usage?: string;
  style?: StyleId;
}

/** Invented cultures: always generated offline. */
const FANTASY: readonly Culture[] = [
  { label: "Elvish", aliases: ["elf", "elves", "elven", "sylvan", "fey"], style: "elvish" },
  { label: "Dwarvish", aliases: ["dwarf", "dwarves", "dwarven"], style: "dwarvish" },
  { label: "Orcish", aliases: ["orc", "orcs", "half-orc", "goblin", "goblinoid", "hobgoblin"], style: "orcish" },
  { label: "Halfling", aliases: ["halflings", "hobbit", "gnome", "gnomish"], style: "halfling" },
  { label: "Infernal", aliases: ["demon", "demonic", "devil", "devilish", "fiend", "fiendish", "tiefling", "abyssal"], style: "infernal" },
  { label: "Draconic", aliases: ["dragon", "dragons", "dragonborn", "kobold"], style: "draconic" },
  { label: "Common", aliases: ["fantasy", "human", "generic", "medieval", "fantasy human"], style: "common" },
];

/** Real and historical cultures: Behind the Name when available. */
const REAL: readonly Culture[] = [
  { label: "English", aliases: ["british", "anglo"], usage: "eng", style: "common" },
  { label: "Irish", aliases: ["gaelic"], usage: "iri", style: "celtic" },
  { label: "Scottish", aliases: ["scots"], usage: "sco", style: "celtic" },
  { label: "Welsh", aliases: [], usage: "wel", style: "celtic" },
  { label: "French", aliases: [], usage: "fre" },
  { label: "German", aliases: ["germanic"], usage: "ger" },
  { label: "Dutch", aliases: [], usage: "dut" },
  { label: "Italian", aliases: [], usage: "ita", style: "latin" },
  { label: "Spanish", aliases: [], usage: "spa", style: "latin" },
  { label: "Portuguese", aliases: [], usage: "por", style: "latin" },
  { label: "Scandinavian", aliases: ["nordic", "viking", "old norse"], usage: "sca", style: "norse" },
  { label: "Norwegian", aliases: [], usage: "nor", style: "norse" },
  { label: "Swedish", aliases: [], usage: "swe", style: "norse" },
  { label: "Danish", aliases: [], usage: "dan", style: "norse" },
  { label: "Icelandic", aliases: [], usage: "ice", style: "norse" },
  { label: "Finnish", aliases: [], usage: "fin" },
  { label: "Russian", aliases: ["slavic"], usage: "rus" },
  { label: "Polish", aliases: [], usage: "pol" },
  { label: "Czech", aliases: [], usage: "cze" },
  { label: "Ukrainian", aliases: [], usage: "ukr" },
  { label: "Hungarian", aliases: [], usage: "hun" },
  { label: "Greek", aliases: [], usage: "gre" },
  { label: "Hebrew", aliases: ["jewish"], usage: "heb" },
  { label: "Arabic", aliases: ["arab"], usage: "ara" },
  { label: "Persian", aliases: ["iranian"], usage: "per" },
  { label: "Turkish", aliases: [], usage: "tur" },
  { label: "Indian", aliases: ["hindi"], usage: "ind" },
  { label: "Japanese", aliases: [], usage: "jap" },
  { label: "Chinese", aliases: [], usage: "chi" },
  { label: "Korean", aliases: [], usage: "kor" },
  { label: "Ancient Roman", aliases: ["roman", "latin"], usage: "roma", style: "latin" },
  { label: "Ancient Greek", aliases: ["classical greek"], usage: "grea", style: "latin" },
  { label: "Greek Mythology", aliases: [], usage: "grem", style: "latin" },
  { label: "Roman Mythology", aliases: [], usage: "romm", style: "latin" },
  { label: "Norse Mythology", aliases: ["norse"], usage: "norm", style: "norse" },
  { label: "Celtic Mythology", aliases: ["celtic"], usage: "celm", style: "celtic" },
  { label: "Egyptian Mythology", aliases: ["egyptian", "ancient egyptian"], usage: "egym" },
  { label: "Biblical", aliases: ["bible"], usage: "bibl" },
  { label: "Arthurian", aliases: ["arthurian legend", "camelot"], usage: "arth", style: "celtic" },
];

export const CULTURES: readonly Culture[] = [...FANTASY, ...REAL];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z\s-]/g, "")
    .replace(/[\s-]+/g, " ")
    .replace(/\b(names?|style|culture|people)\b/g, "")
    // Again: a filler word in the middle leaves two spaces behind.
    .replace(/\s+/g, " ")
    .trim();
}

const INDEX = new Map<string, Culture>();
for (const culture of CULTURES) {
  for (const key of [culture.label, ...culture.aliases]) INDEX.set(normalize(key), culture);
}

/** The culture a model's free text names, or null. */
export function findCulture(text: string): Culture | null {
  return INDEX.get(normalize(text)) ?? null;
}

/** Labels for the tool description and the "unknown culture" reply. */
export function cultureLabels(): { fantasy: string[]; real: string[] } {
  return { fantasy: FANTASY.map((c) => c.label), real: REAL.map((c) => c.label) };
}
