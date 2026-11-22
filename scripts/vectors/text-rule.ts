/// <reference types="node" />
/**
 * Regenerates vectors/chains/text-rule.json: the code-point-level text-rule vectors. `text` is
 * every RGI sequence in the pinned emoji-sequences.txt and emoji-zwj-sequences.txt (an independent
 * oracle — UTS #51 defines them as valid emoji) plus cited multilingual samples; every entry must
 * carry no messageTextHazard and display identical to its input. `hidden` is the review's attack
 * set — every entry must classify `hidden-characters`. `visible` is format characters outside their
 * context — no hazard, but the character displays as U+FFFD.
 *
 * Run from the repo root: bun scripts/vectors/text-rule.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCES = {
  emojiSequences: "https://www.unicode.org/Public/18.0.0/emoji/emoji-sequences.txt",
  emojiZwjSequences: "https://www.unicode.org/Public/18.0.0/emoji/emoji-zwj-sequences.txt",
} as const;

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

/** Each ASCII char as its tag character U+E0000 + c. */
const tags = (text: string): string => {
  let out = "";
  for (const c of text) {
    out += String.fromCodePoint(0xe0000 + (c.codePointAt(0) ?? 0));
  }
  return out;
};

const TAG_FLAG = "\u{1F3F4}";
const TAG_END = "\u{E007F}";
const FFFD = "\uFFFD";

type TextCase = { readonly name: string; readonly text: string; readonly source: string };
type VisibleCase = { readonly name: string; readonly text: string; readonly display: string };

