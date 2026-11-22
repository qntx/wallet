/**
 * Untrusted text (a signed message, an EIP-712 domain name, a token symbol) made safe to show, and
 * the checks behind the message-text rules. Code points come in three classes, taken from the
 * generated Unicode 18.0.0 tables in unicode-tables.ts so the kernel and the host classify every
 * code point identically regardless of the engine's ICU version. Deceptive ones — controls other
 * than TAB/LF/CR, the line and paragraph separators, the bidi embedding/override marks U+202A–202E,
 * interlinear annotation anchors U+FFF9–FFFB, default-ignorable code points outside the format set,
 * tag characters outside an exact RGI emoji tag sequence (U+1F3F4, the tag-encoded body, U+E007F)
 * and variation selectors not immediately after a base the selector is defined for — mean what the
 * owner reads is not what was signed (`hasHiddenCharacters`); they render as U+FFFD. Format
 * characters — joiners, direction marks, the soft hyphen, the combining grapheme joiner, variation
 * selectors in a valid position and RGI tag sequences — are ordinary text; direction marks, the
 * soft hyphen, CGJ and joiners outside a joining context display as U+FFFD so they stay visible,
 * the rest pass through. Everything else is text.
 *
 * Joining context: a ZWJ is kept after a virama (ccc=9, RFC 5892 appendix A.2) or inside an emoji
 * ZWJ sequence (UTS #51 ED-16: the preceding code point is Extended_Pictographic or an emoji
 * modifier — an emoji-variation FE0F after a pictographic base counts as its base — and the next is
 * Extended_Pictographic). A ZWNJ is kept after a virama or between left- and right-joining
 * characters, skipping transparent ones (RFC 5892 appendix A.1).
 */

import {
  DEFAULT_IGNORABLE,
  EMOJI_MODIFIER,
  EXTENDED_PICTOGRAPHIC,
  JOIN_LEFT,
  JOIN_RIGHT,
  JOIN_TRANSPARENT,
  RGI_TAG_SEQUENCES,
  UNIFIED_IDEOGRAPH,
  VARIATION_BASES,
  VARIATION_SELECTOR,
  VIRAMA,
} from "./unicode-tables.ts";

const CONTROL = /\p{Cc}/u;
const MARK_VISIBLE = new Set([0x200e, 0x200f, 0x061c, 0x00ad, 0x034f]);

const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const EMOJI_VS = 0xfe0f;
const IVS_FIRST = 0xe0100;

const TAG_BASE = 0x1f3f4;
const TAG_FIRST = 0xe0020;
const TAG_BODY_LAST = 0xe007e;
const TAG_LAST = 0xe007f;
const TAG_CANCEL = 0xe007f;

const codePoint = (char: string | undefined): number => char?.codePointAt(0) ?? 0;

const codePointsOf = (text: string): string[] => {
  const chars: string[] = [];
  for (const char of text) {
    chars.push(char);
  }
  return chars;
};

/** Whether `cp` lies in a flat sorted inclusive-range table `[lo0, hi0, lo1, hi1, …]`. */
const inRanges = (ranges: ReadonlyArray<number>, cp: number): boolean => {
  let lo = 0;
  let hi = ranges.length / 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const start = ranges[mid * 2];
    const end = ranges[mid * 2 + 1];
    if (start === undefined || end === undefined) {
      return false;
    }
    if (cp < start) {
      hi = mid;
    } else if (cp > end) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
};

const isTagChar = (cp: number): boolean => cp >= TAG_FIRST && cp <= TAG_LAST;

/* The default-ignorable code points that are format characters rather than deceptive: joiners,
   direction marks, soft hyphen, CGJ, variation selectors and tag characters. */
const isFormat = (cp: number): boolean =>
  cp === ZWNJ ||
  cp === ZWJ ||
  MARK_VISIBLE.has(cp) ||
  inRanges(VARIATION_SELECTOR, cp) ||
  isTagChar(cp);

/** The explicit deceptive set: separators, bidi embedding/override marks, annotation anchors. */
const isExplicitDeceptive = (cp: number): boolean =>
  (cp >= 0x2028 && cp <= 0x2029) ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0xfff9 && cp <= 0xfffb);

/**
 * Whether the tag character at `i` is part of an exact RGI emoji tag sequence: U+1F3F4, then the
 * tag-encoded body of one of RGI_TAG_SEQUENCES, terminated by U+E007F (UTS #51).
 */
const inRgiTagSequence = (chars: ReadonlyArray<string>, i: number): boolean => {
  let start = i;
  while (start > 0) {
    const cp = codePoint(chars[start - 1]);
    if (cp < TAG_FIRST || cp > TAG_BODY_LAST) {
      break;
    }
    start--;
  }
  if (start === 0 || codePoint(chars[start - 1]) !== TAG_BASE) {
    return false;
  }
  let end = start;
  let body = "";
  while (end < chars.length) {
    const cp = codePoint(chars[end]);
    if (cp < TAG_FIRST || cp > TAG_BODY_LAST) {
      break;
    }
    body += String.fromCodePoint(cp - 0xe0000);
    end++;
  }
  return codePoint(chars[end]) === TAG_CANCEL && RGI_TAG_SEQUENCES.includes(body) && i <= end;
};

/** A variation selector is deceptive unless it immediately follows a base defined for it. */
const misplacedSelector = (chars: ReadonlyArray<string>, i: number): boolean => {
  const selector = codePoint(chars[i]);
  const prev = codePoint(chars[i - 1]);
  if (selector >= IVS_FIRST) {
    return !inRanges(UNIFIED_IDEOGRAPH, prev);
  }
  const bases = VARIATION_BASES[selector];
  return bases === undefined || !inRanges(bases, prev);
};

