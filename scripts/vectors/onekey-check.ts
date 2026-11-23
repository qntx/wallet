/// <reference types="node" />
/* oxlint-disable typescript/no-unsafe-type-assertion -- the JSON transcripts are untyped */
/**
 * Compares a freshly recorded OneKey emulator transcript (--fresh <dir>, produced by
 * scripts/vectors/onekey-emulator.ts --out) against the committed vector for --model: every session
 * must exist with the same exchange count and every request must be byte-identical. Responses are
 * ignored — they may legitimately differ (BIP-340 auxiliary randomness, stale core-report padding).
 * Any request drift is a client regression and fails the run.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Step = { request: string };
type Transcript = { sessions: Array<{ name: string; exchanges: Step[] }> };

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const MODEL = arg("model", "classic1s");
if (MODEL !== "classic1s" && MODEL !== "pro") {
  throw new Error(`unknown --model ${MODEL}`);
}
const FRESH = arg("fresh", "");
if (FRESH === "") {
  throw new Error("--fresh <dir> with the fresh transcript is required");
}

const committed = JSON.parse(
  readFileSync(resolve(import.meta.dirname, `../../vectors/onekey/emulator-${MODEL}.json`), "utf8"),
) as Transcript;
const fresh = JSON.parse(
  readFileSync(resolve(FRESH, `emulator-${MODEL}.json`), "utf8"),
) as Transcript;

const freshSessions = new Map(fresh.sessions.map((s) => [s.name, s]));
let drift = 0;
for (const session of committed.sessions) {
  const recorded = freshSessions.get(session.name);
  if (recorded === undefined) {
    console.error(`fresh transcript misses session ${session.name}`);
    drift += 1;
    continue;
  }
  if (recorded.exchanges.length !== session.exchanges.length) {
    console.error(
      `${session.name}: ${session.exchanges.length} committed exchanges,` +
        ` ${recorded.exchanges.length} fresh`,
    );
    drift += 1;
    continue;
  }
  for (const [index, step] of session.exchanges.entries()) {
    if (recorded.exchanges[index]?.request !== step.request) {
      console.error(`${session.name} request ${index + 1} drifted`);
      drift += 1;
    }
  }
}
for (const session of fresh.sessions) {
  if (!committed.sessions.some((s) => s.name === session.name)) {
    console.error(`fresh transcript has extra session ${session.name}`);
    drift += 1;
  }
}

if (drift > 0) {
  console.error(`onekey ${MODEL}: ${drift} request drift(s)`);
  process.exitCode = 1;
} else {
  console.log(`onekey ${MODEL}: ${committed.sessions.length} sessions, all requests identical`);
}
