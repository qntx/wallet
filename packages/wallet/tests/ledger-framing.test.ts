/**
 * Ledger HID/BLE framing (host side): vendor vectors in both directions, fast-check round trips,
 * hostile frame sequences that must only ever produce WalletError("integrity"), and a fuzz over
 * every assembler/generator — each must return or throw a WalletError, never a foreign type.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import {
  bleAssembler,
  bleFrames,
  bleMtu,
  BLE_MTU_REQUEST,
  hidAssembler,
  hidFrames,
} from "../src/hardware/ledger.ts";
import type { Assembler } from "../src/hardware/ledger.ts";
import { WalletError } from "../src/types.ts";

const FUZZ_RUNS = Number(process.env["FUZZ_RUNS"] ?? "2000");

const unhex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? []);
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

type ReceiveCase = { name: string; frames: string[]; response?: string; error?: string };

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../vectors/ledger/framing.json", import.meta.url)),
    "utf8",
  ),
) as {
  channel: string;
  hid: {
    send: Array<{ name: string; apdu: string; frames: string[] }>;
    receive: ReceiveCase[];
  };
  ble: {
    mtu: number;
    send: Array<{ name: string; apdu: string; frames: string[] }>;
    receive: ReceiveCase[];
  };
};

const CHANNEL = Number.parseInt(vectors.channel, 16);

/** Pushes every frame, returning the complete response or empty bytes. */
const assembleAll = (assembler: Assembler, frames: string[]): Uint8Array => {
  let out: Uint8Array = new Uint8Array(0);
  for (const f of frames) {
    const complete = assembler.push(unhex(f));
    if (complete !== undefined) {
      out = complete;
    }
  }
  return out;
};

const okReceives = (cases: ReceiveCase[]): ReceiveCase[] =>
  cases.filter((c) => c.error === undefined);
const badReceives = (cases: ReceiveCase[]): ReceiveCase[] =>
  cases.filter((c) => c.error !== undefined);

const integrity = (fn: () => unknown): void => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WalletError);
    expect((error as WalletError).code).toBe("integrity");
    return;
  }
  throw new Error("expected an integrity WalletError");
};

const throwsAs = (kind: string, fn: () => unknown): void => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WalletError);
    expect((error as WalletError).code).toBe(kind);
    return;
  }
  throw new Error(`expected ${kind}`);
};

/** `fn` must return or throw WalletError — anything else fails the property. */
const onlyWalletError = (fn: () => unknown): void => {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof WalletError)) {
      throw error;
    }
  }
};

