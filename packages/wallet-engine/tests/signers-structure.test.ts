import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

/**
 * The one signing path: outside `src/signers/` no engine file may call `.sign(` on a `chains(...)`
 * expression or import the `card`/`hardware` facades — custody dispatch lives only in the
 * SignersController.
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
  /chains\([^)]*\)\.sign\(/,
  /^import(?!\s+type\s)[^;]*from "@qntx\/wallet\/(card|hardware)"/m,
];

describe("the signers module owns every signature", () => {
  it("no file outside src/signers signs through chains() or imports the signer facades", () => {
    const offenders = sources(SRC)
      .filter((file) => !file.includes("/src/signers/"))
      .filter((file) => OWNED.some((pattern) => pattern.test(readFileSync(file, "utf8"))));
    expect(offenders).toStrictEqual([]);
  });
});
