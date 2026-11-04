export const TOKEN_SYMBOL_MAX = 32;
export const TOKEN_DECIMALS_MAX = 36;

const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2060],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

const isUnsafe = (codePoint: number): boolean =>
  UNSAFE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);

/**
 * Untrusted contract text (a token symbol) as safe-to-show text: trimmed, non-empty, at most `max`
 * code points, with no control, bidi-control or zero-width characters. `undefined` otherwise.
 */
export function safeDisplayText(raw: string, max: number): string | undefined {
  const text = raw.trim();
  let count = 0;
  for (const char of text) {
    count += 1;
    if (count > max || isUnsafe(char.codePointAt(0) ?? 0)) {
      return undefined;
    }
  }
  return count === 0 ? undefined : text;
}

export function isAscii(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

/** A token's `decimals` as an integer within `0..TOKEN_DECIMALS_MAX`, else `undefined`. */
export const safeDecimals = (value: number): number | undefined =>
  Number.isInteger(value) && value >= 0 && value <= TOKEN_DECIMALS_MAX ? value : undefined;