describe("ledger framing", () => {
  it("replays vendor HID frames both ways", () => {
    for (const c of vectors.hid.send) {
      expect(hidFrames(unhex(c.apdu), CHANNEL).map(hex)).toStrictEqual(c.frames);
    }
    for (const c of okReceives(vectors.hid.receive)) {
      expect(hex(assembleAll(hidAssembler(CHANNEL), c.frames))).toBe(c.response);
    }
    for (const c of badReceives(vectors.hid.receive)) {
      integrity(() => assembleAll(hidAssembler(CHANNEL), c.frames));
    }
  });

  it("replays vendor BLE frames both ways", () => {
    const { mtu } = vectors.ble;
    for (const c of vectors.ble.send) {
      expect(bleFrames(unhex(c.apdu), mtu).map(hex)).toStrictEqual(c.frames);
    }
    for (const c of okReceives(vectors.ble.receive)) {
      expect(hex(assembleAll(bleAssembler(mtu), c.frames))).toBe(c.response);
    }
    for (const c of badReceives(vectors.ble.receive)) {
      integrity(() => assembleAll(bleAssembler(mtu), c.frames));
    }
  });

  it("BLE_MTU_REQUEST is the vendor 08‖0‖0‖0‖0 frame and bleMtu parses replies", () => {
    expect(hex(BLE_MTU_REQUEST)).toBe("0800000000");
    expect(bleMtu(Uint8Array.of(0x08, 0, 0, 0, 3, 64))).toBe(64);
    integrity(() => bleMtu(Uint8Array.of(0x05, 0, 0, 0, 3, 64)));
    integrity(() => bleMtu(Uint8Array.of(0x08, 0, 0, 0, 3, 5)));
    integrity(() => bleMtu(Uint8Array.of(0x08, 0, 0, 0, 0)));
  });

  it("round-trips arbitrary APDUs over HID and BLE", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 5, maxLength: 260 }),
        fc.integer({ min: 0, max: 0xffff }),
        fc.integer({ min: 6, max: 255 }),
        (apdu: Uint8Array, channel: number, mtu: number) => {
          const hidOut = assembleAll(hidAssembler(channel), hidFrames(apdu, channel).map(hex));
          expect([...hidOut]).toStrictEqual([...apdu]);
          const bleOut = assembleAll(bleAssembler(mtu), bleFrames(apdu, mtu).map(hex));
          expect([...bleOut]).toStrictEqual([...apdu]);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("every hostile frame sequence returns or throws only WalletError(integrity)", () => {
    const channel = 0x2a3f;
    const [first = new Uint8Array(0)] = hidFrames(unhex("e001000000"), channel);

    integrity(() => hidAssembler(channel).push(new Uint8Array(63)));
    integrity(() => hidAssembler(channel).push(new Uint8Array(65)));
    for (const other of hidFrames(unhex("e001000000"), channel + 1)) {
      integrity(() => hidAssembler(channel).push(other));
    }

    const wrongTag = new Uint8Array(first);
    wrongTag[2] = 0x08;
    integrity(() => hidAssembler(channel).push(wrongTag));

    const wrongSeq = new Uint8Array(first);
    wrongSeq[4] = 0x07;
    integrity(() => hidAssembler(channel).push(wrongSeq));

    const shortLen = new Uint8Array(first);
    shortLen[5] = 0;
    shortLen[6] = 1; // announced length 1 < 2
    integrity(() => hidAssembler(channel).push(shortLen));

    const a = hidAssembler(channel);
    expect(a.push(first)).toBeDefined();
    integrity(() => a.push(first)); // extra frame after completion

    // continuation frame without a started message
    const cont = new Uint8Array(first);
    cont[4] = 0x01;
    integrity(() => hidAssembler(channel).push(cont));

    // BLE: frame longer than mtu, wrong tag, sequence skip
    const ba = bleAssembler(20);
    integrity(() => ba.push(new Uint8Array(21)));
    const [bf0 = new Uint8Array(0)] = bleFrames(unhex("e001000000e0"), 20);
    const bad = new Uint8Array(bf0);
    bad[0] = 0x08;
    integrity(() => bleAssembler(20).push(bad));
    const skip = bleAssembler(20);
    skip.push(bf0);
    integrity(() => skip.push(Uint8Array.of(0x05, 0, 3, 0xaa)));
  });

  it("validates APDU bounds with invalid-input", () => {
    expect.assertions(10);
    const channel = 0x2a3f;
    const input = (fn: () => unknown): void => throwsAs("invalid-input", fn);
    input(() => hidFrames(new Uint8Array(4), channel));
    input(() => hidFrames(new Uint8Array(261), channel));
    input(() => hidFrames(new Uint8Array(5), -1));
    input(() => bleFrames(new Uint8Array(5), 5));
    input(() => bleFrames(new Uint8Array(5), 256));
  });

  it("fuzz: assemblers only throw WalletError on hostile inputs", () => {
    expect(() =>
      fc.assert(
        fc.property(
          fc.array(fc.uint8Array({ minLength: 0, maxLength: 80 }), { maxLength: 8 }),
          fc.integer({ min: 0, max: 0x1_00_00 }),
          (frames: Uint8Array[], channelRaw: number) => {
            const channel = channelRaw % 0x1_00_00;
            onlyWalletError(() => {
              const a = hidAssembler(channel);
              for (const f of frames) {
                a.push(f);
              }
            });
            onlyWalletError(() => {
              const b = bleAssembler(20 + (channelRaw % 200) + 6);
              for (const f of frames) {
                b.push(f);
              }
            });
          },
        ),
        { numRuns: FUZZ_RUNS },
      ),
    ).not.toThrow();
  }, 600_000);

  it("fuzz: frame generators only throw WalletError on hostile inputs", () => {
    expect(() =>
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 0, maxLength: 300 }),
          fc.integer({ min: -10, max: 0x1_00_10 }),
          fc.integer({ min: -5, max: 300 }),
          (apdu: Uint8Array, channel: number, mtu: number) => {
            onlyWalletError(() => hidFrames(apdu, channel));
            onlyWalletError(() => bleFrames(apdu, mtu));
            onlyWalletError(() => bleMtu(apdu));
          },
        ),
        { numRuns: FUZZ_RUNS },
      ),
    ).not.toThrow();
  }, 600_000);
});
