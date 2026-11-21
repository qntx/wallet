import { hasHiddenCharacters } from "@qntx/wallet-chains";

export const TOKEN_SYMBOL_MAX = 32;
export const TOKEN_DECIMALS_MAX = 36;

/** The characters contract text may not carry: hidden ones, controls, and invisible marks. */
const UNSAFE_TEXT =
  /[\p{Cc}\p{Zl}\p{Zp}]|\u200C|\u200D|\u200E|\u200F|\u061C|\u00AD|[\u{E0000}-\u{E007F}]/u;

/**
 * Untrusted contract text (a token symbol) as safe-to-show text: trimmed, non-empty, at most `max`
 * code points, with no control, bidi-control or zero-width characters. `undefined` otherwise.
 */
export function safeDisplayText(raw: string, max: number): string | undefined {
  const text = raw.trim();
  if (hasHiddenCharacters(text) || UNSAFE_TEXT.test(text)) {
    return undefined;
  }
  let count = 0;
  for (const _char of text) {
    count += 1;
    if (count > max) {
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
