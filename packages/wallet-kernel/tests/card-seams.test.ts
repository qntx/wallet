// oxlint-disable typescript/require-await -- test-only callbacks satisfy async contracts
/**
 * Card client × signing plans × transport — the card protocol's command surface against every
 * task of the committed signing-plan vectors, card-side signature decode and Ed25519 stream
 * assembly against chains assemble for a high-s ECDSA signature, and the wire bounds the native
 * reader and kernel binding enforce.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/utils.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import { describe, expect, it } from "vite-plus/test";

import { assembleBitcoinPsbt, planBitcoinPsbt } from "@qntx/wallet-chains/bitcoin";
import { assembleEvm, planEvm } from "@qntx/wallet-chains/evm";
import { assembleSolana, planSolana } from "@qntx/wallet-chains/solana";

import { pathString } from "../src/modules/chains/keys.ts";
import {
  cmd,
  decode,
  openRequest,
  SELECT_APDU,
  shortId,
  taprootTweak,
} from "../src/modules/card/protocol/index.ts";
import { m2 } from "../src/modules/card/protocol/kdf.ts";
import { sessionFromKeys } from "../src/modules/card/protocol/session.ts";
import { loadVectors } from "./helpers.ts";

const hex = hexToBytes;

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/signing-plans.json"), "utf8"),
) as {
  readonly mnemonic: string;
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly key?: { readonly path: ReadonlyArray<number>; readonly publicKey: string };
    readonly request: Record<string, unknown> & { readonly kind: string };
    readonly stages: ReadonlyArray<
      ReadonlyArray<{
        readonly scheme: string;
        readonly path: ReadonlyArray<number>;
        readonly publicKey: string;
        readonly digest?: string;
        readonly message?: string;
        readonly tweak?: string;
      }>
    >;
    readonly artefact:
      | string
      | {
          readonly signatures: ReadonlyArray<{
            readonly index: number;
            readonly partialSig?: string;
            readonly tapKeySig?: string;
          }>;
        };
  }>;
};

const SEED = mnemonicToSeedSync(vectors.mnemonic);
const root = HDKey.fromMasterSeed(SEED);
const N = secp256k1.Point.Fn.ORDER;

const requireBytes = (value: string | undefined, what: string): Uint8Array => {
  if (value === undefined) {
    throw new Error(`task missing ${what}`);
  }
  return hex(value);
};

type Task = (typeof vectors.cases)[number]["stages"][number][number];

const everyTask = vectors.cases.flatMap((c) =>
  c.stages.flatMap((stage) => stage.map((task) => ({ name: c.name, task }))),
);

describe("card commands × signing-plan tasks", () => {
  it.each(everyTask)("$name: the task's commands build", ({ task }) => {
    if (task.scheme === "ecdsa-secp256k1") {
      cmd.signEcdsa(requireBytes(task.digest, "digest"), task.path);
      return;
    }
    if (task.scheme === "bip340") {
      const internal = root.derive(pathString(task.path)).publicKey;
      if (internal === null) {
        throw new Error("no public key at the task path");
      }
      // The card computes TapTweak(x(P)) itself; the vector tweak must match it.
      expect(bytesToHex(taprootTweak(internal, new Uint8Array(0)))).toBe(task.tweak);
      cmd.signBip340(
        requireBytes(task.message, "message"),
        requireBytes(task.tweak, "tweak"),
        task.path,
      );
      return;
    }
    if (task.scheme === "ed25519") {
      cmd.ed25519Begin(task.path);
      const encodedR = new Uint8Array(32).fill(0x42);
      const publicKey = requireBytes(task.publicKey, "publicKey");
      const message = requireBytes(task.message, "message");
      const chunks = cmd.ed25519Stream(encodedR, publicKey, message);
      for (const chunk of chunks) {
        expect(chunk.data.length).toBeGreaterThanOrEqual(1);
        expect(chunk.data.length).toBeLessThanOrEqual(236);
      }
      expect(concatBytes(...chunks.map((chunk) => chunk.data))).toStrictEqual(
        concatBytes(encodedR, publicKey, message),
      );
      return;
    }
    throw new Error(`unexpected scheme ${task.scheme}`);
  });
});

/* The three cross-checks: a card-shaped signature for the same task — a deliberately high-s
   ECDSA where the scheme has an s — passes the card's decode and the chains' assemble to the
   vector artefact. */
