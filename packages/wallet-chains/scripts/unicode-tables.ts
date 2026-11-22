/// <reference types="node" />
/**
 * Regenerates src/unicode-tables.ts: the code-point classes the text rules in src/display.ts use,
 * generated from the pinned Unicode 18.0.0 Character Database so the kernel (Hermes) and the host
 * classify every code point identically regardless of the engine's ICU version.
 *
 * Run from the repo root: bun packages/wallet-chains/scripts/unicode-tables.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const UCD = "https://www.unicode.org/Public/18.0.0";
const SOURCES = {
  derivedCoreProperties: `${UCD}/ucd/DerivedCoreProperties.txt`,
  propList: `${UCD}/ucd/PropList.txt`,
  standardizedVariants: `${UCD}/ucd/StandardizedVariants.txt`,
  emojiData: `${UCD}/ucd/emoji/emoji-data.txt`,
  emojiVariationSequences: `${UCD}/ucd/emoji/emoji-variation-sequences.txt`,
  derivedCombiningClass: `${UCD}/ucd/extracted/DerivedCombiningClass.txt`,
  derivedJoiningType: `${UCD}/ucd/extracted/DerivedJoiningType.txt`,
  emojiSequences: `${UCD}/emoji/emoji-sequences.txt`,
} as const;

/** Every fetch must name Unicode 18.0(.0) in its header comment block — a pinned-input check. */
const fetchUcd = async (url: string): Promise<string> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url}: HTTP ${res.status}`);
  }
  const text = await res.text();
  const header = text.split("\n").filter((line) => line.startsWith("#"));
  if (!header.some((line) => /\b18\.0(?:\.0)?\b/.test(line))) {
    throw new Error(`${url}: header does not name Unicode 18.0(.0)`);
  }
  return text;
};

type Range = readonly [number, number];

/** `START[..END] ; VALUE` data rows (comments stripped), filtered to `value`. */
const propertyRanges = (text: string, value: string): Range[] => {
  const out: Range[] = [];
  for (const line of text.split("\n")) {
    const row = line.split("#", 1)[0]?.trim() ?? "";
    if (row === "") {
      continue;
    }
    const [rangePart, valuePart] = row.split(";").map((part) => part.trim());
    if (valuePart !== value || rangePart === undefined) {
      continue;
    }
    const [lo, hi] = rangePart.split("..").map((hex) => Number.parseInt(hex, 16));
    if (lo === undefined || Number.isNaN(lo)) {
      throw new Error(`bad range in row: ${line}`);
    }
    out.push([lo, hi ?? lo]);
  }
  return out;
};

/** `START[..END] ; VALUE` rows filtered to any of `values`, in file order. */
const propertyRangesIn = (text: string, values: ReadonlySet<string>): Range[] => {
  const out: Range[] = [];
  for (const line of text.split("\n")) {
    const row = line.split("#", 1)[0]?.trim() ?? "";
    if (row === "") {
      continue;
    }
    const [rangePart, valuePart] = row.split(";").map((part) => part.trim());
    if (rangePart === undefined || valuePart === undefined || !values.has(valuePart)) {
      continue;
    }
    const [lo, hi] = rangePart.split("..").map((hex) => Number.parseInt(hex, 16));
    if (lo === undefined || Number.isNaN(lo)) {
      throw new Error(`bad range in row: ${line}`);
    }
    out.push([lo, hi ?? lo]);
  }
  return out;
};

/**
 * Sorted ranges (UCD files list code points in order) flattened to `[lo0, hi0, lo1, hi1, …]` with
 * adjacent ranges merged.
 */
const flatten = (ranges: Range[]): number[] => {
  const flat: number[] = [];
  for (const [lo, hi] of ranges) {
    const lastEnd = flat.at(-1);
    if (lastEnd !== undefined && lo <= lastEnd + 1) {
      if (hi > lastEnd) {
        flat[flat.length - 1] = hi;
      }
    } else if (lastEnd === undefined || lo > lastEnd) {
      flat.push(lo, hi);
    } else {
      throw new Error("ranges are not in code-point order");
    }
  }
  return flat;
};

/** Two sorted range lists merged into one sorted list. */
const mergeRanges = (a: Range[], b: Range[]): Range[] => {
  const out: Range[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    const next = right === undefined || (left !== undefined && left[0] <= right[0]) ? left : right;
    if (next === undefined) {
      break;
    }
    if (next === left) {
      i++;
    } else {
      j++;
    }
    out.push(next);
  }
  return out;
};

/** Space-separated code points from a data row's first field. */
const sequenceOf = (row: string): number[] =>
  row
    .split("#", 1)[0]
    ?.split(";")[0]
    ?.trim()
    .split(/\s+/)
    .map((hex) => Number.parseInt(hex, 16)) ?? [];

const hex = (cp: number): string => `0x${cp.toString(16)}`;

/* Each table packs to a base-36 delta list: "4t,0,9m,0" decodes to [173, 173, 508, 508] —
   sorted ranges, so every gap is small and the digits stay few. The generated file stays data
   plus one decoder — dense enough that a family's bundle stays inside its gzip budget with the
   full tables. */
const packed = (flat: number[]): string => {
  let prev = 0;
  const tokens: string[] = [];
  for (const cp of flat) {
    tokens.push((cp - prev).toString(36));
    prev = cp;
  }
  return tokens.join(",");
};

const emit = (name: string, flat: number[]): string =>
  `export const ${name}: ReadonlyArray<number> = ranges(\n  "${packed(flat)}",\n);\n`;

const main = async (): Promise<void> => {
  const [
    derivedCoreProperties,
    propList,
    standardizedVariants,
    emojiData,
    emojiVariationSequences,
    derivedCombiningClass,
    derivedJoiningType,
    emojiSequences,
  ] = await Promise.all(Object.values(SOURCES).map(async (url) => fetchUcd(url)));
  const texts: Record<keyof typeof SOURCES, string> = {
    derivedCoreProperties,
    propList,
    standardizedVariants,
    emojiData,
    emojiVariationSequences,
    derivedCombiningClass,
    derivedJoiningType,
    emojiSequences,
  };

  const table = (value: string, source: string): number[] => flatten(propertyRanges(source, value));

  const DEFAULT_IGNORABLE = table("Default_Ignorable_Code_Point", texts.derivedCoreProperties);
  const VARIATION_SELECTOR = table("Variation_Selector", texts.propList);
  const UNIFIED_IDEOGRAPH = table("Unified_Ideograph", texts.propList);
  const EXTENDED_PICTOGRAPHIC = table("Extended_Pictographic", texts.emojiData);
  const EMOJI_MODIFIER = table("Emoji_Modifier", texts.emojiData);
  const VIRAMA = table("9", texts.derivedCombiningClass);
  const JOIN_LEFT = flatten(propertyRangesIn(texts.derivedJoiningType, new Set(["L", "D"])));
  const JOIN_RIGHT = flatten(propertyRangesIn(texts.derivedJoiningType, new Set(["R", "D"])));
  const JOIN_TRANSPARENT = table("T", texts.derivedJoiningType);

  /* The bases each Mongolian FVS or VS1–VS16 may follow: StandardizedVariants.txt carries
     `BASE VS` rows, emoji-variation-sequences.txt the text/emoji-style bases. */
  const SELECTOR_BASES = new Set<number>([
    0x180b,
    0x180c,
    0x180d,
    0x180f,
    ...Array.from({ length: 16 }, (_, i) => 0xfe00 + i),
  ]);
  /* SELECTOR_BASES is listed in ascending code-point order, so VARIATION_BASES stays sorted. */
  const SELECTORS = [...SELECTOR_BASES];
  const bases = new Map<number, Range[]>();
  for (const text of [texts.standardizedVariants, texts.emojiVariationSequences]) {
    for (const line of text.split("\n")) {
      const row = line.split("#", 1)[0]?.trim() ?? "";
      if (row === "") {
        continue;
      }
      const seq = sequenceOf(line);
      const [base, selector] = seq;
      if (seq.length !== 2 || base === undefined || selector === undefined) {
        continue;
      }
      if (!SELECTOR_BASES.has(selector)) {
        continue;
      }
      bases.set(selector, mergeRanges(bases.get(selector) ?? [], [[base, base]]));
    }
  }
  const VARIATION_BASES = new Map<number, number[]>(
    SELECTORS.flatMap((selector): Array<[number, number[]]> => {
      const list = bases.get(selector);
      return list === undefined ? [] : [[selector, flatten(list)]];
    }),
  );

  /* RGI flag tag sequences: U+1F3F4, the tag-encoded body, U+E007F. */
  const RGI_TAG_SEQUENCES: string[] = [];
  for (const line of texts.emojiSequences.split("\n")) {
    const row = line.split("#", 1)[0]?.trim() ?? "";
    if (row === "" || !row.includes("RGI_Emoji_Tag_Sequence")) {
      continue;
    }
    const seq = sequenceOf(line);
    if (seq[0] !== 0x1f3f4 || seq.at(-1) !== 0xe007f) {
      throw new Error(`unexpected RGI_Emoji_Tag_Sequence shape: ${line}`);
    }
    RGI_TAG_SEQUENCES.push(String.fromCodePoint(...seq.slice(1, -1).map((cp) => cp - 0xe0000)));
  }

  const header = `/**
 * GENERATED FILE — do not edit. Produced by packages/wallet-chains/scripts/unicode-tables.ts
 * from the Unicode 18.0.0 Character Database:
${Object.values(SOURCES)
  .map((url) => ` *   ${url}`)
  .join("\n")}
 *
 * Each table is a base-36-packed delta of an ascending list of inclusive code-point ranges
 * [lo0, hi0, lo1, hi1, …]. VARIATION_BASES maps a Mongolian free variation selector or VS1–VS16
 * to the ranges of bases that selector is defined for. RGI_TAG_SEQUENCES holds the RGI flag tag
 * bodies (the ASCII string encoded between U+1F3F4 and U+E007F).
 */

