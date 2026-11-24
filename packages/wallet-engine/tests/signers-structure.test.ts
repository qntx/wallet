import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

/**
 * The one signing path: outside `src/signers/` no engine file may call `chains(...)`, import the
 * `card`/`hardware` facades, or call them — account derivation and custody dispatch live only in
 * the SignersController, and every consumer goes through `signers.apis`.
 */
const SRC = new URL("../src/", import.meta.url);

const sources = (dir: URL): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(new URL(`${entry.name}/`, dir))
      : entry.name.endsWith(".ts")
        ? [new URL(entry.name, dir).pathname]
        : [],
  );

const OWNED = [
  /\bchains\(/,
  /^import(?!\s+type\s)[^;]*from "@qntx\/wallet\/(card|hardware)"/m,
  /\b(?:card|hardware)\(/,
];

describe("the signers module owns every signature", () => {
  it("no file outside src/signers calls chains() or touches the signer facades", () => {
    const offenders = sources(SRC)
      .filter((file) => !file.includes("/src/signers/"))
      .filter((file) => OWNED.some((pattern) => pattern.test(readFileSync(file, "utf8"))));
    expect(offenders).toStrictEqual([]);
  });
});
