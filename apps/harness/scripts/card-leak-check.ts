/**
 * Leak checker for the card-surfaces run: `bun scripts/card-leak-check.ts <log>`.
 * The log is the app-process capture (logcat --pid / simctl log stream). FAIL
 * when any fixture secret — plain, hex, base64/base64url, UTF-16LE hex or a
 * decimal byte list — appears anywhere in it; the trusted path must leave no
 * byte-level fingerprint in this runtime's log. PASS also requires the
 * positive control (the decoy IS inside CARD_LEAK_RECORD lines), both inputs
 * matching, the cancelled flow, both tap summaries, an unavailable device
 * tap, and the sheet prompt visible on CARD_SHEET_OPEN but never inside a
 * CARD_LEAK_RECORD.
 */
import { readFileSync } from "node:fs";

import {
  ACCESS_CODE,
  DECOY,
  SHORT_ID_NORMALIZED,
  SHORT_ID_PRINTED,
  SHORT_ID_TYPED,
  TAP_PROMPT,
} from "../probes/card-surfaces-fixture.ts";

const log = readFileSync(process.argv[2] ?? "", "utf8");
const lines = log.split("\n");
const leakLines = lines.filter((line) => line.includes("CARD_LEAK_RECORD"));

const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)];

const encodings = (s: string): ReadonlyArray<readonly [string, string]> => {
  const bytes = utf8(s);
  const hexLower = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  const base64 = Buffer.from(s, "utf8").toString("base64");
  const utf16le = [...s]
    .map((c) => {
      const code = c.charCodeAt(0);
      return `${(code & 0xff).toString(16).padStart(2, "0")}${(code >> 8).toString(16).padStart(2, "0")}`;
    })
    .join("");
  return [
    ["plain", s],
    ["hex", hexLower],
    ["hex-upper", hexLower.toUpperCase()],
    ["base64", base64],
    ["base64url", base64.replaceAll("+", "-").replaceAll("/", "_")],
    ["utf16le-hex", utf16le],
    ["dec-bytes", bytes.join(",")],
    ["dec-bytes-spaced", bytes.join(", ")],
  ];
};

const SECRETS: ReadonlyArray<readonly [string, string]> = [
  ["access-code", ACCESS_CODE],
  ["short-id-typed", SHORT_ID_TYPED],
  ["short-id-printed", SHORT_ID_PRINTED],
  ["short-id-normalized", SHORT_ID_NORMALIZED],
];

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  checks.push({ name, ok, detail });
};

let anySecret = false;
for (const [label, secret] of SECRETS) {
  for (const [form, encoded] of encodings(secret)) {
    if (encoded.length > 0 && log.includes(encoded)) {
      anySecret = true;
      check(`secret ${label} (${form})`, false, "found in log");
    }
  }
}
check("no secret fingerprint anywhere", !anySecret);

const decoyInRecords = leakLines.some((line) => line.includes(DECOY));
check("decoy reaches CARD_LEAK_RECORD", decoyInRecords, "positive control");

// The marker also nests inside a CARD_LEAK_RECORD wrapper line; take the
// plain one (recorder lines are rejected by the checker anyway).
const resultLine = lines.find(
  (line) =>
    line.includes("CARD_SURFACES_RESULT {") &&
    !line.includes("CARD_LEAK_RECORD"),
);
const done = lines.some((line) => line.includes("CARD_SURFACES_DONE"));
check("run finished", done);

const jsonAfter = (line: string, marker: string): unknown => {
  const index = line.indexOf(marker);
  // ReactNativeJS wraps console arguments in quotes: 'CARD_X {"a":1}'
  let tail = line.slice(index + marker.length).trim();
  if (tail.endsWith("'") || tail.endsWith('"')) {
    tail = tail.slice(0, -1);
  }
  return JSON.parse(tail);
};

const result = ((): Record<string, unknown> => {
  if (resultLine === undefined) {
    return {};
  }
  try {
    return jsonAfter(resultLine, "CARD_SURFACES_RESULT ") as Record<string, unknown>;
  } catch {
    return {};
  }
})();

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const steps = (key: string): Record<string, unknown>[] => {
  const entry = asRecord(result[key]);
  const list = entry?.["steps"];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
};

const stepIs = (
  list: Record<string, unknown>[],
  index: number,
  expect: Record<string, unknown>,
): boolean => {
  const step = list[index];
  if (step === undefined) {
    return false;
  }
  return Object.entries(expect).every(([k, v]) => step[k] === v);
};

// Inputs: every kind reported match:true from inside the kernel.
for (const key of ["code", "shortId", "approval"] as const) {
  const entry = asRecord(result[key]);
  check(
    `input ${key} match`,
    entry?.["input"] === "ok" && entry?.["match"] === true,
    JSON.stringify(entry ?? null),
  );
}

// Cancel flow: the pending input reports cancelled, then cancelled:true.
check(
  "cancelled input",
  asRecord(result["cancelledInput"])?.["input"] === "cancelled",
  JSON.stringify(result["cancelledInput"] ?? null),
);
check(
  "cancel reply",
  asRecord(result["cancelled"])?.["cancelled"] === true,
  JSON.stringify(result["cancelled"] ?? null),
);

// Tap ok: open ok, three transmits with SW 9000, success close.
const okSteps = steps("tapOk");
check(
  "tap ok open",
  stepIs(okSteps, 0, { step: "open", ok: true }),
  JSON.stringify(okSteps[0] ?? null),
);
check(
  "tap ok transmits",
  okSteps.length === 5 &&
    [1, 2, 3].every((i) => stepIs(okSteps, i, { ok: true, sw: "9000" })),
  JSON.stringify(okSteps),
);
check("tap ok close", stepIs(okSteps, 4, { step: "close", ok: true }), "");

// Tap lost: open ok, both transmits tag-lost, failure close.
const lostSteps = steps("tapLost");
check(
  "tap lost open",
  stepIs(lostSteps, 0, { step: "open", ok: true }),
  JSON.stringify(lostSteps[0] ?? null),
);
check(
  "tap lost transmits",
  lostSteps.length === 4 &&
    stepIs(lostSteps, 1, { ok: false, failure: "tag-lost" }) &&
    stepIs(lostSteps, 2, { ok: false, failure: "tag-lost" }),
  JSON.stringify(lostSteps),
);
check("tap lost close", stepIs(lostSteps, 3, { step: "close", ok: true }), "");

// Device tap: the platform reader is unavailable on emulator/simulator.
const deviceTap = asRecord(asRecord(result["deviceTap"])?.["deviceTap"]);
check(
  "device tap unavailable",
  deviceTap?.["open"] === "unavailable",
  JSON.stringify(deviceTap ?? null),
);

// The sheet prompt: on the native channel, never through the main runtime.
const promptOnSheet = lines.some(
  (line) => line.includes("CARD_SHEET_OPEN") && line.includes(TAP_PROMPT),
);
check("tap prompt on CARD_SHEET_OPEN", promptOnSheet);
const promptInRecords = leakLines.some((line) => line.includes(TAP_PROMPT));
check("tap prompt absent from CARD_LEAK_RECORD", !promptInRecords);

const closes = lines.filter((line) => line.includes("CARD_SHEET_CLOSE"));
check(
  "sheet closes logged",
  closes.some((line) => line.includes("success")) &&
    closes.some((line) => line.includes("failure")),
  `${closes.length} close lines`,
);

let failed = 0;
for (const { name, ok, detail } of checks) {
  if (!ok) {
    failed++;
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
