// oxlint-disable vitest/no-conditional-in-test, vitest/no-conditional-expect -- artefact comparison narrows on artefact kind and per-input signature shape
// oxlint-disable typescript/require-await -- backend stubs satisfy the async contract synchronously
/**
 * Chain key sources and plan execution — seedKeys' BIP-32/SLIP-10 material against independent
 * derivations, backend aux-randomness accounting, wipe semantics, importedKeys' single-key surface,
 * and run.ts driving the committed signing-plan vectors through a seed backend.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import type { Versions } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import { describe, expect, it } from "vite-plus/test";

import type { KeyPath, SignTask } from "@qntx/wallet-chains";
import { ChainError } from "@qntx/wallet-chains";
import { planBitcoinMessage, planBitcoinPsbt } from "@qntx/wallet-chains/bitcoin";
import { planEvm } from "@qntx/wallet-chains/evm";
import { planSolana } from "@qntx/wallet-chains/solana";
import { planTron } from "@qntx/wallet-chains/tron";

import { KernelError } from "../src/errors.ts";
import { importedKeys, pathString, seedKeys } from "../src/modules/chains/keys.ts";
import type { TaskSigner } from "../src/modules/chains/keys.ts";
import { signPlan, taskSignerFor } from "../src/modules/chains/run.ts";
import { seededRandom } from "./harness.ts";

const HARDENED = 0x80000000;

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/signing-plans.json"), "utf8"),
) as {
  readonly mnemonic: string;
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly key?: { readonly path: ReadonlyArray<number>; readonly publicKey: string };
    readonly request: Record<string, unknown> & { readonly kind: string };
    readonly stages: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
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

const fromHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const kernelError = async (fn: () => unknown, code?: string): Promise<void> => {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(KernelError);
  if (code !== undefined) {
    expect((thrown as KernelError).code).toBe(code);
  }
};

describe("seedKeys material", () => {
  const PATHS: ReadonlyArray<readonly [string, KeyPath]> = [
    ["m", []],
    ["m/44'/60'/0'/0/0", [44 + HARDENED, 60 + HARDENED, HARDENED, 0, 0]],
    ["m/44'/195'/0'/0/0", [44 + HARDENED, 195 + HARDENED, HARDENED, 0, 0]],
    ["m/84'/0'/0'/0/0", [84 + HARDENED, HARDENED, HARDENED, 0, 0]],
    ["m/86'/0'/0'/0/0", [86 + HARDENED, HARDENED, HARDENED, 0, 0]],
  ];

  it("secp256k1 material equals BIP-32 derivation at the master and task paths", async () => {
    const keys = seedKeys(SEED, seededRandom(1).random);
    const root = HDKey.fromMasterSeed(SEED);
    for (const [derivation, path] of PATHS) {
      expect(pathString(path)).toBe(derivation);
      const expected = path.length === 0 ? root : root.derive(derivation);
      // oxlint-disable-next-line no-await-in-loop -- one derivation per iteration, in path order
      await expect(keys.material.secp256k1(path)).resolves.toStrictEqual(expected.publicKey);
    }
    keys.wipe();
  });

  it("ed25519 material equals the SLIP-10 key", async () => {
    const keys = seedKeys(SEED, seededRandom(1).random);
    const path: KeyPath = [44 + HARDENED, 501 + HARDENED, HARDENED, HARDENED];
    const expected = ed25519.getPublicKey(
      Slip10.fromMasterSeed(SEED).derive("m/44'/501'/0'/0'").privateKey,
    );
    await expect(keys.material.ed25519(path)).resolves.toStrictEqual(expected);
    keys.wipe();
  });

  it("extendedPublicKey serializes under the requested version bytes", async () => {
    const path: KeyPath = [84 + HARDENED, HARDENED, HARDENED];
    const versions: ReadonlyArray<readonly [Versions, string]> = [
      [{ public: 0x0488b21e, private: 0x0488ade4 }, "xpub"],
      [{ public: 0x043587cf, private: 0x04358394 }, "tpub"],
    ];
    for (const [v, prefix] of versions) {
      const keys = seedKeys(SEED, seededRandom(1).random);
      const expected = HDKey.fromMasterSeed(SEED, v).derive("m/84'/0'/0'").publicExtendedKey;
      // oxlint-disable-next-line no-await-in-loop -- one source per version row
      const xpub = await keys.material.extendedPublicKey(path, v);
      expect(xpub).toBe(expected);
      expect(xpub.startsWith(prefix)).toBe(true);
      keys.wipe();
    }
  });
});

describe("seedKeys backend", () => {
  const ecdsaTask: SignTask = {
    scheme: "ecdsa-secp256k1",
    path: [44 + HARDENED, 60 + HARDENED, HARDENED, 0, 0],
    publicKey: new Uint8Array(33),
    digest: new Uint8Array(32),
  };
  const bip340Task: SignTask = {
    scheme: "bip340",
    path: [86 + HARDENED, HARDENED, HARDENED, 0, 0],
    publicKey: new Uint8Array(32),
    message: new Uint8Array(32),
    tweak: new Uint8Array(32),
  };
  const ed25519Task: SignTask = {
    scheme: "ed25519",
    path: [44 + HARDENED, 501 + HARDENED, HARDENED, HARDENED],
    publicKey: new Uint8Array(32),
    message: new Uint8Array(4),
  };

  it("draws random(32) exactly once per bip340 task and never for other schemes", async () => {
    const draws: number[] = [];
    const keys = seedKeys(SEED, (n) => {
      draws.push(n);
      return new Uint8Array(n).fill(9);
    });
    const calls: Array<{ priv: Uint8Array; aux: Uint8Array }> = [];
    const spy: TaskSigner = (_task, priv, aux) => {
      calls.push({ priv, aux });
      return new Uint8Array(64);
    };
    const backend = keys.backend(spy);
    await backend.sign(ecdsaTask);
    await backend.sign(ed25519Task);
    expect(draws).toHaveLength(0);
    await backend.sign(bip340Task);
    await backend.sign(bip340Task);
    expect(draws).toStrictEqual([32, 32]);
    expect(calls[0]?.aux).toHaveLength(0);
    expect(calls[1]?.aux).toHaveLength(0);
    expect(calls[2]?.aux).toStrictEqual(new Uint8Array(32).fill(9));
    const root = HDKey.fromMasterSeed(SEED);
    expect(calls[0]?.priv).toStrictEqual(root.derive("m/44'/60'/0'/0/0").privateKey);
    expect(calls[1]?.priv).toStrictEqual(
      Slip10.fromMasterSeed(SEED).derive("m/44'/501'/0'/0'").privateKey,
    );
    expect(calls[2]?.priv).toStrictEqual(root.derive("m/86'/0'/0'/0/0").privateKey);
    keys.wipe();
  });

  it("wipe closes the source and zeroes the cached private nodes", async () => {
    const keys = seedKeys(SEED, seededRandom(2).random);
    const seen: Uint8Array[] = [];
    const spy: TaskSigner = (_task, priv) => {
      seen.push(priv);
      return new Uint8Array(64);
    };
    const backend = keys.backend(spy);
    await backend.sign(ecdsaTask);
    await backend.sign(ed25519Task);
    expect(seen).toHaveLength(2);
    expect(seen.every((p) => p.some((b) => b !== 0))).toBe(true);
    keys.wipe();
    // The SLIP-10 node's privateKey field is the same array wipe() zeroes. BIP-32's
    // privateKey getter hands out copies, so its zeroing is internal to the node.
    expect(seen[1]?.every((b) => b === 0)).toBe(true);
    await kernelError(async () => keys.material.secp256k1([]), "integrity");
    await kernelError(async () => keys.material.ed25519([]), "integrity");
    await kernelError(async () => backend.sign(ecdsaTask), "integrity");
    await kernelError(
      async () => keys.material.extendedPublicKey([], { public: 0x0488b21e, private: 0x0488ade4 }),
      "integrity",
    );
  });
});

describe("importedKeys", () => {
  const SECRET = new Uint8Array(32).fill(0x11);
  const honest: TaskSigner = () => new Uint8Array(64);

  it("a secp256k1 import serves only its own curve at []", async () => {
    const keys = importedKeys(new Uint8Array(SECRET), "secp256k1", () => new Uint8Array(32));
    await expect(keys.material.secp256k1([])).resolves.toStrictEqual(
      secp256k1.getPublicKey(SECRET, true),
    );
    await kernelError(async () => keys.material.secp256k1([0]), "integrity");
    await kernelError(async () => keys.material.ed25519([]), "integrity");
    await kernelError(
      async () => keys.material.extendedPublicKey([], { public: 0x0488b21e, private: 0x0488ade4 }),
      "integrity",
    );
    const backend = keys.backend(honest);
    await backend.sign(atRoot("ecdsa-secp256k1"));
    await backend.sign(atRoot("bip340"));
    await kernelError(async () => backend.sign(atRoot("ed25519")), "integrity");
    await kernelError(
      async () => backend.sign({ ...atRoot("ecdsa-secp256k1"), path: [0] }),
      "integrity",
    );
    keys.wipe();
  });

  it("an ed25519 import serves only its own curve at []", async () => {
    const keys = importedKeys(new Uint8Array(SECRET), "ed25519", () => new Uint8Array(32));
    await expect(keys.material.ed25519([])).resolves.toStrictEqual(ed25519.getPublicKey(SECRET));
    await kernelError(async () => keys.material.secp256k1([]), "integrity");
    const backend = keys.backend(honest);
    await backend.sign(atRoot("ed25519"));
    await kernelError(async () => backend.sign(atRoot("ecdsa-secp256k1")), "integrity");
    await kernelError(async () => backend.sign(atRoot("bip340")), "integrity");
    keys.wipe();
    await kernelError(async () => keys.material.ed25519([]), "integrity");
  });
});

describe("run.ts plan execution", () => {
  const ACCOUNT = {
    kind: "hd",
    walletId: "vectors",
    groupIndex: 0,
    template: "evm.bip44",
  } as const;
  const BYTE_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
    "evm.personal-message": ["message"],
    "tron.transaction": ["rawData"],
    "tron.message": ["message"],
    "solana.transaction": ["message"],
    "solana.message": ["message"],
    "bitcoin.psbt": ["psbt"],
  };

  const requestOf = (c: (typeof vectors.cases)[number]): Record<string, unknown> => {
    const request: Record<string, unknown> = { ...c.request, account: ACCOUNT };
    for (const field of BYTE_FIELDS[c.request.kind] ?? []) {
      const value = request[field];
      if (typeof value === "string") {
        request[field] = fromHex(value);
      }
    }
    return request;
  };

  const planFor = (c: (typeof vectors.cases)[number]) => {
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
    const key = { path: keyVector.path, publicKey: fromHex(keyVector.publicKey) };
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

  const artefactBytes = (result: Record<string, unknown>): Uint8Array | string =>
    (result["signedTransaction"] ?? result["signedPsbt"] ?? result["signature"]) as
      | Uint8Array
      | string;

  /** BIP-340 is deterministic in (msg, tweaked key, aux): zero aux reproduces the vectors. */
  const zeroRandom = (): Uint8Array => new Uint8Array(32);

  it.each(vectors.cases)("$name: seed backend signs to the vector artefact", async (c) => {
    const plan = planFor(c);
    const keys = seedKeys(SEED, zeroRandom);
    try {
      const result = await signPlan(plan, keys.backend(taskSignerFor(plan)));
      expect(result.kind).toBe(c.request.kind);
      const artefact = artefactBytes(result);
      if (typeof c.artefact === "string") {
        // Strings compare exactly; the committed tron byte artefact keeps an uppercase nibble.
        const actual = typeof artefact === "string" ? artefact : toHex(artefact);
        const expected = typeof artefact === "string" ? c.artefact : c.artefact.toLowerCase();
        expect(actual).toBe(expected);
      } else {
        // bitcoin.psbt: the vector carries per-input signature entries, not raw bytes.
        const tx = Transaction.fromPSBT(artefact as Uint8Array);
        for (const entry of c.artefact.signatures) {
          const input = tx.getInput(entry.index);
          const sig =
            typeof entry.partialSig === "string" ? input.partialSig?.[0]?.[1] : input.tapKeySig;
          const want = typeof entry.partialSig === "string" ? entry.partialSig : entry.tapKeySig;
          expect(toHex(sig ?? new Uint8Array())).toBe(want);
        }
      }
    } finally {
      keys.wipe();
    }
  });

  it("a backend returning garbage is mapped to integrity", async () => {
    const c = vectors.cases.find((v) => v.name === "evm-personal-message");
    if (c === undefined) {
      throw new Error("vector case missing");
    }
    const plan = planFor(c);
    const garbage = { sign: async () => new Uint8Array(64) };
    await kernelError(async () => {
      await signPlan(plan, garbage);
    }, "integrity");
    // Only assemble's refusal is mapped; a backend throwing ChainError propagates unchanged.
    const failing = {
      sign: async () => {
        throw new ChainError("invalid-signature", "forged");
      },
    };
    await expect(signPlan(plan, failing)).rejects.toBeInstanceOf(ChainError);
  });

  it("taskSignerFor picks the family's signer", () => {
    const priv = new Uint8Array(32).fill(3);
    const aux = new Uint8Array(32);
    const ecdsa = atRoot("ecdsa-secp256k1");
    const bip340 = atRoot("bip340");
    const ed = atRoot("ed25519");

    const evm = taskSignerFor({ kind: "evm.transaction" } as never);
    expect(evm(ecdsa, priv, aux)).toHaveLength(64);
    expect(() => evm(bip340, priv, aux)).toThrow(ChainError);
    expect(() => evm(ed, priv, aux)).toThrow(ChainError);

    const tron = taskSignerFor({ kind: "tron.message" } as never);
    expect(tron(ecdsa, priv, aux)).toHaveLength(64);
    expect(() => tron(ed, priv, aux)).toThrow(ChainError);

    const solana = taskSignerFor({ kind: "solana.message" } as never);
    expect(solana(ed, priv, aux)).toHaveLength(64);
    expect(() => solana(ecdsa, priv, aux)).toThrow(ChainError);

    const bitcoin = taskSignerFor({ kind: "bitcoin.message" } as never);
    expect(bitcoin(ecdsa, priv, aux)).toHaveLength(64);
    expect(bitcoin(bip340, priv, aux)).toHaveLength(64);
    expect(() => bitcoin(ed, priv, aux)).toThrow(ChainError);
  });
});

/** A minimal task at path [] for signer dispatch checks. */
const atRoot = (scheme: SignTask["scheme"]): SignTask =>
  scheme === "ed25519"
    ? { scheme, path: [], publicKey: new Uint8Array(32), message: new Uint8Array(1) }
    : scheme === "bip340"
      ? {
          scheme,
          path: [],
          publicKey: new Uint8Array(32),
          message: new Uint8Array(32),
          tweak: new Uint8Array(32),
        }
      : { scheme, path: [], publicKey: new Uint8Array(33), digest: new Uint8Array(32) };
