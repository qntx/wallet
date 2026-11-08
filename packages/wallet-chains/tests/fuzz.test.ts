import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { decodeBitcoinPsbt } from "../src/bitcoin/index.ts";
import { decodeEvm, normalizeEvm } from "../src/evm/index.ts";
import { ChainError, parseSignIn } from "../src/index.ts";
import type { DisplayIntent, SignRequest } from "../src/index.ts";
import { normalizeSolana } from "../src/solana/index.ts";
import { attempt } from "./fuzz.ts";

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
        expect(intentOrChainError(attempt(() => decodeEvm(evmRequest(tx))))).toBe(true);
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
          intentOrChainError(attempt(() => decodeEvm(typedDataRequest(JSON.stringify(json))))),
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
