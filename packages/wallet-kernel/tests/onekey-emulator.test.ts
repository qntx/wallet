/**
 * Offline replay of the live Classic 1S emulator recording (vectors/onekey/emulator-classic1s.json,
 * produced by scripts/vectors/onekey-emulator.ts against a v3.21.0 debug build): the replay
 * exchange asserts the client writes byte-identical requests and serves the recorded answers.
 */
import { describe, expect, it } from "vite-plus/test";

import { initialize } from "../src/modules/onekey/protocol/device.ts";
import { OneKeyError } from "../src/modules/onekey/protocol/errors.ts";
import { Success } from "../src/modules/onekey/protocol/messages.ts";
import { call } from "../src/modules/onekey/protocol/session.ts";
import type { Exchange } from "../src/modules/onekey/protocol/session.ts";
import { loadVectors } from "./helpers.ts";
import {
  LoadDevice,
  TEST_MNEMONIC,
  replayExchange,
  transcriptSession,
} from "./onekey-emulator/index.ts";
import type { Transcript } from "./onekey-emulator/index.ts";

const transcript = loadVectors("onekey/emulator-classic1s.json") as Transcript;

function session(name: string): Exchange {
  return replayExchange(transcriptSession(transcript, name));
}

async function thrown(fn: () => Promise<unknown>): Promise<OneKeyError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof OneKeyError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to throw");
}

describe("classic1s emulator replay", () => {
  it("fresh device initialize is not-initialized", async () => {
    const error = await thrown(async () => initialize(session("uninitialized")));
    expect(error.code).toBe("not-initialized");
  });

  it("replays LoadDevice with the button confirm round", async () => {
    const success = await call(
      session("load-device"),
      { def: LoadDevice, value: { mnemonics: [TEST_MNEMONIC], label: "OneKey" } },
      Success,
    );
    expect(success.message).toBe("Device loaded");
  });

  it("initialize returns the loaded classic1s DeviceInfo", async () => {
    const info = await initialize(session("initialized"));
    expect(info.model).toBe("classic1s");
    expect(info.firmware).toStrictEqual([3, 21, 0]);
    expect(info.pinProtection).toBe(false);
    expect(info.passphraseProtection).toBe(false);
    expect(info.unlocked).toBe(true);
    expect(info.bitcoinOnly).toBe(false);
    expect(info.deviceId).toBe("0D8A8E040824F2BDC7F7DDE0");
    expect(info.sessionId).toHaveLength(32);
  });
});
