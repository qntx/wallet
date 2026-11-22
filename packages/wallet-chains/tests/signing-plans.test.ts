// oxlint-disable vitest/expect-expect -- plan/attack/serialisability helpers wrap the expect calls
// oxlint-disable vitest/no-conditional-in-test -- family dispatch and per-case narrowing guards are inherent to the fixture matrix
/**
 * Vectors/chains/signing-plans.json — every case's committed task lists and final artefact. The
 * honest local task signers must reproduce the artefact exactly; a noble-only fake card backend
 * (high-s ECDSA halves, tweaked BIP-340, Ed25519) drives the same plans into artefacts verified
 * with independent libraries; hostile backends must all die at assemble with `invalid-signature`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import {
  bytesToNumberBE,
  bytesToNumberLE,
  numberToBytesBE,
  numberToBytesLE,
} from "@noble/curves/utils.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction } from "@scure/btc-signer/transaction.js";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import {
  parseTransaction,
  recoverMessageAddress,
  recoverTransactionAddress,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import {
  assembleBitcoinMessage,
  assembleBitcoinPsbt,
  planBitcoinMessage,
  planBitcoinPsbt,
  verifyBitcoinMessage,
  verifyLegacyBitcoinMessage,
} from "../src/bitcoin/index.ts";
import type { BitcoinMessagePlan, BitcoinPsbtPlan } from "../src/bitcoin/index.ts";
import { signBitcoinTask } from "../src/bitcoin/sign.ts";
import { assembleEvm, planEvm } from "../src/evm/index.ts";
import type { EvmSignPlan } from "../src/evm/index.ts";
import { signEvmTask } from "../src/evm/sign.ts";
import { ChainError } from "../src/index.ts";
import type { Assembled, SignTask, TaskKey } from "../src/index.ts";
import { assembleSolana, planSolana } from "../src/solana/index.ts";
import type { SolanaSignPlan } from "../src/solana/index.ts";
import { signSolanaTask } from "../src/solana/sign.ts";
import { assembleTron, planTron } from "../src/tron/index.ts";
import type { TronSignPlan } from "../src/tron/index.ts";
import { signTronTask } from "../src/tron/sign.ts";

type TaskVector = {
  readonly scheme: "ecdsa-secp256k1" | "bip340" | "ed25519";
  readonly path: ReadonlyArray<number>;
  readonly publicKey: string;
  readonly digest?: string;
  readonly message?: string;
  readonly tweak?: string;
};
type CaseVector = {
  readonly name: string;
  readonly key?: { readonly path: ReadonlyArray<number>; readonly publicKey: string };
  readonly request: { readonly kind: string } & Record<string, unknown>;
  readonly stages: ReadonlyArray<ReadonlyArray<TaskVector>>;
  readonly artefact: unknown;
};

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/signing-plans.json"), "utf8"),
) as { readonly mnemonic: string; readonly cases: ReadonlyArray<CaseVector> };

const HARDENED = 0x80000000;
const { Fn } = secp256k1.Point;
const SEED = mnemonicToSeedSync(vectors.mnemonic);
const ZERO32 = new Uint8Array(32);
const ACCOUNT = { kind: "hd", walletId: "vectors", groupIndex: 0, template: "evm.bip44" } as const;

const fromHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const pathString = (path: ReadonlyArray<number>): string =>
  `m/${path.map((i) => (i >= HARDENED ? `${i - HARDENED}'` : String(i))).join("/")}`;

/** SLIP-10 ed25519 derivation — test-only, noble hmac/sha512, hardened steps only. */
const slip10 = (seed: Uint8Array, path: ReadonlyArray<number>): Uint8Array => {
  let hmacOut = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let chain = hmacOut.slice(32);
  let node = hmacOut.slice(0, 32);
  for (const index of path) {
    const data = new Uint8Array(37);
    data.set(node, 1);
    const idx = index + HARDENED;
    data[33] = Math.floor(idx / 16777216);
    data[34] = Math.floor(idx / 65536) % 256;
    data[35] = Math.floor(idx / 256) % 256;
    data[36] = idx % 256;
    hmacOut = hmac(sha512, chain, data);
    chain = hmacOut.slice(32);
    node = hmacOut.slice(0, 32);
  }
  return node;
};

