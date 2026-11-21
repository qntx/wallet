import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { decodeBitcoinPsbt } from "../src/bitcoin/index.ts";
import { decodeEvm, normalizeEvm } from "../src/evm/index.ts";
import { ChainError, parseSignIn } from "../src/index.ts";
import type { DisplayIntent, SignRequest } from "../src/index.ts";
import { normalizeSolana } from "../src/solana/index.ts";
import { decodeTron } from "../src/tron/decode.ts";
import { normalizeTron } from "../src/tron/index.ts";
import { decodeTronRawData, encodeTronRawData } from "../src/tron/raw.ts";
import { attempt } from "./fuzz.ts";
import { ACCOUNT, OWNER, tronVectors } from "./tron.ts";

const SIGNER = "0x1111111111111111111111111111111111111111";

/** Run count for property tests; the weekly job raises it via FUZZ_RUNS. */
const numRuns = Number(process.env["FUZZ_RUNS"] ?? "200");

const EVM_ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "evm.bip44" as const,
};
const SOL_ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "solana.bip44-change" as const,
};
const BTC_ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
};
const EVM_NET = "eip155:1";
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BTC_NET = "bip122:000000000019d6689c085ae165831e93";
const SOL_SIGNER = "11111111111111111111111111111112";
const VERIFIABILITY = new Set(["full", "partial", "opaque"]);

/** A decode outcome: an intent with a known verifiability, or a ChainError. */
const intentOrChainError = (
  r:
    | { readonly ok: true; readonly value: DisplayIntent }
    | { readonly ok: false; readonly error: unknown },
): boolean => (r.ok ? VERIFIABILITY.has(r.value.verifiability) : r.error instanceof ChainError);

/** A returned value, or a ChainError — a foreign exception type fails the property. */
const okOrChainError = (r: ReturnType<typeof attempt>): boolean =>
  r.ok || r.error instanceof ChainError;

