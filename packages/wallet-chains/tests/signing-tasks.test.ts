// oxlint-disable vitest/expect-expect -- chainError and the refusal helpers wrap the expect calls
// oxlint-disable vitest/no-conditional-in-test -- property callbacks narrow schemes and the psbt builders branch per fixture
/**
 * The guards inside tasks.ts, the local task signers, and the bitcoin planners' refusal surface:
 * fast-check properties over acceptEcdsa/acceptBip340/acceptEd25519, signBitcoinTask's tweak math
 * proven equal to btc-signer's own schnorr path, the strict-vs-zip215 boundary, and every PSBT /
 * message input shape the planner must refuse.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { numberToBytesBE, numberToBytesLE } from "@noble/curves/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { p2ms, p2pkh, p2tr, p2wpkh, p2wsh } from "@scure/btc-signer/payment.js";
import { SigHash, Transaction } from "@scure/btc-signer/transaction.js";
import {
  NETWORK,
  TEST_NETWORK,
  tagSchnorr,
  taprootTweakPrivKey,
  taprootTweakPubkey,
  signSchnorr,
} from "@scure/btc-signer/utils.js";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { assembleBitcoinPsbt, planBitcoinMessage, planBitcoinPsbt } from "../src/bitcoin/index.ts";
import { signBitcoinTask } from "../src/bitcoin/sign.ts";
import { signEvmTask } from "../src/evm/sign.ts";
import { ChainError } from "../src/index.ts";
import type { Bip340Task, EcdsaTask, Ed25519Task, TaskKey } from "../src/index.ts";
import { signSolanaTask } from "../src/solana/sign.ts";
import { acceptBip340, acceptEcdsa, acceptEd25519, signaturesOf } from "../src/tasks.ts";
import { signTronTask } from "../src/tron/sign.ts";

const { Fn } = secp256k1.Point;
const MAINNET = "bip122:000000000019d6689c085ae165831e93";

const fromHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const randomPriv = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .filter((b) => secp256k1.utils.isValidSecretKey(b));
const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
const random64 = fc.uint8Array({ minLength: 64, maxLength: 64 });

const chainError = (fn: () => unknown, code?: string): void => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ChainError);
  if (code !== undefined) {
    expect((thrown as ChainError).code).toBe(code);
  }
};

const indexOfBytes = (haystack: Uint8Array, needle: Uint8Array): number => {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  throw new Error("needle not found");
};

describe("accept* properties", () => {
  it("an honest ECDSA signature — and its high-s twin — is accepted and recovers the task key", () => {
    fc.assert(
      fc.property(randomPriv, bytes32, (priv, digest) => {
        const task: EcdsaTask = {
          scheme: "ecdsa-secp256k1",
          path: [],
          publicKey: secp256k1.getPublicKey(priv, true),
          digest,
        };
        const sig = secp256k1.Signature.fromBytes(
          secp256k1.sign(digest, priv, { prehash: false }),
          "compact",
        );
        for (const candidate of [
          sig.toBytes("compact"),
          new secp256k1.Signature(sig.r, Fn.neg(sig.s)).toBytes("compact"),
        ]) {
          const accepted = acceptEcdsa(task, candidate);
          const recovered = new secp256k1.Signature(accepted.r, accepted.s)
            .addRecoveryBit(accepted.yParity)
            .recoverPublicKey(task.digest)
            .toBytes(true);
          expect(toHex(recovered)).toBe(toHex(task.publicKey));
          expect(accepted.s).toBeLessThanOrEqual(Fn.ORDER / 2n);
        }
      }),
      { numRuns: 100 },
    );
  }, 30_000);

  it("an honest BIP-340 signature is accepted; a random 64-byte blob throws ChainError", () => {
    fc.assert(
      fc.property(randomPriv, bytes32, bytes32, random64, (priv, msg, tweak, blob) => {
        const xonly = secp256k1.getPublicKey(priv, true).slice(1);
        const task: Bip340Task = {
          scheme: "bip340",
          path: [],
          publicKey: xonly,
          message: msg,
          tweak,
        };
        const honest = schnorr.sign(msg, priv, ZERO_AUX);
        expect(acceptBip340(task, honest)).toHaveLength(64);
        if (toHex(honest) !== toHex(blob)) {
          chainError(() => acceptBip340(task, blob), "invalid-signature");
        }
      }),
      { numRuns: 100 },
    );
  }, 30_000);

  it("an honest Ed25519 signature is accepted; a random 64-byte blob throws ChainError", () => {
    fc.assert(
      fc.property(
        fc
          .uint8Array({ minLength: 32, maxLength: 32 })
          .filter((b) => ed25519.utils.isValidSecretKey(b)),
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        random64,
        (seed, message, blob) => {
          const task: Ed25519Task = {
            scheme: "ed25519",
            path: [],
            publicKey: ed25519.getPublicKey(seed),
            message,
          };
          const honest = ed25519.sign(message, seed);
          expect(acceptEd25519(task, honest)).toHaveLength(64);
          if (toHex(honest) !== toHex(blob)) {
            chainError(() => acceptEd25519(task, blob), "invalid-signature");
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 30_000);

  it("a single-bit change in an honest signature throws ChainError for every scheme", () => {
    const flip = (sig: Uint8Array, bit: number): Uint8Array => {
      const out = new Uint8Array(sig);
      const index = Math.floor(bit / 8);
      const mask = 2 ** (bit % 8);
      const cur = out[index] ?? 0;
      out[index] = cur % (2 * mask) >= mask ? cur - mask : cur + mask;
      return out;
    };
    fc.assert(
      fc.property(
        randomPriv,
        bytes32,
        bytes32,
        fc.integer({ min: 0, max: 511 }),
        (priv, msg, digest, bit) => {
          const pub = secp256k1.getPublicKey(priv, true);
          const ecdsaTask: EcdsaTask = {
            scheme: "ecdsa-secp256k1",
            path: [],
            publicKey: pub,
            digest,
          };
          const bip340Task: Bip340Task = {
            scheme: "bip340",
            path: [],
            publicKey: pub.slice(1),
            message: msg,
            tweak: ZERO_AUX,
          };
          chainError(
            () =>
              acceptEcdsa(ecdsaTask, flip(secp256k1.sign(digest, priv, { prehash: false }), bit)),
            "invalid-signature",
          );
          chainError(
            () => acceptBip340(bip340Task, flip(schnorr.sign(msg, priv, ZERO_AUX), bit)),
            "invalid-signature",
          );
        },
      ),
      { numRuns: 100 },
    );
    fc.assert(
      fc.property(
        fc
          .uint8Array({ minLength: 32, maxLength: 32 })
          .filter((b) => ed25519.utils.isValidSecretKey(b)),
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 0, max: 511 }),
        (seed, message, bit) => {
          const task: Ed25519Task = {
            scheme: "ed25519",
            path: [],
            publicKey: ed25519.getPublicKey(seed),
            message,
          };
          chainError(
            () => acceptEd25519(task, flip(ed25519.sign(message, seed), bit)),
            "invalid-signature",
          );
        },
      ),
      { numRuns: 100 },
    );
  }, 60_000);

  it("signaturesOf accepts exactly one signature per task", () => {
    const tasks = [
      { scheme: "ed25519", path: [], publicKey: new Uint8Array(32), message: new Uint8Array(1) },
    ] as const;
    expect(() => signaturesOf(tasks, [new Uint8Array(64)])).not.toThrow();
    chainError(() => signaturesOf(tasks, []), "invalid-signature");
    chainError(
      () => signaturesOf(tasks, [new Uint8Array(64), new Uint8Array(64)]),
      "invalid-signature",
    );
  });
});

const ZERO_AUX = new Uint8Array(32);

describe("signBitcoinTask bip340 tweak", () => {
  it("equals btc-signer's tweaked schnorr for random keys of either y parity", () => {
    let even = 0;
    let odd = 0;
    fc.assert(
      fc.property(randomPriv, bytes32, bytes32, (priv, msg, aux) => {
        const x = secp256k1.getPublicKey(priv, true).slice(1);
        const tweak = tagSchnorr("TapTweak", x);
        const [outputKey] = taprootTweakPubkey(x, new Uint8Array());
        const task: Bip340Task = {
          scheme: "bip340",
          path: [],
          publicKey: outputKey,
          message: msg,
          tweak,
        };
        const odd_y = secp256k1.Point.BASE.multiply(Fn.fromBytes(priv)).toAffine().y % 2n === 1n;
        if (odd_y) {
          odd += 1;
        } else {
          even += 1;
        }
        const ours = signBitcoinTask(task, priv, aux);
        expect(schnorr.verify(ours, msg, outputKey)).toBe(true);
        expect(toHex(ours)).toBe(
          toHex(signSchnorr(msg, taprootTweakPrivKey(priv, new Uint8Array()), aux)),
        );
      }),
      { numRuns: 100 },
    );
    expect(odd > 0 && even > 0).toBe(true);
  }, 30_000);

  it("refuses a tweak at or above the curve order and a zero tweaked key", () => {
    const priv = new Uint8Array(32).fill(7);
    const x = secp256k1.getPublicKey(priv, true).slice(1);
    const task: Bip340Task = {
      scheme: "bip340",
      path: [],
      publicKey: taprootTweakPubkey(x, new Uint8Array())[0],
      message: ZERO_AUX,
      tweak: ZERO_AUX,
    };
    chainError(
      () => signBitcoinTask({ ...task, tweak: numberToBytesBE(Fn.ORDER, 32) }, priv, ZERO_AUX),
      "invalid-request",
    );
    const d0 = Fn.fromBytes(priv);
    const even = secp256k1.Point.BASE.multiply(d0).toAffine().y % 2n === 0n ? d0 : Fn.neg(d0);
    chainError(
      () => signBitcoinTask({ ...task, tweak: numberToBytesBE(Fn.neg(even), 32) }, priv, ZERO_AUX),
      "invalid-request",
    );
  });
});

describe("ed25519 strict boundary", () => {
  it("refuses what zip215 accepts: a signature under a small-order public key", () => {
    /* noble 2.x verifies the cofactored equation in BOTH modes; the strict-mode discriminant a
       backend can hit is a small-order public key — zip215 accepts it, our task verification
       must refuse. (A cofactored-only R′ = R + T signature is accepted by noble under both flags
       — cofactored is the only equation this verifier implements.) */
    const identity = Uint8Array.from([1, ...new Uint8Array(31)]);
    const message = new TextEncoder().encode("cofactored only");
    const sig = Uint8Array.from([...ed25519.Point.BASE.toBytes(), ...numberToBytesLE(1n, 32)]);
    expect(ed25519.verify(sig, message, identity, { zip215: true })).toBe(true);
    expect(ed25519.verify(sig, message, identity, { zip215: false })).toBe(false);
    const task: Ed25519Task = {
      scheme: "ed25519",
      path: [],
      publicKey: identity,
      message,
    };
    chainError(() => acceptEd25519(task, sig), "invalid-signature");
  });
});

