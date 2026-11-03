/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The repo does not depend on @types/bun; declare the used surface.
declare const Bun: {
  JSONC: { parse: (text: string) => unknown };
};

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

const REPOSITORY_URL = "git+https://github.com/qntx/wallet.git";

export type PackageEntry = { path: string; pkg: unknown };

const scanDir = (dir: string): PackageEntry[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, "package.json"))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, pkg: JSON.parse(readFileSync(path, "utf8")) as unknown }));

/**
 * Consistency check: internal `@qntx/*` dependencies must be exact `<version>` pins in
 * dependencies, peerDependencies and devDependencies — a caret peer would let a different package
 * version slip in against a bundled kernel built for one protocol version — and every `workspaces`
 * entry in bun.lock must record the package.json version of its workspace directory. The private
 * workspace root is not passed in.
 */
export function checkVersion(packages: PackageEntry[], bunLock: unknown): string[] {
  const errors: string[] = [];

  const internalVersions = new Map<string, string>();
  for (const { pkg } of packages) {
    const { name, version } = asRecord(pkg);
    if (typeof name === "string" && typeof version === "string") {
      internalVersions.set(name, version);
    }
  }

  for (const { path, pkg } of packages) {
    const manifest = asRecord(pkg);
    const { version } = manifest;
    if (typeof version !== "string") {
      errors.push(`${path}: missing string "version"`);
      continue;
    }
    for (const section of ["dependencies", "peerDependencies", "devDependencies"] as const) {
      const deps = asRecord(manifest[section]);
      for (const [name, spec] of Object.entries(deps)) {
        const depVersion = internalVersions.get(name);
        if (depVersion === undefined) {
          continue;
        }
        if (spec !== depVersion) {
          errors.push(
            `${path}: ${section}["${name}"] must be "${depVersion}", got ${JSON.stringify(spec)}`,
          );
        }
      }
    }
  }

  // bun.lock mirrors each workspace manifest's `version` under `workspaces`
  // keyed by directory; drift means the lockfile refresh was skipped.
  const workspaces = asRecord(asRecord(bunLock)["workspaces"]);
  for (const { path, pkg } of packages) {
    const dir = path.slice(0, -"/package.json".length);
    const { version } = asRecord(pkg);
    const entry = workspaces[dir];
    if (entry === undefined) {
      errors.push(`bun.lock: missing workspaces["${dir}"] entry`);
      continue;
    }
    const lockVersion = asRecord(entry)["version"];
    if (lockVersion !== version) {
      errors.push(
        `bun.lock: workspaces["${dir}"] has version ${JSON.stringify(lockVersion)}, expected ${JSON.stringify(version)}`,
      );
    }
  }

  // The kernel's runtime dependencies are the enclave's protocol attack surface: every one must
  // be an exact pin, and bun.lock must resolve that exact version (workspace deps are covered by
  // the internal-pin rule above).
  // npm provenance rejects a publish whose repository does not match the building repository, so
  // every published package declares it, down to its own directory.
  for (const { path, pkg } of packages) {
    const manifest = asRecord(pkg);
    if (manifest["private"] === true) {
      continue;
    }
    const repository = asRecord(manifest["repository"]);
    const directory = path.replace(/\/package\.json$/, "");
    if (repository["url"] !== REPOSITORY_URL || repository["directory"] !== directory) {
      errors.push(
        `${path}: repository must be { url: "${REPOSITORY_URL}", directory: "${directory}" }`,
      );
    }
  }

  const kernel = packages.find(({ pkg }) => asRecord(pkg)["name"] === "@qntx/wallet-kernel");
  if (kernel === undefined) {
    errors.push("packages: @qntx/wallet-kernel not found");
  } else {
    const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
    const lockPackages = asRecord(asRecord(bunLock)["packages"]);
    for (const [name, spec] of Object.entries(asRecord(asRecord(kernel.pkg)["dependencies"]))) {
      if (typeof spec !== "string" || !exact.test(spec)) {
        errors.push(
          `${kernel.path}: dependencies["${name}"] must be an exact version, got ${JSON.stringify(spec)}`,
        );
        continue;
      }
      if (internalVersions.has(name)) {
        continue;
      }
      const lockEntry = lockPackages[name];
      const resolvedField: unknown = Array.isArray(lockEntry) ? lockEntry[0] : undefined;
      if (typeof resolvedField !== "string") {
        errors.push(`bun.lock: packages["${name}"] has no resolved version`);
        continue;
      }
      const resolved = resolvedField.slice(name.length + 1);
      if (resolved !== spec) {
        errors.push(
          `bun.lock: packages["${name}"] resolves ${JSON.stringify(resolved)}, kernel pins ${JSON.stringify(spec)}`,
        );
      }
    }
  }

  return errors;
}