const hexOf = (bytes: Uint8Array): string =>
  `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

type TxShape = {
  readonly to: Uint8Array | undefined;
  readonly value: string;
  readonly data: string;
};

const evmTx = fc.record({
  to: fc.option(fc.uint8Array({ minLength: 20, maxLength: 20 }), { nil: undefined }),
  value: fc.uint8Array({ maxLength: 32 }).map(hexOf),
  data: fc.uint8Array().map(hexOf),
});
const evmRequest = (tx: TxShape): SignRequest => ({
  kind: "evm.transaction",
  network: EVM_NET,
  account: EVM_ACCOUNT,
  tx: {
    type: "legacy",
    chainId: 1,
    nonce: 0,
    gas: "0x5208",
    value: tx.value,
    data: tx.data,
    gasPrice: "0x1",
    ...(tx.to === undefined ? {} : { to: hexOf(tx.to) }),
  },
});

const typedDataRequest = (json: string): SignRequest => ({
  kind: "evm.typed-data",
  network: EVM_NET,
  account: EVM_ACCOUNT,
  typedData: json,
});

const solanaRequest = (message: Uint8Array): SignRequest => ({
  kind: "solana.message",
  format: "raw",
  network: SOL_NET,
  account: SOL_ACCOUNT,
  message,
});

const psbtRequest = (psbt: Uint8Array): Extract<SignRequest, { kind: "bitcoin.psbt" }> => ({
  kind: "bitcoin.psbt",
  network: BTC_NET,
  account: BTC_ACCOUNT,
  psbt,
  sign: [{ index: 0, template: "btc.bip84" as const }],
});

const normalizeTwice = (
  tx: TxShape,
): readonly [ReturnType<typeof attempt>, ReturnType<typeof attempt>] => {
  const once = attempt(() => normalizeEvm(evmRequest(tx)));
  return [once, once.ok ? attempt(() => normalizeEvm(once.value)) : once];
};

describe("EVM decode/normalize fuzz", () => {
  it("decodeEvm on arbitrary calls returns an intent or a ChainError", () => {
    fc.assert(
      fc.property(evmTx, (tx) => {
        expect(intentOrChainError(attempt(() => decodeEvm(evmRequest(tx), SIGNER)))).toBe(true);
      }),
      { numRuns },
    );
  });

  it("normalizeEvm is idempotent on accepted inputs", () => {
    fc.assert(
      fc.property(evmTx, (tx) => {
        const [once, twice] = normalizeTwice(tx);
        expect(twice).toStrictEqual(once);
      }),
      { numRuns },
    );
  });

  it("decodeEvm on arbitrary typed-data JSON throws only a ChainError", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (json) => {
        expect(
          intentOrChainError(
            attempt(() => decodeEvm(typedDataRequest(JSON.stringify(json)), SIGNER)),
          ),
        ).toBe(true);
      }),
      { numRuns },
    );
  });

  it("parseSignIn never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(attempt(() => parseSignIn(text, "evm")).ok).toBe(true);
        expect(attempt(() => parseSignIn(text, "solana")).ok).toBe(true);
      }),
      { numRuns },
    );
  });
});

describe("Solana and Bitcoin decode fuzz", () => {
  it("normalizeSolana on arbitrary message bytes throws only a ChainError", () => {
    fc.assert(
      fc.property(fc.uint8Array(), (message) => {
        expect(
          okOrChainError(attempt(() => normalizeSolana(solanaRequest(message), SOL_SIGNER))),
        ).toBe(true);
      }),
      { numRuns },
    );
  });

  it("decodeBitcoinPsbt on arbitrary bytes throws only a ChainError", () => {
    fc.assert(
      fc.property(fc.uint8Array(), (psbt) => {
        expect(intentOrChainError(attempt(() => decodeBitcoinPsbt(psbtRequest(psbt))))).toBe(true);
      }),
      { numRuns },
    );
  });
});

const TRON_NET = "tron:728126428";
const RAW_VECTORS = tronVectors.transactions.map((v) =>
  Uint8Array.from((v.rawDataHex.match(/../g) ?? []).map((h) => Number.parseInt(h, 16))),
);

const tronTx = (rawData: Uint8Array): SignRequest => ({
  kind: "tron.transaction",
  network: TRON_NET,
  account: ACCOUNT,
  rawData,
});

/** One or two single-byte mutations applied to a real vector. */
const mutated = fc
  .tuple(
    fc.integer({ min: 0, max: RAW_VECTORS.length - 1 }),
    fc.nat({ max: 300 }),
    fc.integer({ min: 1, max: 255 }),
    fc.nat({ max: 300 }),
    fc.integer({ min: 1, max: 255 }),
  )
  .map(([vi, p1, x1, p2, x2]) => {
    const base = RAW_VECTORS[vi] ?? new Uint8Array(0);
    const bytes = new Uint8Array(base);
    if (base.length > 0) {
      bytes[p1 % base.length] = ((bytes[p1 % base.length] ?? 0) + x1) % 256;
      bytes[p2 % base.length] = ((bytes[p2 % base.length] ?? 0) + x2) % 256;
    }
    return bytes;
  });

const rawRoundTripsOrChainError = (bytes: Uint8Array): boolean => {
  const r = attempt(() => decodeTronRawData(bytes));
  if (!r.ok) {
    return r.error instanceof ChainError;
  }
  const encoded = encodeTronRawData(r.value);
  return encoded.length === bytes.length && encoded.every((b, i) => b === bytes[i]);
};

describe("TRON decode/normalize fuzz", () => {
  it("decodeTronRawData round-trips or throws only a ChainError", () => {
    fc.assert(
      fc.property(fc.uint8Array(), (bytes) => {
        expect(rawRoundTripsOrChainError(bytes)).toBe(true);
      }),
      { numRuns },
    );
  });

  it("mutated vectors round-trip or throw only a ChainError", () => {
    fc.assert(
      fc.property(mutated, (bytes) => {
        expect(rawRoundTripsOrChainError(bytes)).toBe(true);
      }),
      { numRuns },
    );
  });

  it("decodeTron on mutated vectors returns an intent or a ChainError", () => {
    fc.assert(
      fc.property(mutated, (bytes) => {
        expect(intentOrChainError(attempt(() => decodeTron(tronTx(bytes), OWNER)))).toBe(true);
      }),
      { numRuns },
    );
  });

  it("normalizeTron on arbitrary bytes throws only a ChainError", () => {
    fc.assert(
      fc.property(fc.uint8Array(), (bytes) => {
        expect(okOrChainError(attempt(() => normalizeTron(tronTx(bytes))))).toBe(true);
        expect(
          okOrChainError(
            attempt(() =>
              normalizeTron({
                kind: "tron.message",
                network: TRON_NET,
                account: ACCOUNT,
                message: bytes,
              }),
            ),
          ),
        ).toBe(true);
      }),
      { numRuns },
    );
  });
});
