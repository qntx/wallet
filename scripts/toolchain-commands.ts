/// <reference types="node" />
/**
 * The command-level layer of the toolchain gate: a `run:` line, a manifest script or a Dockerfile
 * `RUN` body — already lexed by `shell-words.ts` into pipelines of argv — is normalized down to the
 * tool it really invokes (basename, `sudo`/`env`/`nice`-style wrappers, `pipX.Y`/`pythonX.Y`,
 * `python -m pip`), then judged per invocation: bin runners must resolve a bin of a declared
 * dependency, installers must not reach a registry outside the lockfile, a `curl`/`wget` must never
 * feed an interpreter in the same pipeline or through a substitution, and `docker run|create|pull`
 * may only name digest-pinned or same-file-built images. `sh -c`, `eval` and heredoc bodies fed to
 * a shell recurse as scripts.
 */
import { parse } from "./shell-words.ts";
import type { Command, Pipeline } from "./shell-words.ts";

/** A container image pinned by digest. */
export const DIGEST_IMAGE = /@sha256:[0-9a-f]{64}$/;

/**
 * The dependency facts a command resolves bins and packages against: `bin` maps an executable name
 * to the package that provides it, `declared` answers whether a package name is a declared
 * dependency — each over the candidate manifest directories the invocation's working directory
 * gives it (nearest first).
 */
export type DependencyIndex = {
  readonly bin: (name: string, dirs: ReadonlyArray<string>) => string | undefined;
  readonly declared: (name: string, dirs: ReadonlyArray<string>) => boolean;
};

const basename = (word: string): string => word.slice(word.lastIndexOf("/") + 1);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);