describe("local task signers refuse what they do not use", () => {
  const priv = new Uint8Array(32).fill(3);
  const pub = secp256k1.getPublicKey(priv, true);
  const ecdsaTask: EcdsaTask = {
    scheme: "ecdsa-secp256k1",
    path: [],
    publicKey: pub,
    digest: new Uint8Array(32),
  };
  const bip340Task: Bip340Task = {
    scheme: "bip340",
    path: [],
    publicKey: pub.slice(1),
    message: new Uint8Array(32),
    tweak: new Uint8Array(32),
  };
  const ed25519Task: Ed25519Task = {
    scheme: "ed25519",
    path: [],
    publicKey: ed25519.getPublicKey(priv),
    message: new Uint8Array(4),
  };

  it("every family refuses the schemes it never plans, with 'unsupported'", () => {
    for (const task of [bip340Task, ed25519Task] as const) {
      chainError(() => signEvmTask(task, priv), "unsupported");
      chainError(() => signTronTask(task, priv), "unsupported");
    }
    for (const task of [ecdsaTask, bip340Task] as const) {
      chainError(() => signSolanaTask(task, priv), "unsupported");
    }
    chainError(() => signBitcoinTask(ed25519Task, priv, ZERO_AUX), "unsupported");
  });

  it("31- and 33-byte keys fail with today's messages", () => {
    for (const bad of [new Uint8Array(31), new Uint8Array(33)]) {
      expect(() => signEvmTask(ecdsaTask, bad)).toThrow("private key must be 32 bytes");
      expect(() => signTronTask(ecdsaTask, bad)).toThrow("private key must be 32 bytes");
      expect(() => signBitcoinTask(ecdsaTask, bad, ZERO_AUX)).toThrow(
        "private key must be 32 bytes",
      );
      expect(() => signSolanaTask(ed25519Task, bad)).toThrow("private key must be a 32-byte seed");
    }
  });
});

