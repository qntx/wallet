/// <reference types="node" />
/**
 * Every tool CI runs must come from the lockfile, and its version must have one source of truth.
 * Bun is pinned by the root package.json `packageManager` field: every `oven-sh/setup-bun` step
 * reads it via `bun-version-file: package.json` (a literal `bun-version` would be a second,
 * drifting source), `devEngines.packageManager` is gone for the same reason, and reusable workflows
 * — which install Bun inside a definition this repo does not control — are handed the resolved
 * version through a `toolchain` job's output so they still pin the same one. Every
 * `actions/setup-node` step pins an exact `X.Y.Z` so the npm it bundles is stable. Every `run:`
 * command and manifest script that invokes `bunx`/`bun x`/`npx`/`npm exec` names a bin provided by
 * a dependency declared in the root manifest or the step's working-directory manifest — an
 * undeclared name would resolve against the registry instead of the lockfile. `bunfig.toml`'s
 * `minimumReleaseAgeExcludes` entries must be exact `name@X.Y.Z` pins — a bare name exempts every
 * future release of that package from the 7-day cooldown, not just the one the PR meant to land
 * early. Exit 1 with one line per finding.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMap, isNode, isScalar, isSeq, parseDocument } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const BUN_ACTION = "oven-sh/setup-bun@";
const NODE_ACTION = "actions/setup-node@";
const VERSION_FILE = "package.json";
const PACKAGE_MANAGER = /^bun@\d+\.\d+\.\d+$/;
/** `name@X.Y.Z`, scoped names allowed — no ranges, no bare names, no tags. */
const EXACT_PIN = /^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+@\d+\.\d+\.\d+$/;
const EXACT_NODE = /^\d+\.\d+\.\d+$/;
const REUSABLE = /^[^/\s]+\/[^/\s]+\/\.github\/workflows\/[^/\s]+\.ya?ml@/;
/** Reusable workflows that install no Bun — allow-listed out of the toolchain gate. */
const NO_BUN_REUSABLE = new Set(["qntx/workflows/.github/workflows/release.yml"]);
const NEEDS_TOOLCHAIN = `\${{ needs.toolchain.outputs.bun-version }}`;
const STEPS_BUN = `\${{ steps.bun.outputs.bun-version }}`;

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): JsonObject => (isRecord(value) ? value : {});

/**
 * The dependency surface a command may resolve bins against: `dirs` are the manifest directories in
 * scope — the step's working-directory and the repo root. `bin` returns the declared dependency
 * whose package provides the bin name; `declared` answers whether the name is a dependency at all.
 * Injected so tests run on fixtures; the CLI resolves against node_modules.
 */
export type DependencyIndex = {
  readonly bin: (name: string, dirs: ReadonlyArray<string>) => string | undefined;
  readonly declared: (name: string, dirs: ReadonlyArray<string>) => boolean;
};

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

/** One `bunx`/`bun x`/`npx`/`npm exec` call site inside a command string. */
type ToolCall = { readonly tool: string; readonly offset: number };

