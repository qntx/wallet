/// <reference types="node" />
/**
 * Shared kernel-manifest pieces: bun.lock parsing and the exact-pin library/bundle
 * resolution used by both the wallet-worker manifest script and
 * `scripts/build-kernel.ts`. Callers assemble their own manifest shape on top.
 */
import { createHash } from "node:crypto";

export type ManifestLibrary = { readonly name: string; readonly version: string; readonly integrity: string };
export type ManifestBundle = { readonly file: string; readonly sha256: string };

/**
 * Bun.lock is JSONC: generated entries carry trailing commas but no comments. Stripping commas
 * ahead of `}`/`]` makes it strict JSON; entry values are single-line, so the pattern cannot match
 * inside a string.
 */
export function parseLockfile(text: string): unknown {
  return JSON.parse(text.replaceAll(/,(\s*[}\]])/g, "$1")) as unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function lockPackages(bunLock: unknown): Record<string, unknown> {
  const packages = isRecord(bunLock) ? bunLock["packages"] : undefined;
  return isRecord(packages) ? packages : {};
}

export function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string") {
        out[key] = entry;
      }
    }
  }
  return out;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * `dependencies` is the kernel package's dependency table, `backendDependencies` any host-side
 * backend packages, `lockPackages` the `packages` section of a parsed bun.lock. A dependency
 * resolving to a `workspace:` path is bundled source, not a registry library — it is not listed
 * (its contract is pinned by `protocol`/`vaultFormat`). Everything else must be an exact pin that
 * resolves to itself with a recorded integrity.
 */
export function manifestLibraries(input: {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly backendDependencies?: Readonly<Record<string, string>>;
  readonly lockPackages: Readonly<Record<string, unknown>>;
}): ManifestLibrary[] {
  const libraries: ManifestLibrary[] = [];
  const entries = [
    ...Object.entries(input.dependencies),
    ...Object.entries(input.backendDependencies ?? {}),
  ].toSorted(([a], [b]) => a.localeCompare(b));
  for (const [name, spec] of entries) {
    if (!EXACT_VERSION.test(spec)) {
      throw new Error(`${name}: kernel dependencies must be exact versions, got "${spec}"`);
    }
    const entry = input.lockPackages[name];
    const resolvedField: unknown = Array.isArray(entry) ? entry[0] : undefined;
    const integrity: unknown = Array.isArray(entry) ? entry[3] : undefined;
    if (typeof resolvedField !== "string") {
      throw new TypeError(`${name}: not resolved in bun.lock`);
    }
    const resolved = resolvedField.slice(name.length + 1);
    if (resolved.startsWith("workspace:")) {
      continue;
    }
    if (resolved !== spec) {
      throw new Error(`${name}: pinned ${spec} but bun.lock resolves ${resolved}`);
    }
    if (typeof integrity !== "string" || integrity.length === 0) {
      throw new Error(`${name}: bun.lock records no integrity`);
    }
    libraries.push({ name, version: spec, integrity });
  }
  return libraries;
}

/** SHA-256 of each emitted bundle file. */
export function manifestBundles(
  bundles: ReadonlyArray<{ readonly file: string; readonly bytes: Uint8Array }>,
): ManifestBundle[] {
  return bundles.map(({ file, bytes }) => ({
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
}
