/**
 * A `wrangler.jsonc` reader usable from bun scripts and the test suite alike: strips `//` comments
 * outside string literals and trailing commas, then `JSON.parse`s. The same logic lives inline in
 * packages/wallet-engine/tests/gateway-capacity/harness.ts — keep them in step.
 */
export function parseJsonc(raw: string): unknown {
  let inString = false;
  let stripped = "";
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === '"' && raw[i - 1] !== "\\") {
      inString = !inString;
      stripped += c;
      continue;
    }
    if (!inString && c === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") {
        i += 1;
      }
      stripped += "\n";
      continue;
    }
    stripped += c;
  }
  return JSON.parse(stripped.replaceAll(/,(\s*[}\]])/g, "$1"));
}
