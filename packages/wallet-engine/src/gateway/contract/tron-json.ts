/**
 * Lossless JSON.parse: TRON's java-tron printer emits int64 fields as bare JSON numbers, so any
 * value beyond ±(2^53−1) would lose precision under `JSON.parse`. This parser accepts exactly the
 * JSON grammar — nothing `JSON.parse` would reject is accepted — and differs only in that an
 * integer literal (no fraction, no exponent) outside the safe range becomes a `bigint` holding the
 * literal's exact value. Everything else — strings, booleans, null, doubles, duplicate keys (last
 * wins) — behaves identically to `JSON.parse`.
 */
export class TronJsonParseError extends Error {
  /** Byte offset into the input where the grammar failed. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "TronJsonParseError";
    this.offset = offset;
  }
}

/** Hostile nesting is rejected before the recursion can overflow the stack. */
const MAX_DEPTH = 512;

const QUOTE = 0x22; // "
const BACKSLASH = 0x5c; // \
const COMMA = 0x2c; // ,
const COLON = 0x3a; // :
const LBRACE = 0x7b; // {
const RBRACE = 0x7d; // }
const LBRACKET = 0x5b; // [
const RBRACKET = 0x5d; // ]
const MINUS = 0x2d; // -
const PLUS = 0x2b; // +
const DOT = 0x2e; // .
const ZERO = 0x30; // 0
const NINE = 0x39; // 9
const ESCAPES = new Set([QUOTE, BACKSLASH, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74]); // " \ / b f n r t

const isDigit = (c: number): boolean => c >= ZERO && c <= NINE;
const isHexDigit = (c: number): boolean =>
  isDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);

export const parseTronJson = (text: string): unknown => {
  const n = text.length;
  let i = 0;

  /** Code point at `p`, `-1` past the end — every digit/structural test fails on it. */
  const at = (p: number): number => text.codePointAt(p) ?? -1;

  const fail = (message: string): never => {
    throw new TronJsonParseError(message, i);
  };

  const skipWs = (): void => {
    while (i < n) {
      const c = at(i);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
        return;
      }
      i += 1;
    }
  };

  const literal = (word: string): void => {
    if (!text.startsWith(word, i)) {
      fail(`expected ${word}`);
    }
    i += word.length;
  };

  const string = (): string => {
    const start = i;
    i += 1; // opening quote
    for (;;) {
      if (i >= n) {
        fail("unterminated string");
      }
      const c = at(i);
      if (c === QUOTE) {
        i += 1;
        // The token is a complete JSON string literal — deferring escape semantics to JSON.parse
        // keeps surrogate pairs and every escape identical to the platform decoder.
        return String(JSON.parse(text.slice(start, i)));
      }
      if (c === BACKSLASH) {
        const e = at(i + 1);
        if (ESCAPES.has(e)) {
          i += 2;
          continue;
        }
        if (e === 0x75) {
          // \uXXXX — four hex digits are required.
          for (let k = 2; k <= 5; k += 1) {
            if (!isHexDigit(at(i + k))) {
              fail("bad unicode escape");
            }
          }
          i += 6;
          continue;
        }
        fail("bad escape");
      }
      if (c < 0x20) {
        fail("control character in string");
      }
      i += 1;
    }
  };

  const number = (): number | bigint => {
    const start = i;
    if (at(i) === MINUS) {
      i += 1;
    }
    const d0 = at(i);
    if (d0 === ZERO) {
      i += 1;
    } else if (d0 >= 0x31 && d0 <= NINE) {
      while (isDigit(at(i))) {
        i += 1;
      }
    } else {
      fail("bad number");
    }
    let integer = true;
    if (at(i) === DOT) {
      integer = false;
      i += 1;
      if (!isDigit(at(i))) {
        fail("bad fraction");
      }
      while (isDigit(at(i))) {
        i += 1;
      }
    }
    const e = at(i);
    if (e === 0x65 || e === 0x45) {
      integer = false;
      i += 1;
      const sign = at(i);
      if (sign === PLUS || sign === MINUS) {
        i += 1;
      }
      if (!isDigit(at(i))) {
        fail("bad exponent");
      }
      while (isDigit(at(i))) {
        i += 1;
      }
    }
    const token = text.slice(start, i);
    if (!integer) {
      return Number(token);
    }
    const value = Number(token);
    return Number.isSafeInteger(value) ? value : BigInt(token);
  };

  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH) {
      fail("nesting too deep");
    }
    skipWs();
    if (i >= n) {
      fail("unexpected end of input");
    }
    const c = at(i);
    if (c === QUOTE) {
      return string();
    }
    if (c === LBRACE) {
      const out: Record<string, unknown> = {};
      i += 1;
      skipWs();
      if (at(i) === RBRACE) {
        i += 1;
        return out;
      }
      for (;;) {
        skipWs();
        if (at(i) !== QUOTE) {
          fail("expected object key");
        }
        const key = string();
        skipWs();
        if (at(i) !== COLON) {
          fail("expected :");
        }
        i += 1;
        const v = value(depth + 1);
        // defineProperty so a "__proto__" key lands as an own property, exactly like JSON.parse.
        Object.defineProperty(out, key, {
          value: v,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        skipWs();
        const next = at(i);
        if (next === RBRACE) {
          i += 1;
          return out;
        }
        if (next !== COMMA) {
          fail("expected , or }");
        }
        i += 1;
      }
    }
    if (c === LBRACKET) {
      const out: unknown[] = [];
      i += 1;
      skipWs();
      if (at(i) === RBRACKET) {
        i += 1;
        return out;
      }
      for (;;) {
        out.push(value(depth + 1));
        skipWs();
        const next = at(i);
        if (next === RBRACKET) {
          i += 1;
          return out;
        }
        if (next !== COMMA) {
          fail("expected , or ]");
        }
        i += 1;
      }
    }
    if (c === 0x74) {
      literal("true");
      return true;
    }
    if (c === 0x66) {
      literal("false");
      return false;
    }
    if (c === 0x6e) {
      literal("null");
      return null;
    }
    if (c === MINUS || isDigit(c)) {
      return number();
    }
    return fail("unexpected character");
  };

  const parsed = value(0);
  skipWs();
  if (i !== n) {
    fail("trailing characters");
  }
  return parsed;
};
