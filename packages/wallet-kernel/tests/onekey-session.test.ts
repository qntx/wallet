/**
 * The call driver against scripted exchanges: every interaction round, every Failure mapping, the
 * round cap, and the leak invariant — nothing the client writes may carry a PIN matrix answer or
 * passphrase text, and error messages never echo device text.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { OneKeyError } from "../src/modules/onekey/protocol/errors.ts";
import type { OneKeyErrorCode } from "../src/modules/onekey/protocol/errors.ts";
import { decodeMessage, encodeMessage } from "../src/modules/onekey/protocol/frame.ts";
import {
  BixinPinInputOnDevice,
  ButtonAck,
  ButtonRequest,
  Failure,
  Features,
  GetFeatures,
  Initialize,
  PassphraseAck,
  PassphraseRequest,
  PinMatrixRequest,
  Success,
} from "../src/modules/onekey/protocol/messages.ts";
import { decode, encode } from "../src/modules/onekey/protocol/proto.ts";
import type { Decoded, Fields, MessageDef } from "../src/modules/onekey/protocol/proto.ts";
import { call } from "../src/modules/onekey/protocol/session.ts";
import type { Exchange } from "../src/modules/onekey/protocol/session.ts";

const hex = hexToBytes;

const FEATURES = {
  majorVersion: 3,
  minorVersion: 21,
  patchVersion: 0,
  initialized: true,
  onekeyDeviceType: 1,
  onekeyFirmwareVersion: "3.21.0",
};

/** A device that serves queued encoded-message responses and records what it was sent. */
function scripted(responses: Uint8Array[]): { exchange: Exchange; writes: Uint8Array[] } {
  const writes: Uint8Array[] = [];
  const exchange = async (data: Uint8Array): Promise<Uint8Array> => {
    writes.push(new Uint8Array(data));
    const next = responses.shift();
    if (next === undefined) {
      return Promise.reject(new Error("scripted device ran out of responses"));
    }
    return Promise.resolve(next);
  };
  return { exchange, writes };
}

/** The i-th write, or a hard failure — keeps `??` out of test bodies. */
function written(writes: Uint8Array[], index: number): Uint8Array {
  const bytes = writes[index];
  if (bytes === undefined) {
    throw new Error(`expected write ${index}`);
  }
  return bytes;
}

/** Encodes a full exchange message (reports) the way a device sends it. */
function reply<F extends Fields>(def: MessageDef<F>, value: Decoded<F>): Uint8Array {
  return encodeMessage(def.typeId, encode(def, value));
}

