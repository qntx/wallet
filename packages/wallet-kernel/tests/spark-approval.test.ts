import { secp256k1 } from "@noble/curves/secp256k1.js";
/**
 * Spark approval binding, driven through the real kernel handlers: `spark.approve` registers a
 * verified intent, then the pooled signer must find a matching live approval before
 * `spark.signFrost`/`spark.signKeySpend` produce anything. The budget (invoice amount + max fee),
 * the destination (the HTLC refund script's payment hash and SSP, the coop-exit payout, the onchain
 * outputs and fee) and the 60 s approval TTL on the monotonic clock are kernel-side checks. The
 * injected SparkCrypto is a stub with the right abiVersion and fabricated FROST material, so
 * everything between the wire validator and the backend — outflow derivation, approval matching —
 * is the real code path. The BOLT11 fixtures are signature-valid regtest invoices produced by
 * encodeTestBolt11 (packages/wallet-engine/tests/support/bolt11.ts); decodeBolt11 verifies their
 * signatures.
 */
import { concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import { nobleBackend } from "@qntx/nostr";
import type { SparkCrypto } from "@qntx/spark/crypto";
import {
  decodeBolt11,
  EPHEMERAL_ANCHOR_SCRIPT,
  lightningSendHtlcScript,
  sparkNetworkConfig,
} from "@qntx/spark/signer";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { CATALOGS } from "../src/modules/chains/prompt.ts";
import type { KeystorePrompt } from "../src/platform.ts";
import { codePoints, PROMPT_BOUNDS } from "../src/prompts.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import type { FakeKeystore, KeystoreCall } from "./keystore.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DEVICE = { kind: "device" } as const;
const HARDWARE = { kind: "hardware" } as const;
const REGTEST = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef } as const;

const pubkey = (fill: number): Uint8Array =>
  secp256k1.getPublicKey(new Uint8Array(32).fill(fill), true);
const xonly = (fill: number): Uint8Array => pubkey(fill).slice(1);

/**
 * A P2TR script to stand in for a leaf/connector prevout — contents are irrelevant to outflow
 * matching.
 */
const LEAF_SCRIPT = p2tr(xonly(0x21)).script;
const FOREIGN_SCRIPT = p2tr(xonly(0x22)).script;

const destination = (fill: number): { address: string; script: Uint8Array } => {
  const payment = p2wpkh(pubkey(fill), REGTEST);
  if (payment.address === undefined) {
    throw new Error("p2wpkh produced no address");
  }
  return { address: payment.address, script: payment.script };
};
const APPROVED = destination(0x31);
const OTHER = destination(0x32);

/** 5000 sat regtest invoice, payment hash 32×0x0b (encodeTestBolt11, secretKey 32×00‖07, ts 1.7e9). */
const INVOICE =
  "lnbcrt50000000p1pj48ugqpp5pv9skzctpv9skzctpv9skzctpv9skzctpv9skzctpv9skzctpv9ssp5qgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqdqzwvnp4qfwtmurydewmf64rnrektuh20g8r6svm0cpnpcuuay4ammw2cnumczz82a77n2yre89s5n42rhk9ptl5etcrjqrqz3xcvwlq0t04c4szxvuvvwqc70exd4h7s6x42p77wnjljfncfd4nhz2vxmdnk386rc7qprzg0tw";
/** Zero-amount regtest invoice, payment hash 32×0x0c (same generator and key). */
const ZERO_INVOICE =
  "lnbcrt1pj48ugqpp5psxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqsp5qgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqdqzwvnp4qfwtmurydewmf64rnrektuh20g8r6svm0cpnpcuuay4ammw2cnumcxazknz2cuz74swc6vsttfhhp9m5z6k66u3y3pm2f4up3jx9aasz33v4q2kx7r69dv9egwxgedqhplzv6n649a2t9jh0phzgak9qpafqpz8anf9";

const PAYMENT_HASH = decodeBolt11(INVOICE).paymentHash;
const OTHER_HASH = new Uint8Array(32).fill(0x0d);
const SSP = sparkNetworkConfig("regtest").ssp.identityPublicKey;

const FROST_ITEM = 130; // nonce(64) ‖ hiding(33) ‖ binding(33) per commitment

