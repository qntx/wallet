/**
 * Fuzz every public parser/assembler with random bytes: each must either return normally or throw a
 * LedgerError — never a foreign error type. Run count from FUZZ_RUNS like card-fuzz.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { decodeResponse, encodeCommand } from "../src/modules/ledger/protocol/apdu.ts";
import type { Exchange } from "../src/modules/ledger/protocol/apdu.ts";
import { Reader } from "../src/modules/ledger/protocol/bytes.ts";
import { appAndVersion, requireApp } from "../src/modules/ledger/protocol/device.ts";
import { LedgerError } from "../src/modules/ledger/protocol/errors.ts";
import {
  bleAssembler,
  bleMtu,
  bleFrames,
  hidAssembler,
  hidFrames,
} from "../src/modules/ledger/protocol/framing.ts";
import { statusError } from "../src/modules/ledger/protocol/status.ts";

const RUNS = Number(process.env["FUZZ_RUNS"] ?? "2000");

/** `fn` must return or throw LedgerError — anything else fails the property. */
const onlyLedgerError = (fn: () => unknown): void => {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof LedgerError)) {
      throw error;
    }
  }
};

const ledgerErrorAsync = async (fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof LedgerError)) {
      throw error;
    }
  }
};

describe("ledger fuzz", () => {
  it("framing assemblers only throw LedgerError(transport)", () => {
    expect(() =>
      fc.assert(
        fc.property(
          fc.array(fc.uint8Array({ minLength: 0, maxLength: 80 }), { maxLength: 8 }),
          fc.integer({ min: 0, max: 0x1_00_00 }),
          (frames, channelRaw) => {
            const channel = channelRaw % 0x1_00_00;
            onlyLedgerError(() => {
              const a = hidAssembler(channel);
              for (const f of frames) {
                a.push(f);
              }
            });
            onlyLedgerError(() => {
              const b = bleAssembler(20 + (channelRaw % 200) + 6);
              for (const f of frames) {
                b.push(f);
              }
            });
          },
        ),
      ),
    ).not.toThrow();
  }, 600_000);

  it("frame generators only throw LedgerError on hostile inputs", () => {
    expect(() =>
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 0, maxLength: 300 }),
          fc.integer({ min: -10, max: 0x1_00_10 }),
          fc.integer({ min: -5, max: 300 }),
          (apdu, channel, mtu) => {
            onlyLedgerError(() => hidFrames(apdu, channel));
            onlyLedgerError(() => bleFrames(apdu, mtu));
            onlyLedgerError(() => bleMtu(apdu));
          },
        ),
      ),
    ).not.toThrow();
  }, 600_000);

  it("APDU decode/encode and the byte Reader only throw LedgerError", () => {
    expect(() =>
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 0, maxLength: 300 }),
          fc.integer({ min: -100, max: 400 }),
          fc.integer({ min: -100, max: 400 }),
          (bytes, cla, ins) => {
            onlyLedgerError(() => decodeResponse(bytes));
            onlyLedgerError(() =>
              encodeCommand({
                cla: cla & 0xff,
                ins: ins & 0xff,
                p1: cla & 0xff,
                p2: ins & 0xff,
                data: bytes.subarray(0, Math.min(bytes.length, 300)),
              }),
            );
            onlyLedgerError(() => {
              const r = new Reader(bytes);
              while (r.rest().length > 0) {
                r.u8();
              }
              r.end();
            });
          },
        ),
      ),
    ).not.toThrow();
  }, 600_000);

  it("statusError covers every word for every app scope", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0x1_00_00 }),
        fc.constantFrom("bitcoin", "ethereum", "solana", "tron", "dashboard"),
        (sw, app) => {
          const error = statusError(app, sw & 0xffff);
          expect(error).toBeInstanceOf(LedgerError);
          expect(error.sw).toBe(sw & 0xffff);
        },
      ),
      { numRuns: RUNS },
    );
  }, 600_000);

  it("appAndVersion and requireApp only throw LedgerError on random replies", async () => {
    const exchange = (reply: Uint8Array): Exchange => {
      const out = new Uint8Array(reply.length + 2);
      out.set(reply);
      out[reply.length] = 0x90;
      out[reply.length + 1] = 0x00;
      return async () => Promise.resolve(out);
    };
    await expect(
      fc.assert(
        fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 120 }), async (reply) => {
          await ledgerErrorAsync(async () => {
            const info = await appAndVersion(exchange(reply));
            for (const app of ["bitcoin", "ethereum", "solana", "tron"] as const) {
              onlyLedgerError(() => requireApp(info, app));
            }
          });
        }),
        { numRuns: RUNS },
      ),
    ).resolves.toBeUndefined();
  }, 600_000);
});
