/// <reference types="node" />
/**
 * Every tool CI runs must come from the lockfile, and its version must have one source of truth.
 * Bun is pinned by the root package.json `packageManager` field: every `oven-sh/setup-bun` step
 * reads it via `bun-version-file: package.json` (a literal `bun-version` would be a second,
 * drifting source), `devEngines.packageManager` is gone for the same reason, and reusable workflows
 * — which install Bun inside a definition this repo does not control — are handed the resolved
 * version through a `toolchain` job's output so they still pin the same one. Every
 * `actions/setup-node` step pins an exact `X.Y.Z` so the npm it bundles is stable, and the other
 * toolchain actions pin an exact version input (`actions/setup-java` `java-version` X.Y.Z(+B),
 * `foundry-rs/foundry-toolchain` `version` vX.Y.Z — its default is the floating `stable`). Every
 * `uses:` reference — job-level reusable calls included — pins a full commit sha (a step-level
 * `docker://image@sha256:` satisfies it). Command text — `run:` steps (after YAML decoding and
 * alias resolution), composite-action steps, Dockerfile `RUN` bodies and manifest scripts — is
 * parsed by the POSIX-shell lexer in `shell-words.ts` into pipelines of argv tokens, so quoting,
 * `\\`-continuations, comments, `$(…)`/backtick/process substitutions and heredocs cannot hide a
 * command; `sh -c`, `eval` and heredoc bodies fed to a shell recurse as scripts. Over the
 * normalized commands: `bunx`/`bun x`/`npx`/`npm exec`/`npm x` names a bin provided by a dependency
 * declared in the root manifest or the step's working-directory manifest — an undeclared name would
 * resolve against the registry instead of the lockfile — and nothing may reach a registry at all:
 * `curl`/`wget` piped to an interpreter (or substituted into one's argv), `npm
 * install|install-test|update` after npm's own alias-and-abbreviation dereference (`npm ci` is
 * fine, `--offline` clears install), `bun add|update|create`, `bun install` without
 * `--frozen-lockfile` in that same invocation, `pnpm dlx`/`yarn dlx`/`pnpx`, `pip install` without
 * a `--require-hashes` or `--no-index` token, and `docker run|create|pull` (the `container run` /
 * `image pull` spellings included) of an image that is neither digest-pinned nor built by the
 * file's own `docker/build-push-action` steps or `docker build -t` commands. `container.image` and
 * `services.*.image` pin `@sha256:` digests, and a Dockerfile `FROM` is a `@sha256:` image or a
 * prior build stage. `bunfig.toml`'s `[install]` table — the parsed document, not the text — sets
 * `minimumReleaseAge >= 604800` and its `minimumReleaseAgeExcludes` entries must be exact
 * `name@X.Y.Z` pins — a bare name exempts every future release of that package from the 7-day
 * cooldown, not just the one the PR meant to land early — and every directory that keeps a
 * `bun.lock` carries a `bunfig.toml` meeting that bar.
 *
 * Deliberately not covered: the internals of script files a `run:` command or manifest script
 * invokes (a `bun scripts/x.ts` is checked for its own command words, not the files it runs); tools
 * the runner image itself provides (docker, buildx, jq, apt); `apt-get` and `rustup
 * --default-toolchain stable` inside the emulator Dockerfiles; the Gradle wrapper; a `curl -o` that
 * only downloads a file a following sha256 check verifies; heredoc bodies fed to a non-shell
 * interpreter (`python <<EOF` is checked as `python`, not as Python source); and a Dockerfile
 * `RUN`'s `# escape=` parser directive (backslash continuations are assumed). Exit 1 with one line
 * per finding.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from "yaml";

import { parse } from "./shell-words.ts";
import type { Command } from "./shell-words.ts";
import {
  checkCommand,
  checkCommands,
  collectBuildTags,
  DIGEST_IMAGE,
  squeezeExpressions,
} from "./toolchain-commands.ts";
import type { DependencyIndex } from "./toolchain-commands.ts";

export type { DependencyIndex } from "./toolchain-commands.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const BUN_ACTION = "oven-sh/setup-bun@";
const NODE_ACTION = "actions/setup-node@";
const JAVA_ACTION = "actions/setup-java@";
const FOUNDRY_ACTION = "foundry-rs/foundry-toolchain@";
const BUILD_PUSH_ACTION = "docker/build-push-action@";
const VERSION_FILE = "package.json";
const PACKAGE_MANAGER = /^bun@\d+\.\d+\.\d+$/;
/** `name@X.Y.Z`, scoped names allowed — no ranges, no bare names, no tags. */
const EXACT_PIN = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+@\d+\.\d+\.\d+$/;
const EXACT_NODE = /^\d+\.\d+\.\d+$/;
/** Setup-java `java-version`: a full `X.Y.Z` release with an optional `+B` build suffix. */
const EXACT_JAVA = /^\d+\.\d+\.\d+(\+\d+)?$/;
/** Foundry-toolchain `version`: a full `vX.Y.Z` release tag. */
const EXACT_FOUNDRY = /^v\d+\.\d+\.\d+$/;
/** A `uses:` reference's ref: a full commit sha, or a `./` local path (checked separately). */
const PINNED_REF = /@[0-9a-f]{40}$/;
/** Every directory under bunfig needs at least this release age — the 7-day cooldown. */
const MIN_RELEASE_AGE = 604800;
const REUSABLE = /^[^/\s]+\/[^/\s]+\/\.github\/workflows\/[^/\s]+\.ya?ml@/;
/** Reusable workflows that install no Bun — allow-listed out of the toolchain gate. */
const NO_BUN_REUSABLE = new Set(["qntx/workflows/.github/workflows/release.yml"]);
const NEEDS_TOOLCHAIN = `\${{ needs.toolchain.outputs.bun-version }}`;
const STEPS_BUN = `\${{ steps.bun.outputs.bun-version }}`;

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): JsonObject => (isRecord(value) ? value : {});

