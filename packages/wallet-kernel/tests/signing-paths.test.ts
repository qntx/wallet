/**
 * Signing-path seams — the structural half of "the kernel signs only through the plan → backend →
 * assemble pipeline": the `@qntx/wallet-chains/<family>/sign` private-key entries are imported only
 * by run.ts (the plan executor) and sessions.ts (the session signer), and inside modules/chains
 * only keys.ts touches derivation or curve code.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vite-plus/test";

const SRC = join(import.meta.dirname, "..", "src");
const CHAINS = join(SRC, "modules", "chains");

const tsFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));

type ImportEdge = {
  readonly specifier: string;
  readonly names: ReadonlyArray<string>;
};

/**
 * The static imports of one source file: `{ specifier, names }` per `import … from "…"` clause.
 * `import type` counts — a type edge is still a dependency edge — as do multi-line clauses and
 * default/namespace bindings. Side-effect imports return `names: []`.
 */
const importsOf = (source: string): ReadonlyArray<ImportEdge> => {
  const out: ImportEdge[] = [];
  const clause = /\bimport\s+(?:type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gs;
  for (const match of source.matchAll(clause)) {
    out.push({ specifier: match[2] ?? "", names: importNames(match[1] ?? "") });
  }
  const sideEffect = /\bimport\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(sideEffect)) {
    out.push({ specifier: match[1] ?? "", names: [] });
  }
  return out;
};

/** The bound identifiers of an import clause: default, `* as ns`, and `{ name, other as alias }`. */
const importNames = (clause: string): ReadonlyArray<string> => {
  const names: string[] = [];
  const namespace = /\*\s+as\s+(\w+)/.exec(clause);
  if (namespace !== null) {
    names.push(namespace[1] ?? "");
  }
  const braces = /\{([^}]*)\}/s.exec(clause);
  if (braces !== null) {
    for (const entry of (braces[1] ?? "").split(",")) {
      const imported = entry
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (imported !== undefined && imported !== "") {
        names.push(imported);
      }
    }
  }
  if (namespace === null && braces === null) {
    names.push(clause.trim());
  }
  const leading = clause.trimStart();
  if (braces !== null && /^[^{]/.test(leading)) {
    // `Default, { named }` — the default binding precedes the braces.
    names.unshift(leading.split(",")[0]?.trim() ?? "");
  }
  return names;
};

/** Line and block comments removed so identifier checks see only live code. */
const stripComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");

describe("chains/*/sign imports", () => {
  it("the extractor handles import type and multi-line imports", () => {
    const fixture = `import a from "mod-a";
import * as ns from "mod-b";
import { one, two as renamed } from "mod-c";
import type {
  T1,
  T2,
} from "mod-d";
import {
  multi1,
  multi2 as aliased,
} from "mod-e";
import { type Inline, other } from "mod-f";
import "mod-g/side";
`;
    expect(importsOf(fixture)).toStrictEqual([
      { specifier: "mod-a", names: ["a"] },
      { specifier: "mod-b", names: ["ns"] },
      { specifier: "mod-c", names: ["one", "two"] },
      { specifier: "mod-d", names: ["T1", "T2"] },
      { specifier: "mod-e", names: ["multi1", "multi2"] },
      { specifier: "mod-f", names: ["Inline", "other"] },
      { specifier: "mod-g/side", names: [] },
    ]);
  });

  const SIGN = /^@qntx\/wallet-chains\/(bitcoin|evm|solana|tron)\/sign$/;

  const signImportMap = (): Record<string, Record<string, ReadonlyArray<string>>> => {
    const map: Record<string, Record<string, ReadonlyArray<string>>> = {};
    for (const file of tsFiles(SRC)) {
      const edges: Record<string, ReadonlyArray<string>> = {};
      for (const edge of importsOf(readFileSync(file, "utf8"))) {
        if (SIGN.test(edge.specifier)) {
          edges[edge.specifier] = edge.names;
        }
      }
      if (Object.keys(edges).length > 0) {
        map[relative(SRC, file)] = edges;
      }
    }
    return map;
  };

  it("only run.ts and sessions.ts import a family /sign entry", () => {
    expect(signImportMap()).toStrictEqual({
      "modules/chains/run.ts": {
        "@qntx/wallet-chains/bitcoin/sign": ["signBitcoinTask"],
        "@qntx/wallet-chains/evm/sign": ["signEvmTask"],
        "@qntx/wallet-chains/solana/sign": ["signSolanaTask"],
        "@qntx/wallet-chains/tron/sign": ["signTronTask"],
      },
      "modules/sessions/sessions.ts": {
        "@qntx/wallet-chains/evm/sign": ["signEvmTypedData"],
      },
    });
  });
});

describe("modules/chains internals", () => {
  const CRYPTO = /^@scure\/bip32$|^micro-key-producer\/|^@noble\/curves\//;

  const siblings = tsFiles(CHAINS).filter((file) => !file.endsWith("keys.ts"));

  const cryptoHolders = (): string[] => {
    const holders: string[] = [];
    for (const file of siblings) {
      if (importsOf(readFileSync(file, "utf8")).some((edge) => CRYPTO.test(edge.specifier))) {
        holders.push(relative(CHAINS, file));
      }
    }
    return holders;
  };

  it("only keys.ts imports derivation or curve code; no sibling signs with raw material", () => {
    expect(cryptoHolders()).toStrictEqual([]);
    for (const file of siblings) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("fromMasterSeed");
      expect(source).not.toContain("privateKey");
      // `backend.sign(task)` is the SigningBackend dispatch; any other `.sign(` would be a
      // sibling signing with raw key material outside the keys.ts bridge.
      expect(stripComments(source).replaceAll(/\bbackend\.sign\(/g, "")).not.toContain(".sign(");
    }
    expect(
      importsOf(readFileSync(join(CHAINS, "keys.ts"), "utf8")).some((edge) =>
        CRYPTO.test(edge.specifier),
      ),
    ).toBe(true);
  });

  it("index.ts hands the withWalletSeed seed only to seedKeys(", () => {
    const source = stripComments(readFileSync(join(CHAINS, "index.ts"), "utf8"));
    const passed = /seedKeys\(\s*seed\b|\(\s*seed\s*\)\s*=>/g;
    expect(/\bseed\b/.test(source.replaceAll(passed, ""))).toBe(false);
  });
});