/** Interpreters that may execute downloaded bytes — after basename/version normalization. */
const EXECUTORS = new Set([...SHELLS, "python", "node", "perl", "ruby", "php", "bun", "deno"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `sudo`'s flags that consume the next word (sudo(8)); every other `-x` flag is boolean. */
const SUDO_VALUE_FLAGS = new Set([
  "-u",
  "-g",
  "-h",
  "-p",
  "-C",
  "-D",
  "-R",
  "-T",
  "-U",
  "-t",
  "-r",
]);

/**
 * The command a `sudo -E bash`/`env A=1 sh`/`nohup nice -n 5 cmd` actually runs: wrapper prefixes
 * forward to the real argv0, which rules judge — so `curl | sudo -E bash` is `curl | bash`.
 */
const normalize = (
  command: Command,
): {
  readonly tool: string;
  readonly argv: ReadonlyArray<string>;
  readonly substitutions: ReadonlyArray<ReadonlyArray<Pipeline>>;
  readonly heredocs: ReadonlyArray<string>;
} => {
  let argv = [...command.argv];
  for (;;) {
    const tool = basename(argv[0] ?? "");
    let j = -1;
    if (tool === "sudo") {
      j = 1;
      while (j < argv.length) {
        const token = argv[j] ?? "";
        if (SUDO_VALUE_FLAGS.has(token)) {
          j += 2;
        } else if (token.startsWith("-") || ASSIGNMENT.test(token)) {
          j += 1;
        } else {
          break;
        }
      }
    } else if (tool === "env") {
      j = 1;
      while (j < argv.length) {
        const token = argv[j] ?? "";
        if (token === "-u" || token === "-C" || token === "-S") {
          j += 2;
        } else if (token === "--unset" || token === "--chdir" || token === "--split-string") {
          j += 2;
        } else if (token.startsWith("-") || ASSIGNMENT.test(token)) {
          j += 1;
        } else {
          break;
        }
      }
    } else if (tool === "nice") {
      j = 1;
      while (j < argv.length) {
        const token = argv[j] ?? "";
        if (token === "-n" || token === "--adjustment") {
          j += 2;
        } else if (token.startsWith("-")) {
          j += 1;
        } else {
          break;
        }
      }
    } else if (tool === "exec" || tool === "command" || tool === "nohup" || tool === "time") {
      j = 1;
      while (j < argv.length && (argv[j] ?? "").startsWith("-")) {
        j += 1;
      }
    }
    if (j < 0) {
      break;
    }
    if (j >= argv.length) {
      argv = [];
      break;
    }
    argv = argv.slice(j);
  }
  let tool = basename(argv[0] ?? "");
  if (/^pip\d+(\.\d+)?$/.test(tool)) {
    tool = "pip";
  } else if (/^python\d+(\.\d+)?$/.test(tool)) {
    tool = "python";
  }
  // `python -m pip` is pip — including `python3.11 -m pip`.
  if (tool === "python" && argv[1] === "-m" && argv[2] === "pip") {
    tool = "pip";
    argv = [argv[0] ?? "pip", ...argv.slice(3)];
  }
  return {
    tool,
    argv,
    substitutions: command.substitutions,
    heredocs: command.heredocs,
  };
};

/* npm's subcommand resolution, copied from npm@11.20.0 lib/utils/cmd-list.js (the npm a
   setup-node runner bundles): exact command → direct alias → unique abbreviation over
   commands ∪ aliases → chase aliases. Anything unresolvable is not a subcommand. */
const NPM_COMMANDS = [
  "access",
  "adduser",
  "approve-scripts",
  "audit",
  "bugs",
  "cache",
  "ci",
  "completion",
  "config",
  "dedupe",
  "deny-scripts",
  "deprecate",
  "diff",
  "dist-tag",
  "docs",
  "doctor",
  "edit",
  "exec",
  "explain",
  "explore",
  "find-dupes",
  "fund",
  "get",
  "help",
  "help-search",
  "init",
  "install",
  "install-ci-test",
  "install-scripts",
  "install-test",
  "link",
  "ll",
  "login",
  "logout",
  "ls",
  "org",
  "outdated",
  "owner",
  "pack",
  "ping",
  "pkg",
  "prefix",
  "profile",
  "prune",
  "publish",
  "query",
  "rebuild",
  "repo",
  "restart",
  "root",
  "run",
  "sbom",
  "search",
  "set",
  "shrinkwrap",
  "stage",
  "star",
  "stars",
  "start",
  "stop",
  "team",
  "test",
  "token",
  "trust",
  "undeprecate",
  "uninstall",
  "unpublish",
  "unstar",
  "update",
  "version",
  "view",
  "whoami",
];
const NPM_ALIASES: Record<string, string> = {
  author: "owner",
  home: "docs",
  issues: "bugs",
  info: "view",
  show: "view",
  find: "search",
  add: "install",
  unlink: "uninstall",
  remove: "uninstall",
  rm: "uninstall",
  r: "uninstall",
  un: "uninstall",
  rb: "rebuild",
  list: "ls",
  ln: "link",
  create: "init",
  i: "install",
  it: "install-test",
  cit: "install-ci-test",
  u: "update",
  up: "update",
  c: "config",
  s: "search",
  se: "search",
  tst: "test",
  t: "test",
  ddp: "dedupe",
  v: "view",
  "run-script": "run",
  "clean-install": "ci",
  "clean-install-test": "install-ci-test",
  x: "exec",
  why: "explain",
  la: "ll",
  verison: "version",
  ic: "ci",
  innit: "init",
  in: "install",
  ins: "install",
  inst: "install",
  insta: "install",
  instal: "install",
  isnt: "install",
  isnta: "install",
  isntal: "install",
  isntall: "install",
  "install-clean": "ci",
  "isntall-clean": "ci",
  hlep: "help",
  "dist-tags": "dist-tag",
  upgrade: "update",
  udpate: "update",
  rum: "run",
  sit: "install-ci-test",
  urn: "run",
  ogr: "org",
  "add-user": "adduser",
};

const npmDeref = (typed: string): string | undefined => {
  const c = typed.replaceAll(/([A-Z])/g, (m) => `-${m.toLowerCase()}`);
  if (NPM_COMMANDS.includes(c)) {
    return c;
  }
  if (NPM_ALIASES[c] !== undefined) {
    return NPM_ALIASES[c];
  }
  const full = [...NPM_COMMANDS, ...Object.keys(NPM_ALIASES)].filter(
    (word) => word.startsWith(c) && word !== c,
  );
  if (full.length === 1) {
    let a = full[0] ?? "";
    while (NPM_ALIASES[a] !== undefined) {
      a = NPM_ALIASES[a] ?? a;
    }
    return a;
  }
  return undefined;
};

/** Npm's value-taking globals — skipped while locating the subcommand (`--x=v` is one word). */
const NPM_VALUE_FLAGS = new Set([
  "--prefix",
  "--registry",
  "--cache",
  "--userconfig",
  "--globalconfig",
  "--workspace",
  "-w",
  "--loglevel",
  "--tag",
  "--otp",
  "--before",
  "--min-release-age",
  "--min-release-age-exclude",
  "--omit",
  "--include",
  "--install-strategy",
  "--script-shell",
  "--node-options",
  "--cafile",
  "--ca",
  "--cert",
  "--key",
  "--proxy",
  "--https-proxy",
  "--noproxy",
  "--scope",
]);

/** Bun's value-taking globals — skipped while locating the subcommand. */
const BUN_VALUE_FLAGS = new Set([
  "--cwd",
  "-c",
  "--config",
  "--env-file",
  "-r",
  "--preload",
  "--require",
  "--import",
  "-F",
  "--filter",
  "--shell",
  "-e",
  "--eval",
  "-p",
  "--print",
  "--elide-lines",
  "--watch-kill-signal",
]);

/** Bun's subcommand aliases — `bun i` is `bun install`, `bun a` is `bun add`. */
const BUN_ALIASES: Record<string, string> = {
  i: "install",
  a: "add",
  rm: "remove",
  c: "create",
  x: "x",
};

/** Docker's value-taking global flags — skipped while locating the subcommand. */
const DOCKER_GLOBAL_VALUE_FLAGS = new Set([
  "--config",
  "-c",
  "--context",
  "-H",
  "--host",
  "-l",
  "--log-level",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
]);

/*
 * The value-taking options of `docker container run`/`create` (Boolean-only flags omitted: an
 * unlisted `--flag value` pair reads its value as the image, staying on the safe side). From the
 * Docker CLI reference, https://docs.docker.com/reference/cli/docker/container/run/ (retrieved
 * 2026-11-27).
 */
const DOCKER_RUN_VALUE_FLAGS = new Set([
  "-a",
  "--add-host",
  "--annotation",
  "--attach",
  "--blkio-weight",
  "--blkio-weight-device",
  "--cap-add",
  "--cap-drop",
  "--cgroup-parent",
  "--cgroupns",
  "--cidfile",
  "--cpu-count",
  "--cpu-percent",
  "--cpu-period",
  "--cpu-quota",
  "--cpu-rt-period",
  "--cpu-rt-runtime",
  "--cpu-shares",
  "--cpus",
  "--cpuset-cpus",
  "--cpuset-mems",
  "--detach-keys",
  "--device",
  "--device-cgroup-rule",
  "--device-read-bps",
  "--device-read-iops",
  "--device-write-bps",
  "--device-write-iops",
  "--dns",
  "--dns-option",
  "--dns-opt",
  "--dns-search",
  "--domainname",
  "-e",
  "--entrypoint",
  "--env",
  "--env-file",
  "--expose",
  "--gpus",
  "--group-add",
  "-h",
  "--health-cmd",
  "--health-interval",
  "--health-retries",
  "--health-start-interval",
  "--health-start-period",
  "--health-timeout",
  "--hostname",
  "--init-path",
  "--io-maxbandwidth",
  "--io-maxiops",
  "--ip",
  "--ip6",
  "--ipc",
  "--isolation",
  "--kernel-memory",
  "-l",
  "--label",
  "--label-file",
  "--link",
  "--log-driver",
  "--log-opt",
  "-m",
  "--mac-address",
  "--memory",
  "--memory-reservation",
  "--memory-swap",
  "--memory-swappiness",
  "--mount",
  "--name",
  "--network",
  "--network-alias",
  "--oom-score-adj",
  "-p",
  "--pid",
  "--pids-limit",
  "--platform",
  "--publish",
  "--pull",
  "--restart",
  "--runtime",
  "--security-opt",
  "--shm-size",
  "--stop-signal",
  "--stop-timeout",
  "--storage-opt",
  "--sysctl",
  "--tmpfs",
  "-u",
  "--ulimit",
  "--user",
  "--userns",
  "--uts",
  "-v",
  "--volume",
  "--volume-driver",
  "--volumes-from",
  "-w",
  "--workdir",
]);

/** The value-taking options of `docker image pull` (same reference, same date). */
const DOCKER_PULL_VALUE_FLAGS = new Set(["--platform"]);

/**
 * The subcommand of a `docker` invocation and the arguments that follow it: docker's own global
 * flags may precede the verb, so they — and only they — are skipped here. The verb's own flags and
 * their values stay in `rest` for the verb's option table to take apart.
 */
const dockerVerb = (
  args: ReadonlyArray<string>,
): { readonly verb: string | undefined; readonly rest: ReadonlyArray<string> } => {
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    if (token === "--") {
      return { verb: args[i + 1], rest: args.slice(i + 2) };
    }
    if (token.startsWith("-") && token !== "-") {
      if (!token.includes("=") && DOCKER_GLOBAL_VALUE_FLAGS.has(token)) {
        i += 1;
      }
      continue;
    }
    return { verb: token, rest: args.slice(i + 1) };
  }
  return { verb: undefined, rest: [] };
};

/** The words after a command's option run — `--x=v` is one word, `-` is a word, `--` ends it. */
const positionals = (args: ReadonlyArray<string>, valueFlags: ReadonlySet<string>): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    if (token === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (token.startsWith("-") && token !== "-") {
      if (!token.includes("=") && valueFlags.has(token)) {
        i += 1;
      }
      continue;
    }
    out.push(token);
  }
  return out;
};