/** The names a dependency's `bin` field offers: a string bin takes the unscoped package name. */
const binNames = (pkg: string, field: unknown): ReadonlyArray<string> =>
  typeof field === "string"
    ? [pkg.startsWith("@") ? (pkg.split("/")[1] ?? pkg) : pkg]
    : isRecord(field)
      ? Object.keys(field)
      : [];

/** The deps a manifest declares — dependencies and devDependencies hold the tool bins. */
const declaredDeps = (dir: string): ReadonlyArray<string> => {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) {
    return [];
  }
  const pkg: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  return [
    ...Object.keys(asRecord(asRecord(pkg)["dependencies"])),
    ...Object.keys(asRecord(asRecord(pkg)["devDependencies"])),
  ];
};

/**
 * The real resolver: for each in-scope manifest dir, each declared dependency's package.json is
 * read from that dir's node_modules, falling back to the root's (workspace installs hoist).
 */
export const liveIndex = (root: string): DependencyIndex => ({
  bin: (name, dirs) => {
    for (const dir of dirs) {
      for (const dep of declaredDeps(dir)) {
        const candidates = [join(dir, "node_modules", dep), join(root, "node_modules", dep)];
        const manifest = candidates.map((d) => join(d, "package.json")).find(existsSync);
        if (manifest === undefined) {
          /* A declared dependency not installed in this context (apps/harness installs in the
             jobs that use it): bunx/npx resolve `bunx <name>` to package `<name>` by convention —
             accept the unscoped name, nothing more. */
          if ((dep.startsWith("@") ? dep.split("/")[1] : dep) === name) {
            return dep;
          }
          continue;
        }
        const pkg: unknown = JSON.parse(readFileSync(manifest, "utf8"));
        if (binNames(dep, asRecord(pkg)["bin"]).includes(name)) {
          return dep;
        }
      }
    }
    return undefined;
  },
  declared: (name, dirs) => dirs.some((dir) => declaredDeps(dir).includes(name)),
});

/** The directories a `run:` step resolves against: its working-directory, then the root. */
const stepDirs = (root: string, workingDirectory: string | undefined): string[] => {
  const dir = join(root, workingDirectory ?? ".");
  return dir === root ? [root] : [dir, root];
};

/**
 * A yaml scalar's text — strings, numbers and booleans only (a plain `String(value)` on a node
 * would stringify `[object Object]`).
 */
const scalarText = (node: unknown): string | undefined => {
  if (!isScalar(node)) {
    return undefined;
  }
  const value: unknown = node.value;
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : undefined;
};

/** A job's `needs`, whatever shape it took — scalar, list, or map. */
const needsItems = (needs: unknown): ReadonlyArray<unknown> => {
  if (isSeq(needs)) {
    return needs.items;
  }
  if (isMap(needs)) {
    return needs.items.map((p) => p.key);
  }
  return needs === undefined ? [] : [needs];
};

