/**
 * Shared harness pieces for the emulator recordings and the replay test: the test-only LoadDevice
 * descriptor (seed loading is a debug-build facility, not part of the client), the transcript
 * shape, and the replay Exchange that asserts requests and serves recorded responses.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { defineMessage } from "../../src/modules/signers/onekey/protocol/proto.ts";
import type { MessageDef } from "../../src/modules/signers/onekey/protocol/proto.ts";
import type { Exchange } from "../../src/modules/signers/onekey/protocol/session.ts";

export { debugYes, udpExchange } from "./udp.ts";

type Field<K extends string, N extends number, R extends string> = {
  readonly no: N;
  readonly kind: K;
  readonly rule: R;
};

// firmware-pro/classic1s common/protob/messages-management.proto LoadDevice — identical in both
// schemas; only the fields the seed-loading flow sets are declared.
export type LoadDeviceFields = {
  mnemonics: Field<"string", 1, "repeated">;
  pin: Field<"string", 3, "optional">;
  passphraseProtection: Field<"bool", 4, "optional">;
  label: Field<"string", 6, "optional">;
  skipChecksum: Field<"bool", 7, "optional">;
};
export const LoadDevice: MessageDef<LoadDeviceFields> = defineMessage(13, {
  mnemonics: { no: 1, kind: "string", rule: "repeated" },
  pin: { no: 3, kind: "string", rule: "optional" },
  passphraseProtection: { no: 4, kind: "bool", rule: "optional" },
  label: { no: 6, kind: "string", rule: "optional" },
  skipChecksum: { no: 7, kind: "bool", rule: "optional" },
});

// firmware-pro/classic1s common/protob/messages-common.proto Success — used only by tests (the
// device answers it to LoadDevice and other management calls the client itself never sends).
export type SuccessFields = { message: Field<"string", 1, "optional"> };
export const Success: MessageDef<SuccessFields> = defineMessage(2, {
  message: { no: 1, kind: "string", rule: "optional" },
});

export const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

export type TranscriptExchange = { readonly request: string; readonly response: string };
export type TranscriptSession = {
  readonly name: string;
  readonly exchanges: ReadonlyArray<TranscriptExchange>;
};
export type Transcript = {
  readonly source: Record<string, unknown>;
  readonly sessions: ReadonlyArray<TranscriptSession>;
};

/**
 * The emulator transcript for `model` from ONEKEY_TRANSCRIPTS when set (CI's fresh recordings),
 * otherwise the committed vectors/onekey directory.
 */
export function loadTranscript(model: "classic1s" | "pro"): Transcript {
  const dir = process.env["ONEKEY_TRANSCRIPTS"];
  const path =
    dir === undefined || dir === ""
      ? join(import.meta.dirname, `../../../../vectors/onekey/emulator-${model}.json`)
      : join(dir, `emulator-${model}.json`);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JSON transcript is untyped
  return JSON.parse(readFileSync(path, "utf8")) as Transcript;
}

export function transcriptSession(transcript: Transcript, name: string): TranscriptSession {
  const session = transcript.sessions.find((s) => s.name === name);
  if (session === undefined) {
    throw new Error(`transcript has no session ${name}`);
  }
  return session;
}

/**
 * An Exchange that replays a recorded session: every request must equal the recorded one (otherwise
 * the replay has diverged from the real device conversation) and the recorded response is
 * returned.
 */
export function replayExchange(session: TranscriptSession): Exchange {
  let at = 0;
  return async (data) => {
    // Yield so callers observe exchanges asynchronously like a real transport.
    await Promise.resolve();
    const step = session.exchanges[at];
    at += 1;
    if (step === undefined) {
      throw new Error("replay ran past the recorded session");
    }
    const sent = bytesToHex(data);
    if (sent !== step.request) {
      throw new Error(`replay request ${at} diverged: sent ${sent}, recorded ${step.request}`);
    }
    return hexToBytes(step.response);
  };
}
