/**
 * Untrusted text (a signed message, an EIP-712 domain name, a token symbol) made safe to show, and
 * the checks behind the message-text rules. Code points come in three classes. Deceptive ones —
 * controls other than TAB/LF/CR, line and paragraph separators, bidi embedding/override/isolate
 * marks, interlinear annotation anchors, default-ignorable characters outside the format set and
 * tag characters outside a valid emoji tag sequence — mean what the owner reads is not what was
 * signed (`hasHiddenCharacters`); they render as U+FFFD. Format ones — joiners, direction marks,
 * the soft hyphen, the combining grapheme joiner, variation selectors and emoji tag sequences — are
 * ordinary text; joiners display only where they actually join, direction marks and the soft hyphen
 * display as U+FFFD so they stay visible, the rest pass through. Everything else is text.
 */

const DECEPTIVE = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069\uFFF9-\uFFFB]/u;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const FORMAT = /\u200C|\u200D|\u200E|\u200F|\u061C|\u00AD|\u034F|\p{Variation_Selector}/u;
const JOINER = /\u200C|\u200D/u;
const JOINER_PREV =
  /[\p{L}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Variation_Selector}]/u;
const JOINER_NEXT = /[\p{L}\p{M}\p{Extended_Pictographic}]/u;
const MARK_VISIBLE = new Set([0x200e, 0x200f, 0x061c, 0x00ad]);

const TAG_BASE = 0x1f3f4;
const TAG_FIRST = 0xe0000;
const TAG_LAST = 0xe007f;
const TAG_BODY_FIRST = 0xe0020;
const TAG_BODY_LAST = 0xe007e;

const codePoint = (char: string | undefined): number => char?.codePointAt(0) ?? 0;

const codePointsOf = (text: string): string[] => {
  const chars: string[] = [];
  for (const char of text) {
    chars.push(char);
  }
  return chars;
};

/**
 * Whether the tag character at `i` is part of a valid emoji tag sequence: U+1F3F4, then one or more
 * of U+E0020–U+E007E, terminated by U+E007F.
 */
const inEmojiTagSequence = (chars: ReadonlyArray<string>, i: number): boolean => {
  let start = i;
  while (start > 0) {
    const cp = codePoint(chars[start - 1]);
    if (cp < TAG_FIRST || cp > TAG_LAST) {
      break;
    }
    start--;
  }
  if (start === 0 || codePoint(chars[start - 1]) !== TAG_BASE) {
    return false;
  }
  let end = start;
  while (end < chars.length) {
    const cp = codePoint(chars[end]);
    if (cp < TAG_BODY_FIRST || cp > TAG_BODY_LAST) {
      break;
    }
    end++;
  }
  return end > start && codePoint(chars[end]) === TAG_LAST && i <= end;
};

const isDeceptive = (char: string, codePoint: number): boolean =>
  (codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d && DECEPTIVE.test(char)) ||
  (IGNORABLE.test(char) && !FORMAT.test(char));

/**
 * Whether `text` holds a deceptive code point — one that hides, reorders or fakes content. TAB, LF
 * and CR are the only control characters ordinary text may carry.
 */
export const hasHiddenCharacters = (text: string): boolean => {
  const chars = codePointsOf(text);
  for (const [i, char] of chars.entries()) {
    const cp = codePoint(char);
    if (cp >= TAG_FIRST && cp <= TAG_LAST ? !inEmojiTagSequence(chars, i) : isDeceptive(char, cp)) {
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
 * The code points of one line: tabs as spaces, trimmed; deceptive characters, misplaced joiners and
 * the always-visible marks (LRM, RLM, ALM, SHY) as U+FFFD; tag characters only inside a valid emoji
 * tag sequence.
 */
const safeLine = (line: string): ReadonlyArray<string> => {
  const chars = codePointsOf(line.replaceAll("\t", " ").trim());
  return chars.map((char, i) => {
    const cp = codePoint(char);
    if (cp >= TAG_FIRST && cp <= TAG_LAST) {
      return inEmojiTagSequence(chars, i) ? char : REPLACEMENT;
    }
    if (JOINER.test(char)) {
      return JOINER_PREV.test(chars[i - 1] ?? "") && JOINER_NEXT.test(chars[i + 1] ?? "")
        ? char
        : REPLACEMENT;
    }
    if (MARK_VISIBLE.has(cp) || isDeceptive(char, cp)) {
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
