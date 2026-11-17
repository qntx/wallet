import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as fc from "fast-check";
import { p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import { decodeBitcoinPsbt } from "../src/bitcoin/index.ts";
import { ChainError } from "../src/index.ts";
import type { SignRequest } from "../src/index.ts";

const NET = "bip122:000000000019d6689c085ae165831e93";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0 } as const;
const OP_RETURN = 0x6a;
/** Bitcoin Core CScript::IsUnspendable — the decoder's burn rule, restated here as an oracle. */
const MAX_SCRIPT_SIZE = 10_000;
const unspendable = (script: Uint8Array): boolean =>
  script[0] === OP_RETURN || script.length > MAX_SCRIPT_SIZE;

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A compressed pubkey derived from drawn bytes via a hash — always a valid secret key. */
const pub33 = (priv: Uint8Array): Uint8Array => secp256k1.getPublicKey(priv, true);
const xonly = (priv: Uint8Array): Uint8Array => pub33(priv).slice(1);

const ownPub = pub33(sha256(new TextEncoder().encode("own")));
const ownScript = p2wpkh(ownPub).script;

type OutSpec =
  | { readonly kind: "p2wpkh"; readonly amount: bigint; readonly priv: Uint8Array }
  | { readonly kind: "p2tr"; readonly amount: bigint; readonly priv: Uint8Array }
  | { readonly kind: "change"; readonly amount: bigint }
  | { readonly kind: "opReturn"; readonly amount: bigint; readonly data: Uint8Array }
  | { readonly kind: "weird"; readonly amount: bigint }
  | { readonly kind: "oversized"; readonly amount: bigint };

const sats = fc.bigInt({ min: 0n, max: 500_000_000n });
const priv = fc.uint8Array({ minLength: 8, maxLength: 32 }).map((b) => sha256(b));
const outSpec: fc.Arbitrary<OutSpec> = fc.oneof(
  fc.record({ kind: fc.constant("p2wpkh" as const), amount: sats, priv }),
  fc.record({ kind: fc.constant("p2tr" as const), amount: sats, priv }),
  fc.record({ kind: fc.constant("change" as const), amount: sats }),
  fc.record({
    kind: fc.constant("opReturn" as const),
    amount: sats,
    data: fc.uint8Array({ maxLength: 40 }),
  }),
  fc.record({ kind: fc.constant("weird" as const), amount: sats }),
  fc.record({ kind: fc.constant("oversized" as const), amount: sats }),
);

/** The script the generated output spec carries. */
const scriptOf = (spec: OutSpec): Uint8Array => {
  switch (spec.kind) {
    case "p2wpkh":
      return p2wpkh(pub33(spec.priv)).script;
    case "p2tr":
      return p2tr(xonly(spec.priv)).script;
    case "change":
      return ownScript;
    case "opReturn":
      return Uint8Array.of(OP_RETURN, spec.data.length, ...spec.data);
    case "weird":
      // A spendable-looking but nonstandard script: OP_2 then a 33-byte push.
      return Uint8Array.of(0x52, 0x21, ...new Uint8Array(33).fill(0xab));
    case "oversized": {
      const script = new Uint8Array(MAX_SCRIPT_SIZE + 1);
      script[0] = 0x51;
      return script;
    }
  }
};

type Generated = {
  readonly inputs: ReadonlyArray<bigint>;
  readonly outputs: ReadonlyArray<OutSpec>;
};

const generated: fc.Arbitrary<Generated> = fc.record({
  inputs: fc.array(sats, { minLength: 1, maxLength: 4 }),
  outputs: fc.array(outSpec, { minLength: 1, maxLength: 6 }),
});

const psbtOf = (inputAmounts: ReadonlyArray<bigint>, outputs: ReadonlyArray<OutSpec>) => {
  const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
  for (const [i, amount] of inputAmounts.entries()) {
    const prev = new Transaction({ version: 2 });
    prev.addInput({ txid: new Uint8Array(32).fill(i + 1), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: ownScript, amount });
    tx.addInput({
      txid: prev.id,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: ownScript, amount },
      nonWitnessUtxo: prev.toBytes(true, false),
      bip32Derivation: [
        [ownPub, { fingerprint: 1, path: [0x80000054, 0x80000000, 0x80000000, 0, i] }],
      ],
    });
  }
  for (const spec of outputs) {
    tx.addOutput({ script: scriptOf(spec), amount: spec.amount });
  }
  return tx.toPSBT(0);
};