/** The step maps of a parsed workflow or composite action, with their source ranges. */
const stepNodes = (document: ReturnType<typeof parseDocument>): ReadonlyArray<unknown> => {
  const resolved = (node: unknown): unknown => (isAlias(node) ? node.resolve(document) : node);
  const steps: unknown[] = [];
  const jobs: unknown = resolved(document.get("jobs", true));
  if (isMap(jobs)) {
    for (const pair of jobs.items) {
      const job = resolved(pair.value);
      if (isMap(job)) {
        const seq = resolved(job.get("steps", true));
        if (isSeq(seq)) {
          for (const step of seq.items) {
            const item = resolved(step);
            if (isMap(item)) {
              steps.push(item);
            }
          }
        }
      }
    }
  }
  // A composite action carries its steps under runs.steps instead.
  const runs: unknown = resolved(document.get("runs", true));
  if (isMap(runs)) {
    const seq = resolved(runs.get("steps", true));
    if (isSeq(seq)) {
      for (const step of seq.items) {
        const item = resolved(step);
        if (isMap(item)) {
          steps.push(item);
        }
      }
    }
  }
  return steps;
};

/** The offset of a yaml node, for line numbers in findings. */
const offsetOf = (node: unknown): number | undefined => {
  if (!isNode(node)) {
    return undefined;
  }
  const { range } = node;
  return range === null || range === undefined ? undefined : range[0];
};

const lineAt = (source: string, offset: number | undefined): string => {
  if (offset === undefined) {
    return "";
  }
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (source[i] === "\n") {
      line += 1;
    }
  }
  return `:${line}`;
};

/** One `tags:` entry may still carry a comma- or newline-separated list. */
const splitTagValue = (text: string): string[] =>
  squeezeExpressions(text)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t !== "");

/**
 * The version-input rules every toolchain action step shares: `input` is the `with:` key that must
 * exist and match `pattern` exactly.
 */
const TOOLCHAIN_INPUTS: ReadonlyArray<{
  readonly action: string;
  readonly input: string;
  readonly pattern: RegExp;
}> = [
  { action: JAVA_ACTION, input: "java-version", pattern: EXACT_JAVA },
  { action: FOUNDRY_ACTION, input: "version", pattern: EXACT_FOUNDRY },
];

/**
 * Workflow and composite-action rules over the parsed document: every `uses:` pins a full commit
 * sha (or names a `./` local action or a `docker://` image digest); setup-bun steps read the
 * version from the root manifest and never pin their own; setup-node and the other toolchain
 * actions pin exact versions; a `run:` command follows the shared command rules — after YAML
 * decoding, so a `\`-continued literal block or a `#` comment line behaves like bash and an alias
 * node resolves like any anchor (one that does not is a finding); job `container`/`services` images
 * pin digests and `docker` commands may only reference digest-pinned or workflow-built images —
 * `docker build -t` inside a `run:` counts too; a non-allow-listed reusable workflow waits on
 * `toolchain` and is handed the resolved Bun version, which the file must produce in a `toolchain`
 * job. A stray `oven-sh/setup-bun@` mention outside a `uses:` step is still a finding — the
 * raw-source pass covers what parsing drops (comments, malformed steps).
 */
