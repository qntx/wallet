/**
 * OneKey Protocol-V1 transport — the host contract for `device: "onekey"` operations. Every
 * `message` exchange carries one framed command in `request.data` and the device answers one framed
 * message back; the kernel owns the protobuf layer, the host only moves bytes.
 *
 * USB: both directions travel in 64-byte HID reports. The first report carries a 9-byte header —
 * `3f 23 23`, BE u16 message type, BE u32 payload length — and 55 payload bytes; every continuation
 * report starts with `3f` and carries 63. Write `request.data` report by report; to read an answer,
 * collect reports until `oneKeyAnswerLength(firstReport, "usb")` bytes have arrived and hand the
 * whole sequence back. The firmware may leave stale bytes in the final report's padding — only the
 * declared payload is meaningful, and the kernel reads only that.
 *
 * BLE: GATT service `00000001-0000-1000-8000-00805f9b34fb`, write characteristic
 * `00000002-0000-1000-8000-00805f9b34fb`, notify characteristic
 * `00000003-0000-1000-8000-00805f9b34fb`. Write `request.data` — the same 64-byte report sequence;
 * the BLE chip counts reports, not write calls — split into writes at or below the negotiated MTU.
 * The answer arrives as notifications of up to MTU bytes forming one stream: `3f 23 23` + type +
 * length + exactly `length` payload bytes (the chip strips the USB continuation markers), so
 * concatenate notifications until `oneKeyAnswerLength(first, "ble")`.
 *
 * `oneKeyAnswerLength` returns the total byte count to collect for one device answer from its first
 * chunk — USB report count times 64, or the BLE header-plus-payload size — and throws on a chunk
 * that is not a OneKey frame. Exported for tests; the exchange helpers below cover it.
 */
import type { DeviceIo, DeviceRequest, DeviceResponse } from "../protocol/hardware.ts";
import { WalletError } from "../types.ts";
import type { BlePort, HidPort } from "./ports.ts";

const REPORT_SIZE = 64;

const input = (message: string): WalletError => new WalletError("invalid-input", message);

export const oneKeyAnswerLength = (firstChunk: Uint8Array, transport: "usb" | "ble"): number => {
  if (
    firstChunk.length < 9 ||
    firstChunk[0] !== 0x3f ||
    firstChunk[1] !== 0x23 ||
    firstChunk[2] !== 0x23
  ) {
    throw input("the device answer does not start with the OneKey header");
  }
  const length = new DataView(
    firstChunk.buffer,
    firstChunk.byteOffset,
    firstChunk.length,
  ).getUint32(5);
  return transport === "usb" ? 64 * Math.max(1, Math.ceil((8 + length) / 63)) : 9 + length;
};

/** Reads `port` until `answerLength(first chunk)` bytes have arrived; returns the whole sequence. */
const collect = async (port: HidPort | BlePort, transport: "usb" | "ble"): Promise<Uint8Array> => {
  const first = await port.read();
  const total = oneKeyAnswerLength(first, transport);
  const chunks = [first];
  let collected = first.length;
  while (collected < total) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one chunk per transport read
    const chunk = await port.read();
    chunks.push(chunk);
    collected += chunk.length;
  }
  const data = new Uint8Array(collected);
  let at = 0;
  for (const chunk of chunks) {
    data.set(chunk, at);
    at += chunk.length;
  }
  return data;
};

/**
 * One framed command exchange over USB HID: writes `data` report by report, then collects the whole
 * report sequence of the answer. One call at a time — an interleaved call while a previous one is
 * in flight is `invalid-input`.
 */
export function oneKeyHidExchange(port: HidPort): (data: Uint8Array) => Promise<Uint8Array> {
  let inFlight = false;
  return async (data) => {
    if (inFlight) {
      throw input("exchange is already in flight on this link");
    }
    if (data.length === 0 || data.length % REPORT_SIZE !== 0) {
      throw input("the request is not a whole number of 64-byte HID reports");
    }
    inFlight = true;
    try {
      for (let at = 0; at < data.length; at += REPORT_SIZE) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- reports are ordered on one link
        await port.write(data.subarray(at, at + REPORT_SIZE));
      }
      return await collect(port, "usb");
    } finally {
      inFlight = false;
    }
  };
}

/**
 * The same exchange over BLE: `data` — the same 64-byte report sequence — is split into writes of
 * at most `mtu` bytes (the chip counts reports, not write calls), and the answer is the
 * concatenated notification stream. One call at a time — interleaving is `invalid-input`.
 */
export function oneKeyBleExchange(
  port: BlePort,
  mtu: number,
): (data: Uint8Array) => Promise<Uint8Array> {
  if (!Number.isSafeInteger(mtu) || mtu < 1) {
    throw input("BLE MTU is not a positive integer");
  }
  let inFlight = false;
  return async (data) => {
    if (inFlight) {
      throw input("exchange is already in flight on this link");
    }
    if (data.length === 0) {
      throw input("the request is empty");
    }
    inFlight = true;
    try {
      for (let at = 0; at < data.length; at += mtu) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- writes are ordered on one link
        await port.write(data.subarray(at, at + mtu));
      }
      return await collect(port, "ble");
    } finally {
      inFlight = false;
    }
  };
}

/**
 * A `DeviceIo` backed by a framed exchange: `message` requests are written verbatim, any other
 * request kind is `unsupported` — a OneKey device cannot take a QR or compare exchange.
 */
export function oneKeyIo(exchange: (data: Uint8Array) => Promise<Uint8Array>): DeviceIo {
  return {
    exchange: async (request: DeviceRequest): Promise<DeviceResponse> => {
      if (request.kind !== "message") {
        throw new WalletError("unsupported", "the onekey transport only carries framed messages");
      }
      return { kind: "message", data: await exchange(request.data) };
    },
  };
}