/** A real previous transaction paying `script` `amount` — its txid validates as a prevout. */
const funding = (script: Uint8Array, amount: bigint): { txid: string; raw: Uint8Array } => {
  const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
  prev.addInput({ txid: fromHex("1111".repeat(16)), index: 0, sequence: 0xffffffff });
  prev.addOutput({ script, amount });
  return { txid: prev.id, raw: prev.toBytes(true, false) };
};

const PAYEE = p2wpkh(new Uint8Array(33).fill(2), NETWORK).script;

describe("planBitcoinPsbt refusals", () => {
  const ownPriv = new Uint8Array(32).fill(7);
  const ownPub = secp256k1.getPublicKey(ownPriv, true);
  const ownX = ownPub.slice(1);
  const otherPub = secp256k1.getPublicKey(new Uint8Array(32).fill(9), true);
  const otherX = otherPub.slice(1);
  const key: TaskKey = { path: [], publicKey: ownPub };

  const psbtWith = (inputs: ReadonlyArray<Record<string, unknown>>, outputs = 1): Uint8Array => {
    const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
    for (const input of inputs) {
      tx.addInput(input);
    }
    for (let i = 0; i < outputs; i++) {
      tx.addOutput({ script: PAYEE, amount: 5000n });
    }
    return tx.toPSBT(0);
  };

  const wpkhInput = (pub = ownPub, sighash?: number): Record<string, unknown> => {
    const prev = funding(p2wpkh(pub, NETWORK).script, 100000n);
    return {
      txid: fromHex(prev.txid),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: p2wpkh(pub, NETWORK).script, amount: 100000n },
      nonWitnessUtxo: prev.raw,
      ...(sighash === undefined ? {} : { sighashType: sighash }),
    };
  };

  const pkhInput = (pub = ownPub): Record<string, unknown> => {
    const prev = funding(p2pkh(pub, NETWORK).script, 100000n);
    return {
      txid: fromHex(prev.txid),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: p2pkh(pub, NETWORK).script, amount: 100000n },
      nonWitnessUtxo: prev.raw,
    };
  };

  const trInput = (
    fields: Record<string, unknown> = {},
    internalX = ownX,
    script = p2tr(internalX, undefined, NETWORK).script,
  ): Record<string, unknown> => ({
    txid: fromHex(funding(script, 100000n).txid),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script, amount: 100000n },
    tapInternalKey: internalX,
    ...fields,
  });

  it("refuses a duplicate index, a 32-byte key, an undecodable PSBT and an out-of-range index", () => {
    const psbt = psbtWith([wpkhInput()]);
    chainError(
      () =>
        planBitcoinPsbt(psbt, [
          { index: 0, key },
          { index: 0, key },
        ]),
      "invalid-request",
    );
    chainError(
      () => planBitcoinPsbt(psbt, [{ index: 0, key: { path: [], publicKey: new Uint8Array(32) } }]),
      "invalid-request",
    );
    chainError(() => planBitcoinPsbt(new Uint8Array([0xde, 0xad]), []), "invalid-request");
    chainError(() => planBitcoinPsbt(psbt, [{ index: 9, key }]), "invalid-request");
  });

  it("refuses taproot inputs that are not a clean key-path spend of the task key", () => {
    // No tapInternalKey at all.
    const bare = trInput();
    delete bare["tapInternalKey"];
    chainError(() => planBitcoinPsbt(psbtWith([bare]), [{ index: 0, key }]), "invalid-request");
    // tapInternalKey of another key.
    chainError(
      () => planBitcoinPsbt(psbtWith([trInput({}, otherX)]), [{ index: 0, key }]),
      "invalid-request",
    );
    // Script-path fields a key-path signer must never silently sign over. The
    // prevouts below commit to the declared root, so only the planner's own
    // script-path guard can refuse them.
    const leafScript = Uint8Array.of(0x51);
    const leafRoot = tagSchnorr("TapLeaf", Uint8Array.of(0xc0, leafScript.length, ...leafScript));
    const [leafKey, leafParity] = taprootTweakPubkey(ownX, leafRoot);
    const leaf = trInput(
      {
        tapLeafScript: [
          [
            { version: 0xc0 + leafParity, internalKey: ownX, merklePath: [] },
            Uint8Array.of(...leafScript, 0xc0),
          ],
        ],
      },
      ownX,
      Uint8Array.of(0x51, 0x20, ...leafKey),
    );
    chainError(() => planBitcoinPsbt(psbtWith([leaf]), [{ index: 0, key }]), "invalid-request");
    const merkleRoot = new Uint8Array(32).fill(1);
    const merkle = trInput(
      { tapMerkleRoot: merkleRoot },
      ownX,
      Uint8Array.of(0x51, 0x20, ...taprootTweakPubkey(ownX, merkleRoot)[0]),
    );
    chainError(() => planBitcoinPsbt(psbtWith([merkle]), [{ index: 0, key }]), "invalid-request");
    // A prevout that pays another output key cannot survive addInput's own
    // commitment validation, so forge it: patch the decoded script of an
    // honest PSBT. btc-signer catches the inconsistency at decode and the
    // planner wraps it; its own p2tr(Q) check is unreachable defence-in-depth.
    const honest = psbtWith([trInput()]);
    const [ownQ] = taprootTweakPubkey(ownX, new Uint8Array());
    const forged = new Uint8Array(honest);
    const scriptAt = indexOfBytes(forged, Uint8Array.of(0x51, 0x20, ...ownQ));
    forged.set(taprootTweakPubkey(otherX, new Uint8Array())[0], scriptAt + 2);
    chainError(() => planBitcoinPsbt(forged, [{ index: 0, key }]), "invalid-request");
  });

  it("refuses non-default sighashes the old signer never allowed", () => {
    // SIGHASH_ALL on a taproot input (its default is SIGHASH_DEFAULT = 0).
    chainError(
      () => planBitcoinPsbt(psbtWith([trInput({ sighashType: SigHash.ALL })]), [{ index: 0, key }]),
      "unsupported",
    );
    // SIGHASH_NONE on a segwit input.
    chainError(
      () => planBitcoinPsbt(psbtWith([wpkhInput(ownPub, SigHash.NONE)]), [{ index: 0, key }]),
      "unsupported",
    );
    // SIGHASH_SINGLE|ANYONECANPAY without a same-index output (index 1, one output).
    chainError(
      () =>
        planBitcoinPsbt(
          psbtWith([wpkhInput(), wpkhInput(ownPub, SigHash.SINGLE_ANYONECANPAY)], 1),
          [{ index: 1, key }],
        ),
      "unsupported",
    );
  });

  it("refuses inputs the declared key cannot satisfy", () => {
    // A P2WSH multisig that contains the key.
    const ms = p2ms(1, [ownPub]);
    const wsh = p2wsh(ms, NETWORK);
    const wshInput = {
      txid: fromHex(funding(wsh.script, 100000n).txid),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: wsh.script, amount: 100000n },
      witnessScript: ms.script,
    };
    chainError(() => planBitcoinPsbt(psbtWith([wshInput]), [{ index: 0, key }]), "invalid-request");
    // P2WPKH and P2PKH inputs of another key.
    chainError(
      () => planBitcoinPsbt(psbtWith([wpkhInput(otherPub)]), [{ index: 0, key }]),
      "invalid-request",
    );
    chainError(
      () => planBitcoinPsbt(psbtWith([pkhInput(otherPub)]), [{ index: 0, key }]),
      "invalid-request",
    );
  });
});