/** One `ffi.FrostSignResponse` share per entry: field 1 (repeated bytes), tag 0x0a, len 0x20. */
const frostSignResponse = (count: number): Uint8Array => {
  const out = new Uint8Array(count * 34);
  for (let i = 0; i < count; i++) {
    out[i * 34] = 0x0a;
    out[i * 34 + 1] = 0x20;
    out.fill(7, i * 34 + 2, i * 34 + 34);
  }
  return out;
};

const notImplemented = (): never => {
  throw new Error("stub crypto: operation not implemented");
};

const VSS_PROOF = 33;
const VSS_SHARE = 32;

/**
 * The `t`×33 ‖ `n`×32 layout `splitSecretWithProofs` returns: proof items need only their count,
 * but each share becomes a share public key (`share·G`), so shares are small nonzero scalars.
 */
const fakeSplit = (threshold: number, shares: number): Uint8Array => {
  const out = new Uint8Array(threshold * VSS_PROOF + shares * VSS_SHARE);
  for (let i = 0; i < threshold; i++) {
    out[i * VSS_PROOF] = 0x02;
  }
  for (let i = 0; i < shares; i++) {
    out[threshold * VSS_PROOF + i * VSS_SHARE + VSS_SHARE - 1] = i + 1;
  }
  return out;
};

/**
 * Minimal SparkCrypto: `abiVersion: 1` is the only field the signer inspects up front; FROST
 * nonces, commitments and signature shares are fabricated in the wire shapes the signer stores,
 * echoes back and decodes. `prepareTransfer` needs a VSS-shaped split and an ECIES ciphertext the
 * receiver alone would decrypt — echoing the plaintext keeps the package deterministic and
 * byte-identical between `prepareTransfer`'s reply and the signed `transfer-package` statement.
 * FROST/VSS/ECIES correctness belongs to the real backend, not this test.
 */
const stubCrypto = (): SparkCrypto => ({
  abiVersion: 1,
  frostCommit: (_hedge: Uint8Array, random: Uint8Array) => {
    const items = new Uint8Array((random.length / 32) * FROST_ITEM);
    for (let i = 0; i < random.length / 32; i++) {
      const item = items.subarray(i * FROST_ITEM, (i + 1) * FROST_ITEM);
      item.set(random.subarray(i * 32, (i + 1) * 32));
      item[64] = 0x02;
      item[97] = 0x02;
    }
    return items;
  },
  frostSign: () => frostSignResponse(1),
  frostAggregate: notImplemented,
  eciesEncrypt: (_publicKey: Uint8Array, plaintext: Uint8Array) => Uint8Array.from(plaintext),
  eciesDecrypt: notImplemented,
  splitSecretWithProofs: (_secret: Uint8Array, threshold: number, shares: number) =>
    fakeSplit(threshold, shares),
});

const ok = (response: KernelResponse): ProtocolValue => {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
};

const errCode = (response: KernelResponse): string | undefined =>
  "err" in response ? response.err.code : undefined;

const field = (value: ProtocolValue, key: string): ProtocolValue => {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const v = value[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
};

const str = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};

const bytesOf = (value: ProtocolValue): Uint8Array => {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("expected bytes");
  }
  return value;
};

const must = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("missing value");
  }
  return value;
};

type SparkTest = {
  readonly h: Harness;
  readonly keystore: FakeKeystore;
  readonly session: string;
  readonly account: {
    readonly walletId: string;
    readonly groupIndex: 0;
    readonly network: "regtest";
  };
  /** The pooled signer's identity public key — the `identityPublicKey` of every HTLC script. */
  readonly identity: Uint8Array;
};

const setup = async (keystore: FakeKeystore = fakeKeystore()): Promise<SparkTest> => {
  const h = createHarness({
    keystore: keystore.keystore,
    backends: {
      spark: async () => {
        await Promise.resolve();
        return stubCrypto();
      },
      nostr: nobleBackend,
    },
  });
  await h.settle();
  const created = ok(
    await h.call("wallet.importMnemonic", {
      mnemonic: utf8ToBytes(MNEMONIC),
      factor: DEVICE,
    }),
  );
  const session = str(created, "session");
  const account = {
    walletId: str(field(created, "wallet"), "walletId"),
    groupIndex: 0 as const,
    network: "regtest" as const,
  };
  const identity = bytesOf(ok(await h.call("spark.identityPublicKey", { account }, session)));
  return { h, keystore, session, account, identity };
};

const lastPrompt = (keystore: FakeKeystore): KeystorePrompt | undefined =>
  keystore.calls.findLast((c): c is KeystoreCall & { prompt?: KeystorePrompt } => "prompt" in c)
    ?.prompt;

