/**
 * The provider SPI, verified independently of check-boundaries.ts: providers under
 * `src/apps/<app>/` may reach the engine only through `src/apps/spi.ts`, the core files never name
 * an app, nothing outside a provider dir imports into it, and every runtime value the SPI
 * re-exports is public API — `createAppSocketCore` is the one in-tree exception (see spi.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import * as apps from "../src/apps/index.ts";
import * as spi from "../src/apps/spi.ts";
import * as main from "../src/index.ts";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(PKG, "src");
const APPS = join(SRC, "apps");
const SPI = join(APPS, "spi.ts");
const ENGINE_PACKAGE = /^@qntx\/wallet-engine(?:\/|$)/;

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );

const providerDirs = readdirSync(APPS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/**
 * The static specifier spellings: `from "x"`, `import("x")` and bare `import "x"`. Comments are
 * stripped first so a documented example cannot read as an edge (the `[^:]` keeps `wss://…` inside
 * a string literal from eating the rest of the line).
 */
const specifiers = (source: string): ReadonlyArray<string> => {
  const stripped = source
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/(^|[^:])\/\/[^\n]*/g, "$1");
  return [...stripped.matchAll(/(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
};

const appDirOf = (path: string): string | undefined =>
  providerDirs.find((app) => path.startsWith(join(APPS, app) + sep));

/** A provider edge is legal only inside its own dir or at the SPI — everything else reports. */
const providerViolation = (file: string, spec: string): string | undefined => {
  if (ENGINE_PACKAGE.test(spec)) {
    return `${file} imports the engine by name: "${spec}"`;
  }
  if (!spec.startsWith(".")) {
    return undefined;
  }
  const resolved = resolve(dirname(file), spec);
  return resolved.startsWith(PKG) && appDirOf(resolved) !== appDirOf(file) && resolved !== SPI
    ? `${file} reaches outside its provider dir: "${spec}"`
    : undefined;
};

/** Every provider file's illegal engine edge, plus how much was scanned (never vacuous). */
const providerScan = (): { violations: string[]; files: number; edges: number } => {
  const violations: string[] = [];
  let files = 0;
  let edges = 0;
  for (const app of providerDirs) {
    for (const file of walk(join(APPS, app))) {
      files += 1;
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        edges += 1;
        const violation = providerViolation(file, spec);
        if (violation !== undefined) {
          violations.push(violation);
        }
      }
    }
  }
  return { violations, files, edges };
};

/** Provider names mentioned by the core `src/apps/*.ts` files — expected: none. */
const coreMentions = (): string[] =>
  readdirSync(APPS, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .flatMap((entry) => {
      const text = readFileSync(join(APPS, entry.name), "utf8").toLowerCase();
      return providerDirs
        .filter((app) => text.includes(app.toLowerCase()))
        .map((app) => `src/apps/${entry.name} mentions "${app}"`);
    });

/** Edges from outside a provider dir into one — the core and other apps never import a provider. */
const inboundViolations = (): string[] =>
  walk(SRC).flatMap((file) =>
    specifiers(readFileSync(file, "utf8")).flatMap((spec) => {
      if (!spec.startsWith(".")) {
        return [];
      }
      const toApp = appDirOf(resolve(dirname(file), spec));
      const fromApp = appDirOf(file);
      return toApp !== undefined && toApp !== fromApp
        ? [`${file} imports into src/apps/${toApp}/: "${spec}"`]
        : [];
    }),
  );

/** SPI runtime values that are not public exports of the main or `/apps` entries. */
const internalValues = (): string[] => {
  const publicValues = new Set<unknown>([...Object.values(main), ...Object.values(apps)]);
  return Object.entries(spi).flatMap(([name, value]) => (publicValues.has(value) ? [] : [name]));
};

const SAMPLE_FILE = join(APPS, providerDirs[0] ?? "x", "sample.ts");

describe("apps provider SPI", () => {
  it("flags a direct engine import on an inline sample — the extractor self-check", () => {
    const sample =
      'import { timeoutSignal } from "../../timer.ts";\nexport const x = timeoutSignal;\n';
    expect(specifiers(sample)).toContain("../../timer.ts");
    expect(providerViolation(SAMPLE_FILE, "../../timer.ts")).toContain("outside its provider dir");
    expect(providerViolation(SAMPLE_FILE, "@qntx/wallet-engine")).toContain("by name");
    expect(providerViolation(SAMPLE_FILE, "../spi.ts")).toBeUndefined();
    expect(providerViolation(SAMPLE_FILE, "./sibling.ts")).toBeUndefined();
  });

  it("providers reach the engine only through src/apps/spi.ts", () => {
    const { violations, files, edges } = providerScan();
    expect(files).toBeGreaterThan(0);
    expect(edges).toBeGreaterThan(0);
    expect(violations).toStrictEqual([]);
  });

  it("the core apps files never name a provider", () => {
    expect(coreMentions()).toStrictEqual([]);
  });

  it("nothing outside a provider dir imports into it", () => {
    expect(inboundViolations()).toStrictEqual([]);
  });

  it("every SPI runtime value is public API except the in-tree socket core", () => {
    /* `createAppSocketCore` stays in-tree until the providers leave the package — exporting it
       would grow the `/apps` core entry for code every provider bundle already carries. */
    expect(internalValues()).toStrictEqual(["createAppSocketCore"]);
  }, 30_000);
});