const request = (
  psbt: Uint8Array,
  inputCount: number,
): Extract<SignRequest, { kind: "bitcoin.psbt" }> => ({
  kind: "bitcoin.psbt",
  network: NET,
  account: ACCOUNT,
  psbt,
  sign: Array.from({ length: inputCount }, (_, index) => ({
    index,
    template: "btc.bip84" as const,
  })),
});

describe("decodeBitcoinPsbt conservation", () => {
  it("Σ proven inputs = Σ outflows + Σ change + fee, and every moving output is one flow", () => {
    fc.assert(
      fc.property(generated, ({ inputs, outputs }) => {
        const inSum = inputs.reduce((a, b) => a + b, 0n);
        const outSum = outputs.reduce((a, o) => a + o.amount, 0n);
        const psbt = psbtOf(inputs, outputs);
        const own = new Set([hex(ownScript)]);
        if (outSum > inSum) {
          // Consensus-invalid: the outputs exceed everything the inputs prove.
          expect(() => decodeBitcoinPsbt(request(psbt, inputs.length), own)).toThrow(
            expect.objectContaining({ code: "invalid-request" }) as Error,
          );
          return;
        }
        const intent = decodeBitcoinPsbt(request(psbt, inputs.length), own);
        // Every non-change output is an outflow except a zero-value unspendable one, which moves
        // nothing; a burn is exactly an unspendable output with value.
        const moved = outputs.filter(
          (o) => o.kind !== "change" && (o.amount > 0n || !unspendable(scriptOf(o))),
        );
        expect(intent.outflows).toHaveLength(moved.length);
        const outflowSum = intent.outflows.reduce(
          (sum, flow) => sum + BigInt(flow.amount.amount),
          0n,
        );
        const change = outputs
          .filter((o) => o.kind === "change")
          .reduce((a, o) => a + o.amount, 0n);
        expect(inSum - outflowSum - change).toBe(BigInt(intent.fee?.max.amount ?? "-1"));
        moved.forEach((spec, i) => {
          const flow = intent.outflows[i];
          expect(flow?.amount.asset).toBe("sats");
          expect(flow?.amount.amount).toBe(spec.amount.toString(10));
          expect(flow?.burn === true).toBe(unspendable(scriptOf(spec)));
        });
      }),
      { numRuns: 300 },
    );
  });

  it("outputs that exceed the proven inputs are an invalid request", () => {
    const intent = () => {
      const psbt = psbtOf(
        [100_000n],
        [
          { kind: "p2wpkh", amount: 90_000n, priv: sha256(new Uint8Array([9])) },
          { kind: "p2wpkh", amount: 20_000n, priv: sha256(new Uint8Array([8])) },
        ],
      );
      return decodeBitcoinPsbt(request(psbt, 1), new Set([hex(ownScript)]));
    };
    expect(intent).toThrow(ChainError);
    expect(intent).toThrow("PSBT outputs exceed its inputs");
  });

  it("value sent to an OP_RETURN output is a burn outflow, not fee and not invisible", () => {
    const psbt = psbtOf(
      [100_000_000n],
      [
        { kind: "p2wpkh", amount: 1_000_000n, priv: sha256(new Uint8Array([7])) },
        { kind: "opReturn", amount: 98_000_000n, data: Uint8Array.of(0xde, 0xad, 0xbe, 0xef) },
      ],
    );
    const intent = decodeBitcoinPsbt(request(psbt, 1), new Set());
    expect(intent.verifiability).toBe("full");
    const [send, burn] = intent.outflows;
    expect(intent.outflows).toHaveLength(2);
    expect(send?.burn).toBeUndefined();
    expect(send?.amount.amount).toBe("1000000");
    expect(burn?.burn).toBe(true);
    expect(burn?.verified).toBe(true);
    expect(burn?.amount).toMatchObject({ asset: "sats", amount: "98000000" });
    expect(burn?.to).toBe("6a04deadbeef");
    expect(intent.fee?.max.amount).toBe("1000000");
  });

  it("a zero-value OP_RETURN moves nothing and is not an outflow", () => {
    const psbt = psbtOf(
      [100_000n],
      [
        { kind: "p2wpkh", amount: 90_000n, priv: sha256(new Uint8Array([6])) },
        { kind: "opReturn", amount: 0n, data: new Uint8Array(0) },
      ],
    );
    const intent = decodeBitcoinPsbt(request(psbt, 1), new Set());
    expect(intent.outflows).toHaveLength(1);
    expect(intent.outflows[0]?.burn).toBeUndefined();
    expect(intent.fee?.max.amount).toBe("10000");
  });
});