/** The private key a task path names: SLIP-10 for ed25519, BIP-32 for secp256k1 schemes. */
const privateKeyFor = (task: Pick<SignTask, "scheme" | "path">): Uint8Array => {
  if (task.scheme === "ed25519") {
    return slip10(
      SEED,
      task.path.map((i) => i - HARDENED),
    );
  }
  const priv = HDKey.fromMasterSeed(SEED).derive(pathString(task.path)).privateKey;
  if (priv === null) {
    throw new Error("unreachable: vector path has a private key");
  }
  return priv;
};

type AnyPlan = EvmSignPlan | TronSignPlan | SolanaSignPlan | BitcoinPsbtPlan | BitcoinMessagePlan;

/** Byte fields arrive hex in the JSON; every other field is already wire-shaped. */
const BYTE_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "evm.personal-message": ["message"],
  "tron.transaction": ["rawData"],
  "tron.message": ["message"],
  "solana.transaction": ["message"],
  "solana.message": ["message"],
  "bitcoin.psbt": ["psbt"],
};

const requestOf = (c: CaseVector): Record<string, unknown> => {
  const request: Record<string, unknown> = { ...c.request, account: ACCOUNT };
  for (const field of BYTE_FIELDS[c.request.kind] ?? []) {
    const value = request[field];
    if (typeof value === "string") {
      request[field] = fromHex(value);
    }
  }
  return request;
};

const planFor = (c: CaseVector): AnyPlan => {
  const request = requestOf(c);
  if (c.request.kind === "bitcoin.psbt") {
    const inputs = (
      c.request["inputs"] as ReadonlyArray<{
        readonly index: number;
        readonly path: ReadonlyArray<number>;
        readonly publicKey: string;
      }>
    ).map(({ index, path, publicKey }) => ({
      index,
      key: { path, publicKey: fromHex(publicKey) },
    }));
    return planBitcoinPsbt(request["psbt"] as Uint8Array, inputs);
  }
  const keyVector = c.key;
  if (keyVector === undefined) {
    throw new Error(`${c.name}: no key`);
  }
  const key: TaskKey = { path: keyVector.path, publicKey: fromHex(keyVector.publicKey) };
  if (c.request.kind === "bitcoin.message") {
    return planBitcoinMessage(request as never, key);
  }
  if (c.request.kind.startsWith("evm.")) {
    return planEvm(request as never, key);
  }
  if (c.request.kind.startsWith("tron.")) {
    return planTron(request as never, key);
  }
  return planSolana(request as never, key);
};

// oxlint-disable-next-line typescript/consistent-return -- every kind returns; a fallthrough is impossible
const assembleFor = (
  plan: AnyPlan,
  signatures: ReadonlyArray<Uint8Array>,
): Assembled<Uint8Array | string, AnyPlan> => {
  switch (plan.kind) {
    case "evm.transaction":
    case "evm.personal-message":
    case "evm.fiat24-session":
    case "evm.typed-data":
      return assembleEvm(plan, signatures);
    case "tron.transaction":
    case "tron.message":
    case "tron.typed-data":
      return assembleTron(plan, signatures);
    case "solana.transaction":
    case "solana.message":
      return assembleSolana(plan, signatures);
    case "bitcoin.psbt":
      return assembleBitcoinPsbt(plan, signatures);
    case "bitcoin.message":
      return assembleBitcoinMessage(plan, signatures);
  }
};

const assertTasks = (
  tasks: ReadonlyArray<SignTask>,
  expected: ReadonlyArray<TaskVector> | undefined,
  label: string,
): void => {
  expect(tasks).toHaveLength(expected?.length ?? -1);
  for (const [i, task] of tasks.entries()) {
    const e = expected?.[i];
    if (e === undefined) {
      throw new Error(`${label}: missing expected task ${i}`);
    }
    expect(task.scheme).toBe(e.scheme);
    expect([...task.path]).toStrictEqual([...e.path]);
    expect(toHex(task.publicKey)).toBe(e.publicKey);
    if (task.scheme === "ecdsa-secp256k1") {
      expect(toHex(task.digest)).toBe(e.digest);
    } else if (task.scheme === "bip340") {
      expect(toHex(task.message)).toBe(e.message);
      expect(toHex(task.tweak)).toBe(e.tweak);
    } else {
      expect(toHex(task.message)).toBe(e.message);
    }
  }
};

/** The family's raw-key task signer, driven task-by-task like a backend would be. */
const localSigner =
  (kind: string) =>
  (task: SignTask): Uint8Array => {
    const priv = privateKeyFor(task);
    if (kind.startsWith("evm.")) {
      return signEvmTask(task, priv);
    }
    if (kind.startsWith("tron.")) {
      return signTronTask(task, priv);
    }
    if (kind.startsWith("solana.")) {
      return signSolanaTask(task, priv);
    }
    return signBitcoinTask(task, priv, ZERO32);
  };

