/**
 * Card client × signing plans × transport — the card protocol's command surface against every task
 * of the committed signing-plan vectors, card-side signature decode and Ed25519 stream assembly
 * against chains assemble for a high-s ECDSA signature, and the wire bounds the native reader and
 * kernel binding enforce.
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

import type { SignTask } from "@qntx/wallet-chains";
import { assembleBitcoinPsbt, planBitcoinPsbt } from "@qntx/wallet-chains/bitcoin";
import { assembleEvm, planEvm } from "@qntx/wallet-chains/evm";
import { assembleSolana, planSolana } from "@qntx/wallet-chains/solana";

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
import { pathString } from "../src/modules/chains/keys.ts";
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

type VectorCase = (typeof vectors.cases)[number];
type VectorTask = NonNullable<VectorCase["stages"]>[number][number];

const SEED = mnemonicToSeedSync(vectors.mnemonic);
const root = HDKey.fromMasterSeed(SEED);
const N = secp256k1.Point.Fn.ORDER;

const requireBytes = (value: string | undefined, what: string): Uint8Array => {
  if (value === undefined) {
    throw new Error(`task missing ${what}`);
  }
  return hex(value);
};

const publicAt = (path: ReadonlyArray<number>): Uint8Array => {
  const { publicKey } = root.derive(pathString(path));
  if (publicKey === null) {
    throw new Error("no public key at the task path");
  }
  return publicKey;
};

const everyTask = vectors.cases.flatMap((c) =>
  c.stages.flatMap((stage) => stage.map((task) => ({ name: c.name, task }))),
);

const tasksOf = (scheme: string): ReadonlyArray<{ name: string; task: VectorTask }> =>
  everyTask.filter(({ task }) => task.scheme === scheme);

const TASK_SCHEMES = ["ecdsa-secp256k1", "bip340", "ed25519"] as const;

/** Narrows a signing-plan task to one scheme — throws otherwise. */
function assertScheme<T extends { scheme: string }, S extends string>(
  task: T | undefined,
  scheme: S,
): asserts task is Extract<T, { scheme: S }> {
  if (task === undefined || task.scheme !== scheme) {
    throw new Error(`expected a ${scheme} task`);
  }
}

/** Unwraps a chains assemble result — throws unless it is `signed`. */
const signedArtefact = <A>(assembled: { readonly kind: string; readonly artefact?: A }): A => {
  if (assembled.kind !== "signed" || assembled.artefact === undefined) {
    throw new Error("expected a signed artefact");
  }
  return assembled.artefact;
};

const hexByte = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46);

