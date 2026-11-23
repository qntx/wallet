/**
 * Recording and drift-checking for the speculos suite. In record mode (`LEDGER_RECORD=1 bun run
 * test:speculos`) each case's exact APDU traffic, screens and parsed result are written to
 * `vectors/ledger/<app>.json` — the vendor app is the oracle. In normal mode every exchange call is
 * compared against the committed transcript: any drift between what our client sends and what the
 * pinned app answered fails the test.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Exchange } from "../../src/modules/ledger/protocol/apdu.ts";
import type { LedgerApp } from "../../src/modules/ledger/protocol/device.ts";
import { LedgerError } from "../../src/modules/ledger/protocol/errors.ts";
import { exchange as liveExchange, Screen } from "./harness.ts";

export const RECORD: boolean = process.env["LEDGER_RECORD"] === "1";

export type Step = { apdu: string; response: string };

export type RecordedError = { code: string; sw?: number };

export type RecordedCase = {
  name: string;
  setting?: string;
  call: Record<string, unknown>;
  commands: Step[];
  screens: string[];
  result?: unknown;
  error?: RecordedError;
};

export type VectorFile = {
  app: string;
  appVersion: string;
  appCommit: string;
  speculos: string;
  seed: string;
  cases: RecordedCase[];
};

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const unhex = (value: string): Uint8Array => {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
    throw new Error("not hex");
  }
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
};

const vectorsDir = fileURLToPath(new URL("../../../../vectors/ledger", import.meta.url));
const appsJsonPath = fileURLToPath(
  new URL("../../../../scripts/ledger/apps.json", import.meta.url),
);

type AppsJson = {
  images: { speculos: string; builder: string };
  model: string;
  seed: string;
  apps: Record<string, { commit: string; version: string; name: string }>;
};

const isAppsJson = (value: unknown): value is AppsJson =>
  typeof value === "object" &&
  value !== null &&
  "images" in value &&
  "seed" in value &&
  "apps" in value;

export function appsJson(): AppsJson {
  const parsed: unknown = JSON.parse(readFileSync(appsJsonPath, "utf8"));
  if (!isAppsJson(parsed)) {
    throw new Error(`${appsJsonPath}: unexpected shape`);
  }
  return parsed;
}

const vectorPath = (app: string): string => `${vectorsDir}/${app}.json`;

const isVectorFile = (value: unknown): value is VectorFile =>
  typeof value === "object" && value !== null && "cases" in value && Array.isArray(value.cases);

export function committed(app: string): VectorFile | undefined {
  const path = vectorPath(app);
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isVectorFile(parsed)) {
    throw new Error(`${path}: unexpected shape`);
  }
  return parsed;
}

export function writeVectors(app: string, cases: RecordedCase[]): void {
  const pins = appsJson();
  const pin = app === "device" ? undefined : pins.apps[app];
  // merge over the committed file: a failed case must not drop a case recorded in an
  // earlier run; fresh recordings replace their stale versions
  const prior = committed(app)?.cases ?? [];
  const fresh = new Set(cases.map((c) => c.name));
  const merged = [...prior.filter((c) => !fresh.has(c.name)), ...cases];
  const doc: VectorFile = {
    app,
    appVersion: pin?.version ?? "0.0.0",
    appCommit: pin?.commit ?? "",
    speculos: pins.images.speculos,
    seed: pins.seed,
    cases: merged,
  };
  writeFileSync(vectorPath(app), `${JSON.stringify(doc, null, 2)}\n`);
}

const serializeError = (error: unknown): RecordedError => {
  if (error instanceof LedgerError) {
    return error.sw === undefined ? { code: error.code } : { code: error.code, sw: error.sw };
  }
  return { code: "test-failure" };
};

export type CaseDef = {
  name: string;
  /** The app setting this case needs toggled on (recorded with the case). */
  setting?: { label: string; enabled: boolean };
  call: Record<string, unknown>;
  /** May leave the emulator dead — the runner restarts speculos afterwards. */
  mayKillEmulator?: boolean;
  /**
   * `def` is the case itself — `run` may extend `def.call` with inputs only known live (e.g. a
   * message built from the device key) so they land in the recorded vector.
   */
  run: (exchange: Exchange, screen: Screen, def: CaseDef) => Promise<unknown>;
  /**
   * The device adds per-run entropy to the yielded signature (Schnorr aux randomness). APDUs are
   * still compared byte-for-byte, but signature bytes in YIELD responses and in the result are
   * masked — the case's own oracle proves each live signature valid.
   */
  volatileSignature?: boolean;
};