describe("planBitcoinMessage refusals", () => {
  const ownPriv = new Uint8Array(32).fill(7);
  const ownPub = secp256k1.getPublicKey(ownPriv, true);
  const otherPub = secp256k1.getPublicKey(new Uint8Array(32).fill(9), true);
  const key: TaskKey = { path: [], publicKey: ownPub };
  const req = (address: string, format: "bip322-simple" | "legacy") => ({
    network: MAINNET,
    address,
    message: "hi",
    format,
  });

  it("refuses the addresses of other keys, wrong formats and wrong networks", () => {
    const otherPkh = p2pkh(otherPub, NETWORK).address ?? "";
    const otherWpkh = p2wpkh(otherPub, NETWORK).address ?? "";
    const otherTr = p2tr(otherPub.slice(1), undefined, NETWORK).address ?? "";
    const ownWpkh = p2wpkh(ownPub, NETWORK).address ?? "";
    const ownPkh = p2pkh(ownPub, NETWORK).address ?? "";
    const testnet = p2wpkh(ownPub, TEST_NETWORK).address ?? "";

    chainError(() => planBitcoinMessage(req(otherPkh, "legacy"), key), "invalid-request");
    chainError(() => planBitcoinMessage(req(otherWpkh, "bip322-simple"), key), "invalid-request");
    chainError(() => planBitcoinMessage(req(otherTr, "bip322-simple"), key), "invalid-request");
    // legacy format on a segwit address, bip322 on a pkh address.
    chainError(() => planBitcoinMessage(req(ownWpkh, "legacy"), key), "invalid-request");
    chainError(() => planBitcoinMessage(req(ownPkh, "bip322-simple"), key), "invalid-request");
    // A testnet address on the mainnet request.
    chainError(() => planBitcoinMessage(req(testnet, "bip322-simple"), key), "invalid-address");
    // A 32-byte key.
    chainError(
      () =>
        planBitcoinMessage(req(ownWpkh, "bip322-simple"), { path: [], publicKey: ownPub.slice(1) }),
      "invalid-request",
    );
  });
});

describe("assembleBitcoinPsbt malformed plans", () => {
  it("refuses a plan whose inputs list is shorter than its tasks", () => {
    const seed = mnemonicToSeedSync(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const priv = HDKey.fromMasterSeed(seed).derive("m/84'/0'/0'/0/0").privateKey;
    if (priv === null) {
      throw new Error("unreachable");
    }
    const pub = secp256k1.getPublicKey(priv, true);
    const tx = new Transaction({ version: 2 });
    const prev = funding(p2wpkh(pub, NETWORK).script, 100000n);
    tx.addInput({
      txid: fromHex(prev.txid),
      index: 0,
      witnessUtxo: { script: p2wpkh(pub, NETWORK).script, amount: 100000n },
    });
    tx.addOutput({ script: PAYEE, amount: 5000n });
    const psbt = tx.toPSBT(0);
    const plan = planBitcoinPsbt(psbt, [{ index: 0, key: { path: [], publicKey: pub } }]);
    const sigs = plan.tasks.map((task) => signBitcoinTask(task, priv, new Uint8Array(32)));
    const malformed = { ...plan, inputs: [] };
    chainError(() => assembleBitcoinPsbt(malformed, sigs), "invalid-signature");
  });
});
