/**
 * The consumer scaffold's third-party dependencies are a pure function of the three first-party
 * manifests: the union of their dependencies plus @qntx/wallet's non-first-party peers (npm does
 * not auto-install tarball peers) plus the repo's vite. The smoke and the lockfile regenerator
 * share this one derivation so the committed manifest and lockfile can never drift from it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../..", import.meta.url).pathname;

export const CONSUMER = join(ROOT, "packages/wallet-worker/tests/consumer");

const FIRST_PARTY = new Set(["@qntx/wallet-chains", "@qntx/wallet", "@qntx/wallet-worker"]);

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

export const manifest = (path: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`${path} did not parse to an object`);
  }
  return parsed;
};

export const entriesOf = (value: unknown): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  if (isRecord(value)) {
    for (const [name, spec] of Object.entries(value)) {
      if (typeof spec === "string") {
        out.push([name, spec]);
      }
    }
  }
  return out;
};

export const expectedDependencies = (): Record<string, string> => {
  const deps: Record<string, string> = {};
  for (const pkg of FIRST_PARTY) {
    for (const [name, spec] of entriesOf(
      manifest(join(ROOT, "packages", pkg.slice(6), "package.json"))["dependencies"],
    )) {
      if (!FIRST_PARTY.has(name)) {
        deps[name] = spec;
      }
    }
  }
  for (const [name, spec] of entriesOf(
    manifest(join(ROOT, "packages/wallet/package.json"))["peerDependencies"],
  )) {
    if (!FIRST_PARTY.has(name)) {
      deps[name] = spec.replace(/^~/, "");
    }
  }
  const root = manifest(join(ROOT, "package.json"));
  for (const [name, spec] of entriesOf(root["devDependencies"])) {
    if (name === "vite") {
      deps[name] = spec;
    }
  }
  return Object.fromEntries(Object.entries(deps).toSorted(([a], [b]) => a.localeCompare(b)));
};
