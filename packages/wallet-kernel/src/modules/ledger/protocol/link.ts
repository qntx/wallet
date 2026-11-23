/**
 * Turns byte-oriented host ports into the `Exchange` primitive: each call sends one APDU as a
 * framed write sequence and reassembles the framed response. One link carries one exchange at a
 * time — a call made while a previous one is in flight is `invalid-input` (the speculos/ledger link
 * has no multiplexing, interleaved frames would corrupt both exchanges).
 */
import type { Exchange } from "./apdu.ts";
import { input } from "./bytes.ts";
import {
  bleAssembler,
  bleFrames,
  bleMtu,
  BLE_MTU_REQUEST,
  hidAssembler,
  hidFrames,
} from "./framing.ts";

export type HidPort = {
  write: (report: Uint8Array) => Promise<void>;
  read: () => Promise<Uint8Array>;
};

export type BlePort = {
  write: (frame: Uint8Array) => Promise<void>;
  read: () => Promise<Uint8Array>;
};

export function hidExchange(port: HidPort, channel: number): Exchange {
  if (!Number.isSafeInteger(channel) || channel < 0 || channel > 0xffff) {
    throw input("HID channel is not a u16");
  }
  let inFlight = false;
  return async (apdu) => {
    if (inFlight) {
      throw input("exchange is already in flight on this link");
    }
    inFlight = true;
    try {
      for (const frame of hidFrames(apdu, channel)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- frames are ordered on one link
        await port.write(frame);
      }
      const assemble = hidAssembler(channel);
      for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- response frames are ordered
        const complete = assemble.push(await port.read());
        if (complete !== undefined) {
          return complete;
        }
      }
    } finally {
      inFlight = false;
    }
  };
}

/** Negotiates the BLE MTU once, then returns the framed exchange. */
export async function bleExchange(port: BlePort): Promise<Exchange> {
  await port.write(BLE_MTU_REQUEST);
  const mtu = bleMtu(await port.read());
  let inFlight = false;
  return async (apdu) => {
    if (inFlight) {
      throw input("exchange is already in flight on this link");
    }
    inFlight = true;
    try {
      for (const frame of bleFrames(apdu, mtu)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- frames are ordered on one link
        await port.write(frame);
      }
      const assemble = bleAssembler(mtu);
      for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- response frames are ordered
        const complete = assemble.push(await port.read());
        if (complete !== undefined) {
          return complete;
        }
      }
    } finally {
      inFlight = false;
    }
  };
}