const ranges = (packed: string): ReadonlyArray<number> => {
  const out: number[] = [];
  let value = 0;
  for (const token of packed.split(",")) {
    value += parseInt(token, 36);
    out.push(value);
  }
  return out;
};
`;

  const sections = [
    emit("DEFAULT_IGNORABLE", DEFAULT_IGNORABLE),
    emit("VARIATION_SELECTOR", VARIATION_SELECTOR),
    emit("UNIFIED_IDEOGRAPH", UNIFIED_IDEOGRAPH),
    emit("EXTENDED_PICTOGRAPHIC", EXTENDED_PICTOGRAPHIC),
    emit("EMOJI_MODIFIER", EMOJI_MODIFIER),
    emit("VIRAMA", VIRAMA),
    emit("JOIN_LEFT", JOIN_LEFT),
    emit("JOIN_RIGHT", JOIN_RIGHT),
    emit("JOIN_TRANSPARENT", JOIN_TRANSPARENT),
    `export const VARIATION_BASES: Readonly<Record<number, ReadonlyArray<number>>> = {\n${[
      ...VARIATION_BASES.entries(),
    ]
      .map(([selector, flat]) => `  ${hex(selector)}: ranges("${packed(flat)}"),`)
      .join("\n")}\n};\n`,
    `export const RGI_TAG_SEQUENCES: ReadonlyArray<string> = ${JSON.stringify(RGI_TAG_SEQUENCES)};\n`,
  ];

  const out = resolve(import.meta.dirname, "../src/unicode-tables.ts");
  writeFileSync(out, `${header}${sections.join("\n")}`);
  console.log(`wrote ${out} (${RGI_TAG_SEQUENCES.length} RGI tag sequences)`);
};

await main();