export function checkWorkflow(path: string, source: string, index: DependencyIndex): string[] {
  const errors: string[] = [];
  const at = (offset?: number): string => `${path}${lineAt(source, offset)}`;
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    return [`${path}: workflow does not parse — ${document.errors[0]?.message ?? ""}`];
  }

  /** A YAML alias resolves to its anchored node; an alias that does not is a finding. */
  const resolve = (node: unknown, atText: string): unknown => {
    if (!isAlias(node)) {
      return node;
    }
    const target = node.resolve(document);
    if (!isNode(target)) {
      errors.push(`${atText}: a YAML alias does not resolve`);
      return undefined;
    }
    return target;
  };
  const scalarAt = (map: unknown, key: string, atText: string): string | undefined =>
    isMap(map) ? scalarText(resolve(map.get(key, true), atText)) : undefined;
  const scalarPath = (map: unknown, atText: string, ...keys: string[]): string | undefined => {
    let node: unknown = map;
    for (const key of keys) {
      if (!isMap(node)) {
        return undefined;
      }
      node = resolve(node.get(key, true), atText);
    }
    return scalarText(node);
  };
  const recordOf = (map: unknown, key: string, atText: string): JsonObject => {
    const node = isMap(map) ? resolve(map.get(key, true), atText) : undefined;
    if (!isMap(node)) {
      return {};
    }
    const record: JsonObject = {};
    for (const pair of node.items) {
      if (isScalar(pair.key)) {
        record[String(pair.key.value)] = scalarText(resolve(pair.value, atText));
      }
    }
    return record;
  };
  const needsOf = (job: unknown, atText: string): ReadonlyArray<string> => {
    if (!isMap(job)) {
      return [];
    }
    return needsItems(resolve(job.get("needs", true), atText)).flatMap((n) => {
      const text = scalarText(resolve(n, atText));
      return text === undefined ? [] : [text];
    });
  };
  const buildPushTags = (step: unknown, atText: string): ReadonlyArray<string> => {
    const node = isMap(step) ? resolve(step.get("with", true), atText) : undefined;
    if (!isMap(node)) {
      return [];
    }
    const tags = resolve(node.get("tags", true), atText);
    if (isSeq(tags)) {
      return tags.items.flatMap((item) => {
        const text = scalarText(resolve(item, atText));
        return text === undefined ? [] : splitTagValue(text);
      });
    }
    const text = scalarText(tags);
    return text === undefined ? [] : splitTagValue(text);
  };

  const jobs: unknown = document.get("jobs", true);

  // Every setup-bun mention in the raw source must sit on a `uses:` line inside a real step.
  const allSteps = stepNodes(document);
  const stepRanges = allSteps.flatMap((step) => {
    const range = isNode(step) ? step.range : undefined;
    return range === null || range === undefined ? [] : [[range[0], range[2]] as const];
  });
  const lines = source.split("\n");
  let cursor = 0;
  for (const line of lines) {
    const offset = cursor;
    cursor += line.length + 1;
    if (!line.includes(BUN_ACTION)) {
      continue;
    }
    const usesColumn = line.indexOf("uses:");
    if (usesColumn === -1 || !/^uses:\s*oven-sh\/setup-bun@/.test(line.slice(usesColumn))) {
      errors.push(`${at(offset)}: a setup-bun reference must be a step's uses: line`);
      continue;
    }
    if (
      !stepRanges.some(([start, end]) => offset + usesColumn >= start && offset + usesColumn <= end)
    ) {
      errors.push(`${at(offset)}: cannot resolve the step holding this setup-bun reference`);
    }
  }

  // Images a `docker run|create|pull` may reference without a digest: this file's own builds —
  // build-push-action tags and `docker build -t` invocations in `run:` steps alike.
  const builtImages = new Set(
    allSteps.flatMap((step) => {
      const stepAt = at(offsetOf(step));
      return scalarAt(step, "uses", stepAt)?.startsWith(BUILD_PUSH_ACTION) === true
        ? buildPushTags(step, stepAt)
        : [];
    }),
  );
  for (const step of allSteps) {
    const run = scalarAt(step, "run", at(offsetOf(step)));
    if (run !== undefined) {
      for (const tag of collectBuildTags(parse(run))) {
        builtImages.add(tag);
      }
    }
  }

  /** The rules a single step answers to, in a job or a composite action alike. */
  const checkStep = (step: unknown, jobDir: string | undefined): void => {
    const stepOffset = offsetOf(step);
    const stepAt = at(stepOffset);
    const stepUses = scalarAt(step, "uses", stepAt);
    if (stepUses !== undefined && stepUses.startsWith("docker://")) {
      if (!DIGEST_IMAGE.test(stepUses)) {
        errors.push(`${stepAt}: a docker:// uses: must pin a @sha256: digest`);
      }
    } else if (stepUses !== undefined && !stepUses.startsWith("./") && !PINNED_REF.test(stepUses)) {
      errors.push(`${stepAt}: uses: ${stepUses} must pin a full commit sha`);
    }
    if (stepUses !== undefined && stepUses.startsWith(BUN_ACTION)) {
      const withBlock = recordOf(step, "with", stepAt);
      if ("bun-version" in withBlock) {
        errors.push(
          `${stepAt}: setup-bun must not set bun-version — the version comes from ${VERSION_FILE}`,
        );
      }
      if (withBlock["bun-version-file"] !== VERSION_FILE) {
        errors.push(`${stepAt}: setup-bun must set bun-version-file: ${VERSION_FILE}`);
      }
    }
    if (stepUses !== undefined && stepUses.startsWith(NODE_ACTION)) {
      const withBlock = recordOf(step, "with", stepAt);
      if ("node-version-file" in withBlock) {
        errors.push(`${stepAt}: setup-node must not set node-version-file`);
      }
      if (
        typeof withBlock["node-version"] !== "string" ||
        !EXACT_NODE.test(withBlock["node-version"])
      ) {
        errors.push(
          `${stepAt}: setup-node must pin an exact node-version X.Y.Z, got ${JSON.stringify(
            withBlock["node-version"],
          )}`,
        );
      }
    }
    for (const { action, input, pattern } of TOOLCHAIN_INPUTS) {
      if (stepUses === undefined || !stepUses.startsWith(action)) {
        continue;
      }
      const value = recordOf(step, "with", stepAt)[input];
      if (typeof value !== "string" || !pattern.test(value)) {
        errors.push(
          `${stepAt}: ${action.slice(0, -1)} must pin an exact ${input}, got ${JSON.stringify(
            value,
          )}`,
        );
      }
    }
    const run = scalarAt(step, "run", stepAt);
    if (run !== undefined) {
      const stepDir = scalarAt(step, "working-directory", stepAt) ?? jobDir;
      errors.push(...checkCommand(stepAt, run, stepDirs(ROOT, stepDir), index, builtImages));
    }
  };

  const toolchains: unknown[] = [];
  let needsToolchainJob = false;
  if (isMap(jobs)) {
    for (const pair of jobs.items) {
      const job = pair.value;
      if (!isMap(job)) {
        continue;
      }
      const jobAt = at(offsetOf(job));
      const jobName = isScalar(pair.key) ? String(pair.key.value) : "?";
      if (jobName === "toolchain") {
        toolchains.push(job);
      }
      const uses = scalarAt(job, "uses", jobAt);
      if (uses !== undefined) {
        if (!uses.startsWith("./") && !PINNED_REF.test(uses)) {
          errors.push(`${jobAt}: a reusable workflow must pin a full commit sha, got ${uses}`);
        }
        if (REUSABLE.test(uses)) {
          const target = uses.slice(0, uses.indexOf("@"));
          if (!NO_BUN_REUSABLE.has(target)) {
            needsToolchainJob = true;
            if (!needsOf(job, jobAt).includes("toolchain")) {
              errors.push(
                `${jobAt}: a reusable workflow must wait on the toolchain job (needs: toolchain)`,
              );
            }
            if (recordOf(job, "with", jobAt)["bun-version"] !== NEEDS_TOOLCHAIN) {
              errors.push(
                `${jobAt}: a reusable workflow must be handed ` +
                  `with: bun-version: ${NEEDS_TOOLCHAIN}`,
              );
            }
          }
        }
      }
      const image =
        scalarPath(job, jobAt, "container", "image") ?? scalarAt(job, "container", jobAt);
      if (image !== undefined && !DIGEST_IMAGE.test(image)) {
        errors.push(`${jobAt}: the container image must pin a @sha256: digest`);
      }
      const services = job.get("services", true);
      if (isMap(services)) {
        for (const service of services.items) {
          const serviceAt = at(offsetOf(service.value));
          const serviceImage = isMap(service.value)
            ? scalarAt(service.value, "image", serviceAt)
            : undefined;
          if (serviceImage !== undefined && !DIGEST_IMAGE.test(serviceImage)) {
            errors.push(`${serviceAt}: a service image must pin a @sha256: digest`);
          }
        }
      }
      const jobDir = scalarPath(job, jobAt, "defaults", "run", "working-directory");
      const steps = job.get("steps", true);
      if (isSeq(steps)) {
        for (const step of steps.items) {
          const item = resolve(step, at(offsetOf(step)));
          if (isMap(item)) {
            checkStep(item, jobDir);
          }
        }
      }
    }
  }

  // A composite action's runs.steps answer to the same step rules — no job defaults apply.
  const runs: unknown = document.get("runs", true);
  if (isMap(runs)) {
    const steps = runs.get("steps", true);
    if (isSeq(steps)) {
      for (const step of steps.items) {
        const item = resolve(step, at(offsetOf(step)));
        if (isMap(item)) {
          checkStep(item, undefined);
        }
      }
    }
  }

  if (needsToolchainJob && toolchains.length === 0) {
    errors.push(`${path}: a reusable workflow needs a toolchain job producing the Bun version`);
  }
  for (const toolchain of toolchains) {
    const toolchainAt = at(offsetOf(toolchain));
    if (recordOf(toolchain, "outputs", toolchainAt)["bun-version"] !== STEPS_BUN) {
      errors.push(`${path}: the toolchain job must output bun-version: ${STEPS_BUN}`);
    }
    const steps = isMap(toolchain) ? toolchain.get("steps", true) : undefined;
    const hasBunStep =
      isSeq(steps) &&
      steps.items.some((step) => {
        const item = resolve(step, toolchainAt);
        return (
          isMap(item) &&
          scalarAt(item, "id", toolchainAt) === "bun" &&
          scalarAt(item, "uses", toolchainAt)?.startsWith(BUN_ACTION) === true
        );
      });
    if (!hasBunStep) {
      errors.push(`${path}: the toolchain job must carry an id: bun setup-bun step`);
    }
  }
  return errors;
}