const main = async (): Promise<void> => {
  const [sequences, zwj] = await Promise.all([
    fetchUcd(SOURCES.emojiSequences),
    fetchUcd(SOURCES.emojiZwjSequences),
  ]);

  /* Every data row of both files, as the string of its code points — RGI flag, tag, keycap,
     modifier, flag-sequence and ZWJ sequences alike. */
  const text: TextCase[] = [];
  for (const { file, body } of [
    { file: "emoji-sequences.txt", body: sequences },
    { file: "emoji-zwj-sequences.txt", body: zwj },
  ]) {
    for (const line of body.split("\n")) {
      const row = line.split("#", 1)[0]?.trim() ?? "";
      if (row === "") {
        continue;
      }
      const [seqPart, typePart] = row.split(";").map((part) => part.trim());
      const type = typePart ?? "";
      const comment = line.split("#")[1]?.trim() ?? type;
      const source = `${SOURCES.emojiSequences.slice(0, -"emoji-sequences.txt".length)}${file}`;
      /* A lone `A..B` token declares one single-code-point sequence per member — expand them all. */
      if (/^[0-9A-Fa-f]+\.\.[0-9A-Fa-f]+$/.test(seqPart ?? "")) {
        const [lo, hi] = (seqPart ?? "").split("..").map((hex) => Number.parseInt(hex, 16));
        if (lo === undefined || hi === undefined) {
          throw new Error(`bad sequence row: ${line}`);
        }
        for (let cp = lo; cp <= hi; cp++) {
          text.push({ name: `${type} ${comment}`.trim(), text: String.fromCodePoint(cp), source });
        }
        continue;
      }
      const cps = seqPart?.split(/\s+/).map((hex) => Number.parseInt(hex, 16)) ?? [];
      if (cps.length === 0 || cps.some((cp) => Number.isNaN(cp))) {
        throw new Error(`bad sequence row: ${line}`);
      }
      text.push({
        name: `${type} ${comment}`.trim(),
        text: String.fromCodePoint(...cps),
        source,
      });
    }
  }

  /* Ordinary text the rules must not touch — one cited sample per joining or variation context. */
  text.push(
    {
      name: "Persian ZWNJ می‌خواهم",
      text: "می‌خواهم",
      source: "RFC 5892 appendix B.3 Persian example (می‌خواهم, U+200C between ی and خ)",
    },
    {
      name: "Devanagari half-form KA+VIRAMA+ZWJ+SSA",
      text: "\u0915\u094D\u200D\u0937",
      source:
        "Unicode Standard ch.12 (Devanagari): dead consonant + ZWJ renders the half form (RFC 5892 ContextJ)",
    },
    {
      name: "Devanagari explicit virama KA+VIRAMA+ZWNJ+SSA",
      text: "\u0915\u094D\u200C\u0937",
      source:
        "Unicode Standard ch.12 (Devanagari): dead consonant + ZWNJ keeps the visible virama (RFC 5892 ContextJ)",
    },
    {
      name: "Sinhala yansaya KA+VIRAMA+ZWJ+RA",
      text: "\u0D9A\u0DCA\u200D\u0DBA",
      source: "Unicode Standard ch.13 (Sinhala): virama + ZWJ forms the rakar/yansaya",
    },
    {
      name: "Malayalam chillu NA+VIRAMA+ZWJ",
      text: "ന്‍",
      source: "Unicode Standard ch.12 (Malayalam): consonant + virama + ZWJ is the chillu form",
    },
    {
      name: "Japanese IVS U+845B U+E0100",
      text: "葛\u{E0100}",
      source: "UTS #37 Ideographic Variation Database: 葛 (U+845B) has registered variants E0100+",
    },
    {
      name: "keycap # U+0023 U+FE0F U+20E3",
      text: "#️⃣",
      source: "UTS #51 / emoji-sequences.txt Emoji_Combining_Sequence 0023 FE0F 20E3",
    },
    /* A Mongolian FVS pair and a CJK-compat pair straight out of StandardizedVariants.txt would
       need a second fetch; cite the rows the unicode-tables generator already parses instead:
       1820 180B is the first Mongolian FVS1 row, 349E FE00 the first CJK-compat row (checked
       against the pinned file when writing this vector). */
    {
      name: "Mongolian FVS U+1820 U+180B",
      text: "ᠠ\u180B",
      source:
        "StandardizedVariants.txt Mongolian section: 1820 180B is a listed free-variation-selector pair",
    },
    {
      name: "CJK-compat standardized variant U+349E U+FE00",
      text: "\u349E\uFE00",
      source:
        "StandardizedVariants.txt CJK compatibility section: 349E FE00 is a listed standardized variant",
    },
  );

  const hidden: ReadonlyArray<{ readonly name: string; readonly text: string }> = [
    {
      name: "flag tag sequence carrying an ASCII sentence",
      text: `Sign in to app.example\n${TAG_FLAG}${tags("transfer all funds to 0xabc")}${TAG_END}`,
    },
    {
      name: "tag body with spaces, uppercase and punctuation",
      text: `gm\n${TAG_FLAG}${tags("ORDER 66: SELL!")}${TAG_END}`,
    },
    {
      name: "tag body over 32 code points",
      text: `gm\n${TAG_FLAG}${tags("x".repeat(40))}${TAG_END}`,
    },
    {
      name: "well-formed but non-RGI subdivision body ustx",
      text: `${TAG_FLAG}${tags("ustx")}${TAG_END}`,
    },
    {
      name: "lone tag character",
      text: "Sign in \u{E0061} please",
    },
    {
      name: "flag tag run without the U+E007F terminator",
      text: `a${TAG_FLAG}${tags("x")}`,
    },
    {
      name: "RGI tag body without the U+E007F terminator",
      text: `a${TAG_FLAG}${tags("gbsct")}`,
    },
    {
      name: "stray tag characters after the cancel tag",
      text: `a${TAG_FLAG}${tags("x")}${TAG_END}${tags("y")}`,
    },
    {
      name: "twenty variation selectors after a Latin base",
      text: `Hello${Array.from({ length: 10 }, (_, i) => String.fromCodePoint(0xfe00 + i)).join("")}${Array.from({ length: 10 }, (_, i) => String.fromCodePoint(0xe0100 + i)).join("")}`,
    },
    {
      name: "emoji variation selector after a Latin letter",
      text: "a\uFE0F",
    },
    {
      name: "two variation selectors on one base",
      text: "❤\uFE0F\uFE0F",
    },
    {
      name: "ideographic variation selector after a Latin letter",
      text: "a\u{E0100}",
    },
    {
      name: "bidi isolates U+2066/U+2069",
      text: "send \u2066everything\u2069",
    },
  ];

  const visible: ReadonlyArray<VisibleCase> = [
    {
      name: "ZWJ between hex letters",
      text: "Pay to 0xab\u200Dcd",
      display: `Pay to 0xab${FFFD}cd`,
    },
    {
      name: "ZWNJ between Latin letters",
      text: "a\u200Cb",
      display: `a${FFFD}b`,
    },
    {
      name: "ZWJ after a Latin letter before an emoji",
      text: "a\u200D😀",
      display: `a${FFFD}😀`,
    },
    {
      name: "ZWJ after an emoji before a Latin letter",
      text: "😀\u200Da",
      display: `😀${FFFD}a`,
    },
    {
      name: "combining grapheme joiner",
      text: "a\u034Fb",
      display: `a${FFFD}b`,
    },
    {
      name: "soft hyphen",
      text: "a\u00ADb",
      display: `a${FFFD}b`,
    },
  ];

  const out = {
    source: Object.values(SOURCES),
    text,
    hidden,
    visible,
  };
  const path = resolve(import.meta.dirname, "../../vectors/chains/text-rule.json");
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `wrote ${path} (${text.length} text, ${hidden.length} hidden, ${visible.length} visible)`,
  );
};

await main();