/** A fake card: noble only — extra-entropy ECDSA with a high-s half, tweaked BIP-340, Ed25519. */
const cardSigner = (): ((task: SignTask) => Uint8Array) => {
  let flips = 0;
  return (task: SignTask): Uint8Array => {
    const priv = privateKeyFor(task);
    if (task.scheme === "ecdsa-secp256k1") {
      const sig = secp256k1.Signature.fromBytes(
        secp256k1.sign(task.digest, priv, { prehash: false, extraEntropy: true }),
        "compact",
      );
      // Half the signatures ship the high-s twin — the card does not normalize.
      flips += 1;
      return flips % 2 === 0
        ? new secp256k1.Signature(sig.r, Fn.neg(sig.s)).toBytes("compact")
        : sig.toBytes("compact");
    }
    if (task.scheme === "bip340") {
      // protocol.md §12.2: even-y internal scalar + the declared tweak, hashed aux.
      const d0 = Fn.fromBytes(priv);
      const even = secp256k1.Point.BASE.multiply(d0).toAffine().y % 2n === 0n ? d0 : Fn.neg(d0);
      const d = Fn.create(even + bytesToNumberBE(task.tweak));
      return schnorr.sign(task.message, Fn.toBytes(d), sha256(Uint8Array.of(flips % 256)));
    }
    return ed25519.sign(task.message, priv);
  };
};

/**
 * Drives a plan through `sign`/`assemble`, asserting every stage's tasks equal the vectors on the
 * way; returns the final artefact. `assertStages` is off for the card backend: a non-deterministic
 * stage-1 signature legitimately yields a different stage-2 EIP-7702 digest than the deterministic
 * signer's committed one (the artefact is then verified independently).
 */
const drive = (
  plan: AnyPlan,
  c: CaseVector,
  sign: (task: SignTask) => Uint8Array,
  assertStages = true,
): Uint8Array | string => {
  let current = plan;
  for (let stage = 0; ; stage++) {
    if (assertStages) {
      assertTasks(current.tasks, c.stages[stage], `${c.name} stage ${stage}`);
    }
    const signatures = current.tasks.map(sign);
    const result = assembleFor(current, signatures);
    if (result.kind === "signed") {
      expect(stage + 1, `${c.name} stage count`).toBe(c.stages.length);
      return result.artefact;
    }
    current = result.plan;
  }
};

/** The vector artefact comparison: PSBT entries per input, strings elsewhere. */
const assertArtefact = (c: CaseVector, artefact: Uint8Array | string): void => {
  if (typeof c.artefact === "string") {
    if (typeof artefact === "string") {
      expect(artefact).toBe(c.artefact);
    } else {
      // tronweb's hex artefact keeps an uppercase nibble in the recovery byte; bytes compare.
      expect(toHex(artefact)).toBe(c.artefact.toLowerCase());
    }
    return;
  }
  const tx = Transaction.fromPSBT(artefact as Uint8Array);
  const entries = (c.artefact as { signatures: ReadonlyArray<Record<string, unknown>> }).signatures;
  for (const entry of entries) {
    const input = tx.getInput(entry["index"] as number);
    if (typeof entry["partialSig"] === "string") {
      expect(toHex(input.partialSig?.[0]?.[1] ?? new Uint8Array())).toBe(entry["partialSig"]);
    } else {
      expect(toHex(input.tapKeySig ?? new Uint8Array())).toBe(entry["tapKeySig"]);
    }
  }
};

const tasksOf = (c: CaseVector): ReadonlyArray<TaskVector> => c.stages.flat();

const expectInvalidSignature = (fn: () => unknown, label: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ChainError && error.code === "invalid-signature") {
      return;
    }
    throw new Error(`${label}: unexpected error`, { cause: error });
  }
  throw new Error(`${label}: did not throw`);
};

describe("vector oracle", () => {
  it.each(vectors.cases)(
    "$name: plan tasks, local signatures and artefact equal the committed vector",
    (c) => {
      const artefact = drive(planFor(c), c, localSigner(c.request.kind));
      assertArtefact(c, artefact);
    },
  );

  it.each(vectors.cases)("structuredClone($name plan) assembles the identical artefact", (c) => {
    const artefact = drive(structuredClone(planFor(c)), c, localSigner(c.request.kind));
    assertArtefact(c, artefact);
  });

  it.each(vectors.cases)("$name plan's JSON rendering carries no private key or seed", (c) => {
    const render = JSON.stringify(planFor(c), (_k, v: unknown) =>
      v instanceof Uint8Array ? `hex:${toHex(v)}` : v,
    );
    const secrets = [toHex(SEED), ...tasksOf(c).map((t) => toHex(privateKeyFor(t)))];
    for (const secret of secrets) {
      expect(render).not.toContain(secret);
    }
  });
});