/**
 * The root manifest must pin `packageManager: "bun@<X.Y.Z>"`; no manifest — root included — may
 * keep a `devEngines.packageManager` declaration, which every tool but Bun reads differently and
 * which would drift against the field. Every script that shells out to a bin-runner names a bin of
 * a declared dependency — an undeclared one resolves against the registry, not the lockfile.
 */
export function checkManifest(
  path: string,
  pkg: unknown,
  root: boolean,
  index: DependencyIndex,
): string[] {
  const errors: string[] = [];
  const manifest = asRecord(pkg);
  if ("packageManager" in asRecord(manifest["devEngines"])) {
    errors.push(
      `${path}: devEngines.packageManager must not exist — the packageManager field is the only source`,
    );
  }
  if (
    root &&
    (typeof manifest["packageManager"] !== "string" ||
      !PACKAGE_MANAGER.test(manifest["packageManager"]))
  ) {
    errors.push(
      `${path}: packageManager must be "bun@<X.Y.Z>", got ${JSON.stringify(manifest["packageManager"])}`,
    );
  }
  if (root) {
    // The root manifest is no workspace package, so `vp run -r test` never reaches it: scripts.test
    // must run the root suite (scripts/**/*.test.ts — every gate script's tests) itself, in a
    // segment that is not part of a `vp run` call.
    const { test } = asRecord(manifest["scripts"]);
    const outside = typeof test === "string" ? test.replaceAll(/vp run[^&;]*/g, "") : "";
    if (!/\bvp test\b/.test(outside)) {
      errors.push(`${path}: scripts.test must run the root suite with a bare vp test`);
    }
  }
  const dir = join(ROOT, path.slice(0, path.lastIndexOf("/")) || ".");
  const dirs = dir === ROOT ? [ROOT] : [dir, ROOT];
  const scripts = Object.values(asRecord(manifest["scripts"])).flatMap((script) =>
    typeof script === "string" ? [script] : [],
  );
  // `docker build -t` anywhere in the manifest counts as built for every script in it.
  const builtImages = new Set(scripts.flatMap((script) => collectBuildTags(parse(script))));
  for (const [name, script] of Object.entries(asRecord(manifest["scripts"]))) {
    if (typeof script === "string") {
      errors.push(...checkCommand(`${path} scripts.${name}`, script, dirs, index, builtImages));
    }
  }
  return errors;
}