/** The `-t`/`--tag` values of every `docker build`/`buildx build`/`image build` in a script. */
export const collectBuildTags = (script: ReadonlyArray<Pipeline>): string[] => {
  const tags: string[] = [];
  for (const pipeline of script) {
    for (const command of pipeline) {
      const { tool, argv } = normalize(command);
      if (tool !== "docker") {
        continue;
      }
      const { verb: head, rest } = dockerVerb(argv.slice(1));
      const build =
        head === "build" ||
        (head === "buildx" && rest[0] === "build") ||
        (head === "image" && rest[0] === "build");
      if (!build) {
        continue;
      }
      const buildArgs = head === "build" ? rest : rest.slice(1);
      for (let i = 0; i < buildArgs.length; i++) {
        const token = buildArgs[i] ?? "";
        if (token === "-t" || token === "--tag") {
          const value = buildArgs[i + 1];
          if (value !== undefined) {
            tags.push(squeezeExpressions(value));
          }
          i += 1;
        } else if (token.startsWith("--tag=")) {
          tags.push(squeezeExpressions(token.slice("--tag=".length)));
        }
      }
    }
  }
  return tags;
};

/**
 * The command rules shared by `run:` steps, manifest scripts and Dockerfile `RUN` bodies, applied
 * to the pipelines the shell parser returns — never to raw text: bin runners resolve only against
 * declared dependencies; installers that would reach a registry outside a lockfile are findings; a
 * downloader piped to an interpreter is a finding; and a `docker` command may only reference
 * digest-pinned images or images the file itself builds. `sh -c`, `eval` and heredoc bodies fed to
 * a shell recurse as scripts; substitution bodies recurse too.
 */