describe("fake card backend", () => {
  bitcoin.initEccLib(ecc);

  const LOW_S = Fn.ORDER / 2n;

  const verifyEvmTransaction = async (c: CaseVector, artefact: Uint8Array): Promise<void> => {
    const [task0] = tasksOf(c);
    if (task0 === undefined) {
      throw new Error("vector case has no tasks");
    }
    const address = privateKeyToAddress(`0x${toHex(privateKeyFor(task0))}`);
    const serialized: `0x${string}` = `0x${toHex(artefact)}`;
    await expect(
      recoverTransactionAddress({ serializedTransaction: serialized as never }),
    ).resolves.toBe(address);
    const parsed = parseTransaction(serialized);
    expect(parsed.s === undefined || BigInt(parsed.s) <= LOW_S).toBe(true);
    for (const auth of parsed.authorizationList ?? []) {
      expect(BigInt(auth.s), `${c.name} authorization low-s`).toBeLessThanOrEqual(LOW_S);
    }
  };

  const verifyEvmSignature = async (c: CaseVector, artefact: Uint8Array): Promise<void> => {
    const [task0] = tasksOf(c);
    if (task0 === undefined) {
      throw new Error("vector case has no tasks");
    }
    const address = privateKeyToAddress(`0x${toHex(privateKeyFor(task0))}`);
    const signature: `0x${string}` = `0x${toHex(artefact)}`;
    if (c.request.kind === "evm.personal-message") {
      const raw: `0x${string}` = `0x${String(c.request["message"])}`;
      await expect(recoverMessageAddress({ message: { raw }, signature })).resolves.toBe(address);
    } else {
      const td = JSON.parse(String(c.request["typedData"])) as Record<string, unknown>;
      await expect(
        recoverTypedDataAddress({
          domain: td["domain"],
          types: td["types"],
          primaryType: td["primaryType"],
          message: td["message"],
          signature,
        } as never),
      ).resolves.toBe(address);
    }
    expect(bytesToNumberBE(artefact.slice(32, 64))).toBeLessThanOrEqual(LOW_S);
  };

  const verifyArtefact = async (c: CaseVector, artefact: Uint8Array | string): Promise<void> => {
    const { kind } = c.request;
    const [task0] = tasksOf(c);
    if (task0 === undefined) {
      throw new Error("vector case has no tasks");
    }
    if (kind === "evm.transaction") {
      return verifyEvmTransaction(c, artefact as Uint8Array);
    }
    if (kind === "evm.personal-message" || kind === "evm.typed-data") {
      return verifyEvmSignature(c, artefact as Uint8Array);
    }
    if (kind.startsWith("tron.")) {
      const sig = artefact as Uint8Array;
      const recovered = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact")
        .addRecoveryBit(sig[64] === 28 ? 1 : 0)
        .recoverPublicKey(fromHex(task0.digest ?? ""))
        .toBytes(true);
      expect(toHex(recovered)).toBe(task0.publicKey);
      expect(bytesToNumberBE(sig.slice(32, 64))).toBeLessThanOrEqual(LOW_S);
      return;
    }
    if (kind.startsWith("solana.")) {
      expect(
        ed25519.verify(
          artefact as Uint8Array,
          fromHex(task0.message ?? ""),
          fromHex(task0.publicKey),
          { zip215: false },
        ),
      ).toBe(true);
      return;
    }
    if (kind === "bitcoin.psbt") {
      const psbt = bitcoin.Psbt.fromBuffer(Buffer.from(artefact as Uint8Array));
      const entries = (c.artefact as { signatures: ReadonlyArray<Record<string, unknown>> })
        .signatures;
      for (const entry of entries) {
        const index = entry["index"] as number;
        expect(
          psbt.validateSignaturesOfInput(index, (pubkey, msghash, signature) =>
            pubkey.length === 32
              ? ecc.verifySchnorr(msghash, pubkey, signature.subarray(0, 64))
              : ecc.verify(msghash, pubkey, signature),
          ),
          `${c.name} input ${index}`,
        ).toBe(true);
      }
      // Every ECDSA partialSig's s is low.
      const tx = Transaction.fromPSBT(artefact as Uint8Array);
      for (const entry of entries) {
        const input = tx.getInput(entry["index"] as number);
        const partial = input.partialSig?.[0]?.[1];
        if (partial !== undefined) {
          const { s } = secp256k1.Signature.fromBytes(partial.slice(0, -1), "der");
          expect(s, `${c.name} input ${entry["index"]}`).toBeLessThanOrEqual(LOW_S);
        }
      }
      return;
    }
    if (kind === "bitcoin.message") {
      const network = String(c.request["network"]);
      const address = String(c.request["address"]);
      const message = String(c.request["message"]);
      if (c.request["format"] === "legacy") {
        expect(verifyLegacyBitcoinMessage(address, message, artefact as string, network)).toBe(
          true,
        );
        const raw = Buffer.from(artefact as string, "base64");
        expect(bytesToNumberBE(raw.subarray(33, 65))).toBeLessThanOrEqual(LOW_S);
      } else {
        expect(verifyBitcoinMessage(address, message, artefact as string, network)).toBe(true);
        if (task0.scheme === "ecdsa-secp256k1") {
          // The bip322-simple P2WPKH witness is [DER‖0x01, pubkey]: count ‖ len ‖ sig ‖ len ‖ pub.
          const raw = Buffer.from((artefact as string).slice(3), "base64");
          const sigLen = raw[1] ?? 0;
          const { s } = secp256k1.Signature.fromBytes(raw.subarray(2, 1 + sigLen), "der");
          expect(s).toBeLessThanOrEqual(LOW_S);
        }
      }
    }
  };

  it.each(vectors.cases)("$name: card material assembles and verifies independently", async (c) => {
    const artefact = drive(planFor(c), c, cardSigner(), false);
    await verifyArtefact(c, artefact);
  });
});