describe("card commands × signing-plan tasks", () => {
  it.each(tasksOf("ecdsa-secp256k1"))("$name: signEcdsa builds", ({ task }) => {
    expect(() => cmd.signEcdsa(requireBytes(task.digest, "digest"), task.path)).not.toThrow();
  });

  it.each(tasksOf("bip340"))(
    "$name: the card's tweak matches and signBip340 builds",
    ({ task }) => {
      const internal = publicAt(task.path);
      // The card computes TapTweak(x(P)) itself; the vector tweak must match it.
      expect(bytesToHex(taprootTweak(internal, new Uint8Array(0)))).toBe(task.tweak);
      expect(() =>
        cmd.signBip340(
          requireBytes(task.message, "message"),
          requireBytes(task.tweak, "tweak"),
          task.path,
        ),
      ).not.toThrow();
    },
  );

  it.each(tasksOf("ed25519"))("$name: the ed25519 stream reassembles R‖A‖M", ({ task }) => {
    expect(() => cmd.ed25519Begin(task.path)).not.toThrow();
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
  });

  it("the vectors use only the three task schemes", () => {
    const covered = TASK_SCHEMES.map((scheme) => tasksOf(scheme).length).reduce((a, b) => a + b, 0);
    expect(covered).toBe(everyTask.length);
    for (const scheme of TASK_SCHEMES) {
      expect(tasksOf(scheme)).not.toHaveLength(0);
    }
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

  const caseOf = (name: string): VectorCase => {
    const c = vectors.cases.find((entry) => entry.name === name);
    if (c === undefined) {
      throw new Error(`vector case ${name} missing`);
    }
    return c;
  };

  const keyOf = (c: VectorCase) => {
    if (c.key === undefined) {
      throw new Error(`${c.name}: no key`);
    }
    return { path: c.key.path, publicKey: hex(c.key.publicKey) };
  };

  const privateAt = (path: ReadonlyArray<number>): Uint8Array => {
    const { privateKey } = root.derive(pathString(path));
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
  const bip340Sign = (
    task: { message: Uint8Array; tweak: Uint8Array },
    priv: Uint8Array,
  ): Uint8Array => {
    const d0 = bytesToNumberBE(priv);
    const even = secp256k1.getPublicKey(priv, true)[0] === 0x02 ? d0 : N - d0;
    const tweaked = (even + bytesToNumberBE(task.tweak)) % N;
    return schnorr.sign(task.message, numberToBytesBE(tweaked, 32), new Uint8Array(32));
  };

  /** The card-shaped signature the plan asks for — high-s ECDSA or tweaked BIP-340. */
  const cardSignature = (task: SignTask): Uint8Array => {
    const priv = privateAt(task.path);
    if (task.scheme === "bip340") {
      const signature = bip340Sign(task, priv);
      expect(decode.bip340(signature, task.message, publicAt(task.path), task.tweak)).toStrictEqual(
        signature,
      );
      return signature;
    }
    if (task.scheme === "ecdsa-secp256k1") {
      return highS(task.digest, priv);
    }
    throw new Error(`unexpected task scheme: ${JSON.stringify(task)}`);
  };

  const signatureEntries = (c: VectorCase) => {
    if (typeof c.artefact === "string") {
      throw new TypeError(`${c.name}: expected signature entries`);
    }
    return c.artefact.signatures;
  };

  const verifyPsbtSignatures = (
    artefact: Uint8Array,
    entries: ReturnType<typeof signatureEntries>,
  ): void => {
    const tx = Transaction.fromPSBT(artefact);
    for (const entry of entries) {
      const input = tx.getInput(entry.index);
      const got =
        typeof entry.partialSig === "string" ? input.partialSig?.at(0)?.at(1) : input.tapKeySig;
      expect(bytesToHex(got ?? new Uint8Array())).toBe(entry.partialSig ?? entry.tapKeySig ?? "");
    }
  };

  it("evm: a high-s card signature decodes and assembles to the vector", () => {
    const c = caseOf("evm-legacy");
    const request = { ...c.request, account: ACCOUNT };
    const plan = planEvm(request as never, keyOf(c));
    const task: SignTask | undefined = plan.tasks.at(0);
    assertScheme(task, "ecdsa-secp256k1");
    const signature = highS(task.digest, privateAt(task.path));
    // Card-side decode verifies high-s, normalizes to low s and finds the recovery bit.
    const result = decode.ecdsa(signature, task.digest, task.publicKey, []);
    expect(bytesToNumberBE(result.signature.subarray(32))).toBeLessThanOrEqual(N / 2n);
    const artefact = signedArtefact(assembleEvm(plan, [signature]));
    expect(bytesToHex(artefact)).toBe(c.artefact);
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
    const signatures = plan.tasks.map((task) => cardSignature(task));
    expect(signatures).toHaveLength(plan.tasks.length);
    const artefact = signedArtefact(assembleBitcoinPsbt(plan, signatures));
    verifyPsbtSignatures(artefact, signatureEntries(c));
  });

  it("solana: the ed25519 stream assembly decodes and assembles to the vector", () => {
    const c = caseOf("solana-transaction-legacy-single-signer");
    const request = {
      ...c.request,
      account: ACCOUNT,
      message: hex(c.request["message"] as string),
    };
    const plan = planSolana(request as never, keyOf(c));
    const task: SignTask | undefined = plan.tasks.at(0);
    assertScheme(task, "ed25519");
    const priv = Slip10.fromMasterSeed(SEED).derive(pathString(task.path)).privateKey;
    const signature = ed25519.sign(task.message, priv);
    // The card streams R‖A‖M and returns le32(S); the client reassembles and verifies.
    expect(
      decode.ed25519(
        signature.subarray(32),
        signature.subarray(0, 32),
        task.publicKey,
        task.message,
      ),
    ).toStrictEqual(signature);
    const artefact = signedArtefact(assembleSolana(plan, [signature]));
    expect(bytesToHex(artefact)).toBe(c.artefact);
  });
});

describe("transport bounds", () => {
  // packages/wallet-native/cpp/runtime/KernelCardReader.cpp: kApduMin/kApduMax.
  const APDU_MIN = 4;
  const APDU_MAX = 261;
  // packages/wallet-native/kernel/card.ts: RESPONSE_MIN/RESPONSE_MAX.
  const RESPONSE_MIN = 2;
  const RESPONSE_MAX = 258;

  const session = sessionFromKeys(
    new Uint8Array(64).fill(7),
    new Uint8Array(33).fill(2),
    new Uint8Array(97).fill(3),
    "test",
    new Uint8Array(8).fill(4),
  );

  /** The first stream chunk must be a maximal 236-byte ed25519-update — throws otherwise. */
  type Stream = ReturnType<typeof cmd.ed25519Stream>;
  const firstUpdate = (stream: Stream): Stream[number] => {
    const update = stream.at(0);
    if (update === undefined || update.name !== "ed25519-update" || update.data.length !== 236) {
      throw new Error("expected a 236-byte ed25519-update chunk");
    }
    return update;
  };

  it("command APDUs fit the reader window", () => {
    const { apdu } = openRequest(() => new Uint8Array(32).fill(1));
    // A 173-byte message makes the first stream chunk a 236-byte update (amendment B2 keeps
    // every chunk non-empty, so a 237-byte stream splits 236 ‖ 1).
    const stream = cmd.ed25519Stream(new Uint8Array(32), new Uint8Array(32), new Uint8Array(173));
    const apdus = [
      SELECT_APDU,
      apdu,
      session.wrap(firstUpdate(stream)),
      session.wrap(
        cmd.create({
          mode: "generate",
          accessHash: new Uint8Array(32),
          entropy: new Uint8Array(32),
          others: [new Uint8Array(16).fill(1), new Uint8Array(16).fill(2)],
        }),
      ),
      session.wrap(
        cmd.export0(new Uint8Array(97), {
          linkKey: new Uint8Array(65),
          signature: new Uint8Array(64),
        }),
      ),
      session.wrap(
        cmd.import0(new Uint8Array(97), {
          ephemeral: new Uint8Array(65),
          signature: new Uint8Array(64),
        }),
      ),
      session.wrap(cmd.import1(new Uint8Array(176))),
    ];
    for (const command of apdus) {
      expect(command.length).toBeGreaterThanOrEqual(APDU_MIN);
      expect(command.length).toBeLessThanOrEqual(APDU_MAX);
    }
    session.close();
  });

  it("response APDUs fit the reader window", () => {
    // §8.1 OPEN response: cardEph ‖ sig ‖ cert ‖ 9000.
    const openResponse = 226 + 2;
    // §8.4: unwrap reads ciphertext ‖ tag(8) ‖ sw(2) with the ciphertext a nonzero multiple of
    // 16 capped at 240 — the largest plaintext data ‖ sw is then 239, so |data| ≤ 237.
    const largest = m2(new Uint8Array(237 + 2)).length + 8 + 2;
    for (const response of [openResponse, largest]) {
      expect(response).toBeGreaterThanOrEqual(RESPONSE_MIN);
      expect(response).toBeLessThanOrEqual(RESPONSE_MAX);
    }
    expect(largest).toBe(250);
  });

  it("every cert identity's short id satisfies the secure-input short-id rule", () => {
    const cert = loadVectors("card/cert.json") as {
      identities: ReadonlyArray<{ name: string; compressed: string }>;
    };
    for (const identity of cert.identities) {
      const bytes = utf8ToBytes(shortId(hex(identity.compressed)).replace("-", ""));
      // `validFor` in packages/wallet-native/kernel/card.ts: 8 bytes of [0-9A-F].
      expect(bytes).toHaveLength(8);
      expect(bytes.every(hexByte)).toBe(true);
    }
  });
});