async function callError(fn: () => Promise<unknown>): Promise<OneKeyError> {
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

const getFeatures = { def: GetFeatures, value: {} };
const initialize = { def: Initialize, value: {} };

describe("call", () => {
  it("returns the expected message", async () => {
    const { exchange, writes } = scripted([reply(Features, FEATURES)]);
    const features = await call(exchange, initialize, Features);
    expect(features.onekeyDeviceType).toBe(1);
    expect(writes).toHaveLength(1);
    expect(decodeMessage(written(writes, 0)).type).toBe(Initialize.typeId);
  });

  it("accepts a list of expected types", async () => {
    const { exchange } = scripted([reply(Success, { message: "ok" })]);
    const result = await call(exchange, getFeatures, [Features, Success]);
    expect(result).toStrictEqual({ message: "ok" });
  });

  it("acks a ButtonRequest and continues", async () => {
    const { exchange, writes } = scripted([
      reply(ButtonRequest, { code: 8, pages: 3 }),
      reply(Features, FEATURES),
    ]);
    await call(exchange, initialize, Features);
    expect(writes).toHaveLength(2);
    expect(decodeMessage(written(writes, 1)).type).toBe(ButtonAck.typeId);
  });

  it("answers a Current PinMatrixRequest with BixinPinInputOnDevice", async () => {
    const { exchange, writes } = scripted([
      reply(PinMatrixRequest, { type: 1 }),
      reply(Features, FEATURES),
    ]);
    await call(exchange, initialize, Features);
    expect(decodeMessage(written(writes, 1)).type).toBe(BixinPinInputOnDevice.typeId);
  });

  it("answers a typeless PinMatrixRequest the same way", async () => {
    const { exchange, writes } = scripted([reply(PinMatrixRequest, {}), reply(Features, FEATURES)]);
    await call(exchange, initialize, Features);
    expect(decodeMessage(written(writes, 1)).type).toBe(BixinPinInputOnDevice.typeId);
  });

  it("rejects a non-Current PinMatrixRequest", async () => {
    const { exchange, writes } = scripted([reply(PinMatrixRequest, { type: 2 })]);
    const error = await callError(async () => call(exchange, initialize, Features));
    expect(error.code).toBe("device-fault");
    expect(writes).toHaveLength(1);
  });

  it("answers a PassphraseRequest with onDevice only", async () => {
    const { exchange, writes } = scripted([
      reply(PassphraseRequest, {}),
      reply(Features, FEATURES),
    ]);
    await call(exchange, initialize, Features);
    const ack = decodeMessage(written(writes, 1));
    expect(ack.type).toBe(PassphraseAck.typeId);
    // Exactly { onDevice: true } — field 3 varint 1, and no other bytes.
    expect(bytesToHex(ack.payload)).toBe("1801");
    expect(decode(PassphraseAck, ack.payload)).toStrictEqual({ onDevice: true });
  });

  it("rejects an attach-pin PassphraseRequest", async () => {
    const { exchange, writes } = scripted([
      reply(PassphraseRequest, { existsAttachPinUser: true }),
    ]);
    const error = await callError(async () => call(exchange, initialize, Features));
    expect(error.code).toBe("device-fault");
    expect(writes).toHaveLength(1);
  });

  it("fails after 256 interaction rounds", async () => {
    const responses = Array.from({ length: 300 }, () => reply(ButtonRequest, { code: 8 }));
    const { exchange, writes } = scripted(responses);
    const error = await callError(async () => call(exchange, initialize, Features));
    expect(error.code).toBe("device-fault");
    expect(writes).toHaveLength(1 + 256);
  });

  it("rejects an unexpected message type", async () => {
    const { exchange } = scripted([reply(Success, { message: "ok" })]);
    const error = await callError(async () => call(exchange, initialize, Features));
    expect(error.code).toBe("device-fault");
  });

  it("rejects a malformed interaction message", async () => {
    const { exchange } = scripted([encodeMessage(ButtonRequest.typeId, hex("0a05"))]);
    const error = await callError(async () => call(exchange, initialize, Features));
    expect(error.code).toBe("device-fault");
  });

  it("rejects a malformed first frame as a frame error", async () => {
    const { exchange } = scripted([hex("0000")]);
    const error = await callError(async () => call(exchange, initialize, Features));
    expect(error.code).toBe("frame");
  });

  it("rejects an unencodable request before writing", async () => {
    const calls: Uint8Array[] = [];
    const exchange: Exchange = async (data) => {
      calls.push(data);
      return Promise.resolve(new Uint8Array());
    };
    const error = await callError(async () =>
      call(exchange, { def: ButtonRequest, value: { pages: -1 } }, Features),
    );
    expect(error.code).toBe("invalid-input");
    expect(calls).toHaveLength(0);
  });
});

describe("failure mapping", () => {
  const codes: Array<{ failure: Decoded<typeof Failure.fields>; expected: OneKeyErrorCode }> = [
    { failure: { code: 4 }, expected: "user-rejected" },
    { failure: { code: 6 }, expected: "user-rejected" },
    { failure: { code: 7 }, expected: "pin-invalid" },
    { failure: { code: 11 }, expected: "not-initialized" },
    { failure: { code: 5 }, expected: "device-locked" },
    { failure: { code: 99 }, expected: "device-error" },
    { failure: { code: 1 }, expected: "device-error" },
    { failure: {}, expected: "device-error" },
  ];

  it.each(codes)("maps Failure $failure.code to $expected", async ({ failure, expected }) => {
    const { exchange } = scripted([reply(Failure, failure)]);
    const error = await callError(async () => call(exchange, initialize, Features));
    expect(error.code).toBe(expected);
    expect(error.failure).toBe(failure.code);
  });

  it("never echoes the device's message text", async () => {
    const { exchange } = scripted([reply(Failure, { code: 4, message: "DEVICE-TEXT-7f2a" })]);
    const error = await callError(async () => call(exchange, initialize, Features));
    expect(error.message).not.toContain("DEVICE-TEXT-7f2a");
  });
});

describe("write leak check", () => {
  const ALLOWED = new Set([
    Initialize.typeId,
    GetFeatures.typeId,
    ButtonAck.typeId,
    BixinPinInputOnDevice.typeId,
    PassphraseAck.typeId,
  ]);

  async function collectWrites(responses: Uint8Array[]): Promise<Uint8Array[]> {
    const { exchange, writes } = scripted(responses);
    try {
      await call(exchange, initialize, [Features, Success]);
    } catch {
      // The scripted flow may end in an error; the writes are what matters.
    }
    return writes;
  }

  it("writes only request, ButtonAck, BixinPinInputOnDevice and PassphraseAck types", async () => {
    const all = [
      ...(await collectWrites([
        reply(ButtonRequest, { code: 8 }),
        reply(PinMatrixRequest, { type: 1 }),
        reply(PassphraseRequest, {}),
        reply(Features, FEATURES),
      ])),
      ...(await collectWrites([reply(Features, FEATURES)])),
    ];
    for (const write of all) {
      const { type } = decodeMessage(write);
      expect(ALLOWED.has(type)).toBe(true);
      expect(type).not.toBe(19); // PinMatrixAck, never
    }
  });
});