describe("card decode × chains assemble", () => {
  const ACCOUNT = {
    kind: "hd",
    walletId: "vectors",
    groupIndex: 0,
    template: "evm.bip44",
  } as const;

  const caseOf = (name: string): (typeof vectors.cases)[number] => {
    const c = vectors.cases.find((entry) => entry.name === name);
    if (c === undefined) {
      throw new Error(`vector case ${name} missing`);
    }
    return c;
  };

  const keyOf = (c: (typeof vectors.cases)[number]) => {
    if (c.key === undefined) {
      throw new Error(`${c.name}: no key`);
    }
    return { path: c.key.path, publicKey: hex(c.key.publicKey) };
  };

  const privateAt = (path: ReadonlyArray<number>): Uint8Array => {
    const privateKey = root.derive(pathString(path)).privateKey;
    if (privateKey === null) {
      throw new Error("no private key at path");
    }
    return privateKey;
  };

  /** A valid 64-byte r‖s with s deliberately in the upper half of the curve order. */
  const highS = (digest: Uint8Array, priv: Uint8Array): Uint8Array => {
    const compact = secp256k1.sign(digest, priv, { prehash: false });
    const parsed = secp256k1.Signature.fromBytes(compact, "compact");
    const high = new secp256k1.Signature(parsed.r, N - parsed.s).toBytes("compact");
    expect(bytesToNumberBE(high.subarray(32))).toBeGreaterThan(N / 2n);
    return high;
  };

  /** BIP-340 over the tweaked output key (protocol.md §12.2), zero aux like the vectors. */
  const bip340Sign = (task: { message: Uint8Array; tweak: Uint8Array }, priv: Uint8Array): Uint8Array => {
    const d0 = bytesToNumberBE(priv);
    const even = secp256k1.getPublicKey(priv, true)[0] === 0x02 ? d0 : N - d0;
    const tweaked = (even + bytesToNumberBE(task.tweak)) % N;
    return schnorr.sign(task.message, numberToBytesBE(tweaked, 32), new Uint8Array(32));
  };

  it("evm: a high-s card signature decodes and assembles to the vector", () => {
    const c = caseOf("evm-legacy");
    const request = { ...c.request, account: ACCOUNT };
    const plan = planEvm(request as never, keyOf(c));
    const task = plan.tasks[0];
    if (task.scheme !== "ecdsa-secp256k1") {
      throw new Error("expected an ecdsa task");
    }
    const signature = highS(task.digest, privateAt(task.path));
    // Card-side decode verifies high-s, normalizes to low s and finds the recovery bit.
    const result = decode.ecdsa(signature, task.digest, task.publicKey, []);
    expect(bytesToNumberBE(result.signature.subarray(32))).toBeLessThanOrEqual(N / 2n);
    const assembled = assembleEvm(plan, [signature]);
    expect(assembled.kind).toBe("signed");
    if (assembled.kind === "signed") {
      expect(bytesToHex(assembled.artefact)).toBe(c.artefact);
    }
  });

  it("p2tr: the bip340 card signature decodes and the psbt assembles to the vector", () => {
    const c = caseOf("bitcoin-psbt-single-anyonecanpay");
    const inputs = (
      c.request["inputs"] as ReadonlyArray<{
        readonly index: number;
        readonly path: ReadonlyArray<number>;
        readonly publicKey: string;
      }>
    ).map(({ index, path, publicKey }) => ({
      index,
      key: { path, publicKey: hex(publicKey) },
    }));
    const plan = planBitcoinPsbt(hex(c.request["psbt"] as string), inputs);
    const signatures = plan.tasks.map((task) => {
      const priv = privateAt(task.path);
      if (task.scheme === "bip340") {
        const signature = bip340Sign(task, priv);
        const internal = root.derive(pathString(task.path)).publicKey;
        if (internal === null) {
          throw new Error("no public key at the task path");
        }
        expect(decode.bip340(signature, task.message, internal, task.tweak)).toStrictEqual(
          signature,
        );
        return signature;
      }
      if (task.scheme === "ecdsa-secp256k1") {
        return highS(task.digest, priv);
      }
      throw new Error(`unexpected scheme ${task.scheme}`);
    });
    const assembled = assembleBitcoinPsbt(plan, signatures);
    expect(assembled.kind).toBe("signed");
    if (assembled.kind === "signed" && typeof c.artefact !== "string") {
      const tx = Transaction.fromPSBT(assembled.artefact);
      for (const entry of c.artefact.signatures) {
        const input = tx.getInput(entry.index);
        const got =
          typeof entry.partialSig === "string"
            ? input.partialSig?.[0]?.[1]
            : input.tapKeySig;
        expect(bytesToHex(got ?? new Uint8Array())).toBe(
          entry.partialSig ?? entry.tapKeySig ?? "",
        );
      }
    }
  });

  it("solana: the ed25519 stream assembly decodes and assembles to the vector", () => {
    const c = caseOf("solana-transaction-legacy-single-signer");
    const request = { ...c.request, account: ACCOUNT, message: hex(c.request["message"] as string) };
    const plan = planSolana(request as never, keyOf(c));
    const task = plan.tasks[0];
    if (task.scheme !== "ed25519") {
      throw new Error("expected an ed25519 task");
    }
    const priv = Slip10.fromMasterSeed(SEED).derive(pathString(task.path)).privateKey;
    const signature = ed25519.sign(task.message, priv);
    // The card streams R‖A‖M and returns le32(S); the client reassembles and verifies.
    expect(
      decode.ed25519(signature.subarray(32), signature.subarray(0, 32), task.publicKey, task.message),
    ).toStrictEqual(signature);
    const assembled = assembleSolana(plan, [signature]);
    expect(assembled.kind).toBe("signed");
    if (assembled.kind === "signed") {
      expect(bytesToHex(assembled.artefact)).toBe(c.artefact);
    }
  });
});
