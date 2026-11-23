import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
} from "@solana/transaction-messages";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { decodeBitcoinPsbt } from "../src/bitcoin/index.ts";
import { decodeEvm, normalizeEvm } from "../src/evm/index.ts";
import { ChainError, parseSignIn } from "../src/index.ts";
import type { DisplayIntent, SignRequest } from "../src/index.ts";
import { decodeSolana, normalizeSolana, parseCompiledMessage } from "../src/solana/index.ts";
import { decodeTron } from "../src/tron/decode.ts";
import { normalizeTron } from "../src/tron/index.ts";
import { tronRawDataFromJson } from "../src/tron/json.ts";
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

  it("approve calldata with arbitrary arguments returns an intent or a ChainError", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 20, maxLength: 20 }),
        fc.uint8Array({ maxLength: 96 }),
        (to, tail) => {
          const spender = hexOf(to).slice(2).padStart(64, "0");
          const data = `0x095ea7b3${spender}${hexOf(tail).slice(2)}`;
          const request = evmRequest({ to, value: "0x0", data });
          expect(intentOrChainError(attempt(() => decodeEvm(request, SIGNER)))).toBe(true);
        },
      ),
      { numRuns },
    );
  });

  it("approve calldata to the zero spender returns an intent or a ChainError", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 20, maxLength: 20 }),
        fc.uint8Array({ maxLength: 96 }),
        (to, tail) => {
          const data = `0x095ea7b3${"0".repeat(64)}${hexOf(tail).slice(2)}`;
          const request = evmRequest({ to, value: "0x0", data });
          expect(intentOrChainError(attempt(() => decodeEvm(request, SIGNER)))).toBe(true);
        },
      ),
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

  it("normalizeSolana on arbitrary 0x81-prefixed bytes returns a value or a ChainError", () => {
    fc.assert(
      fc.property(fc.uint8Array(), (suffix) => {
        const message = new Uint8Array([0x81, ...suffix]);
        const request: SignRequest = {
          kind: "solana.transaction",
          network: SOL_NET,
          account: SOL_ACCOUNT,
          message,
        };
        expect(okOrChainError(attempt(() => normalizeSolana(request, SOL_SIGNER)))).toBe(true);
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

const v1Vectors = (
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/solana-v1.json"), "utf8"),
  ) as { cases: Array<{ name: string; message: string; signer: string }> }
).cases;
const v1Mainnet = (
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../vectors/chains/solana-mainnet-v1.json"),
      "utf8",
    ),
  ) as Array<{ wire: string }>
).map((f) => Uint8Array.from(Buffer.from(f.wire, "base64")));
const V1_VECTOR_MESSAGES = v1Vectors.map((c) => Uint8Array.from(Buffer.from(c.message, "hex")));
/* A v1 mainnet fixture's message is its wire minus the trailing signature block. */
const V1_MAINNET_MESSAGES = v1Mainnet.map((wire) =>
  wire.subarray(0, wire.length - 64 * (wire[1] ?? 0)),
);
const V1_MESSAGES = [...V1_VECTOR_MESSAGES, ...V1_MAINNET_MESSAGES];
const V1_SIGNERS = v1Vectors.map((c) => c.signer);
const v1Decoder = getCompiledTransactionMessageDecoder();
const v1Encoder = getCompiledTransactionMessageEncoder();

/** One or two single-byte mutations applied to a valid v1 message. */
const mutatedV1 = fc
  .tuple(
    fc.integer({ min: 0, max: V1_MESSAGES.length - 1 }),
    fc.nat({ max: 4200 }),
    fc.integer({ min: 1, max: 255 }),
    fc.nat({ max: 4200 }),
    fc.integer({ min: 1, max: 255 }),
  )
  .map(([vi, p1, x1, p2, x2]) => {
    const base = V1_MESSAGES[vi] ?? new Uint8Array(0);
    const bytes = new Uint8Array(base);
    if (base.length > 0) {
      bytes[p1 % base.length] = ((bytes[p1 % base.length] ?? 0) + x1) % 256;
      bytes[p2 % base.length] = ((bytes[p2 % base.length] ?? 0) + x2) % 256;
    }
    return { bytes, signer: V1_SIGNERS[vi] ?? SOL_SIGNER };
  });

/* A mutated v1 message either is refused with a ChainError or is a frame the wallet accepts —
   and then kit's own decode→encode must reproduce the bytes exactly (the wallet only accepts
   fixed-size frames), and decodeSolana yields a known verifiability or a ChainError. */
const mutatedV1Outcome = (bytes: Uint8Array, signer: string): boolean => {
  const r = attempt(() => parseCompiledMessage(bytes));
  if (!r.ok) {
    return r.error instanceof ChainError;
  }
  const [decoded] = v1Decoder.read(bytes, 0);
  const reencoded = new Uint8Array(v1Encoder.encode(decoded));
  if (Buffer.compare(Buffer.from(reencoded), Buffer.from(bytes)) !== 0) {
    return false;
  }
  const request: Extract<SignRequest, { kind: "solana.transaction" }> = {
    kind: "solana.transaction",
    network: SOL_NET,
    account: SOL_ACCOUNT,
    message: bytes,
  };
  return intentOrChainError(attempt(() => decodeSolana(request, signer)));
};

/* A (fixture, length) pair mapped to a strict prefix of that mainnet v1 message. */
const truncatedMainnetV1 = fc
  .tuple(
    fc.integer({ min: 0, max: V1_MAINNET_MESSAGES.length - 1 }),
    fc.integer({ min: 0, max: 4096 }),
  )
  .map(([vi, rawLength]) => {
    const base = V1_MAINNET_MESSAGES[vi] ?? new Uint8Array(0);
    return base.subarray(0, base.length === 0 ? 0 : rawLength % base.length);
  });

/** A strict prefix of a v1 message fails, and only with a ChainError. */
const truncatedV1Outcome = (bytes: Uint8Array): boolean => {
  const r = attempt(() => parseCompiledMessage(bytes));
  return !r.ok && r.error instanceof ChainError;
};

describe("Solana v1 fuzz", () => {
  it(
    "mutated v1 vectors re-encode byte-identically or throw only a ChainError",
    () => {
      fc.assert(
        fc.property(mutatedV1, ({ bytes, signer }) => {
          expect(mutatedV1Outcome(bytes, signer)).toBe(true);
        }),
        { numRuns },
      );
    },
    // 20_000 runs (weekly job) take ~150 s — keep 4× headroom over the default 5 s.
    600_000,
  );

  it("every truncation of each v1 vector throws only a ChainError", () => {
    for (const base of V1_VECTOR_MESSAGES) {
      for (let length = 0; length < base.length; length += 1) {
        expect(truncatedV1Outcome(base.subarray(0, length))).toBe(true);
      }
    }
  });

  it(
    "a truncated mainnet v1 message throws only a ChainError",
    () => {
      fc.assert(
        fc.property(truncatedMainnetV1, (bytes) => {
          expect(truncatedV1Outcome(bytes)).toBe(true);
        }),
        { numRuns },
      );
    },
    // 20_000 runs (weekly job) of up-to-3.7 KiB parses take ~15 s — keep 4× headroom.
    120_000,
  );
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

  it("tron.typed-data inputs throw only a ChainError, never hang", () => {
    const td = (typedData: unknown): SignRequest =>
      ({
        kind: "tron.typed-data",
        network: TRON_NET,
        account: ACCOUNT,
        typedData,
      }) as SignRequest;
    fc.assert(
      fc.property(fc.string({ maxLength: 4096 }), (text) => {
        expect(okOrChainError(attempt(() => normalizeTron(td(text))))).toBe(true);
      }),
      { numRuns },
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (prefix) => {
        const doc = `{"types":${prefix}`;
        expect(okOrChainError(attempt(() => normalizeTron(td(doc))))).toBe(true);
      }),
      { numRuns },
    );
  });

  it("tronRawDataFromJson on arbitrary JSON throws only a ChainError", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), fc.boolean(), (raw, visible) => {
        expect(okOrChainError(attempt(() => tronRawDataFromJson(raw, visible)))).toBe(true);
      }),
      { numRuns },
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 2048 }), fc.boolean(), (text, visible) => {
        expect(okOrChainError(attempt(() => tronRawDataFromJson(text, visible)))).toBe(true);
      }),
      { numRuns },
    );
  });
});
