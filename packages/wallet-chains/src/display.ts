/**
 * Untrusted text (a signed message, an EIP-712 domain name, a token symbol) made safe to show: the
 * characters that hide, reorder or fake content are never passed through.
 */

const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2060],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

/** Control, bidi-control, zero-width, line-separator and tag characters. */
export const isUnsafeCodePoint = (codePoint: number): boolean =>
  UNSAFE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);

const REPLACEMENT = "\uFFFD";
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/** The code points of one line: tabs as spaces, trimmed, every other unsafe character replaced. */
const safeLine = (line: string): ReadonlyArray<string> =>
  Array.from(line.replaceAll("\t", " ").trim(), (char) =>
    isUnsafeCodePoint(char.codePointAt(0) ?? 0) ? REPLACEMENT : char,
  );

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