/**
 * `install` must be a table holding `minimumReleaseAge >= 604800` (the 7-day cooldown) and an
 * optional `minimumReleaseAgeExcludes` array whose every entry is an exact `name@X.Y.Z` pin — a
 * bare name exempts every later release of that package from the cooldown forever, not just the
 * version the PR needed early. Keys outside `[install]` never count; neither do values hiding in
 * strings. `config` is the PARSED document — the caller's TOML parse failure is itself a finding.
 */
export function checkBunfig(path: string, config: unknown): string[] {
  const errors: string[] = [];
  const install = isRecord(config) ? config["install"] : undefined;
  if (!isRecord(install)) {
    errors.push(`${path}: minimumReleaseAge must be set to at least ${MIN_RELEASE_AGE}`);
    return errors;
  }
  const age = install["minimumReleaseAge"];
  if (typeof age !== "number") {
    errors.push(`${path}: minimumReleaseAge must be set to at least ${MIN_RELEASE_AGE}`);
  } else if (age < MIN_RELEASE_AGE) {
    errors.push(`${path}: minimumReleaseAge ${age} is below the ${MIN_RELEASE_AGE} cooldown`);
  }
  const excludes = install["minimumReleaseAgeExcludes"];
  if (excludes !== undefined) {
    if (Array.isArray(excludes)) {
      for (const entry of excludes) {
        if (typeof entry !== "string" || !EXACT_PIN.test(entry)) {
          errors.push(
            `${path}: minimumReleaseAgeExcludes entry ${JSON.stringify(
              entry,
            )} must be an exact name@X.Y.Z pin`,
          );
        }
      }
    } else {
      errors.push(`${path}: minimumReleaseAgeExcludes must be an array of exact name@X.Y.Z pins`);
    }
  }
  return errors;
}