describe("hostile backends die at assemble", () => {
  const OTHER_SECP = sha256(new TextEncoder().encode("not the task key"));
  const OTHER_ED = sha256(new TextEncoder().encode("not the task key either"));

  /** A signature valid under everything but what the task declares. */
  const attacks: ReadonlyArray<{
    readonly name: string;
    readonly schemes: ReadonlyArray<SignTask["scheme"]>;
    readonly produce: (task: SignTask, honest: Uint8Array) => Uint8Array;
  }> = [
    {
      name: "wrong key",
      schemes: ["ecdsa-secp256k1"],
      produce: (task) => {
        if (task.scheme !== "ecdsa-secp256k1") {
          throw new Error("unreachable");
        }
        return secp256k1.sign(task.digest, OTHER_SECP, { prehash: false });
      },
    },
    {
      name: "wrong digest",
      schemes: ["ecdsa-secp256k1"],
      produce: (task) => {
        if (task.scheme !== "ecdsa-secp256k1") {
          throw new Error("unreachable");
        }
        return secp256k1.sign(sha256(task.digest), privateKeyFor(task), { prehash: false });
      },
    },
    {
      name: "wrong key",
      schemes: ["bip340"],
      produce: (task) => {
        if (task.scheme !== "bip340") {
          throw new Error("unreachable");
        }
        return schnorr.sign(task.message, OTHER_SECP, ZERO32);
      },
    },
    {
      name: "wrong message",
      schemes: ["bip340"],
      produce: (task) => {
        if (task.scheme !== "bip340") {
          throw new Error("unreachable");
        }
        const d0 = Fn.fromBytes(privateKeyFor(task));
        const even = secp256k1.Point.BASE.multiply(d0).toAffine().y % 2n === 0n ? d0 : Fn.neg(d0);
        const d = Fn.create(even + bytesToNumberBE(task.tweak));
        return schnorr.sign(sha256(task.message), Fn.toBytes(d), ZERO32);
      },
    },
    {
      name: "untweaked internal key",
      schemes: ["bip340"],
      produce: (task) => {
        if (task.scheme !== "bip340") {
          throw new Error("unreachable");
        }
        const d0 = Fn.fromBytes(privateKeyFor(task));
        const even = secp256k1.Point.BASE.multiply(d0).toAffine().y % 2n === 0n ? d0 : Fn.neg(d0);
        return schnorr.sign(task.message, Fn.toBytes(even), ZERO32);
      },
    },
    {
      name: "wrong key",
      schemes: ["ed25519"],
      produce: (task) => {
        if (task.scheme !== "ed25519") {
          throw new Error("unreachable");
        }
        return ed25519.sign(task.message, OTHER_ED);
      },
    },
    {
      name: "wrong message",
      schemes: ["ed25519"],
      produce: (task) => {
        if (task.scheme !== "ed25519") {
          throw new Error("unreachable");
        }
        return ed25519.sign(sha256(task.message), privateKeyFor(task));
      },
    },
    {
      name: "65 bytes",
      schemes: ["ecdsa-secp256k1", "bip340", "ed25519"],
      produce: (_task, honest) => Uint8Array.from([...honest, 0x1b]),
    },
    {
      name: "63 bytes",
      schemes: ["ecdsa-secp256k1", "bip340", "ed25519"],
      produce: (_task, honest) => honest.slice(0, 63),
    },
    {
      name: "64 zero bytes",
      schemes: ["ecdsa-secp256k1", "bip340", "ed25519"],
      produce: () => new Uint8Array(64),
    },
    {
      name: "r out of range",
      schemes: ["ecdsa-secp256k1"],
      produce: (_task, honest) =>
        Uint8Array.from([...numberToBytesBE(Fn.ORDER, 32), ...honest.slice(32)]),
    },
    {
      name: "non-canonical S",
      schemes: ["ed25519"],
      produce: (_task, honest) => {
        const out = new Uint8Array(honest);
        out.set(numberToBytesLE(bytesToNumberLE(out.slice(32)) + ed25519.Point.Fn.ORDER, 32), 32);
        return out;
      },
    },
  ];

  const attackMatrix = attacks.flatMap((attack) =>
    vectors.cases
      .filter((c) => tasksOf(c).some((t) => attack.schemes.includes(t.scheme)))
      .map((c) => ({ attack, c })),
  );

  it.each(attackMatrix)("$attack.name on $c.name", ({ attack, c }) => {
    const plan = planFor(c);
    const signatures = plan.tasks.map((task) =>
      attack.schemes.includes(task.scheme)
        ? attack.produce(task, localSigner(c.request.kind)(task))
        : localSigner(c.request.kind)(task),
    );
    expectInvalidSignature(() => assembleFor(plan, signatures), `${attack.name}/${c.name}`);
  });

  it.each(vectors.cases)("$name: too few and too many signatures", (c) => {
    const plan = planFor(c);
    const honest = plan.tasks.map((task) => localSigner(c.request.kind)(task));
    expectInvalidSignature(() => assembleFor(plan, honest.slice(0, -1)), `${c.name} too few`);
    expectInvalidSignature(
      () => assembleFor(plan, [...honest, honest[0] ?? new Uint8Array(64)]),
      `${c.name} too many`,
    );
  });

  it("rotated signatures across tasks on bitcoin-psbt-every-template", () => {
    const c = vectors.cases.find((entry) => entry.name === "bitcoin-psbt-every-template");
    if (c === undefined) {
      throw new Error("vector case missing");
    }
    const plan = planFor(c);
    const honest = plan.tasks.map((task) => localSigner(c.request.kind)(task));
    expectInvalidSignature(
      () => assembleFor(plan, [...honest.slice(1), honest[0] ?? new Uint8Array()]),
      "rotated signatures",
    );
  });

  it("a stage-1 signature replayed at stage 2 on evm-eip7702-upgrade", () => {
    const c = vectors.cases.find((entry) => entry.name === "evm-eip7702-upgrade");
    if (c === undefined) {
      throw new Error("vector case missing");
    }
    const plan = planFor(c);
    const stage1 = plan.tasks.map((task) => localSigner(c.request.kind)(task));
    const first = assembleFor(plan, stage1);
    if (first.kind !== "next") {
      throw new Error("expected a next plan");
    }
    expectInvalidSignature(() => assembleFor(first.plan, stage1), "replayed stage-1 signature");
  });

  it.each(vectors.cases)(
    "$name: a high-s twin is accepted and yields the identical artefact",
    (c) => {
      const plan = planFor(c);
      const honest = drive(plan, c, (task) => localSigner(c.request.kind)(task));
      const highS = (task: SignTask): Uint8Array => {
        const sig = localSigner(c.request.kind)(task);
        if (task.scheme !== "ecdsa-secp256k1") {
          return sig;
        }
        const { r, s } = secp256k1.Signature.fromBytes(sig, "compact");
        return new secp256k1.Signature(r, Fn.neg(s)).toBytes("compact");
      };
      const twin = drive(structuredClone(plan), c, highS);
      expect(twin).toStrictEqual(honest);
    },
  );
});
