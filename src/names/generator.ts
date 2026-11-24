/**
 * Offline name generator: pure, dependency-free, and seedable. Each style is a
 * set of syllable tables plus a few rules for putting them together; the
 * generator makes the choices and filters out results that read badly, so the
 * names have a consistent flavour whichever model asked for them.
 *
 * This is both the source for invented fantasy cultures (Behind the Name has
 * no orcs) and the fallback whenever Behind the Name can't answer.
 */

export type NameGender = "male" | "female" | "any";
export type NameKind = "person" | "place";

export const STYLE_IDS = [
  "elvish",
  "dwarvish",
  "orcish",
  "halfling",
  "infernal",
  "draconic",
  "norse",
  "latin",
  "celtic",
  "common",
] as const;
export type StyleId = (typeof STYLE_IDS)[number];

export interface GenerateOptions {
  style: StyleId;
  count: number;
  gender: NameGender;
  kind: NameKind;
  surnames: boolean;
  /** Names to leave out, compared case-insensitively. */
  exclude?: ReadonlySet<string>;
  /** Defaults to Math.random; pass `seeded(n)` for repeatable output. */
  random?: () => number;
}

type Rand = () => number;
type Gendered = "male" | "female";

/** A small, fast, seedable PRNG (mulberry32). */
export function seeded(seed: number): Rand {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: Rand, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error("pick from an empty table");
  return item;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A given name built from syllables: onset, up to `maxMiddles` middles, then a gendered ending. */
interface Syllables {
  onsets: readonly string[];
  middles: readonly string[];
  /** How likely each extra middle syllable is (0..1); at most two are added. */
  middleChance: number;
  male: readonly string[];
  female: readonly string[];
}

function syllabic(rand: Rand, s: Syllables, gender: Gendered): string {
  let name = pick(rand, s.onsets);
  for (let i = 0; i < 2 && rand() < s.middleChance; i++) name += pick(rand, s.middles);
  name += pick(rand, gender === "male" ? s.male : s.female);
  return capitalize(name.toLowerCase());
}

/** Two words run together: "Iron" + "fist" → "Ironfist". */
function compound(rand: Rand, first: readonly string[], second: readonly string[]): string {
  return capitalize((pick(rand, first) + pick(rand, second)).toLowerCase());
}

interface Style {
  given(rand: Rand, gender: Gendered): string;
  surname(rand: Rand, gender: Gendered): string;
  place(rand: Rand): string;
}

/** A style whose names, surnames, and places are all syllabic or compound. */
function makeStyle(spec: {
  syllables: Syllables;
  surname: (rand: Rand, gender: Gendered, given: (g: Gendered) => string) => string;
  place: (rand: Rand) => string;
}): Style {
  const given = (rand: Rand, gender: Gendered): string => syllabic(rand, spec.syllables, gender);
  return {
    given,
    surname: (rand, gender) => spec.surname(rand, gender, (g) => given(rand, g)),
    place: spec.place,
  };
}

const elvish: Syllables = {
  onsets: ["Ae", "Aer", "Ara", "Cai", "Cel", "Eil", "Ela", "Ere", "Fae", "Ilu", "Ith", "Lae", "Lir", "Lua", "Mel", "Mir", "Nae", "Nim", "Ori", "Quel", "Rho", "Sil", "Syl", "Tha", "Thi", "Va", "Yl"],
  middles: ["la", "li", "ra", "ri", "the", "na", "ni", "si", "ve", "lo", "an", "el"],
  middleChance: 0.45,
  male: ["ion", "dor", "las", "ril", "van", "thas", "nor", "ian", "ael", "ros", "dil", "ndir"],
  female: ["iel", "wen", "ara", "ith", "ria", "eth", "ys", "lia", "nna", "rien", "ise", "aya"],
};

const dwarvish: Syllables = {
  onsets: ["Bal", "Bar", "Bod", "Bor", "Brak", "Brom", "Dag", "Dol", "Dur", "Dvar", "Ek", "Fal", "Gor", "Grun", "Gund", "Hal", "Har", "Hrom", "Kor", "Mor", "Nal", "Orm", "Rag", "Rur", "Skor", "Thra", "Tor", "Ul", "Vond"],
  middles: ["a", "o", "u", "ri", "ro", "di", "ga", "ka"],
  middleChance: 0.2,
  male: ["in", "ar", "ek", "dur", "grim", "rik", "ok", "um", "mund", "rak", "dain", "nor"],
  female: ["a", "hild", "dis", "ra", "ika", "run", "va", "ess", "wyn", "ga", "dra", "li"],
};

const orcish: Syllables = {
  onsets: ["Bru", "Dhur", "Dra", "Gash", "Gor", "Gr", "Grim", "Kr", "Kra", "Mak", "Mog", "Nar", "Oth", "Ruk", "Shag", "Skar", "Ug", "Ur", "Vok", "Zug"],
  middles: ["a", "u", "o", "ak", "ug", "ra", "za", "gu"],
  middleChance: 0.25,
  male: ["ak", "ug", "ash", "gor", "nak", "rok", "ush", "ruk", "dush", "zog", "mash", "tak"],
  female: ["a", "ka", "ga", "sha", "ra", "ura", "ishka", "ha", "ogga", "eth", "nka", "ruga"],
};

const halfling: Syllables = {
  onsets: ["Ad", "Bel", "Ber", "Cad", "Cor", "Dil", "Fen", "Fin", "Hob", "Jas", "Lav", "Lin", "Mer", "Mil", "Mos", "Nel", "Per", "Pol", "Ros", "Tam", "Til", "Wil"],
  middles: ["a", "i", "o", "e", "li", "bi", "do", "wi"],
  middleChance: 0.3,
  male: ["o", "ric", "fast", "bert", "mond", "wick", "bin", "ton", "ry", "by", "nan", "dock"],
  female: ["a", "ie", "ly", "sy", "belle", "ora", "etta", "wise", "mae", "rose", "nell", "y"],
};

const infernal: Syllables = {
  onsets: ["Ash", "Az", "Bael", "Bar", "Bel", "Dag", "Ira", "Kha", "Lil", "Mal", "Mor", "Nex", "Sar", "Thal", "Ur", "Vas", "Vel", "Xer", "Zar", "Zeph"],
  middles: ["a", "e", "o", "ra", "ze", "ga", "ru", "thi", "mo", "ka"],
  middleChance: 0.4,
  male: ["oth", "iel", "ax", "on", "ius", "as", "zar", "rath", "ul", "ek", "gor", "mon"],
  female: ["ith", "a", "ara", "ess", "ine", "ia", "yx", "isa", "eth", "ora", "ys", "ae"],
};

const draconic: Syllables = {
  onsets: ["Ar", "Bal", "Dra", "Ghes", "Hes", "Ix", "Kal", "Kri", "Med", "Nad", "Pand", "Qir", "Rha", "Sor", "Thar", "Tor", "Ul", "Vax", "Vry", "Zor"],
  middles: ["a", "i", "o", "ra", "ka", "ix", "ash", "or", "yr", "ath"],
  middleChance: 0.45,
  male: ["ax", "ion", "ar", "ath", "ur", "esh", "ix", "or", "oth", "rak", "yx", "thas"],
  female: ["a", "ra", "ix", "ys", "ith", "ash", "ira", "esh", "ka", "sa", "nyx", "ess"],
};

const norse: Syllables = {
  onsets: ["Arn", "As", "Bjor", "Bryn", "Dag", "Ein", "Frey", "Grim", "Gud", "Hal", "Hjal", "Ing", "Kol", "Leif", "Orm", "Rag", "Sig", "Sten", "Svein", "Thor", "Tor", "Ulf", "Vig", "Yr"],
  middles: ["a", "i", "ar", "e", "va"],
  middleChance: 0.15,
  male: ["ulf", "mund", "ar", "stein", "bjorn", "geir", "vald", "rik", "ketil", "ald", "grim", "ir"],
  female: ["hild", "rid", "run", "dis", "frid", "a", "veig", "gerd", "laug", "borg", "ny", "unn"],
};

const latin: Syllables = {
  onsets: ["Ant", "Aur", "Cass", "Cor", "Dec", "Fab", "Fla", "Grat", "Hor", "Jul", "Lae", "Luc", "Marc", "Max", "Oct", "Pub", "Quint", "Ruf", "Sab", "Sev", "Ter", "Tib", "Val", "Vic"],
  middles: ["i", "e", "ri", "ti", "ul", "an", "er"],
  middleChance: 0.3,
  male: ["us", "ius", "ianus", "o", "inus", "ellus", "ex", "or", "atus", "anus", "ens", "ilius"],
  female: ["a", "ia", "illa", "ina", "ana", "ella", "ilia", "ata", "ica", "entia", "essa", "iana"],
};

const celtic: Syllables = {
  onsets: ["Aed", "Ber", "Bran", "Cael", "Car", "Cor", "Dei", "Dun", "Eil", "Eog", "Fer", "Fin", "Gal", "Gwen", "Kea", "Lach", "Mae", "Mor", "Niam", "Rhi", "Ros", "Sio", "Tad", "Tal"],
  middles: ["a", "e", "i", "an", "in", "ar", "wy"],
  middleChance: 0.2,
  male: ["an", "ach", "ric", "in", "wyn", "gus", "dan", "ar", "oc", "dred", "on", "ell"],
  female: ["a", "wen", "eth", "ia", "ne", "nan", "ra", "id", "wyn", "ann", "ith", "ead"],
};

const common: Syllables = {
  onsets: ["Al", "Ald", "Bren", "Bri", "Cal", "Cor", "Dar", "Del", "Ed", "Gar", "Har", "Hel", "Jor", "Ker", "Lan", "Mar", "Ner", "Os", "Per", "Rhe", "Rol", "Sel", "Tam", "Wen"],
  middles: ["a", "e", "i", "o", "ri", "de", "la", "ve"],
  middleChance: 0.25,
  male: ["ric", "an", "win", "mond", "on", "ard", "en", "ald", "ot", "ian", "ec", "ast"],
  female: ["a", "wen", "ine", "ys", "elle", "ara", "ia", "eth", "ora", "issa", "ene", "lyn"],
};

/** A place name: the style's onset plus a place ending, e.g. "Sil" + "thel". */
const placeFrom = (onsets: readonly string[], endings: readonly string[]) => (rand: Rand): string =>
  capitalize((pick(rand, onsets) + pick(rand, endings)).toLowerCase());

const STYLES: Record<StyleId, Style> = {
  elvish: makeStyle({
    syllables: elvish,
    surname: (rand) =>
      capitalize((pick(rand, elvish.onsets) + pick(rand, elvish.middles) + pick(rand, ["thil", "lian", "oris", "venar", "dhel", "riel", "nore", "sar"])).toLowerCase()),
    place: placeFrom(elvish.onsets, ["thel", "ondel", "ias", "wyn", "aris", "ethel", "lune", "sael", "vanis", "orien"]),
  }),
  dwarvish: makeStyle({
    syllables: dwarvish,
    surname: (rand) =>
      compound(
        rand,
        ["Iron", "Stone", "Copper", "Granite", "Deep", "Anvil", "Coal", "Flint", "Gold", "Hammer", "Oak", "Ember", "Silver", "Broad", "Black", "Bright", "Fire", "Rock", "Steel", "Grey"],
        ["beard", "fist", "hammer", "forge", "delve", "shield", "mantle", "helm", "brow", "hand", "axe", "vein", "born", "arm", "maul"],
      ),
    place: placeFrom(["Kar", "Dun", "Grom", "Bar", "Thar", "Dol", "Ul", "Mor", "Zhur", "Vor", "Brak", "Hrom"], ["hold", "delve", "gard", "heim", "rak", "grund", "thrum", "dor", "mar", "kor"]),
  }),
  orcish: makeStyle({
    syllables: orcish,
    surname: (rand) =>
      compound(
        rand,
        ["Skull", "Blood", "Bone", "Iron", "Black", "Gut", "Tusk", "Ash", "Red", "Broken", "Rot", "Grim"],
        ["splitter", "tooth", "eye", "maw", "hide", "fang", "crusher", "ripper", "gnaw", "scar", "fist", "howl"],
      ),
    place: placeFrom(orcish.onsets, ["gash", "mok", "ruk", "goth", "dush", "kar", "zug", "grat", "nash", "ug"]),
  }),
  halfling: makeStyle({
    syllables: halfling,
    surname: (rand) =>
      compound(
        rand,
        ["Bramble", "Tea", "Under", "Good", "Thistle", "Apple", "Hill", "Honey", "Tall", "Brush", "Green", "Warm", "Tumble", "Barley", "Quick", "Bottle"],
        ["foot", "bottom", "hill", "leaf", "wood", "gather", "brook", "burrow", "barrel", "cask", "dew", "bank", "ward", "field", "worth"],
      ),
    place: (rand) =>
      compound(
        rand,
        ["Bramble", "Thistle", "Apple", "Honey", "Barley", "Clover", "Mead", "Willow", "Puddle", "Mossy", "Bee", "Hazel"],
        ["bottom", "dale", "by", "combe", "ford", "green", "hollow", "wick", "stead", "ton"],
      ),
  }),
  infernal: makeStyle({
    syllables: infernal,
    surname: (rand) =>
      capitalize((pick(rand, infernal.onsets) + pick(rand, ["moth", "vex", "raal", "thoth", "zul", "kesh", "ixis", "goroth"])).toLowerCase()),
    place: placeFrom(infernal.onsets, ["oth", "oroth", "ax", "umbra", "yss", "gath", "ekh", "ul", "zaal", "irex"]),
  }),
  draconic: makeStyle({
    syllables: draconic,
    surname: (rand) =>
      capitalize((pick(rand, draconic.onsets) + pick(rand, ["thix", "vex", "ryn", "thar", "dakar", "ilith", "ashtor", "kesh"])).toLowerCase()),
    place: placeFrom(draconic.onsets, ["ath", "kar", "ox", "ruk", "thys", "vor", "ix", "enth", "yrion", "esh"]),
  }),
  norse: makeStyle({
    syllables: norse,
    // Patronymics: Sigrid Halvardsdottir, Orm Kolgrimsson.
    surname: (_rand, gender, given) => {
      const father = given("male");
      const stem = father.endsWith("s") ? father : `${father}s`;
      return gender === "female" ? `${stem}dottir` : `${stem}son`;
    },
    place: placeFrom(norse.onsets, ["heim", "vik", "fjord", "holm", "gard", "stad", "by", "dal", "nes", "borg"]),
  }),
  latin: makeStyle({
    syllables: latin,
    surname: (rand) =>
      capitalize((pick(rand, latin.onsets) + pick(rand, ["ius", "inus", "ex", "icus", "ianus", "enus", "ellius", "onius"])).toLowerCase()),
    place: placeFrom(latin.onsets, ["ium", "ia", "um", "entum", "ona", "aris", "ae", "ica", "acum"]),
  }),
  celtic: makeStyle({
    syllables: celtic,
    // "Aedan mac Fergus", "Rhiann nic Talach".
    surname: (_rand, gender, given) => `${gender === "female" ? "nic" : "mac"} ${given("male")}`,
    place: (rand) =>
      pick(rand, ["Dun", "Glen", "Aber", "Kil", "Llan", "Inver", "Ard", "Bal", "Car", "Tre"]) +
      (pick(rand, celtic.onsets) + pick(rand, celtic.male)).toLowerCase(),
  }),
  common: makeStyle({
    syllables: common,
    surname: (rand) =>
      compound(
        rand,
        ["Ash", "Black", "Brook", "Cold", "Fair", "Hart", "Mill", "Thorn", "Wey", "Long", "Red", "Wood", "Gray", "Strong", "Hale"],
        ["well", "wood", "field", "ford", "more", "ley", "by", "wick", "ridge", "stone", "hollow", "mere", "bridge", "croft"],
      ),
    place: (rand) =>
      rand() < 0.5
        ? compound(rand, ["Ash", "Thorn", "Elm", "Brook", "Stone", "Mill", "Oak", "Wester", "Kings", "High", "Cold", "Black"], ["ford", "bury", "ton", "wick", "mere", "stead", "hold", "gate", "field", "bridge"])
        : placeFrom(common.onsets, ["ton", "bury", "ford", "wick", "mere", "stead", "hold", "gate"])(rand),
  }),
};

/**
 * Whether a syllable-built word reads acceptably: short, no tripled letters,
 * no stuttered chunks, no vowel or consonant pile-ups.
 */
export function readsWell(word: string): boolean {
  const lower = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!looksSane(lower) || lower.length > 10) return false;
  if (/[^aeiouy]{4}/.test(lower)) return false;
  return true;
}

