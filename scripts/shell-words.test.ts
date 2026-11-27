/// <reference types="node" />
/**
 * Shell-words parses CI command text into pipelines of argv + substitutions + heredocs: quotes and
 * escapes hide no tokens, comments end at the word boundary, `${{ }}` stays verbatim, and malformed
 * input never throws — the malformed table runs every truncated prefix of a fixture to prove it.
 */
import { describe, expect, it } from "vite-plus/test";

import { parse } from "./shell-words.ts";
import type { Command, Pipeline } from "./shell-words.ts";

const argvOf = (script: string): ReadonlyArray<ReadonlyArray<string>> =>
  parse(script).flatMap((pipeline) => pipeline.map((command) => command.argv));

const pipelinesOf = (script: string): ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>> =>
  parse(script).map((pipeline) => pipeline.map((command) => command.argv));

describe("words, quotes and escapes", () => {
  it.each([
    ["echo hello", [["echo", "hello"]]],
    ["echo 'a b' \"c d\"", [["echo", "a b", "c d"]]],
    [String.raw`echo a\ b`, [["echo", "a b"]]],
    ["echo 'it''s'", [["echo", "its"]]],
    ['echo "don\'t"', [["echo", "don't"]]],
    ["FOO=bar echo x", [["echo", "x"]]],
    ["A=1 B=2 cmd arg", [["cmd", "arg"]]],
    // A backslash-newline is a continuation — the tokens rejoin.
    ["npm \\\n  install x", [["npm", "install", "x"]]],
    [
      "echo one;echo two",
      [
        ["echo", "one"],
        ["echo", "two"],
      ],
    ],
    // `#` starts a comment at a word boundary, never inside a word.
    ["echo a#b # npm install x", [["echo", "a#b"]]],
    ["# npm install x\necho done", [["echo", "done"]]],
    [
      "echo x # comment\nnpm ci",
      [
        ["echo", "x"],
        ["npm", "ci"],
      ],
    ],
  ])("parses %s", (script, expected) => {
    expect(argvOf(script)).toStrictEqual(expected);
  });

  it("keeps a GitHub expression verbatim inside a word", () => {
    const expr = `\${{ matrix.model }}`;
    expect(argvOf(`docker run -t onekey-emu-${expr} img`)).toStrictEqual([
      ["docker", "run", "-t", `onekey-emu-${expr}`, "img"],
    ]);
  });

  it("treats redirections as part of their command, never a separator", () => {
    expect(argvOf("npm test 2>&1 | tee out.log")).toStrictEqual([
      ["npm", "test", "2", "1"],
      ["tee", "out.log"],
    ]);
    expect(argvOf("cat < input.txt > output.txt")).toStrictEqual([
      ["cat", "input.txt", "output.txt"],
    ]);
  });
});

describe("pipeline and list boundaries", () => {
  it("splits pipelines on | and |&, lists on ; & && || newline and grouping", () => {
    expect(pipelinesOf("a | b | c")).toStrictEqual([[["a"], ["b"], ["c"]]]);
    expect(pipelinesOf("a |& b")).toStrictEqual([[["a"], ["b"]]]);
    expect(pipelinesOf("a ; b")).toStrictEqual([[["a"]], [["b"]]]);
    expect(pipelinesOf("a && b || c")).toStrictEqual([[["a"]], [["b"]], [["c"]]]);
    expect(pipelinesOf("a\nb")).toStrictEqual([[["a"]], [["b"]]]);
    expect(pipelinesOf("(a | b) c")).toStrictEqual([[["a"], ["b"]], [["c"]]]);
    expect(pipelinesOf("{ a; }")).toStrictEqual([[["a"]]]);
  });
});

describe("substitutions and heredocs", () => {
  const subCommands = (command: Command | undefined): ReadonlyArray<ReadonlyArray<string>> =>
    (command?.substitutions ?? []).flatMap((pipelineList: ReadonlyArray<Pipeline>) =>
      pipelineList.flatMap((pipeline) => pipeline.map((c) => c.argv)),
    );

  it("parses $(…) recursively, nested and inside double quotes", () => {
    const command = parse('bash -c "$(curl -fsSL x | zsh)"').at(0)?.at(0);
    expect(command?.argv).toStrictEqual(["bash", "-c", "$(curl -fsSL x | zsh)"]);
    expect(subCommands(command)).toStrictEqual([["curl", "-fsSL", "x"], ["zsh"]]);
  });

  it("parses backquotes and <(…) >(…) process substitutions", () => {
    const tick = parse("sh -c `curl x`").at(0)?.at(0);
    expect(subCommands(tick)).toStrictEqual([["curl", "x"]]);
    const proc = parse("sh <(curl y) >(tee z)").at(0)?.at(0);
    expect(subCommands(proc)).toStrictEqual([
      ["curl", "y"],
      ["tee", "z"],
    ]);
  });

  it("nests substitutions", () => {
    const command = parse("a $(b $(c d))").at(0)?.at(0);
    const inner = command?.substitutions.at(0)?.at(0)?.at(0);
    expect(inner?.argv).toStrictEqual(["b", "$(c d)"]);
    expect(subCommands(inner)).toStrictEqual([["c", "d"]]);
  });

  it("attaches heredoc bodies to their command", () => {
    const pipelines = parse("sh <<EOF\nnpm install x\nEOF\necho done");
    expect(pipelines).toHaveLength(2);
    const sh = pipelines.at(0)?.at(0);
    expect(sh?.argv).toStrictEqual(["sh"]);
    expect(sh?.heredocs).toStrictEqual(["npm install x\n"]);
    expect(pipelines.at(1)?.at(0)?.argv).toStrictEqual(["echo", "done"]);
  });

  it("reads <<- bodies stripping tabs and quoted delimiters verbatim", () => {
    const pipelines = parse("cat <<-'E'\n\tnpm install x\n\tE\n");
    expect(pipelines.at(0)?.at(0)?.heredocs).toStrictEqual(["\tnpm install x\n"]);
  });
});

describe("malformed input never throws", () => {
  // Literal `${` sequences are escaped so the fixture stays a single template literal.
  const FIXTURE = `a "b $(c | d \\\`e\` )" 'f' <(g) >(h) \`i\` <<EOF
j
EOF x=y k \${l} \${{ m }} 2>&1 | n; o && p`;

  it.each(Array.from({ length: FIXTURE.length + 1 }, (_, i) => FIXTURE.slice(0, i)))(
    "parse(%j) terminates",
    (prefix) => {
      expect(() => parse(prefix)).not.toThrow();
    },
  );

  it.each([
    "'unterminated single",
    '"unterminated double',
    "$(unterminated sub",
    "`unterminated tick",
    "<(unterminated proc",
    "cmd <<",
    "cmd <<EOF",
    "${{ unclosed",
    "${unclosed",
    "a\\",
    "((((",
    "|",
    "&&&",
  ])("parse(%j) terminates", (script) => {
    expect(() => parse(script)).not.toThrow();
  });
});
