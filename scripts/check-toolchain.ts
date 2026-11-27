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
 * `uses:` reference — job-level reusable calls included — pins a full commit sha. Every `run:`
 * command, composite-action step, Dockerfile `RUN` and manifest script that invokes `bunx`/`bun
 * x`/`npx`/`npm exec` names a bin provided by a dependency declared in the root manifest or the
 * step's working-directory manifest — an undeclared name would resolve against the registry instead
 * of the lockfile. The same commands must not reach a registry at all: `curl`/`wget` piped to a
 * shell, `npm install|i|add` (`npm ci` is fine), `bun add`, `bun install` without
 * `--frozen-lockfile`, `pnpm dlx`/`yarn dlx`/`pnpx`, `pip install` without `--require-hashes`, and
 * `docker run|create|pull` of an image that is neither digest-pinned nor built by the workflow's
 * own `docker/build-push-action` step. `container.image` and `services.*.image` pin `@sha256:`
 * digests, and a Dockerfile `FROM` is a `@sha256:` image or a prior build stage. `bunfig.toml`'s
 * `minimumReleaseAgeExcludes` entries must be exact `name@X.Y.Z` pins — a bare name exempts every
 * future release of that package from the 7-day cooldown, not just the one the PR meant to land
 * early — and every directory that keeps a `bun.lock` carries a `bunfig.toml` with
 * `minimumReleaseAge >= 604800`.
 *
 * Deliberately not covered: the internals of script files a `run:` command or manifest script
 * invokes (a `bun scripts/x.ts` is checked for its own command words, not the files it runs); tools
 * the runner image itself provides (docker, buildx, jq, apt); `apt-get` and `rustup
 * --default-toolchain stable` inside the emulator Dockerfiles; the Gradle wrapper; and a `curl -o`
 * that only downloads a file a following sha256 check verifies. Exit 1 with one line per finding.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMap, isNode, isScalar, isSeq, parseDocument } from "yaml";

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
/** A container image pinned by digest. */
const DIGEST_IMAGE = /@sha256:[0-9a-f]{64}$/;
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