/** An `ADD`/`COPY` source that reaches the network — an URL or a git remote. */
const REMOTE_SOURCE = /^(?:https?:\/\/|git@|git:\/\/|ssh:\/\/|[^/\s]+\.git(?:[#?]|$))/i;

/** The heredoc delimiters a Dockerfile instruction line declares (`<<EOF`, `<<-'X'`). */
const heredocDelims = (text: string): string[] =>
  [...text.matchAll(/<<-?\s*['"]?([A-Za-z0-9_.-]+)['"]?/g)]
    .map((m) => m[1] ?? "")
    .filter((d) => d !== "");

/**
 * The script a Dockerfile `RUN` actually executes: a `<<EOF` body on the instruction's following
 * lines IS the script (fed to the shell by the builder), so the `<<` markers and the delimiter
 * lines come out and the bodies stay inline with the header's remaining words.
 */
const runScript = (text: string): string => {
  const nl = text.indexOf("\n");
  const header = nl === -1 ? text : text.slice(0, nl);
  const delimiters = heredocDelims(header);
  if (nl === -1 || delimiters.length === 0) {
    return text;
  }
  const cleaned = header.replaceAll(/<<-?\s*['"]?[A-Za-z0-9_.-]+['"]?/g, " ");
  const body = text
    .slice(nl + 1)
    .split("\n")
    .filter((line) => !delimiters.includes(line.replace(/^\t+/, "")));
  return `${cleaned}\n${body.join("\n")}`;
};

/**
 * Dockerfile rules: `RUN` bodies answer to the shared command rules — exec-form JSON arrays are
 * argv, shell form is a script, `\`-continuations join first, `RUN <<EOF` bodies are the script,
 * `RUN --mount=`-style flags are skipped, and `#` comment lines are skipped outside heredoc bodies
 * — and `FROM` references a digest-pinned image or a stage the file itself built. A remote `ADD`
 * source (`http(s)://` or git) must pin `--checksum=sha256:<64 hex>` — nothing else in the build
 * gets to fetch code the lockfile never saw.
 */
export function checkDockerfile(path: string, source: string, index: DependencyIndex): string[] {
  const errors: string[] = [];
  // Instruction lines: `\`-continuations join; `#` comment lines drop; a RUN heredoc's body
  // rides along raw inside the instruction's text.
  const instructions: Array<{
    readonly name: string;
    readonly args: string;
    readonly line: number;
  }> = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i] ?? "";
    const start = i + 1;
    if (first.trim() === "" || first.trimStart().startsWith("#")) {
      continue;
    }
    let text = first;
    while (text.trimEnd().endsWith("\\") && i + 1 < lines.length) {
      i += 1;
      text = `${text.trimEnd().slice(0, -1)} ${lines[i] ?? ""}`;
    }
    const match = /^\s*([A-Za-z]+)[ \t]+(.*)$/s.exec(text);
    if (match === null) {
      continue;
    }
    let args = match[2] ?? "";
    for (const delimiter of heredocDelims(args)) {
      while (i + 1 < lines.length) {
        i += 1;
        const line = lines[i] ?? "";
        args += `\n${line}`;
        if (line.replace(/^\t+/, "") === delimiter) {
          break;
        }
      }
    }
    instructions.push({ name: (match[1] ?? "").toUpperCase(), args, line: start });
  }

  const stages = new Set<string>();
  const builtImages = new Set<string>();
  // `docker build -t` anywhere in the file counts as built — collect before checking runs.
  for (const { name, args } of instructions) {
    if (name === "RUN" && !args.trimStart().startsWith("[")) {
      const body = runScript(args.replace(/^\s*(?:--[a-z-]+=\S+[ \t]+)+/, ""));
      for (const tag of collectBuildTags(parse(body))) {
        builtImages.add(tag);
      }
    }
  }
  for (const { name, args, line } of instructions) {
    const at = `${path}:${line}`;
    if (name === "FROM") {
      const tokens = args.split(/\s+/).filter((t) => t !== "" && !t.startsWith("--"));
      const image = tokens[0] ?? "";
      const stageIndex = tokens.findIndex((t) => /^as$/i.test(t));
      if (!DIGEST_IMAGE.test(image) && !stages.has(image.toLowerCase())) {
        errors.push(`${at}: FROM ${image} must pin a @sha256: digest or name a prior stage`);
      }
      if (stageIndex > 0) {
        const stage = tokens[stageIndex + 1];
        if (stage !== undefined) {
          stages.add(stage.toLowerCase());
        }
      }
      continue;
    }
    if (name === "ADD") {
      const tokens = args.split(/\s+/).filter((t) => t !== "");
      const flags = tokens.filter((t) => t.startsWith("--"));
      const positionals = tokens.filter((t) => !t.startsWith("--"));
      const remote = positionals.slice(0, -1).some((src) => REMOTE_SOURCE.test(src));
      if (remote && !flags.some((f) => /^--checksum=sha256:[0-9a-f]{64}$/i.test(f))) {
        errors.push(`${at}: ADD of a remote source must pin --checksum=sha256:<digest>`);
      }
      continue;
    }
    if (name === "RUN") {
      const trimmed = args.trimStart();
      if (trimmed.startsWith("[")) {
        // Exec form: the JSON array IS the argv — no shell text to parse.
        try {
          const argv: unknown = JSON.parse(trimmed);
          if (Array.isArray(argv) && argv.every((a) => typeof a === "string")) {
            const command: Command = {
              argv,
              substitutions: [],
              heredocs: [],
            };
            errors.push(...checkCommands(at, [[command]], [ROOT], index, builtImages));
          } else {
            errors.push(...checkCommand(at, trimmed, [ROOT], index, builtImages));
          }
        } catch {
          errors.push(...checkCommand(at, trimmed, [ROOT], index, builtImages));
        }
        continue;
      }
      const body = runScript(trimmed.replace(/^(?:--[a-z-]+=\S+[ \t]+)+/, ""));
      errors.push(...checkCommand(at, body, [ROOT], index, builtImages));
    }
  }
  return errors;
}

/** A file the repository walk checks for its extension or name. */
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const ACTION_FILE = /(?:^|\/)action\.ya?ml$/;
const DOCKERFILE_FILE = /(?:^|\/)Dockerfile[^/]*$/;

/** The tracked files the checks walk — workflows, composite actions, Dockerfiles. */
const trackedFiles = (): string[] =>
  execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((path) => path !== "");

/** The tracked paths the repository walk checks — workflows, composite actions, Dockerfiles. */
export const checkedFiles = (paths: ReadonlyArray<string>): string[] =>
  paths.filter((p) => WORKFLOW_FILE.test(p) || ACTION_FILE.test(p) || DOCKERFILE_FILE.test(p));

/** The directories holding a tracked `bun.lock` — each owes a `bunfig.toml` cooldown. */
export const bunfigDirs = (paths: ReadonlyArray<string>): string[] => [
  ...new Set(
    paths
      .filter((p) => p === "bun.lock" || p.endsWith("/bun.lock"))
      .map((p) => p.slice(0, p.length - "bun.lock".length).replace(/\/$/, "") || "."),
  ),
];

/**
 * Every check over the real tree: workflows, composite actions, Dockerfiles, manifests, bunfig.
 * `parseToml` is the caller's real TOML parser — `Bun.TOML.parse` under the CLI.
 */
export const checkRepository = (parseToml: (text: string) => unknown): string[] => {
  const index = liveIndex(ROOT);
  const errors: string[] = [];
  const tracked = trackedFiles();
  for (const path of checkedFiles(tracked).filter((p) => !DOCKERFILE_FILE.test(p))) {
    errors.push(...checkWorkflow(path, readFileSync(join(ROOT, path), "utf8"), index));
  }
  for (const path of checkedFiles(tracked).filter((p) => DOCKERFILE_FILE.test(p))) {
    errors.push(...checkDockerfile(path, readFileSync(join(ROOT, path), "utf8"), index));
  }
  for (const path of tracked.filter((p) => p === "package.json" || p.endsWith("/package.json"))) {
    const pkg: unknown = JSON.parse(readFileSync(join(ROOT, path), "utf8"));
    errors.push(...checkManifest(path, pkg, path === "package.json", index));
  }
  for (const dir of bunfigDirs(tracked)) {
    const bunfigPath = dir === "." ? "bunfig.toml" : `${dir}/bunfig.toml`;
    const bunfig = join(ROOT, bunfigPath);
    if (!existsSync(bunfig)) {
      errors.push(`${bunfigPath}: a directory with bun.lock must pin the release-age cooldown`);
      continue;
    }
    try {
      errors.push(...checkBunfig(bunfigPath, parseToml(readFileSync(bunfig, "utf8"))));
    } catch (error) {
      errors.push(
        `${bunfigPath}: does not parse — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors;
};

/** The CLI runs under Bun; tests inject their own TOML parser, so `Bun` is only referenced here. */
declare const Bun: { readonly TOML: { readonly parse: (text: string) => unknown } };

if (import.meta.main) {
  const errors = checkRepository(Bun.TOML.parse);
  for (const error of errors) {
    console.error(`check-toolchain: ${error}`);
  }
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}