const approve = async (t: SparkTest, intent: ProtocolValue): Promise<KernelResponse> =>
  t.h.call("spark.approve", { account: t.account, intent, verify: HARDWARE }, t.session);

const htlcScript = (
  t: SparkTest,
  paymentHash: Uint8Array,
  sspIdentityPublicKey: Uint8Array = SSP,
): Uint8Array =>
  lightningSendHtlcScript({ paymentHash, sspIdentityPublicKey, identityPublicKey: t.identity });

const singleInputTx = (
  outputs: ReadonlyArray<{ readonly script: Uint8Array; readonly amount: number }>,
): Uint8Array => {
  const tx = new Transaction();
  tx.addInput({ txid: new Uint8Array(32).fill(0x44), index: 0 });
  for (const output of outputs) {
    tx.addOutput({ script: output.script, amount: BigInt(output.amount) });
  }
  return tx.toBytes();
};

type FrostJob = {
  readonly key: { readonly type: "leaf"; readonly leafId: string };
  readonly target: {
    readonly transaction: Uint8Array;
    readonly inputIndex: number;
    readonly prevouts: ReadonlyArray<{ readonly script: Uint8Array; readonly amount: number }>;
  };
  readonly exit?: { readonly connectorTx: Uint8Array; readonly exitTx: Uint8Array };
};

/**
 * One refund-tx job: a single-input spend of a leaf prevout paying `htlc` — the signer derives a
 * `lightning` outflow whose leaves carry `leafSats` each.
 */
const lightningJob = (leafId: string, leafSats: number, htlc: Uint8Array): FrostJob => ({
  key: { type: "leaf", leafId },
  target: {
    transaction: singleInputTx([{ script: htlc, amount: leafSats }]),
    inputIndex: 0,
    prevouts: [{ script: LEAF_SCRIPT, amount: leafSats }],
  },
});

/**
 * One connector-refund job: the signed tx mixes our leaf input with a foreign input spending the
 * connector tx, and `exit` carries the SSP's connector/exit pair — the signer derives an `exit`
 * outflow whose leaves carry `leafSats` and whose `exitOutputs` are `exitTx`'s outputs verbatim.
 */
const exitJob = (
  leafId: string,
  leafSats: number,
  exitOutputs: ReadonlyArray<{ readonly script: Uint8Array; readonly amount: number }>,
): FrostJob => {
  const exitTx = new Transaction();
  exitTx.addInput({ txid: new Uint8Array(32).fill(0x55), index: 0 });
  for (const output of exitOutputs) {
    exitTx.addOutput({ script: output.script, amount: BigInt(output.amount) });
  }
  const connector = new Transaction();
  connector.addInput({ txid: hexToBytes(exitTx.id), index: 0 });
  connector.addOutput({ script: LEAF_SCRIPT, amount: BigInt(1000) });
  const refund = new Transaction();
  refund.addInput({ txid: new Uint8Array(32).fill(0x66), index: 0 });
  refund.addInput({ txid: hexToBytes(connector.id), index: 0 });
  refund.addOutput({ script: LEAF_SCRIPT, amount: BigInt(leafSats - 100) });
  return {
    key: { type: "leaf", leafId },
    target: {
      transaction: refund.toBytes(),
      inputIndex: 0,
      prevouts: [
        { script: LEAF_SCRIPT, amount: leafSats },
        { script: FOREIGN_SCRIPT, amount: 1000 },
      ],
    },
    exit: { connectorTx: connector.toBytes(), exitTx: exitTx.toBytes() },
  };
};

const signFrost = async (t: SparkTest, job: FrostJob): Promise<KernelResponse> => {
  const commitments = ok(
    await t.h.call("spark.newCommitments", { account: t.account, count: 1 }, t.session),
  );
  if (!Array.isArray(commitments)) {
    throw new TypeError("expected commitments array");
  }
  const commitment = must(commitments[0]);
  return t.h.call(
    "spark.signFrost",
    {
      account: t.account,
      jobs: [
        {
          ...job,
          verifyingKey: t.identity,
          commitment,
          operatorCommitments: [],
        },
      ],
    },
    t.session,
  );
};

