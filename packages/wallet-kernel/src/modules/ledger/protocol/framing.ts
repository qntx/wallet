/**
 * HID and BLE transport framing, ported from the vendor's implementation (Apache-2.0,
 * refs/ledgerjs-npm/devices-8.4.4/src/hid-framing.ts and ble/{sendAPDU,receiveAPDU}.ts).
 *
 * HID: fixed 64-byte reports `channel(2, BE) ‖ tag 0x05 ‖ seq(2, BE) ‖ [len(2, BE) on frame 0] ‖
 * data`, last frame zero padded. BLE: same layout without the channel, no padding, frames ≤ MTU;
 * the MTU is negotiated once with `08 00 00 00 00`, the reply carries the size at byte 5
 * (ledgerjs-npm/device-transport-kit-web-ble WebBleApduSender._handleMtuNegotiationFrame).
 *
 * Reassembly is a small state machine: channel/tag/sequence checked in order, the announced length
 * must be ≥ 2 (a response always carries a status word), data beyond the announced length is a
 * violation, and any frame after completion is a violation — all `transport`.
 */
import { input } from "./bytes.ts";
import { LedgerError } from "./errors.ts";

export const HID_REPORT_SIZE = 64;

const APDU_TAG = 0x05;
const MTU_TAG = 0x08;

const transport = (message: string): LedgerError => new LedgerError("transport", message);

/** `push` returns the complete response once; a push after completion is `transport`. */
export type Assembler = {
  push: (frame: Uint8Array) => Uint8Array | undefined;
};

const checkApdu = (apdu: Uint8Array): void => {
  // 5 header bytes + up to 255 data bytes (encodeCommand bounds).
  if (apdu.length < 5 || apdu.length > 260) {
    throw input("APDU is not 5..260 bytes");
  }
};

/** `channel(2) ‖ 05 ‖ seq(2) ‖ [len(2) on frame 0] ‖ data`, zero padded to 64. */
export function hidFrames(apdu: Uint8Array, channel: number): Uint8Array[] {
  checkApdu(apdu);
  if (!Number.isSafeInteger(channel) || channel < 0 || channel > 0xffff) {
    throw input("HID channel is not a u16");
  }
  const data = new Uint8Array(2 + apdu.length);
  new DataView(data.buffer).setUint16(0, apdu.length);
  data.set(apdu, 2);

  const blockSize = HID_REPORT_SIZE - 5;
  const frames: Uint8Array[] = [];
  for (let seq = 0; seq * blockSize < data.length; seq += 1) {
    const frame = new Uint8Array(HID_REPORT_SIZE);
    const head = new DataView(frame.buffer);
    head.setUint16(0, channel);
    head.setUint8(2, APDU_TAG);
    head.setUint16(3, seq);
    frame.set(data.subarray(seq * blockSize, (seq + 1) * blockSize), 5);
    frames.push(frame);
  }
  return frames;
}

/** Reassembles one HID response; every violation is `transport`. */
export function hidAssembler(channel: number): Assembler {
  let sequence = 0;
  let announced = 0;
  let received = 0;
  let data = new Uint8Array(0);
  let done = false;
  return {
    push(frame: Uint8Array): Uint8Array | undefined {
      if (done) {
        throw transport("frame received after the response completed");
      }
      if (frame.length !== HID_REPORT_SIZE) {
        throw transport("HID frame is not 64 bytes");
      }
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      if (view.getUint16(0) !== channel) {
        throw transport("HID frame on the wrong channel");
      }
      if (view.getUint8(2) !== APDU_TAG) {
        throw transport("HID frame carries a foreign tag");
      }
      if (view.getUint16(3) !== sequence) {
        throw transport("HID frame out of sequence");
      }
      if (sequence === 0) {
        announced = view.getUint16(5);
        if (announced < 2) {
          throw transport("announced response length is shorter than a status word");
        }
        data = new Uint8Array(announced);
        received = Math.min(announced, frame.length - 7);
        data.set(frame.subarray(7, 7 + received));
      } else {
        const take = Math.min(announced - received, frame.length - 5);
        data.set(frame.subarray(5, 5 + take), received);
        received += take;
      }
      sequence += 1;
      if (received === announced) {
        done = true;
        return data;
      }
      return undefined;
    },
  };
}

/** The BLE MTU negotiation request (device replies with the frame size at byte 5). */
export const BLE_MTU_REQUEST: Uint8Array = Uint8Array.of(0x08, 0x00, 0x00, 0x00, 0x00);

export function bleMtu(frame: Uint8Array): number {
  if (frame.length < 6 || frame[0] !== MTU_TAG) {
    throw transport("not an MTU negotiation frame");
  }
  const { 5: mtu } = frame;
  if (mtu === undefined || mtu < 6) {
    throw transport("negotiated MTU is not usable");
  }
  return mtu;
}

/** `05 ‖ seq(2) ‖ [len(2) on frame 0] ‖ data`, frames ≤ mtu, no padding. */
export function bleFrames(apdu: Uint8Array, mtu: number): Uint8Array[] {
  checkApdu(apdu);
  if (!Number.isSafeInteger(mtu) || mtu < 6 || mtu > 0xff) {
    throw input("BLE MTU is not 6..255");
  }
  const frames: Uint8Array[] = [];
  for (let seq = 0, offset = 0; offset < apdu.length; seq += 1) {
    const head = seq === 0 ? 5 : 3;
    const take = Math.min(apdu.length - offset, mtu - head);
    const frame = new Uint8Array(head + take);
    const view = new DataView(frame.buffer);
    view.setUint8(0, APDU_TAG);
    view.setUint16(1, seq);
    if (seq === 0) {
      view.setUint16(3, apdu.length);
    }
    frame.set(apdu.subarray(offset, offset + take), head);
    frames.push(frame);
    offset += take;
  }
  return frames;
}

/** Reassembles one BLE response; every violation is `transport`. */
export function bleAssembler(mtu: number): Assembler {
  if (!Number.isSafeInteger(mtu) || mtu < 6 || mtu > 0xff) {
    throw input("BLE MTU is not 6..255");
  }
  let sequence = 0;
  let announced = 0;
  let received = 0;
  let chunks: Uint8Array[] = [];
  let done = false;
  return {
    push(frame: Uint8Array): Uint8Array | undefined {
      if (done) {
        throw transport("frame received after the response completed");
      }
      if (frame.length > mtu) {
        throw transport("BLE frame exceeds the negotiated MTU");
      }
      if (frame[0] !== APDU_TAG) {
        throw transport("BLE frame carries a foreign tag");
      }
      if (frame.length < 3) {
        throw transport("BLE frame is too short for the sequence header");
      }
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      if (view.getUint16(1) !== sequence) {
        throw transport("BLE frame out of sequence");
      }
      let chunk = frame.subarray(3);
      if (sequence === 0) {
        if (chunk.length < 2) {
          throw transport("first BLE frame is too short for the announced length");
        }
        announced = view.getUint16(3);
        chunk = chunk.subarray(2);
      }
      sequence += 1;
      if (received + chunk.length > announced) {
        throw transport("BLE data exceeds the announced response length");
      }
      chunks.push(chunk);
      received += chunk.length;
      if (received === announced) {
        done = true;
        const out = new Uint8Array(announced);
        let offset = 0;
        for (const part of chunks) {
          out.set(part, offset);
          offset += part.length;
        }
        chunks = [];
        return out;
      }
      return undefined;
    },
  };
}