/** Whether the code point at `i` hides, reorders or fakes signed content. */
const isDeceptive = (chars: ReadonlyArray<string>, i: number): boolean => {
  const cp = codePoint(chars[i]);
  if (isTagChar(cp)) {
    return !inRgiTagSequence(chars, i);
  }
  if (inRanges(VARIATION_SELECTOR, cp)) {
    return misplacedSelector(chars, i);
  }
  if (
    cp !== TAB &&
    cp !== LINE_FEED &&
    cp !== CARRIAGE_RETURN &&
    (CONTROL.test(chars[i] ?? "") || isExplicitDeceptive(cp))
  ) {
    return true;
  }
  return inRanges(DEFAULT_IGNORABLE, cp) && !isFormat(cp);
};

/** Whether the joiner at `i` actually joins — kept verbatim in the display. */
const joinsHere = (chars: ReadonlyArray<string>, i: number): boolean => {
  const prev = codePoint(chars[i - 1]);
  if (inRanges(VIRAMA, prev)) {
    return true;
  }
  if (codePoint(chars[i]) === ZWJ) {
    const emojiPrev =
      inRanges(EXTENDED_PICTOGRAPHIC, prev) ||
      inRanges(EMOJI_MODIFIER, prev) ||
      (prev === EMOJI_VS && inRanges(EXTENDED_PICTOGRAPHIC, codePoint(chars[i - 2])));
    return emojiPrev && inRanges(EXTENDED_PICTOGRAPHIC, codePoint(chars[i + 1]));
  }
  let before = i - 1;
  while (before >= 0 && inRanges(JOIN_TRANSPARENT, codePoint(chars[before]))) {
    before--;
  }
  let after = i + 1;
  while (after < chars.length && inRanges(JOIN_TRANSPARENT, codePoint(chars[after]))) {
    after++;
  }
  return (
    inRanges(JOIN_LEFT, codePoint(chars[before])) && inRanges(JOIN_RIGHT, codePoint(chars[after]))
  );
};

/**
 * Whether `text` holds a deceptive code point — one that hides, reorders or fakes content. TAB, LF
 * and CR are the only control characters ordinary text may carry.
 */
export const hasHiddenCharacters = (text: string): boolean => {
  const chars = codePointsOf(text);
  for (const [i] of chars.entries()) {
    if (isDeceptive(chars, i)) {
      return true;
    }
  }
  return false;
};

/**
 * Whether `text` is the rendering of raw bytes, not a description of what the signature authorises:
 * hex with or without a `0x` prefix of either case, optionally separated by whitespace, colons,
 * dashes or commas, past 40 digits — 40 digits is an address written as text, which stays readable
 * — or a single base64/base64url/base58 token of 43 or more characters (≥ 32 bytes) mixing at least
 * two of its character classes.
 */
export const isEncodedBytes = (text: string): boolean => {
  const trimmed = text.trim();
  const squashed = trimmed.replace(/^0x/i, "").replaceAll(/[\s:,-]+/g, "");
  if (squashed.length > 40 && /^[0-9a-fA-F]+$/.test(squashed)) {
    return true;
  }
  const token = trimmed.replace(/^0x/i, "");
  const classes = [/[A-Z]/, /[a-z]/, /[0-9]/].filter((cls) => cls.test(token)).length;
  return (
    !/\s/.test(token) &&
    token.length >= 43 &&
    /^[A-Za-z0-9+/_-]+={0,2}$/.test(token) &&
    classes >= 2
  );
};

const REPLACEMENT = "\uFFFD";
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/**
 * The code points of one line: tabs as spaces, trimmed; deceptive characters, joiners outside a
 * joining context and the always-visible marks (LRM, RLM, ALM, SHY, CGJ) as U+FFFD; tag characters
 * only inside an exact RGI emoji tag sequence.
 */
const safeLine = (line: string): ReadonlyArray<string> => {
  const chars = codePointsOf(line.replaceAll("\t", " ").trim());
  return chars.map((char, i) => {
    const cp = codePoint(char);
    if (isTagChar(cp)) {
      return inRgiTagSequence(chars, i) ? char : REPLACEMENT;
    }
    if (cp === ZWNJ || cp === ZWJ) {
      return joinsHere(chars, i) ? char : REPLACEMENT;
    }
    if (MARK_VISIBLE.has(cp) || isDeceptive(chars, i)) {
      return REPLACEMENT;
    }
    return char;
  });
};

export type DisplayExcerpt = {
  readonly lines: ReadonlyArray<string>;
  /** Code points of non-empty lines that did not fit. */
  readonly omitted: number;
};

/**
 * The leading part of `raw` that fits `maxLines` lines and `maxCodePoints` code points. Empty lines
 * are dropped, so padding cannot push content out of view; the last line may be cut.
 */
export function displayExcerpt(
  raw: string,
  maxLines: number,
  maxCodePoints: number,
): DisplayExcerpt {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const line of raw.split(LINE_BREAK)) {
    const chars = safeLine(line);
    const room = lines.length < maxLines ? maxCodePoints - used : 0;
    const shown = chars.slice(0, room);
    if (shown.length > 0) {
      lines.push(shown.join(""));
      used += shown.length;
    }
    omitted += chars.length - shown.length;
  }
  return { lines, omitted };
}