/**
 * Every `vite` spec aliased to @voidzero-dev/vite-plus-core must match the manifest's own
 * `vite-plus` version: vp resolves its vite command through the alias, and drift between the two is
 * what broke CI on the vite-plus 1.4.0 bump.
 */
export function checkViteAliases(manifests: PackageEntry[]): string[] {
  const errors: string[] = [];
  for (const { path, pkg } of manifests) {
    const manifest = asRecord(pkg);
    const vitePlus = asRecord(manifest["devDependencies"])["vite-plus"];
    if (typeof vitePlus !== "string") {
      continue;
    }
    for (const section of ["dependencies", "devDependencies", "overrides"] as const) {
      const spec = asRecord(manifest[section])["vite"];
      const core =
        typeof spec === "string"
          ? /^npm:@voidzero-dev\/vite-plus-core@(.+)$/.exec(spec)?.[1]
          : undefined;
      if (core !== undefined && core !== vitePlus) {
        errors.push(
          `${path}: ${section}["vite"] resolves vite-plus-core ${core}, expected ${vitePlus} to match vite-plus`,
        );
      }
    }
  }
  return errors;
}

/**
 * Every dependency spec across dependencies, devDependencies and peerDependencies is exact — a
 * semver range (`^`, `~`, `>=`, `*`, a bare major) lets a different version slip in against a
 * release built and manifested for one. Allowed forms: a literal `x.y.z` (with optional
 * prerelease), `workspace:*`/`catalog:`/`file:`/`link:` (not version specs at all), and an `npm:`
 * alias whose target is itself exact (`npm:name@x.y.z`).
 */
const EXACT_SPEC = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const TILDE_SPEC = /^~\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const exactTarget = (spec: string): boolean => {
  if (spec.startsWith("npm:")) {
    const target = spec.slice("npm:".length);
    return EXACT_SPEC.test(target.slice(target.lastIndexOf("@") + 1));
  }
  return EXACT_SPEC.test(spec);
};

const isSpecForm = (spec: string): boolean =>
  spec.startsWith("workspace:") ||
  spec.startsWith("catalog:") ||
  spec.startsWith("file:") ||
  spec.startsWith("link:");

/**
 * Dependency and devDependency specs are exact pins; a semver range lets a different version slip
 * in against a release built and manifested for one. peerDependencies are different: the
 * `@qntx/wallet*` packages released together from this repo must be exact peers, but any other peer
 * (`@qntx/nostr`, `@qntx/spark`, react-native…) may carry a tilde range — an exact peer would force
 * every consumer onto one patch and npm would refuse the install. A caret is never allowed
 * anywhere. `npm:` aliases are exact when their target is.
 */
export function checkExactDeps(manifests: PackageEntry[]): string[] {
  const errors: string[] = [];
  for (const { path, pkg } of manifests) {
    const manifest = asRecord(pkg);
    for (const section of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      for (const [name, spec] of Object.entries(asRecord(manifest[section]))) {
        if (typeof spec !== "string" || isSpecForm(spec)) {
          continue;
        }
        if (
          section === "peerDependencies" &&
          !name.startsWith("@qntx/wallet") &&
          TILDE_SPEC.test(spec)
        ) {
          continue; // a peer released elsewhere may pin a compatible patch line.
        }
        if (!exactTarget(spec)) {
          errors.push(`${path}: ${section}["${name}"] must be exact, got ${JSON.stringify(spec)}`);
        }
      }
    }
  }
  return errors;
}

if (import.meta.main) {
  // Only directories with a package.json are workspaces; bare leftovers may
  // exist under packages/.
  const packages = scanDir("packages");
  const errors = checkVersion(packages, Bun.JSONC.parse(readFileSync("bun.lock", "utf8")));
  const manifests: PackageEntry[] = [
    { path: "package.json", pkg: JSON.parse(readFileSync("package.json", "utf8")) as unknown },
    ...packages,
    ...scanDir("apps"),
  ];
  errors.push(...checkViteAliases(manifests), ...checkExactDeps(manifests));
  for (const error of errors) {
    console.error(`check-version: ${error}`);
  }
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}
