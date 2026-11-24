/**
 * Card-surfaces probe: answers each JSON message with exactly one post so the
 * page's send() calls resolve FIFO. Access-code and short-ID bytes are
 * compared against the fixture inside the kernel and wiped — only `match` and
 * `length` leave. Tap prompts and labels are built here; the main runtime
 * supplies nothing but the command name.
 */

import { bindNativeCardReader } from "../../../packages/wallet-native/kernel/card.ts";
import { bindNativeSecureInput } from "../../../packages/wallet-native/kernel/secure-input.ts";

import {
  ACCESS_CODE,
  ACCESS_CODE_LABEL,
  DEVICE_TAP_PROMPT,
  ECHO_APDUS,
  SELECT_AID_APDU,
  SESSION_APPROVAL_CODE,
  SESSION_APPROVAL_LABEL,
  SHORT_ID_LABEL,
  SHORT_ID_NORMALIZED,
  TAG_LOST_APDU,
  TAP_PROMPT,
} from "./card-surfaces-fixture.ts";
import { postJson, utf8Encode } from "./share.ts";

const reader = bindNativeCardReader(__qntx.cardReader);
const input = bindNativeSecureInput(__qntx.secureInput);

type Command = {
  readonly cmd: string;
  readonly kind?: string;
  readonly scenario?: string;
};

type Step = {
  readonly step: string;
  readonly ms: number;
  readonly ok: boolean;
  readonly failure?: string;
  readonly len?: number;
  readonly sw?: string;
};

const hex = (byte: number): string => byte.toString(16).padStart(2, "0");

// A transmit's record: response length and SW1SW2 only — the data stays here.
const txStep = async (
  name: string,
  apdu: Uint8Array,
): Promise<{ step: Step; ok: boolean }> => {
  const t0 = __qntx.elapsed();
  const result = await reader.transmit(apdu);
  const ms = Math.round((__qntx.elapsed() - t0) * 100) / 100;
  if (result.ok) {
    const v = result.value;
    const sw = v.length >= 2 ? hex(v[v.length - 2]!) + hex(v[v.length - 1]!) : undefined;
    return {
      step: sw === undefined
        ? { step: name, ms, ok: true, len: v.length }
        : { step: name, ms, ok: true, len: v.length, sw },
      ok: true,
    };
  }
  return { step: { step: name, ms, ok: false, failure: result.failure }, ok: false };
};

const openStep = async (prompt: string): Promise<{ step: Step; ok: boolean }> => {
  const t0 = __qntx.elapsed();
  const opened = await reader.open(prompt);
  const ms = Math.round((__qntx.elapsed() - t0) * 100) / 100;
  if (opened.ok) {
    return { step: { step: "open", ms, ok: true }, ok: true };
  }
  return { step: { step: "open", ms, ok: false, failure: opened.failure }, ok: false };
};

const runTap = async (scenario: string): Promise<void> => {
  const steps: Step[] = [];
  const opened = await openStep(TAP_PROMPT);
  steps.push(opened.step);
  if (opened.ok && scenario === "ok") {
    for (const [index, apdu] of [SELECT_AID_APDU, ...ECHO_APDUS].entries()) {
      steps.push((await txStep(`tx${index}`, apdu)).step);
    }
    reader.close("success", "Signed");
    steps.push({ step: "close", ms: 0, ok: true });
  } else if (opened.ok && scenario === "lost") {
    steps.push((await txStep("tx0", TAG_LOST_APDU)).step);
    // The session ended above: this must fail without reaching the platform.
    steps.push((await txStep("tx1", ECHO_APDUS[0]!)).step);
    reader.close("failure", "");
    steps.push({ step: "close", ms: 0, ok: true });
  } else if (opened.ok) {
    reader.close("failure", "");
    steps.push({ step: "close", ms: 0, ok: true });
  }
  postJson({ tap: scenario, steps });
};

const runDeviceTap = async (): Promise<void> => {
  const t0 = __qntx.elapsed();
  const opened = await reader.open(DEVICE_TAP_PROMPT);
  const ms = Math.round((__qntx.elapsed() - t0) * 100) / 100;
  reader.close("failure", "");
  postJson(
    opened.ok
      ? { deviceTap: { open: "ok" }, ms }
      : { deviceTap: { open: opened.failure, detail: opened.detail }, ms },
  );
};

const INPUT_KINDS = {
  "access-code": { label: ACCESS_CODE_LABEL, expected: () => utf8Encode(ACCESS_CODE) },
  "short-id": { label: SHORT_ID_LABEL, expected: () => utf8Encode(SHORT_ID_NORMALIZED) },
  "session-approval": {
    label: SESSION_APPROVAL_LABEL,
    expected: () => utf8Encode(SESSION_APPROVAL_CODE),
  },
} as const;

type InputKind = keyof typeof INPUT_KINDS;

const runInput = async (kind: InputKind): Promise<void> => {
  const { label, expected } = INPUT_KINDS[kind];
  const result = await input.request(kind, label);
  if (!result.ok) {
    postJson({ input: result.failure, kind });
    return;
  }
  const want = expected();
  const value = result.value;
  const match = value.length === want.length && value.every((byte, i) => byte === want[i]);
  value.fill(0);
  postJson({ input: "ok", kind, match });
};

let pendingInput: Promise<void> | undefined;

const onMessage = (message: ArrayBuffer): void => {
  const cmd = JSON.parse(new TextDecoder().decode(message)) as Command;
  if (cmd.cmd === "input" && typeof cmd.kind === "string" && cmd.kind in INPUT_KINDS) {
    pendingInput = runInput(cmd.kind as InputKind);
    return;
  }
  if (cmd.cmd === "cancel-input") {
    void (async () => {
      input.cancel();
      // The cancelled request's own reply must post before this one — the
      // page's two sends resolve FIFO in that order.
      await pendingInput;
      postJson({ cancelled: true });
    })();
    return;
  }
  if (cmd.cmd === "tap" && typeof cmd.scenario === "string") {
    void runTap(cmd.scenario);
    return;
  }
  if (cmd.cmd === "device-tap") {
    void runDeviceTap();
    return;
  }
  postJson({ error: "unknown command" });
};

__qntx.frames.onMessage(onMessage);
postJson({ cmd: "ready" });