const TOOL_CALL = /(?:^|[\s;&|(`])(bunx|bun[\s]+x|npx|npm[\s]+exec)[\s]+/g;

const toolCalls = (command: string): ToolCall[] =>
  [...command.matchAll(TOOL_CALL)].map((match) => ({
    tool: match[1] ?? "",
    offset: (match.index ?? 0) + match[0].length,
  }));

/**
 * Flags the runner invocations a shell command makes that would resolve a bin outside the
 * declared-dependency surface. After the tool name, flags are skipped (`--bun`, `--yes`, the `--`
 * separator); `-p`/`--package` names the package explicitly and is checked as a declaration; the
 * first bare token is the bin and must be provided by a declared dependency.
 */
const checkCommand = (
  at: string,
  command: string,
  dirs: ReadonlyArray<string>,
  index: DependencyIndex,
): string[] => {
  const errors: string[] = [];
  for (const call of toolCalls(command)) {
    const segment = command.slice(call.offset).split(/&&|\|\||[;|\n]/)[0] ?? "";
    const tokens = segment.split(/\s+/).filter((token) => token !== "");
    let explicit = false;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] ?? "";
      if (token === "--") {
        continue;
      }
      if (token === "-p" || token === "--package") {
        const pkg = tokens[i + 1] ?? "";
        i += 1;
        explicit = true;
        if (!index.declared(pkg, dirs)) {
          errors.push(`${at}: ${call.tool} -p ${pkg} names no declared dependency`);
        }
        continue;
      }
      if (token.startsWith("--package=")) {
        const pkg = token.slice("--package=".length);
        explicit = true;
        if (!index.declared(pkg, dirs)) {
          errors.push(`${at}: ${call.tool} --package=${pkg} names no declared dependency`);
        }
        continue;
      }
      if (token.startsWith("-")) {
        continue;
      }
      // With -p the named package serves the bin; without it the declared deps must.
      if (!explicit && index.bin(token, dirs) === undefined) {
        errors.push(
          `${at}: ${call.tool} ${token} resolves no bin of a dependency declared in ${dirs
            .map((d) => `${d}/package.json`)
            .join(" or ")}`,
        );
      }
      break;
    }
  }
  return errors;
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
const needsOf = (job: unknown): ReadonlyArray<string> => {
  if (!isMap(job)) {
    return [];
  }
  const needs: unknown = job.get("needs", true);
  const scalar = scalarText(needs);
  if (scalar !== undefined) {
    return [scalar];
  }
  if (isSeq(needs)) {
    return needs.items.flatMap((n) => {
      const text = scalarText(n);
      return text === undefined ? [] : [text];
    });
  }
  if (isMap(needs)) {
    return needs.items.flatMap((p) => {
      const text = scalarText(p.key);
      return text === undefined ? [] : [text];
    });
  }
  return [];
};

/** The step maps of a parsed workflow or composite action, with their source ranges. */
const stepNodes = (document: ReturnType<typeof parseDocument>): ReadonlyArray<unknown> => {
  const steps: unknown[] = [];
  const jobs: unknown = document.get("jobs", true);
  if (isMap(jobs)) {
    for (const pair of jobs.items) {
      const job = pair.value;
      if (isMap(job)) {
        const seq = job.get("steps", true);
        if (isSeq(seq)) {
          for (const step of seq.items) {
            if (isMap(step)) {
              steps.push(step);
            }
          }
        }
      }
    }
  }
  // A composite action carries its steps under runs.steps instead.
  const runs: unknown = document.get("runs", true);
  if (isMap(runs)) {
    const seq = runs.get("steps", true);
    if (isSeq(seq)) {
      for (const step of seq.items) {
        if (isMap(step)) {
          steps.push(step);
        }
      }
    }
  }
  return steps;
};

const scalarAt = (map: unknown, key: string): string | undefined =>
  isMap(map) ? scalarText(map.get(key, true)) : undefined;

/** Walk nested yaml maps — `scalarPath(job, "defaults", "run", "working-directory")`. */
const scalarPath = (map: unknown, ...keys: string[]): string | undefined => {
  let node: unknown = map;
  for (const key of keys) {
    if (!isMap(node)) {
      return undefined;
    }
    node = node.get(key, true);
  }
  return scalarText(node);
};

const recordOf = (map: unknown, key: string): JsonObject => {
  if (!isMap(map)) {
    return {};
  }
  const node = map.get(key, true);
  if (!isMap(node)) {
    return {};
  }
  const record: JsonObject = {};
  for (const pair of node.items) {
    if (isScalar(pair.key)) {
      const { value } = pair;
      record[String(pair.key.value)] = isScalar(value) ? value.value : undefined;
    }
  }
  return record;
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

/**
 * Workflow and composite-action rules over the parsed document: setup-bun steps read the version
 * from the root manifest and never pin their own; a `run:` command's bunx/npx bins resolve through
 * declared dependencies; a non-allow-listed reusable workflow waits on `toolchain` and is handed
 * the resolved Bun version, which the file must produce in a `toolchain` job; setup-node steps pin
 * an exact Node version. A stray `oven-sh/setup-bun@` mention outside a `uses:` step is still a
 * finding — the raw-source pass covers what parsing drops (comments, malformed steps).
 */
export function checkWorkflow(path: string, source: string, index: DependencyIndex): string[] {
  const errors: string[] = [];
  const at = (offset?: number): string => `${path}${lineAt(source, offset)}`;
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    return [`${path}: workflow does not parse — ${document.errors[0]?.message ?? ""}`];
  }
  const jobs: unknown = document.get("jobs", true);

  // Every setup-bun mention in the raw source must sit on a `uses:` line inside a real step.
  const stepRanges = stepNodes(document).flatMap((step) => {
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

  const toolchains: unknown[] = [];
  let needsToolchainJob = false;
  if (isMap(jobs)) {
    for (const pair of jobs.items) {
      const job = pair.value;
      if (!isMap(job)) {
        continue;
      }
      const jobName = isScalar(pair.key) ? String(pair.key.value) : "?";
      if (jobName === "toolchain") {
        toolchains.push(job);
      }
      const uses = scalarAt(job, "uses");
      if (uses !== undefined && REUSABLE.test(uses)) {
        const target = uses.slice(0, uses.indexOf("@"));
        if (!NO_BUN_REUSABLE.has(target)) {
          needsToolchainJob = true;
          if (!needsOf(job).includes("toolchain")) {
            errors.push(
              `${at(offsetOf(job))}: a reusable workflow must wait on the toolchain job (needs: toolchain)`,
            );
          }
          if (scalarAt(job.get("with", true), "bun-version") !== NEEDS_TOOLCHAIN) {
            errors.push(
              `${at(offsetOf(job))}: a reusable workflow must be handed ` +
                `with: bun-version: ${NEEDS_TOOLCHAIN}`,
            );
          }
        }
      }
      const jobDir = scalarPath(job, "defaults", "run", "working-directory");
      const steps = job.get("steps", true);
      if (isSeq(steps)) {
        for (const step of steps.items) {
          if (!isMap(step)) {
            continue;
          }
          const stepUses = scalarAt(step, "uses");
          const stepOffset = offsetOf(step);
          if (stepUses !== undefined && stepUses.startsWith(BUN_ACTION)) {
            const withBlock = recordOf(step, "with");
            if ("bun-version" in withBlock) {
              errors.push(
                `${at(stepOffset)}: setup-bun must not set bun-version — the version comes from ${VERSION_FILE}`,
              );
            }
            if (withBlock["bun-version-file"] !== VERSION_FILE) {
              errors.push(
                `${at(stepOffset)}: setup-bun must set bun-version-file: ${VERSION_FILE}`,
              );
            }
          }
          if (stepUses !== undefined && stepUses.startsWith(NODE_ACTION)) {
            const withBlock = recordOf(step, "with");
            if ("node-version-file" in withBlock) {
              errors.push(`${at(stepOffset)}: setup-node must not set node-version-file`);
            }
            if (
              typeof withBlock["node-version"] !== "string" ||
              !EXACT_NODE.test(withBlock["node-version"])
            ) {
              errors.push(
                `${at(stepOffset)}: setup-node must pin an exact node-version X.Y.Z, got ${JSON.stringify(
                  withBlock["node-version"],
                )}`,
              );
            }
          }
          const run = scalarAt(step, "run");
          if (run !== undefined) {
            const stepDir = scalarAt(step, "working-directory") ?? jobDir;
            errors.push(...checkCommand(at(stepOffset), run, stepDirs(ROOT, stepDir), index));
          }
        }
      }
    }
  }

  // A composite action's runs.steps are checked as run commands too — no defaults apply.
  const runs: unknown = document.get("runs", true);
  if (isMap(runs)) {
    const steps = runs.get("steps", true);
    if (isSeq(steps)) {
      for (const step of steps.items) {
        if (!isMap(step)) {
          continue;
        }
        const run = scalarAt(step, "run");
        if (run !== undefined) {
          const stepDir = scalarAt(step, "working-directory");
          errors.push(...checkCommand(at(offsetOf(step)), run, stepDirs(ROOT, stepDir), index));
        }
      }
    }
  }

  if (needsToolchainJob && toolchains.length === 0) {
    errors.push(`${path}: a reusable workflow needs a toolchain job producing the Bun version`);
  }
  for (const toolchain of toolchains) {
    const outputs = recordOf(toolchain, "outputs");
    if (outputs["bun-version"] !== STEPS_BUN) {
      errors.push(`${path}: the toolchain job must output bun-version: ${STEPS_BUN}`);
    }
    const steps = isMap(toolchain) ? toolchain.get("steps", true) : undefined;
    const hasBunStep =
      isSeq(steps) &&
      steps.items.some(
        (step) =>
          isMap(step) &&
          scalarAt(step, "id") === "bun" &&
          scalarAt(step, "uses")?.startsWith(BUN_ACTION) === true,
      );
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
  const dir = join(ROOT, path.slice(0, path.lastIndexOf("/")) || ".");
  const dirs = dir === ROOT ? [ROOT] : [dir, ROOT];
  for (const [name, script] of Object.entries(asRecord(manifest["scripts"]))) {
    if (typeof script === "string") {
      errors.push(...checkCommand(`${path} scripts.${name}`, script, dirs, index));
    }
  }
  return errors;
}

/**
 * `minimumReleaseAgeExcludes` entries must be exact `name@X.Y.Z` pins: a bare name exempts every
 * later release of that package from the 7-day cooldown forever, not just the version the PR needed
 * early.
 */
export function checkBunfig(source: string): string[] {
  const line = source
    .split("\n")
    .find((l) => l.trimStart().startsWith("minimumReleaseAgeExcludes"));
  if (line === undefined) {
    return [];
  }
  return [...line.matchAll(/"([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((entry) => !EXACT_PIN.test(entry))
    .map(
      (entry) =>
        `bunfig.toml: minimumReleaseAgeExcludes entry ${JSON.stringify(entry)} must be an exact name@X.Y.Z pin`,
    );
}

/** Immediate subdirectories of `dir` that hold a package.json (`packages/*`, `apps/*`). */
const manifestPaths = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${dir}/${entry.name}/package.json`)
    .filter((path) => existsSync(join(ROOT, path)));

const workflowFiles = (dir: string): string[] =>
  existsSync(join(ROOT, dir))
    ? readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory()) {
          return workflowFiles(`${dir}/${entry.name}`);
        }
        const yml = entry.name.endsWith(".yml") || entry.name.endsWith(".yaml");
        return yml && (dir.endsWith("workflows") || dir.includes("/actions/"))
          ? [`${dir}/${entry.name}`]
          : [];
      })
    : [];

/** Every check over the real tree: workflows, composite actions, manifests, bunfig. */
export const checkRepository = (): string[] => {
  const index = liveIndex(ROOT);
  const errors: string[] = [];
  for (const path of workflowFiles(".github").toSorted()) {
    errors.push(...checkWorkflow(path, readFileSync(join(ROOT, path), "utf8"), index));
  }
  const paths = ["package.json", ...manifestPaths("packages"), ...manifestPaths("apps")];
  for (const path of paths) {
    const pkg: unknown = JSON.parse(readFileSync(join(ROOT, path), "utf8"));
    errors.push(...checkManifest(path, pkg, path === "package.json", index));
  }
  errors.push(...checkBunfig(readFileSync(join(ROOT, "bunfig.toml"), "utf8")));
  return errors;
};

if (import.meta.main) {
  const errors = checkRepository();
  for (const error of errors) {
    console.error(`check-toolchain: ${error}`);
  }
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}
