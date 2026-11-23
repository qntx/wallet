/**
 * Message framing against the vector file's `reports` (protocol V1) and `ble` splits (the
 * device→host stream, chunked two ways), plus hostile frames for every rejection in decodeMessage
 * and encodeMessage.
 */
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { OneKeyError } from "../src/modules/onekey/protocol/errors.ts";
import {
  decodeMessage,
  encodeMessage,
  MAX_MESSAGE,
  REPORT_SIZE,
} from "../src/modules/onekey/protocol/frame.ts";
import { loadVectors } from "./helpers.ts";

const hex = hexToBytes;

type Vector = {
  name: string;
  type: number;
  encoded: string;
  reports: string[];
  ble: Record<"20" | "182", string[]>;
};

const vectors = (loadVectors("onekey/messages.json") as { messages: Vector[] }).messages;

function onekeyError(fn: () => unknown): OneKeyError | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof OneKeyError) {
      return error;
    }
    throw error;
  }
  return undefined;
}

const frame = (fn: () => unknown): OneKeyError => {
  const error = onekeyError(fn);
  if (error?.code !== "frame") {
    throw new Error(`expected frame, got ${error?.code ?? "no error"}`);
  }
  return error;
};

const join = (parts: string[]): Uint8Array => concatBytes(...parts.map(hex));

describe("encodeMessage", () => {
  it.each(vectors)("frames $name", (vector) => {
    const out = encodeMessage(vector.type, hex(vector.encoded));
    expect(bytesToHex(out)).toBe(vector.reports.join(""));
    expect(out.length % REPORT_SIZE).toBe(0);
  });

  it("rejects a payload over MAX_MESSAGE", () => {
    const error = onekeyError(() => encodeMessage(17, new Uint8Array(MAX_MESSAGE + 1)));
    expect(error?.code).toBe("invalid-input");
  });

  it("encodes the maximum payload into exactly 65 536 report bytes", () => {
    // 64 504 payload bytes fill 1 024 reports — the exchange byte cap.
    const out = encodeMessage(17, new Uint8Array(MAX_MESSAGE));
    expect(out).toHaveLength(65_536);
  });

  it("rejects a type id out of range", () => {
    expect(onekeyError(() => encodeMessage(0x1_00_00, new Uint8Array()))?.code).toBe(
      "invalid-input",
    );
    expect(onekeyError(() => encodeMessage(-1, new Uint8Array()))?.code).toBe("invalid-input");
  });
});

describe("decodeMessage", () => {
  it.each(vectors)("reassembles $name from reports", (vector) => {
    const message = decodeMessage(join(vector.reports));
    expect(message.type).toBe(vector.type);
    expect(bytesToHex(message.payload)).toBe(vector.encoded);
  });

  it.each(vectors)("reassembles $name from the BLE stream split at 20", (vector) => {
    const message = decodeMessage(join(vector.ble["20"]));
    expect(message.type).toBe(vector.type);
    expect(bytesToHex(message.payload)).toBe(vector.encoded);
  });

  it.each(vectors)("reassembles $name from the BLE stream split at 182", (vector) => {
    const message = decodeMessage(join(vector.ble["182"]));
    expect(message.type).toBe(vector.type);
    expect(bytesToHex(message.payload)).toBe(vector.encoded);
  });
});

describe("hostile frames", () => {
  it("rejects bad magic", () => {
    expect(frame(() => decodeMessage(hex("3f2324001100000000")))).toBeDefined();
    expect(frame(() => decodeMessage(hex("002323001100000000")))).toBeDefined();
  });

  it("rejects a length header over MAX_MESSAGE on the first bytes", () => {
    expect(frame(() => decodeMessage(hex("3f2323001100010001")))).toBeDefined();
    const ble = new Uint8Array(9 + MAX_MESSAGE + 1);
    ble.set(hex("3f2323001100010001"), 0);
    expect(frame(() => decodeMessage(ble))).toBeDefined();
  });

  it("rejects fewer than 9 bytes", () => {
    expect(frame(() => decodeMessage(hex("3f23230011000000")))).toBeDefined();
  });

  it("rejects a USB sequence that is not a whole number of reports", () => {
    // Declared length 56 needs two reports (128 bytes) or the 65-byte stream; 100 is neither.
    const data = new Uint8Array(100);
    data.set(hex("3f2323001100000038"), 0);
    expect(frame(() => decodeMessage(data))).toBeDefined();
    const extra = new Uint8Array(192);
    extra.set(hex("3f2323001100000038"), 0);
    extra[64] = 0x3f;
    extra[128] = 0x3f;
    expect(frame(() => decodeMessage(extra))).toBeDefined();
  });

  it("rejects a missing continuation magic byte", () => {
    // Length 56 forces a second report; its first byte is not 0x3f.
    const data = new Uint8Array(128);
    data.set(hex("3f2323001100000038"), 0);
    expect(frame(() => decodeMessage(data))).toBeDefined();
  });

  it("rejects non-zero padding after the payload", () => {
    const data = encodeMessage(17, hex("0801"));
    data[63] = 0x01;
    expect(frame(() => decodeMessage(data))).toBeDefined();
  });

  it("rejects a BLE stream with one extra byte", () => {
    expect(frame(() => decodeMessage(hex("3f2323001100000002080100")))).toBeDefined();
  });

  it("accepts a single-report message whose BLE and USB forms coincide", () => {
    const payload = new Uint8Array(55).fill(0x41);
    const encoded = encodeMessage(26, payload);
    expect(encoded).toHaveLength(REPORT_SIZE);
    const message = decodeMessage(encoded);
    expect(message.type).toBe(26);
    expect(message.payload).toStrictEqual(payload);
  });
});
