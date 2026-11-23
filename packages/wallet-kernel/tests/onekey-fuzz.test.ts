/**
 * Property coverage for the codec and the frame decoder (fast-check; `bun run fuzz` raises the run
 * count via FUZZ_RUNS). The contract everywhere: return normally or throw a OneKeyError — never
 * another error type, never a hang — and a mutated-but-once-valid input is never decoded back to
 * the original value.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { OneKeyError } from "../src/modules/onekey/protocol/errors.ts";
import { decodeMessage, encodeMessage } from "../src/modules/onekey/protocol/frame.ts";
import { ButtonRequest, Failure, Features } from "../src/modules/onekey/protocol/messages.ts";
import { decode, encode } from "../src/modules/onekey/protocol/proto.ts";
import type { MessageDef } from "../src/modules/onekey/protocol/proto.ts";

/** Run count; the weekly job raises it via FUZZ_RUNS. */
const RUNS = Number(process.env["FUZZ_RUNS"] ?? "3000");
const TIMEOUT = 60_000 * Math.max(1, Math.ceil(RUNS / 3000));

function onlyOneKeyError(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof OneKeyError) {
      return;
    }
    throw error;
  }
}

type Mutated = { readonly ok: false } | { readonly ok: true; readonly decoded: unknown };

/**
 * Applies `mutate` to a copy and feeds the decoder: `ok:false` means a (typed) rejection, `ok:true`
 * carries the decoded value, which the caller must prove differs from the original.
 */
function mutateAndDecode(
  encoded: Uint8Array,
  def: MessageDef,
  mutate: (copy: Uint8Array) => void,
): Mutated {
  const copy = new Uint8Array(encoded);
  mutate(copy);
  try {
    return { ok: true, decoded: decode(def, copy) };
  } catch (error) {
    if (error instanceof OneKeyError) {
      return { ok: false };
    }
    throw error;
  }
}

const FEATURES_VALUE = {
  majorVersion: 2,
  minorVersion: 99,
  patchVersion: 99,
  initialized: true,
  onekeyDeviceType: 5,
  onekeyFirmwareVersion: "4.21.0",
  capabilities: [1, 2, 7],
};

const DECODERS: ReadonlyArray<readonly [string, MessageDef]> = [
  ["Features", Features],
  ["Failure", Failure],
  ["ButtonRequest", ButtonRequest],
];

/** Complements the byte at `at % length` — every bit flip must change the decode. */
const flipByte =
  (at: number) =>
  (copy: Uint8Array): void => {
    const index = at % copy.length;
    copy[index] = 255 - (copy[index] ?? 0);
  };

const zeroFrom =
  (at: number) =>
  (copy: Uint8Array): void => {
    copy.fill(0, at % copy.length);
  };

/** The generated value as decode returns it: an empty repeated field stays absent. */
function withoutEmptyCapabilities(
  value: Readonly<Record<string, unknown> & { capabilities: ReadonlyArray<number> }>,
): Record<string, unknown> {
  const { capabilities, ...rest } = value;
  return capabilities.length > 0 ? { ...rest, capabilities } : rest;
}

describe("decode robustness", () => {
  it.each(DECODERS)(
    "arbitrary bytes into %s decode",
    (_name, def) => {
      fc.assert(
        fc.property(fc.uint8Array(), (data) => {
          expect(() => onlyOneKeyError(() => decode(def, data))).not.toThrow();
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    "arbitrary bytes into decodeMessage",
    () => {
      fc.assert(
        fc.property(fc.uint8Array(), (data) => {
          expect(() => onlyOneKeyError(() => decodeMessage(data))).not.toThrow();
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe("mutations are never accepted as the original", () => {
  const encodedFeatures = encode(Features, FEATURES_VALUE);
  const originalFields = {
    majorVersion: 2,
    minorVersion: 99,
    patchVersion: 99,
    initialized: true,
    onekeyDeviceType: 5,
    onekeyFirmwareVersion: "4.21.0",
    capabilities: [1, 2, 7],
  };

  it(
    "bit flips",
    () => {
      fc.assert(
        fc.property(fc.nat(), (at) => {
          expect(mutateAndDecode(encodedFeatures, Features, flipByte(at))).not.toStrictEqual({
            ok: true,
            decoded: originalFields,
          });
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    "truncations",
    () => {
      fc.assert(
        fc.property(fc.nat(), (at) => {
          expect(mutateAndDecode(encodedFeatures, Features, zeroFrom(at))).not.toStrictEqual({
            ok: true,
            decoded: originalFields,
          });
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});

describe("round trips", () => {
  it(
    "payloads survive encode/decode",
    () => {
      fc.assert(
        fc.property(fc.uint8Array({ maxLength: 512 }), fc.nat({ max: 0xffff }), (payload, type) => {
          const message = decodeMessage(encodeMessage(type, payload));
          expect(message.type).toBe(type);
          expect(message.payload).toStrictEqual(payload);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );

  it(
    "decoded Features survive decode(encode())",
    () => {
      fc.assert(
        fc.property(
          fc.record({
            majorVersion: fc.nat({ max: 0xff_ff_ff_ff }),
            minorVersion: fc.nat({ max: 0xff_ff_ff_ff }),
            patchVersion: fc.nat({ max: 0xff_ff_ff_ff }),
            bootloaderMode: fc.boolean(),
            pinProtection: fc.boolean(),
            initialized: fc.boolean(),
            onekeyDeviceType: fc.nat({ max: 0xff_ff_ff_ff }),
            // ASCII only: lone surrogates would encode as U+FFFD and not round-trip.
            onekeyFirmwareVersion: fc.string({ unit: "grapheme-ascii" }),
            capabilities: fc.array(fc.nat({ max: 0xff_ff_ff_ff })),
          }),
          (value) => {
            const decoded = decode(Features, encode(Features, value));
            expect(decoded).toStrictEqual(withoutEmptyCapabilities(value));
          },
        ),
        { numRuns: RUNS },
      );
    },
    TIMEOUT,
  );
});