/** A tool word may sit at the start or right after a separator — quotes included (`sh -c "…"`). */
const WORD_BOUNDARY = `${String.raw`(?:^|[\s;&|(`}\`${String.raw`"'])`}`;

const TOOL_CALL = new RegExp(
  WORD_BOUNDARY + String.raw`(bunx|bun[\s]+x|npx|npm[\s]+exec)[\s]+`,
  "g",
);

const toolCalls = (command: string): ToolCall[] =>
  [...command.matchAll(TOOL_CALL)].map((match) => ({
    tool: match[1] ?? "",
    offset: (match.index ?? 0) + match[0].length,
  }));

/** The rest of the pipeline segment starting at `offset` — where a command's flags live. */
const segmentAt = (command: string, offset: number): string =>
  command.slice(offset).split(/&&|\|\||[;|\n]/)[0] ?? "";

/**
 * One installer invocation inside a command string: the tool word and its first argument, e.g.
 * `npm` + `install`, `bun` + `add`, `pip` + `install`. `pnpx` is a tool of its own.
 */
const INSTALLER_CALL = new RegExp(
  `${
    WORD_BOUNDARY + String.raw`(npm|bun|pnpm|yarn|pnpx|pip3?)[\s]+([^\s;&|(`
  }\`${String.raw`"']+)`}`,
  "g",
);

/** `curl`/`wget` whose output is piped into a shell — code straight off the network, executed. */
const DOWNLOAD_PIPE = new RegExp(
  WORD_BOUNDARY + String.raw`(?:curl|wget)\b[^|\n]*\|\s*(?:sudo[\s]+|env[\s]+)?(?:sh|bash|zsh)\b`,
);

/**
 * `docker run|create|pull <image>`: the image is the first bare token once flags — and the values
 * of the flags that take one — are skipped. Boolean-only flags are not listed: an unlisted `--flag
 * value` pair is treated as two tokens, so the value becomes the would-be image and the rule stays
 * on the safe side.
 */
const DOCKER_CALL = new RegExp(WORD_BOUNDARY + String.raw`docker[\s]+(run|create|pull)\b`, "g");
const DOCKER_VALUE_FLAGS = new Set([
  "-p",
  "--publish",
  "-e",
  "--env",
  "--env-file",
  "-v",
  "--volume",
  "--mount",
  "--tmpfs",
  "--name",
  "--hostname",
  "--network",
  "--network-alias",
  "--link",
  "--ip",
  "--ip6",
  "--dns",
  "--dns-search",
  "--dns-opt",
  "--add-host",
  "-w",
  "--workdir",
  "-u",
  "--user",
  "--group-add",
  "--entrypoint",
  "--platform",
  "--pull",
  "--restart",
  "--stop-signal",
  "--stop-timeout",
  "--device",
  "--cap-add",
  "--cap-drop",
  "--security-opt",
  "--label",
  "-l",
  "--log-driver",
  "--log-opt",
  "--health-cmd",
  "--health-interval",
  "--health-timeout",
  "--health-retries",
  "--health-start-period",
  "--ulimit",
  "--sysctl",
  "--shm-size",
  "-m",
  "--memory",
  "--memory-swap",
  "--memory-reservation",
  "--kernel-memory",
  "--cpus",
  "--cpu-shares",
  "--cpu-period",
  "--cpu-quota",
  "--cpu-rt-period",
  "--cpu-rt-runtime",
  "--cpuset-cpus",
  "--cpuset-mems",
  "--pids-limit",
  "--blkio-weight",
  "-a",
  "--attach",
  "--detach-keys",
  "--cidfile",
  "--expose",
  "--ipc",
  "--isolation",
  "--pid",
  "--userns",
  "--uts",
  "--volume-driver",
  "--volumes-from",
  "--storage-opt",
  "--runtime",
  "--gpus",
  "--oom-score-adj",
  "--swappiness",
  "--init-path",
  "--mac-address",
]);

/**
 * `${{ … }}` expressions may contain spaces, which would split an image reference like
 * `onekey-emu-${{ matrix.model }}` across tokens — collapse them so both sides compare equal.
 */
const squeezeExpressions = (text: string): string =>
  text.replaceAll(/\$\{\{[^}]*\}\}/g, (m) => m.replaceAll(/\s+/g, ""));

/** The image token of a `docker run|create|pull` segment, once flags and their values are gone. */
const dockerImage = (segment: string): string | undefined => {
  const tokens = segment.split(/\s+/).filter((t) => t !== "");
  // The segment starts right after the subcommand (run/create/pull); flags come first.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (token.startsWith("-")) {
      if (!token.includes("=") && DOCKER_VALUE_FLAGS.has(token)) {
        i += 1;
      }
      continue;
    }
    return token;
  }
  return undefined;
};

/**
 * The command rules shared by `run:` steps, manifest scripts and Dockerfile `RUN` bodies: bin
 * runners resolve only against declared dependencies; installers that would reach a registry
 * outside a lockfile are findings; a downloader piped to a shell is a finding; and a `docker`
 * command may only reference digest-pinned images or images the file itself built.
 */
const checkCommand = (
  at: string,
  command: string,
  dirs: ReadonlyArray<string>,
  index: DependencyIndex,
  builtImages: ReadonlySet<string> = new Set(),
): string[] => {
  const errors: string[] = [];
  for (const call of toolCalls(command)) {
    const segment = segmentAt(command, call.offset);
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
  if (DOWNLOAD_PIPE.test(command)) {
    errors.push(`${at}: a curl/wget download must not be piped to a shell`);
  }
  for (const match of command.matchAll(INSTALLER_CALL)) {
    const [, tool = "", sub = ""] = match;
    const where = `${at}:`;
    if (tool === "npm" && (sub === "install" || sub === "i" || sub === "add")) {
      errors.push(`${where} npm ${sub} resolves outside a committed lockfile — use npm ci`);
    } else if (tool === "bun" && sub === "add") {
      errors.push(`${where} bun add resolves outside the lockfile`);
    } else if (tool === "bun" && sub === "install") {
      const segment = segmentAt(command, (match.index ?? 0) + match[0].length);
      if (!segment.includes("--frozen-lockfile")) {
        errors.push(`${where} bun install must pass --frozen-lockfile`);
      }
    } else if (tool === "pnpx" || ((tool === "pnpm" || tool === "yarn") && sub === "dlx")) {
      errors.push(`${where} ${tool} ${sub} runs registry code without a lockfile`);
    } else if ((tool === "pip" || tool === "pip3") && sub === "install") {
      const segment = segmentAt(command, (match.index ?? 0) + match[0].length);
      if (!segment.includes("--require-hashes")) {
        errors.push(`${where} pip install must pass --require-hashes`);
      }
    }
  }
  for (const match of command.matchAll(DOCKER_CALL)) {
    const image = dockerImage(
      squeezeExpressions(segmentAt(command, (match.index ?? 0) + match[0].length)),
    );
    if (image !== undefined && !DIGEST_IMAGE.test(image) && !builtImages.has(image)) {
      errors.push(
        `${at}: docker ${match[1] ?? ""} ${image} is neither digest-pinned nor built by this file`,
      );
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

/** The `tags:` values a `docker/build-push-action` step builds — scalar, list or multiline. */
const buildPushTags = (step: unknown): ReadonlyArray<string> => {
  if (!isMap(step)) {
    return [];
  }
  const node = step.get("with", true);
  if (!isMap(node)) {
    return [];
  }
  const tags = node.get("tags", true);
  const split = (text: string): string[] =>
    squeezeExpressions(text)
      .split(/[\n,]/)
      .map((t) => t.trim())
      .filter((t) => t !== "");
  if (isSeq(tags)) {
    return tags.items.flatMap((item) => {
      const text = scalarText(item);
      return text === undefined ? [] : split(text);
    });
  }
  const text = scalarText(tags);
  return text === undefined ? [] : split(text);
};

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
 * sha (or names a `./` local action); setup-bun steps read the version from the root manifest and
 * never pin their own; setup-node and the other toolchain actions pin exact versions; a `run:`
 * command follows the shared command rules; job `container`/`services` images pin digests and
 * `docker` commands may only reference digest-pinned or workflow-built images; a non-allow-listed
 * reusable workflow waits on `toolchain` and is handed the resolved Bun version, which the file
 * must produce in a `toolchain` job. A stray `oven-sh/setup-bun@` mention outside a `uses:` step is
 * still a finding — the raw-source pass covers what parsing drops (comments, malformed steps).
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

  // Images a `docker run|create|pull` may reference without a digest: this file's own builds.
  const builtImages = new Set(
    allSteps.flatMap((step) =>
      scalarAt(step, "uses")?.startsWith(BUILD_PUSH_ACTION) === true ? buildPushTags(step) : [],
    ),
  );

  /** The rules a single step answers to, in a job or a composite action alike. */
  const checkStep = (step: unknown, jobDir: string | undefined): void => {
    const stepUses = scalarAt(step, "uses");
    const stepOffset = offsetOf(step);
    if (stepUses !== undefined && !stepUses.startsWith("./") && !PINNED_REF.test(stepUses)) {
      errors.push(`${at(stepOffset)}: uses: ${stepUses} must pin a full commit sha`);
    }
    if (stepUses !== undefined && stepUses.startsWith(BUN_ACTION)) {
      const withBlock = recordOf(step, "with");
      if ("bun-version" in withBlock) {
        errors.push(
          `${at(stepOffset)}: setup-bun must not set bun-version — the version comes from ${VERSION_FILE}`,
        );
      }
      if (withBlock["bun-version-file"] !== VERSION_FILE) {
        errors.push(`${at(stepOffset)}: setup-bun must set bun-version-file: ${VERSION_FILE}`);
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
    for (const { action, input, pattern } of TOOLCHAIN_INPUTS) {
      if (stepUses === undefined || !stepUses.startsWith(action)) {
        continue;
      }
      const value = recordOf(step, "with")[input];
      if (typeof value !== "string" || !pattern.test(value)) {
        errors.push(
          `${at(stepOffset)}: ${action.slice(0, -1)} must pin an exact ${input}, got ${JSON.stringify(
            value,
          )}`,
        );
      }
    }
    const run = scalarAt(step, "run");
    if (run !== undefined) {
      const stepDir = scalarAt(step, "working-directory") ?? jobDir;
      errors.push(
        ...checkCommand(at(stepOffset), run, stepDirs(ROOT, stepDir), index, builtImages),
      );
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
      const jobName = isScalar(pair.key) ? String(pair.key.value) : "?";
      if (jobName === "toolchain") {
        toolchains.push(job);
      }
      const uses = scalarAt(job, "uses");
      if (uses !== undefined) {
        if (!uses.startsWith("./") && !PINNED_REF.test(uses)) {
          errors.push(
            `${at(offsetOf(job))}: a reusable workflow must pin a full commit sha, got ${uses}`,
          );
        }
        if (REUSABLE.test(uses)) {
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
      }
      const image = scalarPath(job, "container", "image") ?? scalarAt(job, "container");
      if (image !== undefined && !DIGEST_IMAGE.test(image)) {
        errors.push(`${at(offsetOf(job))}: the container image must pin a @sha256: digest`);
      }
      const services = job.get("services", true);
      if (isMap(services)) {
        for (const service of services.items) {
          const serviceImage = isMap(service.value) ? scalarAt(service.value, "image") : undefined;
          if (serviceImage !== undefined && !DIGEST_IMAGE.test(serviceImage)) {
            errors.push(
              `${at(offsetOf(service.value))}: a service image must pin a @sha256: digest`,
            );
          }
        }
      }
      const jobDir = scalarPath(job, "defaults", "run", "working-directory");
      const steps = job.get("steps", true);
      if (isSeq(steps)) {
        for (const step of steps.items) {
          if (isMap(step)) {
            checkStep(step, jobDir);
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
        if (isMap(step)) {
          checkStep(step, undefined);
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
  for (const [name, script] of Object.entries(asRecord(manifest["scripts"]))) {
    if (typeof script === "string") {
      errors.push(...checkCommand(`${path} scripts.${name}`, script, dirs, index));
    }
  }
  return errors;
}

/** A TOML line with its `#`-comment removed — comments never start inside a string. */
const stripComment = (line: string): string => {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (quote === "") {
      if (c === '"' || c === "'") {
        quote = c;
      } else if (c === "#") {
        return line.slice(0, i);
      }
    } else if (c === quote && (quote !== '"' || line[i - 1] !== "\\")) {
      quote = "";
    }
  }
  return line;
};

/**
 * `minimumReleaseAgeExcludes` entries must be exact `name@X.Y.Z` pins: a bare name exempts every
 * later release of that package from the 7-day cooldown forever, not just the version the PR needed
 * early. The array may span lines and quote either way. `minimumReleaseAge` itself must be present
 * and at least a week.
 */
export function checkBunfig(source: string): string[] {
  const errors: string[] = [];
  const text = source.split("\n").map(stripComment).join("\n");
  const age = /minimumReleaseAge\s*=\s*(\d+)/.exec(text);
  if (age === null) {
    errors.push(`bunfig.toml: minimumReleaseAge must be set to at least ${MIN_RELEASE_AGE}`);
  } else if (Number(age[1]) < MIN_RELEASE_AGE) {
    errors.push(
      `bunfig.toml: minimumReleaseAge ${age[1] ?? ""} is below the ${MIN_RELEASE_AGE} cooldown`,
    );
  }
  const excludes = /minimumReleaseAgeExcludes\s*=\s*\[/.exec(text);
  if (excludes !== null) {
    const arrayText = text.slice(excludes.index + excludes[0].length);
    const end = arrayText.indexOf("]");
    const body = end === -1 ? arrayText : arrayText.slice(0, end);
    for (const match of body.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const entry = match[1] ?? match[2] ?? "";
      if (!EXACT_PIN.test(entry)) {
        errors.push(
          `bunfig.toml: minimumReleaseAgeExcludes entry ${JSON.stringify(entry)} must be an exact name@X.Y.Z pin`,
        );
      }
    }
  }
  return errors;
}

/**
 * Dockerfile rules: `RUN` bodies answer to the shared command rules, and `FROM` references a
 * digest-pinned image or a stage the file itself built. `\`-continuations join before parsing.
 */
export function checkDockerfile(path: string, source: string, index: DependencyIndex): string[] {
  const errors: string[] = [];
  const logical: string[] = [];
  let pending = "";
  for (const raw of source.split("\n")) {
    const line = raw.trimEnd();
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    logical.push(pending + line);
    pending = "";
  }
  if (pending !== "") {
    logical.push(pending);
  }
  const stages = new Set<string>();
  for (const [i, line] of logical.entries()) {
    const at = `${path}:${i + 1}`;
    const from = /^\s*FROM\s+(.+)$/i.exec(line);
    if (from !== null) {
      const tokens = (from[1] ?? "").split(/\s+/).filter((t) => t !== "" && !t.startsWith("--"));
      const image = tokens[0] ?? "";
      const stageIndex = tokens.findIndex((t) => /^as$/i.test(t));
      if (!DIGEST_IMAGE.test(image) && !stages.has(image.toLowerCase())) {
        errors.push(`${at}: FROM ${image} must pin a @sha256: digest or name a prior stage`);
      }
      if (stageIndex > 0) {
        const name = tokens[stageIndex + 1];
        if (name !== undefined) {
          stages.add(name.toLowerCase());
        }
      }
      continue;
    }
    const run = /^\s*RUN\s+(.+)$/i.exec(line);
    if (run !== null) {
      errors.push(...checkCommand(at, run[1] ?? "", [ROOT], index));
    }
  }
  return errors;
}

/** Immediate subdirectories of `dir` (`packages/*`, `apps/*`). */
const subDirs = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${dir}/${entry.name}`);

/** Immediate subdirectories of `dir` that hold a package.json (`packages/*`, `apps/*`). */
const manifestPaths = (dir: string): string[] =>
  subDirs(dir)
    .map((entry) => `${entry}/package.json`)
    .filter((path) => existsSync(join(ROOT, path)));

/** The tracked files the checks walk — workflows, composite actions, Dockerfiles. */
const trackedFiles = (): string[] =>
  execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((path) => path !== "");

const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const ACTION_FILE = /(?:^|\/)action\.ya?ml$/;
const DOCKERFILE_FILE = /(?:^|\/)Dockerfile[^/]*$/;

/** The tracked paths the repository walk checks — workflows, composite actions, Dockerfiles. */
export const checkedFiles = (paths: ReadonlyArray<string>): string[] =>
  paths.filter((p) => WORKFLOW_FILE.test(p) || ACTION_FILE.test(p) || DOCKERFILE_FILE.test(p));

/** Every check over the real tree: workflows, composite actions, Dockerfiles, manifests, bunfig. */
export const checkRepository = (): string[] => {
  const index = liveIndex(ROOT);
  const errors: string[] = [];
  const tracked = trackedFiles();
  for (const path of checkedFiles(tracked).filter((p) => !DOCKERFILE_FILE.test(p))) {
    errors.push(...checkWorkflow(path, readFileSync(join(ROOT, path), "utf8"), index));
  }
  for (const path of checkedFiles(tracked).filter((p) => DOCKERFILE_FILE.test(p))) {
    errors.push(...checkDockerfile(path, readFileSync(join(ROOT, path), "utf8"), index));
  }
  const paths = ["package.json", ...manifestPaths("packages"), ...manifestPaths("apps")];
  for (const path of paths) {
    const pkg: unknown = JSON.parse(readFileSync(join(ROOT, path), "utf8"));
    errors.push(...checkManifest(path, pkg, path === "package.json", index));
  }
  for (const dir of [".", ...subDirs("packages"), ...subDirs("apps")]) {
    if (!existsSync(join(ROOT, dir, "bun.lock"))) {
      continue;
    }
    const bunfig = join(ROOT, dir, "bunfig.toml");
    if (!existsSync(bunfig)) {
      errors.push(
        `${dir}/bunfig.toml: a directory with bun.lock must pin the release-age cooldown`,
      );
      continue;
    }
    errors.push(...checkBunfig(readFileSync(bunfig, "utf8")));
  }
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
