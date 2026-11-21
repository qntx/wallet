/**
 * A strict JSON parser: the RFC 8259 grammar `JSON.parse` accepts, plus the two canonicality rules
 * signing inputs need — a duplicate object key and trailing text after the value are malformed
 * inputs, not silently resolved. Errors are reported through `invalid` so the caller's error type
 * carries them; `depth` bounds nesting so a deep document cannot exhaust the stack.
 */
const WS = new Set([" ", "\t", "\n", "\r"]);
const HEX_QUAD = /^[0-9a-fA-F]{4}$/;

export const strictJson = (
  text: string,
  invalid: (reason: string) => never,
  depth = 200,
): unknown => {
  let at = 0;
  const fail = (reason: string): never => invalid(`${reason} at offset ${at}`);

  const ws = (): void => {
    while (at < text.length && WS.has(text[at] ?? "")) {
      at += 1;
    }
  };

  const string = (): string => {
    let out = "";
    at += 1;
    for (;;) {
      if (at >= text.length) {
        fail("unterminated string");
      }
      const c = text[at] ?? "";
      if (c === '"') {
        at += 1;
        return out;
      }
      if (c === "\\") {
        at += 1;
        const escape = text[at];
        switch (escape) {
          case '"':
          case "\\":
          case "/":
            out += escape;
            at += 1;
            break;
          case "b":
            out += "\b";
            at += 1;
            break;
          case "f":
            out += "\f";
            at += 1;
            break;
          case "n":
            out += "\n";
            at += 1;
            break;
          case "r":
            out += "\r";
            at += 1;
            break;
          case "t":
            out += "\t";
            at += 1;
            break;
          case "u": {
            const digits = text.slice(at + 1, at + 5);
            if (!HEX_QUAD.test(digits)) {
              fail(String.raw`malformed \u escape`);
            }
            out += String.fromCodePoint(Number.parseInt(digits, 16));
            at += 5;
            break;
          }
          default:
            fail(`unknown escape \\${escape ?? "?"}`);
        }
      } else {
        if (c < " ") {
          fail("control character in string");
        }
        out += c;
        at += 1;
      }
    }
  };

  const number = (): number => {
    const start = at;
    if (text[at] === "-") {
      at += 1;
    }
    if (text[at] === "0") {
      at += 1;
    } else if ((text[at] ?? "") >= "1" && (text[at] ?? "") <= "9") {
      while ((text[at] ?? "") >= "0" && (text[at] ?? "") <= "9") {
        at += 1;
      }
    } else {
      fail("malformed number");
    }
    if (text[at] === ".") {
      at += 1;
      if (!((text[at] ?? "") >= "0" && (text[at] ?? "") <= "9")) {
        fail("malformed number");
      }
      while ((text[at] ?? "") >= "0" && (text[at] ?? "") <= "9") {
        at += 1;
      }
    }
    if (text[at] === "e" || text[at] === "E") {
      at += 1;
      if (text[at] === "+" || text[at] === "-") {
        at += 1;
      }
      if (!((text[at] ?? "") >= "0" && (text[at] ?? "") <= "9")) {
        fail("malformed number");
      }
      while ((text[at] ?? "") >= "0" && (text[at] ?? "") <= "9") {
        at += 1;
      }
    }
    return Number(text.slice(start, at));
  };

  const literal = (word: "true" | "false" | "null", value: unknown): unknown => {
    if (!text.startsWith(word, at)) {
      fail(`malformed value`);
    }
    at += word.length;
    return value;
  };

  const value = (level: number): unknown => {
    if (level > depth) {
      fail("document nests too deeply");
    }
    ws();
    const c = text[at];
    if (c === '"') {
      return string();
    }
    if (c === "{") {
      const object: Record<string, unknown> = {};
      const keys = new Set<string>();
      at += 1;
      ws();
      if (text[at] === "}") {
        at += 1;
        return object;
      }
      for (;;) {
        ws();
        if (text[at] !== '"') {
          fail("expected a member name");
        }
        const key = string();
        if (keys.has(key)) {
          fail(`duplicate key ${JSON.stringify(key)}`);
        }
        keys.add(key);
        ws();
        if (text[at] !== ":") {
          fail("expected ':'");
        }
        at += 1;
        const member = value(level + 1);
        Object.defineProperty(object, key, {
          value: member,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        ws();
        if (text[at] === ",") {
          at += 1;
          continue;
        }
        if (text[at] === "}") {
          at += 1;
          return object;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      const array: unknown[] = [];
      at += 1;
      ws();
      if (text[at] === "]") {
        at += 1;
        return array;
      }
      for (;;) {
        array.push(value(level + 1));
        ws();
        if (text[at] === ",") {
          at += 1;
          continue;
        }
        if (text[at] === "]") {
          at += 1;
          return array;
        }
        fail("expected ',' or ']'");
      }
    }
    if (c === "t") {
      return literal("true", true);
    }
    if (c === "f") {
      return literal("false", false);
    }
    if (c === "n") {
      return literal("null", null);
    }
    return number();
  };

  const parsed = value(1);
  ws();
  if (at !== text.length) {
    fail("trailing text after the JSON value");
  }
  return parsed;
};