const signKeySpend = async (
  t: SparkTest,
  inputSats: number,
  outputs: ReadonlyArray<{ readonly script: Uint8Array; readonly amount: number }>,
): Promise<KernelResponse> =>
  t.h.call(
    "spark.signKeySpend",
    {
      account: t.account,
      key: { type: "leaf", leafId: "key-spend" },
      target: {
        transaction: singleInputTx(outputs),
        inputIndex: 0,
        prevouts: [{ script: LEAF_SCRIPT, amount: inputSats }],
      },
    },
    t.session,
  );

const approveLightning = async (t: SparkTest): Promise<KernelResponse> =>
  approve(t, { kind: "lightning", invoice: INVOICE, maxFeeSats: 100 });

const approveExit = async (t: SparkTest): Promise<KernelResponse> =>
  approve(t, { kind: "exit", address: APPROVED.address, amountSats: 4000, maxFeeSats: 300 });

const approveOnchain = async (t: SparkTest): Promise<KernelResponse> =>
  approve(t, { kind: "onchain", address: APPROVED.address, maxFeeSats: 200 });

const RECEIVER = pubkey(0x41);
const TOKEN_ID = new Uint8Array(32).fill(9);

/** The p2tr script the signer whitelists for a recorded transfer receiver. */
const receiverScript = (identityPublicKey: Uint8Array): Uint8Array =>
  p2tr(identityPublicKey.slice(1)).script;

const recordBytes = (value: ProtocolValue): Record<string, Uint8Array> => {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const out: Record<string, Uint8Array> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = bytesOf(entry);
  }
  return out;
};

const varint = (value: number): Uint8Array => {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return new Uint8Array(bytes);
};

/** Length-delimited protobuf field (`fieldNo` at wire type 2). */
const lenField = (fieldNo: number, data: Uint8Array): Uint8Array =>
  concatBytes(new Uint8Array([(fieldNo << 3) | 2]), varint(data.length), data);

/**
 * A `spark.TransferPackage` carrying `key_tweak_package` (field 2, map<string,bytes>) and
 * `hash_variant = HASH_VARIANT_V2` (field 6, varint 1) — the digest requires the variant and
 * `packageOutflow` only compares the tweak map against what `prepareTransfer` recorded.
 */
const transferPackage = (operatorPackages: Record<string, Uint8Array>): Uint8Array =>
  concatBytes(
    ...Object.entries(operatorPackages).map(([identifier, value]) =>
      lenField(2, concatBytes(lenField(1, utf8ToBytes(identifier)), lenField(2, value))),
    ),
    new Uint8Array([0x30, 0x01]),
  );

/** Big-endian u128, the wire form of `PartialTokenOutput.token_amount`. */
const u128be = (amount: bigint): Uint8Array => {
  const out = new Uint8Array(16);
  let rest = amount;
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
};

/**
 * A `spark_token.PartialTokenTransaction` with one `partial_token_outputs` entry (field 6) of owner
 * public key (1), token identifier (4) and u128 amount (5) — all `tokenOutflow` reads.
 */
const tokenTransaction = (owner: Uint8Array, amount: bigint): Uint8Array =>
  lenField(6, concatBytes(lenField(1, owner), lenField(4, TOKEN_ID), lenField(5, u128be(amount))));

/**
 * Registers the transfer and records its refund signature: `spark.prepareTransfer` gives the
 * package contents and whitelists the receiver's p2tr script for the leaf, and a `signFrost` job
 * paying that script with `amountSats` is what `packageOutflow` later reads as the leaf amount.
 */
const prepareTransfer = async (
  t: SparkTest,
  transferId: string,
  leafId: string,
  receiver: Uint8Array,
  amountSats: number,
): Promise<Record<string, Uint8Array>> => {
  const prepared = ok(
    await t.h.call(
      "spark.prepareTransfer",
      {
        account: t.account,
        request: {
          transferId,
          leaves: [{ leafId, key: { type: "leaf", leafId }, receiverIdentityPublicKey: receiver }],
        },
      },
      t.session,
    ),
  );
  ok(
    await signFrost(t, {
      key: { type: "leaf", leafId },
      target: {
        transaction: singleInputTx([{ script: receiverScript(receiver), amount: amountSats }]),
        inputIndex: 0,
        prevouts: [{ script: LEAF_SCRIPT, amount: amountSats }],
      },
    }),
  );
  return recordBytes(field(prepared, "operatorPackages"));
};

const signTransfer = async (
  t: SparkTest,
  transferId: string,
  operatorPackages: Record<string, Uint8Array>,
): Promise<KernelResponse> =>
  t.h.call(
    "spark.signIdentity",
    {
      account: t.account,
      statement: {
        kind: "transfer-package",
        transferId,
        package: transferPackage(operatorPackages),
      },
    },
    t.session,
  );