/**
 * The looser test for compounds and places, where consonant clusters at the
 * seam are normal ("Skullsplitter", "Blackstone") but "Hillhill" is not.
 */
function looksSane(word: string): boolean {
  const lower = word.toLowerCase().replace(/[^a-z]/g, "");
  if (lower.length < 3 || lower.length > 18) return false;
  if (/(.)\1\1/.test(lower)) return false;
  if (/(.{2,})\1/.test(lower)) return false;
  if (/[aeiouy]{3}/.test(lower)) return false; // "Kriaorur"
  if (/aa|ii|uu|yy/.test(lower)) return false; // "Thiian"; "ee"/"oo" are fine
  return true;
}

function personName(style: Style, rand: Rand, gender: Gendered, surnames: boolean): string {
  const given = style.given(rand, gender);
  if (!readsWell(given)) return "";
  if (!surnames) return given;
  const surname = style.surname(rand, gender);
  // A particle ("mac Fergus") isn't part of the word being judged.
  const core = surname.split(" ").at(-1) ?? surname;
  if (!looksSane(core)) return "";
  return `${given} ${surname}`;
}

/**
 * `count` distinct names in the given style. Can return fewer when the style's
 * tables are nearly exhausted against `exclude`, never more.
 */
export function generateNames(options: GenerateOptions): string[] {
  const rand = options.random ?? Math.random;
  const style = STYLES[options.style];
  const seen = new Set<string>();
  for (const name of options.exclude ?? []) seen.add(name.toLowerCase());

  const names: string[] = [];
  const maxAttempts = options.count * 50;
  for (let attempt = 0; attempt < maxAttempts && names.length < options.count; attempt++) {
    let name: string;
    if (options.kind === "place") {
      name = style.place(rand);
      if (!looksSane(name)) continue;
    } else {
      const gender: Gendered = options.gender === "any" ? (rand() < 0.5 ? "male" : "female") : options.gender;
      name = personName(style, rand, gender, options.surnames);
      if (name === "") continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}