/**
 * Zero the signature tail of a `10` (YIELD) response — `10 ‖ varint input ‖ u8 pubkeyLen ‖ pubkey ‖
 * signature ‖ e000` (doc/bitcoin.md) — so a randomized signature cannot drift the transcript.
 */
const maskYield = (step: Step): Step => {
  const r = unhex(step.response);
  if (r.length < 4 || r[0] !== 0x10 || r.at(-2) !== 0xe0 || r.at(-1) !== 0x00) {
    return step;
  }
  const first = r[1] ?? 0;
  const varintLen = first < 0xfd ? 1 : first === 0xfd ? 3 : first === 0xfe ? 5 : 9;
  const start = 1 + varintLen + 1 + (r[1 + varintLen] ?? 0);
  if (start >= r.length - 2) {
    return step;
  }
  r.fill(0, start, r.length - 2);
  return { apdu: step.apdu, response: hex(r) };
};

const maskSig = (result: unknown): unknown => {
  if (!Array.isArray(result)) {
    return result;
  }
  return result.map((item: unknown) => {
    if (typeof item !== "object" || item === null || !("signature" in item)) {
      return item;
    }
    return { ...item, signature: "masked" };
  });
};

const recorder = (
  app: LedgerApp,
  expected: Step[] | undefined,
): { exchange: Exchange; steps: Step[] } => {
  const steps: Step[] = [];
  const ex: Exchange = async (apdu) => {
    const response = await liveExchange(app, apdu);
    steps.push({ apdu: hex(apdu), response: hex(response) });
    return response;
  };
  void expected;
  return { exchange: ex, steps };
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Poll the REST API; returns false when the container is gone (app exit kills speculos). */
export async function alive(app: LedgerApp): Promise<boolean> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${41000 + ["bitcoin", "ethereum", "solana", "tron"].indexOf(app)}/events?currentscreenonly=true`,
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Navigate the app's settings menu to `label`, toggle it to `enabled`, and leave via Back. Item
 * screens show `<Label> <description> <Enabled|Disabled>`; pressing both toggles in place.
 */
// oxlint-disable eslint/no-await-in-loop -- the device menu is paged one screen at a time
export async function setSetting(screen: Screen, label: string, enabled: boolean): Promise<void> {
  const right = async (): Promise<void> => {
    await screen.button("right", "press-and-release");
    await sleep(300);
  };
  const both = async (): Promise<void> => {
    await screen.button("both", "press-and-release");
    await sleep(400);
  };
  // find the "App settings" entry on the home menu; a blind both-press could land on "Quit app"
  for (let i = 0; i < 8; i += 1) {
    if (/app settings/i.test(await screen.screen())) {
      break;
    }
    await right();
    if (i === 7) {
      throw new Error("App settings entry not found");
    }
  }
  await both();
  // find the setting item; screens print the current state as their last word
  const item = new RegExp(`^${label} `, "i");
  for (let i = 0; i < 10; i += 1) {
    const text = await screen.screen();
    if (item.test(text)) {
      const on = /enabled\s*$/i.test(text);
      if (on !== enabled) {
        await both();
      }
      break;
    }
    await right();
    if (i === 9) {
      throw new Error(`setting "${label}" not found`);
    }
  }
  // find Back and press it
  for (let i = 0; i < 10; i += 1) {
    if (/^back$/i.test(await screen.screen())) {
      await both();
      return;
    }
    await right();
  }
  throw new Error("settings Back entry not found");
}
// oxlint-enable eslint/no-await-in-loop

export type RunOutcome = {
  steps: Step[];
  screens: string[];
  result?: unknown;
  error?: RecordedError;
};

const HOME = /app is ready|app settings|app info|quit app/i;
// outcome pages ("Transaction rejected", "Message signed"…) dismiss themselves — just wait
const TRANSIENT = /rejected|signed|verified|denied/i;
// a review prompt is only dismissed from its Reject page; both-press on any other page is a
// no-op. Anchored: a content page whose payload merely contains the word (e.g. a message body)
// must be paged through, not confirmed.
const REJECT = /^reject|^deny|^cancel/i;
// the settings submenu's last item — pressing both exits to the home menu
const BACK = /^back\b/i;
// blocking notices ("Blind signing must be enabled in settings") have one page — press both
const NOTICE = /must be enabled|cannot be displayed|denied/i;

/** Dismiss any leftover prompt so the next case starts from the app's home/menu screen. */
// oxlint-disable eslint/no-await-in-loop -- prompt screens are paged one at a time
async function ensureHome(screen: Screen): Promise<void> {
  for (let i = 0; i < 24; i += 1) {
    const sc = await screen.screen();
    if (HOME.test(sc)) {
      return;
    }
    if (REJECT.test(sc) || BACK.test(sc) || NOTICE.test(sc)) {
      await screen.button("both", "press-and-release");
    } else if (!TRANSIENT.test(sc)) {
      // inside a review/sign prompt: step right towards the Reject page (it is the last
      // one and does not wrap) — the same motion walks a settings submenu to "Back"
      await screen.button("right", "press-and-release");
    }
    await sleep(400);
  }
  throw new Error(`app did not return to its home screen; last: ${await screen.screen()}`);
}
// oxlint-enable eslint/no-await-in-loop

/** Runs one case against the live device; captures commands, screens, result or error. */
export async function runCase(app: LedgerApp, caze: CaseDef): Promise<RunOutcome> {
  const screen = new Screen(app);
  await ensureHome(screen);
  if (caze.setting !== undefined) {
    await setSetting(screen, caze.setting.label, caze.setting.enabled);
  }
  const { exchange, steps } = recorder(app, undefined);
  try {
    const result = await caze.run(exchange, screen, caze);
    return { steps, screens: screen.texts, result };
  } catch (error) {
    // only device answers are recordable; harness/navigation failures must fail the test
    if (!(error instanceof LedgerError)) {
      throw error;
    }
    return { steps, screens: screen.texts, error: serializeError(error) };
  } finally {
    try {
      await ensureHome(screen);
    } catch {
      // cleanup is best-effort — the case outcome is already decided
    }
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Executes `def` against the live app. In verify mode the recorded transcript, result and screens
 * must all match byte for byte. Returns the outcome so callers can extend assertions (signature
 * oracles).
 */
export async function checkCase(
  app: LedgerApp,
  def: CaseDef,
  recorded: RecordedCase | undefined,
): Promise<RunOutcome> {
  if (!RECORD && recorded === undefined) {
    throw new Error(`no recorded case "${def.name}" — run LEDGER_RECORD=1 first`);
  }
  const outcome = await runCase(app, def);
  if (RECORD || recorded === undefined) {
    return outcome;
  }
  const steps = def.volatileSignature === true ? outcome.steps.map(maskYield) : outcome.steps;
  const recordedSteps =
    def.volatileSignature === true ? recorded.commands.map(maskYield) : recorded.commands;
  if (!same(steps, recordedSteps)) {
    throw new Error(
      `case "${def.name}" transcript drifted\nexpected: ${JSON.stringify(recorded.commands)}\ngot:      ${JSON.stringify(outcome.steps)}`,
    );
  }
  if (recorded.error !== undefined) {
    if (!same(outcome.error, recorded.error)) {
      throw new Error(
        `case "${def.name}" error drifted: expected ${JSON.stringify(recorded.error)}, got ${JSON.stringify(outcome.error)}`,
      );
    }
  } else if (
    outcome.error !== undefined ||
    !same(
      def.volatileSignature === true ? maskSig(outcome.result) : outcome.result,
      def.volatileSignature === true ? maskSig(recorded.result) : recorded.result,
    )
  ) {
    throw new Error(
      `case "${def.name}" result drifted: expected ${JSON.stringify(recorded.result)}, got ${JSON.stringify(outcome.result ?? outcome.error)}`,
    );
  }
  return outcome;
}

/** `approve()` then await the exchange — for flows whose last screen is the approve label. */
export async function approveThen<T>(job: Promise<T>, screen: Screen, match: RegExp): Promise<T> {
  await screen.approve(match, { maxSteps: 40 });
  return job;
}