const signToken = async (
  t: SparkTest,
  owner: Uint8Array,
  amount: bigint,
): Promise<KernelResponse> =>
  t.h.call(
    "spark.signIdentity",
    {
      account: t.account,
      statement: { kind: "token-transaction", partialTransaction: tokenTransaction(owner, amount) },
    },
    t.session,
  );

describe("lightning approval", () => {
  it("covers leaves up to the invoice amount plus max fee, and no further", async () => {
    const t = await setup();
    ok(await approveLightning(t));
    const htlc = htlcScript(t, PAYMENT_HASH);
    // The rejected spend must come first: a covered outflow consumes the approval.
    expect(errCode(await signFrost(t, lightningJob("over", 5101, htlc)))).toBe("approval-required");
    expect(errCode(await signFrost(t, lightningJob("at-cap", 5100, htlc)))).toBeUndefined();
  });

  it("budgets a zero-amount invoice by the declared amountSats", async () => {
    const t = await setup();
    expect(decodeBolt11(ZERO_INVOICE).amountMsat).toBeUndefined();
    ok(
      await approve(t, {
        kind: "lightning",
        invoice: ZERO_INVOICE,
        amountSats: 700,
        maxFeeSats: 50,
      }),
    );
    const htlc = htlcScript(t, decodeBolt11(ZERO_INVOICE).paymentHash);
    expect(errCode(await signFrost(t, lightningJob("over", 751, htlc)))).toBe("approval-required");
    expect(errCode(await signFrost(t, lightningJob("at-cap", 750, htlc)))).toBeUndefined();
  });

  it("requires amountSats on a zero-amount invoice", async () => {
    const t = await setup();
    expect(
      errCode(await approve(t, { kind: "lightning", invoice: ZERO_INVOICE, maxFeeSats: 50 })),
    ).toBe("invalid-input");
  });

  it("accumulates spent leaves across outflows until the invoice budget is spent", async () => {
    const t = await setup();
    ok(await approveLightning(t));
    const htlc = htlcScript(t, PAYMENT_HASH);
    // 3 000 + 2 100 = 5 100 = invoice + max fee: the second spend is still covered.
    expect(errCode(await signFrost(t, lightningJob("first", 3000, htlc)))).toBeUndefined();
    expect(errCode(await signFrost(t, lightningJob("second", 2100, htlc)))).toBeUndefined();
    // One more sat crosses the budget.
    expect(errCode(await signFrost(t, lightningJob("third", 1, htlc)))).toBe("approval-required");
  });

  it("does not charge an already-signed leaf against the budget twice", async () => {
    const t = await setup();
    ok(await approveLightning(t));
    const htlc = htlcScript(t, PAYMENT_HASH);
    expect(errCode(await signFrost(t, lightningJob("same-leaf", 5100, htlc)))).toBeUndefined();
    // Retried batches re-present the same leaf public key; only fresh leaves count.
    expect(errCode(await signFrost(t, lightningJob("same-leaf", 5100, htlc)))).toBeUndefined();
  });

  it("rejects an HTLC script built for another payment hash", async () => {
    const t = await setup();
    ok(await approveLightning(t));
    const htlc = htlcScript(t, OTHER_HASH);
    expect(errCode(await signFrost(t, lightningJob("other-hash", 100, htlc)))).toBe(
      "approval-required",
    );
  });

  it("rejects an HTLC script locked to another SSP identity", async () => {
    const t = await setup();
    ok(await approveLightning(t));
    const htlc = htlcScript(t, PAYMENT_HASH, pubkey(0x77));
    expect(errCode(await signFrost(t, lightningJob("other-ssp", 100, htlc)))).toBe(
      "approval-required",
    );
    expect(
      errCode(await signFrost(t, lightningJob("real-ssp", 100, htlcScript(t, PAYMENT_HASH)))),
    ).toBeUndefined();
  });
});

