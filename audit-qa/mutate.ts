// Mutation spot-check runner (audit lane quality). Usage from the repo root:
//   bun audit-qa/mutate.ts [ID...]   → appends one JSON line per mutant to /tmp/qa/mutants.jsonl
// A mutant is "killed" when any stage exits non-zero. Chains mutants that survive their own suite
// are rebuilt into dist and replayed through the kernel and engine suites (they consume dist).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

declare const Bun: {
  spawnSync: (o: {
    cmd: string[];
    cwd: string;
    stdout: "pipe";
    stderr: "pipe";
    timeout: number;
    killSignal: string;
  }) => {
    exitCode: number;
    stdout: { toString: () => string };
    stderr: { toString: () => string };
  };
};

type Step = { cwd: string; cmd: string[] };
type Mutant = {
  id: string;
  pkg: string;
  file: string;
  find: string;
  replace: string;
  nth?: number;
  why: string;
  // Extra stages run while the mutant is applied and every earlier stage passed; `rebuild` runs
  // after the file is restored (e.g. the worker kernel bundle the follow-up stage consumed).
  followups?: Step[];
  rebuild?: Step[];
};
const SPEC = process.env["MUTANTS"] ?? "audit-qa/mutants.json";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStep = (v: unknown): v is Step =>
  isObject(v) &&
  typeof v["cwd"] === "string" &&
  Array.isArray(v["cmd"]) &&
  v["cmd"].every((c) => typeof c === "string");
const isStepList = (v: unknown): v is Step[] | undefined =>
  v === undefined || (Array.isArray(v) && v.every(isStep));
const isMutant = (v: unknown): v is Mutant =>
  isObject(v) &&
  typeof v["id"] === "string" &&
  typeof v["pkg"] === "string" &&
  typeof v["file"] === "string" &&
  typeof v["find"] === "string" &&
  typeof v["replace"] === "string" &&
  typeof v["why"] === "string" &&
  (v["nth"] === undefined || typeof v["nth"] === "number") &&
  isStepList(v["followups"]) &&
  isStepList(v["rebuild"]);
const spec: unknown = JSON.parse(readFileSync(SPEC, "utf8"));
if (!Array.isArray(spec)) {
  throw new TypeError(`${SPEC} is not a mutant array`);
}
const mutants: Mutant[] = [];
for (const v of spec) {
  if (!isMutant(v)) {
    throw new TypeError(`${SPEC} entry is not a mutant`);
  }
  mutants.push(v);
}
const only = new Set(process.argv.slice(2));
const OUT = "/tmp/qa/mutants.jsonl";

const run = (cwd: string, cmd: string[]) => {
  const t = Date.now();
  // A mutant that disables a deadline can spin a suite forever (K1/K2): cap every stage.
  const r = Bun.spawnSync({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000,
    killSignal: "SIGKILL",
  });
  const out = `${r.stdout.toString()}${r.stderr.toString()}`;
  const fails = out
    .split("\n")
    .filter((l) => /FAIL|✗|×|AssertionError|Error:/.test(l))
    .slice(0, 8);
  return { cmd: `(cd ${cwd} && ${cmd.join(" ")})`, exit: r.exitCode, ms: Date.now() - t, fails };
};
const test = (pkg: string) => run(`packages/${pkg}`, ["bunx", "vp", "test", "--bail", "1"]);
const buildChains = () => run("packages/wallet-chains", ["bunx", "vp", "pack"]);

for (const m of mutants) {
  if (only.size > 0 && !only.has(m.id)) {
    continue;
  }
  const original = readFileSync(m.file, "utf8");
  const parts = original.split(m.find);
  const count = parts.length - 1;
  const nth = m.nth ?? 1;
  if (m.nth === undefined ? count !== 1 : count < nth) {
    appendFileSync(OUT, `${JSON.stringify({ id: m.id, error: `find matched ${count} times` })}\n`);
    continue;
  }
  const mutated = parts.slice(0, nth).join(m.find) + m.replace + parts.slice(nth).join(m.find);
  const stages: Array<ReturnType<typeof run>> = [];
  let built = false;
  try {
    writeFileSync(m.file, mutated);
    stages.push(test(m.pkg));
    for (const step of m.followups ?? []) {
      if (stages.at(-1)?.exit !== 0) {
        break;
      }
      stages.push(run(step.cwd, step.cmd));
    }
    if (m.pkg === "wallet-chains" && stages.at(-1)?.exit === 0) {
      stages.push(buildChains());
      built = true;
      for (const pkg of ["wallet-kernel", "wallet-engine"]) {
        if (stages.at(-1)?.exit !== 0) {
          break;
        }
        stages.push(test(pkg));
      }
    }
  } finally {
    writeFileSync(m.file, original);
    if (built) {
      buildChains();
    }
    for (const step of m.rebuild ?? []) {
      run(step.cwd, step.cmd);
    }
  }
  const killed = stages.some((s) => s.exit !== 0);
  appendFileSync(
    OUT,
    `${JSON.stringify({ id: m.id, file: m.file, why: m.why, killed, stages })}\n`,
  );
  process.stdout.write(`${m.id} ${killed ? "KILLED" : "SURVIVED"}\n`);
}