export const checkCommands = (
  at: string,
  script: ReadonlyArray<Pipeline>,
  dirs: ReadonlyArray<string>,
  index: DependencyIndex,
  builtImages: ReadonlySet<string>,
): string[] => {
  const errors: string[] = [];
  const images = new Set(builtImages);

  const binRule = (tool: string, args: ReadonlyArray<string>): void => {
    let explicit = false;
    for (let i = 0; i < args.length; i++) {
      const token = args[i] ?? "";
      if (token === "--") {
        continue;
      }
      if (token === "-p" || token === "--package") {
        const pkg = args[i + 1] ?? "";
        i += 1;
        explicit = true;
        if (!index.declared(pkg, dirs)) {
          errors.push(`${at}: ${tool} -p ${pkg} names no declared dependency`);
        }
        continue;
      }
      if (token.startsWith("--package=")) {
        const pkg = token.slice("--package=".length);
        explicit = true;
        if (!index.declared(pkg, dirs)) {
          errors.push(`${at}: ${tool} --package=${pkg} names no declared dependency`);
        }
        continue;
      }
      if (token.startsWith("-")) {
        continue;
      }
      // With -p the named package serves the bin; without it the declared deps must.
      if (!explicit && index.bin(token, dirs) === undefined) {
        errors.push(
          `${at}: ${tool} ${token} resolves no bin of a dependency declared in ${dirs
            .map((d) => `${d}/package.json`)
            .join(" or ")}`,
        );
      }
      break;
    }
  };

  /** Any pipeline reachable here downloads code — a substitution's body counts too. */
  const downloads = (script: ReadonlyArray<Pipeline>, depth: number): boolean =>
    depth < 8 &&
    script.some((pipeline) =>
      pipeline.some((command) => {
        const n = normalize(command);
        return (
          n.tool === "curl" ||
          n.tool === "wget" ||
          n.substitutions.some((sub) => downloads(sub, depth + 1))
        );
      }),
    );

  const visit = (script: ReadonlyArray<Pipeline>, depth: number): void => {
    if (depth > 8) {
      return;
    }
    for (const pipeline of script) {
      // Download-and-run: a curl/wget earlier in the pipeline feeding a later interpreter, or an
      // interpreter whose own argv substitutes a download (`sh <(curl …)`, `bash -c "$(curl …)"`).
      let downloading = false;
      for (const command of pipeline) {
        const n = normalize(command);
        if (
          EXECUTORS.has(n.tool) &&
          (downloading || n.substitutions.some((sub) => downloads(sub, 0)))
        ) {
          errors.push(`${at}: a curl/wget download must not be piped to a shell`);
          break;
        }
        if (n.tool === "curl" || n.tool === "wget") {
          downloading = true;
        }
      }
      for (const command of pipeline) {
        const n = normalize(command);
        const args = n.argv.slice(1);
        if (n.tool === "bunx") {
          binRule("bunx", args);
        } else if (n.tool === "npx") {
          binRule("npx", args);
        } else if (n.tool === "pnpx") {
          errors.push(`${at}: pnpx runs registry code without a lockfile`);
        } else if (n.tool === "npm") {
          const sub = positionals(args, NPM_VALUE_FLAGS);
          const [typed] = sub;
          const deref = typed === undefined ? undefined : npmDeref(typed);
          const offline = args.some((a) => a === "--offline" || a.startsWith("--offline="));
          if ((deref === "install" || deref === "install-test" || deref === "update") && !offline) {
            errors.push(`${at}: npm ${deref} resolves outside a committed lockfile — use npm ci`);
          } else if (deref === "exec") {
            binRule("npm exec", sub.slice(1));
          }
        } else if (n.tool === "bun") {
          const sub = positionals(args, BUN_VALUE_FLAGS);
          const [typed] = sub;
          const deref = typed === undefined ? undefined : (BUN_ALIASES[typed] ?? typed);
          if (deref === "add" || deref === "update" || deref === "create") {
            errors.push(`${at}: bun ${deref} resolves outside the lockfile`);
          } else if (deref === "install" && !args.includes("--frozen-lockfile")) {
            // The flag must live in this invocation — `bun install && echo --frozen-lockfile`
            // freezes nothing.
            errors.push(`${at}: bun install must pass --frozen-lockfile`);
          } else if (deref === "x") {
            binRule("bun x", sub.slice(1));
          }
        } else if (n.tool === "pip") {
          const [typed] = positionals(args, new Set());
          if (
            typed === "install" &&
            !args.includes("--require-hashes") &&
            !args.includes("--no-index")
          ) {
            errors.push(`${at}: pip install must pass --require-hashes`);
          }
        } else if (n.tool === "pnpm" || n.tool === "yarn") {
          if (positionals(args, new Set())[0] === "dlx") {
            errors.push(`${at}: ${n.tool} dlx runs registry code without a lockfile`);
          }
        } else if (n.tool === "docker") {
          const { verb: head, rest: after } = dockerVerb(args);
          const [noun] = after;
          let verb = head;
          let rest = after;
          if (verb === "container" && (noun === "run" || noun === "create")) {
            verb = noun;
            rest = rest.slice(1);
          } else if (verb === "image" && noun === "pull") {
            verb = "pull";
            rest = rest.slice(1);
          }
          if (verb === "run" || verb === "create" || verb === "pull") {
            const valueFlags = verb === "pull" ? DOCKER_PULL_VALUE_FLAGS : DOCKER_RUN_VALUE_FLAGS;
            const [image] = positionals(rest, valueFlags);
            if (
              image !== undefined &&
              !DIGEST_IMAGE.test(image) &&
              !images.has(squeezeExpressions(image))
            ) {
              errors.push(
                `${at}: docker ${verb} ${image} is neither digest-pinned nor built by this file`,
              );
            }
          }
        }
        // Script recursion: substitutions, a shell's -c argument or heredoc body, eval's words.
        for (const sub of n.substitutions) {
          visit(sub, depth + 1);
        }
        if (SHELLS.has(n.tool)) {
          const flag = args.findIndex((a) => /^-[^-]*c$/.test(a));
          if (flag !== -1 && args[flag + 1] !== undefined) {
            visit(parse(args[flag + 1] ?? ""), depth + 1);
          }
          for (const body of n.heredocs) {
            visit(parse(body), depth + 1);
          }
        }
        if (n.tool === "eval" && args.length > 0) {
          visit(parse(args.join(" ")), depth + 1);
        }
      }
    }
  };
  visit(script, 0);
  return errors;
};

export const checkCommand = (
  at: string,
  command: string,
  dirs: ReadonlyArray<string>,
  index: DependencyIndex,
  builtImages: ReadonlySet<string> = new Set(),
): string[] => checkCommands(at, parse(command), dirs, index, builtImages);

/**
 * `${{ … }}` expressions may contain spaces, which would split an image reference like
 * `onekey-emu-${{ matrix.model }}` across tokens — collapse them so both sides compare equal.
 */
export const squeezeExpressions = (text: string): string =>
  text.replaceAll(/\$\{\{[^}]*\}\}/g, (m) => m.replaceAll(/\s+/g, ""));