describe("cooperative-exit approval", () => {
  it("covers an exit paying the approved amount to the approved address", async () => {
    const t = await setup();
    ok(await approveExit(t));
    const job = exitJob("exit", 4300, [
      { script: APPROVED.script, amount: 4000 },
      { script: FOREIGN_SCRIPT, amount: 200 },
    ]);
    expect(errCode(await signFrost(t, job))).toBeUndefined();
  });

  it("rejects an exit paying less than the approved amount", async () => {
    const t = await setup();
    ok(await approveExit(t));
    const job = exitJob("short-pay", 4000, [{ script: APPROVED.script, amount: 3999 }]);
    expect(errCode(await signFrost(t, job))).toBe("approval-required");
  });

  it("rejects an exit paying a different address", async () => {
    const t = await setup();
    ok(await approveExit(t));
    const job = exitJob("wrong-address", 4000, [{ script: OTHER.script, amount: 4000 }]);
    expect(errCode(await signFrost(t, job))).toBe("approval-required");
  });

  it("rejects leaves beyond the approved amount plus max fee", async () => {
    const t = await setup();
    ok(await approveExit(t));
    const job = exitJob("over-budget", 4301, [{ script: APPROVED.script, amount: 4000 }]);
    expect(errCode(await signFrost(t, job))).toBe("approval-required");
  });

  it("cannot cover two exits whose leaves together exceed the budget", async () => {
    const t = await setup();
    ok(await approveExit(t));
    expect(
      errCode(
        await signFrost(t, exitJob("exit-a", 4000, [{ script: APPROVED.script, amount: 4000 }])),
      ),
    ).toBeUndefined();
    // The first exit's leaves are spent: the second's 1000 fresh sats plus the 4000 spent
    // cross the 4300 budget the approval set.
    expect(
      errCode(
        await signFrost(t, exitJob("exit-b", 1000, [{ script: APPROVED.script, amount: 4000 }])),
      ),
    ).toBe("approval-required");
  });
});

describe("onchain approval", () => {
  it("covers a spend paying the approved address with a fee up to the cap", async () => {
    const t = await setup();
    ok(await approveOnchain(t));
    const signature = ok(
      await signKeySpend(t, 5000, [
        { script: APPROVED.script, amount: 4800 },
        { script: EPHEMERAL_ANCHOR_SCRIPT, amount: 0 },
      ]),
    );
    expect(bytesOf(signature)).toHaveLength(64);
  });

  it("rejects a fee one sat above the cap", async () => {
    const t = await setup();
    ok(await approveOnchain(t));
    expect(errCode(await signKeySpend(t, 5000, [{ script: APPROVED.script, amount: 4799 }]))).toBe(
      "approval-required",
    );
  });

  it("rejects a spend carrying an output to another address", async () => {
    const t = await setup();
    ok(await approveOnchain(t));
    expect(
      errCode(
        await signKeySpend(t, 5000, [
          { script: APPROVED.script, amount: 4000 },
          { script: OTHER.script, amount: 800 },
        ]),
      ),
    ).toBe("approval-required");
  });

  it("consumes the approval after the first signed spend", async () => {
    const t = await setup();
    ok(await approveOnchain(t));
    const spend = async (): Promise<KernelResponse> =>
      signKeySpend(t, 5000, [{ script: APPROVED.script, amount: 4800 }]);
    expect(errCode(await spend())).toBeUndefined();
    expect(errCode(await spend())).toBe("approval-required");
  });
});

describe("transfer approval", () => {
  const approveTransfer = async (t: SparkTest, amountSats = 100): Promise<KernelResponse> =>
    approve(t, {
      kind: "transfer",
      receivers: [{ identityPublicKey: RECEIVER, amountSats }],
    });

  it("covers a transfer to the approved receiver up to the approved amount", async () => {
    const t = await setup();
    ok(await approveTransfer(t));
    const id = "3f7b2e1c-1a2b-4c3d-8e4f-000000000101";
    const packages = await prepareTransfer(t, id, "leaf-1", RECEIVER, 100);
    expect(bytesOf(ok(await signTransfer(t, id, packages))).length).toBeGreaterThan(0);
  });

  it("refuses a transfer whose receiver amount is one sat over the approval", async () => {
    const t = await setup();
    ok(await approveTransfer(t));
    const id = "3f7b2e1c-1a2b-4c3d-8e4f-000000000102";
    const packages = await prepareTransfer(t, id, "leaf-1", RECEIVER, 101);
    expect(errCode(await signTransfer(t, id, packages))).toBe("approval-required");
  });

  it("consumes the approval after the first signed transfer", async () => {
    const t = await setup();
    ok(await approveTransfer(t));
    const idFirst = "3f7b2e1c-1a2b-4c3d-8e4f-000000000103";
    const idSecond = "3f7b2e1c-1a2b-4c3d-8e4f-000000000104";
    const first = await prepareTransfer(t, idFirst, "leaf-1", RECEIVER, 60);
    expect(errCode(await signTransfer(t, idFirst, first))).toBeUndefined();
    const second = await prepareTransfer(t, idSecond, "leaf-2", RECEIVER, 60);
    expect(errCode(await signTransfer(t, idSecond, second))).toBe("approval-required");
  });
});

describe("token approval", () => {
  const approveToken = async (t: SparkTest, amount = "100"): Promise<KernelResponse> =>
    approve(t, {
      kind: "token",
      tokenIdentifier: TOKEN_ID,
      receivers: [{ ownerPublicKey: RECEIVER, amount }],
    });

  it("covers a token send up to the approved amount and consumes the approval", async () => {
    const t = await setup();
    ok(await approveToken(t));
    expect(errCode(await signToken(t, RECEIVER, 100n))).toBeUndefined();
    expect(errCode(await signToken(t, RECEIVER, 100n))).toBe("approval-required");
  });

  it("refuses a token send one unit over the approved amount", async () => {
    const t = await setup();
    ok(await approveToken(t));
    expect(errCode(await signToken(t, RECEIVER, 101n))).toBe("approval-required");
  });
});

describe("approval expiry", () => {
  it("covers an outflow before the 60 s deadline and rejects it from the deadline on", async () => {
    const t = await setup();
    ok(await approveOnchain(t));
    const spend = async (): Promise<KernelResponse> =>
      signKeySpend(t, 5000, [{ script: APPROVED.script, amount: 4800 }]);
    t.h.advance(59_999); // deadline − 1 ms
    expect(errCode(await spend())).toBeUndefined();
    ok(await approveOnchain(t)); // re-approve at 59 999 ms: deadline 119 999
    t.h.advance(60_000); // now == deadline
    expect(errCode(await spend())).toBe("approval-required");
    t.h.advance(60_000); // past it
    expect(errCode(await spend())).toBe("approval-required");
  });

  it("frees the per-account approval cap once approvals expire", async () => {
    const t = await setup();
    for (let i = 0; i < 8; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- approvals register sequentially
      ok(await approveOnchain(t));
    }
    expect(errCode(await approveOnchain(t))).toBe("invalid-input");
    t.h.advance(60_000);
    ok(await approveOnchain(t));
  });
});

describe("oversize approval prompts", () => {
  /** Twenty receivers: twenty "Send …" lines, far past the iOS 8-line bound. */
  const crowdedIntent = (): ProtocolValue => ({
    kind: "transfer",
    receivers: Array.from({ length: 20 }, (_, i) => ({
      identityPublicKey: pubkey(0x41 + i),
      amountSats: 100,
    })),
  });

  it("is refused as blind-signing-disabled before any keystore call while blind signing is off", async () => {
    const keystore = fakeKeystore();
    const t = await setup(keystore);
    const callsBefore = keystore.calls.length;
    expect(errCode(await approve(t, crowdedIntent()))).toBe("blind-signing-disabled");
    expect(keystore.calls.slice(callsBefore)).toStrictEqual([]);
  });

  it("shows the blind title, a whole-line prefix and the count line when blind signing is on", async () => {
    const keystore = fakeKeystore();
    const t = await setup(keystore);
    ok(await t.h.call("vault.setBlindSigning", { enabled: true, verify: HARDWARE }, t.session));
    ok(await approve(t, crowdedIntent()));
    const prompt = lastPrompt(keystore);
    expect(prompt?.title).toBe(CATALOGS.en.blindTitle);
    const lines = String(prompt?.description).split("\n");
    expect(lines.length).toBeLessThanOrEqual(PROMPT_BOUNDS.ios.lines);
    expect(codePoints(lines.join("\n"))).toBeLessThanOrEqual(PROMPT_BOUNDS.ios.characters);
    expect(lines.at(-1)).toBe(CATALOGS.en.moreLines(21 - lines.length));
  });

  it("leaves a fitting approval prompt untouched", async () => {
    const keystore = fakeKeystore();
    const t = await setup(keystore);
    ok(
      await approve(t, {
        kind: "transfer",
        receivers: [{ identityPublicKey: RECEIVER, amountSats: 100 }],
      }),
    );
    const prompt = lastPrompt(keystore);
    expect(prompt?.title).toBe("Confirm Spark transfer");
  });
});
