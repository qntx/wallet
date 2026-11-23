// `pinnedMaterial` on a card-shaped pin answers the same `PublicMaterial` a tap cached into the
// record body: public derivation below a cached node, an exact hit for ed25519, `device-required`
// for anything the tap did not leave behind. Compared against the seed's own material for every
// account template, and against vectors/card/derivation.json's template paths for the vector seed.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import Slip10 from "micro-key-producer/slip10.js";
import { describe, expect, it } from "vite-plus/test";

import type { KeyPath } from "@qntx/wallet-chains";
import type { ChainTemplate } from "@qntx/wallet/protocol";

import { pinnedMaterial } from "../src/derive/pinned.ts";
import { KernelError } from "../src/errors.ts";
import { cardPin } from "../src/modules/card/record.ts";
import type { CardWalletBody } from "../src/modules/card/record.ts";
import { prepareBitcoin } from "../src/modules/chains/bitcoin.ts";
import { accountFor } from "../src/modules/chains/index.ts";
import { seedKeys } from "../src/modules/chains/keys.ts";
import { wipe } from "../src/secret/secret.ts";
import { entropyFromMnemonic } from "../src/seed/mnemonic.ts";
import { seedFromEntropy } from "../src/seed/seed.ts";
import { subtlePbkdf2 } from "./helpers.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const HARDENED = 0x80000000;
const BTC_MAINNET = "bip122:000000000019d6689c085ae165831e93";
const BTC_TESTNET = "bip122:00000000da84f2bafbbc53dee25a72ae";

const derivation = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/card/derivation.json"), "utf8"),
) as {
  templates: {
    seed: string;
    masterPublicKey: string;
    secp256k1: Array<{ name: string; path: string; publicKey: string }>;
    ed25519: Array<{ name: string; path: string; publicKey: string }>;
  };
};

const parsePath = (path: string): KeyPath =>
  path
    .slice(2)
    .split("/")
    .map((segment) =>
      segment.endsWith("'") ? Number(segment.slice(0, -1)) + HARDENED : Number(segment),
    );

const cardMaterial = (body: CardWalletBody) => pinnedMaterial(cardPin(body));

const isDeviceRequired = (error: unknown): boolean =>
  error instanceof KernelError && error.code === "device-required";

/* The vector entries the tap's registration set covers publicly — the rest need a card. */
const SECP_COVERED = new Set(["evm", "tron", "btc-bip84-account", "btc-bip84", "btc-bip86"]);
const ED_COVERED = new Set(["solana", "solana-1", "solana-2"]);
const secpCovered = derivation.templates.secp256k1.filter((entry) => SECP_COVERED.has(entry.name));
const secpUncovered = derivation.templates.secp256k1.filter(
  (entry) => !SECP_COVERED.has(entry.name),
);
const edCovered = derivation.templates.ed25519.filter((entry) => ED_COVERED.has(entry.name));
const edUncovered = derivation.templates.ed25519.filter((entry) => !ED_COVERED.has(entry.name));

/** The registration set a create/import tap caches — every node the wallet needs publicly. */
const cardBody = (seed: Uint8Array): CardWalletBody => {
  const master = HDKey.fromMasterSeed(seed);
  const slip = Slip10.fromMasterSeed(seed);
  try {
    const masterPublic = master.publicKey;
    if (masterPublic === null) {
      throw new Error("no master public key");
    }
    const nodes: Record<string, { key: string; chainCode: string }> = {};
    const add = (path: string): void => {
      const node = master.derive(path);
      try {
        const { publicKey } = node;
        if (publicKey === null) {
          throw new Error(`no public key at ${path}`);
        }
        const { chainCode } = node;
        if (chainCode === null) {
          throw new Error(`no chain code at ${path}`);
        }
        nodes[path] = {
          key: bytesToHex(publicKey),
          chainCode: bytesToHex(chainCode),
        };
      } finally {
        node.wipePrivateData();
      }
    };
    add("m/44'/60'/0'");
    add("m/44'/195'/0'");
    for (const purpose of [44, 49, 84, 86]) {
      add(`m/${purpose}'/0'`);
      for (let group = 0; group < 3; group += 1) {
        add(`m/${purpose}'/0'/${group}'`);
      }
    }
    const ed25519Keys: Record<string, string> = {};
    for (let group = 0; group < 3; group += 1) {
      const node = slip.derive(`m/44'/501'/${group}'/0'`);
      try {
        const { privateKey } = node;
        if (privateKey === null) {
          throw new Error("no private key");
        }
        ed25519Keys[`m/44'/501'/${group}'/0'`] = bytesToHex(ed25519.getPublicKey(privateKey));
      } finally {
        wipe(node.privateKey);
      }
    }
    return {
      master: bytesToHex(masterPublic),
      nodes,
      ed25519: ed25519Keys,
      ephemerals: {},
    };
  } finally {
    master.wipePrivateData();
    wipe(slip.privateKey);
  }
};

const vectorMaterial = cardMaterial(cardBody(hexToBytes(derivation.templates.seed)));

const TEMPLATES: ReadonlyArray<readonly [ChainTemplate, string]> = [
  ["evm.bip44", "eip155:1"],
  ["solana.bip44-change", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
  ["tron.bip44", "tron:728126428"],
  ["btc.bip44", BTC_MAINNET],
  ["btc.bip49", BTC_MAINNET],
  ["btc.bip84", BTC_MAINNET],
  ["btc.bip86", BTC_MAINNET],
];

describe("pinnedMaterial on a card pin", () => {
  it("answers every template's account like the seed's own material", async () => {
    const seed = await seedFromEntropy(entropyFromMnemonic(MNEMONIC), "", subtlePbkdf2);
    const keys = seedKeys(seed, () => new Uint8Array(32));
    try {
      const material = cardMaterial(cardBody(Uint8Array.from(seed)));
      await Promise.all(
        TEMPLATES.flatMap(([template, network]) =>
          [0, 1, 2].map(async (group) => {
            await expect(accountFor(material, template, network, group)).resolves.toStrictEqual(
              await accountFor(keys.material, template, network, group),
            );
          }),
        ),
      );
    } finally {
      keys.wipe();
      wipe(seed);
    }
  });

  /* The registration set covers account nodes plus the unhardened tails below them; paths
     whose hardened prefixes were never cached answer device-required. */
  it.each(secpCovered.map((entry) => [entry.name, entry] as const))(
    "answers the derivation vector's secp256k1 path for %s",
    async (_name, entry) => {
      await expect(vectorMaterial.secp256k1(parsePath(entry.path))).resolves.toStrictEqual(
        hexToBytes(entry.publicKey),
      );
    },
  );

  it.each(secpUncovered.map((entry) => [entry.name, entry] as const))(
    "answers device-required below an uncached hardened prefix for %s",
    async (_name, entry) => {
      await expect(vectorMaterial.secp256k1(parsePath(entry.path))).rejects.toSatisfy(
        isDeviceRequired,
      );
    },
  );

  it.each(edCovered.map((entry) => [entry.name, entry] as const))(
    "answers the derivation vector's ed25519 path for %s",
    async (_name, entry) => {
      await expect(vectorMaterial.ed25519(parsePath(entry.path))).resolves.toStrictEqual(
        hexToBytes(entry.publicKey),
      );
    },
  );

  it.each(edUncovered.map((entry) => [entry.name, entry] as const))(
    "answers device-required for the uncached ed25519 path %s",
    async (_name, entry) => {
      await expect(vectorMaterial.ed25519(parsePath(entry.path))).rejects.toSatisfy(
        isDeviceRequired,
      );
    },
  );

  it("a cache miss, a testnet xpub and a hardened step below the cache answer device-required", async () => {
    const seed = await seedFromEntropy(entropyFromMnemonic(MNEMONIC), "", subtlePbkdf2);
    try {
      const material = cardMaterial(cardBody(seed));
      // The master resolves; a group the tap never cached does not.
      await expect(material.secp256k1([])).resolves.toHaveLength(33);
      await expect(accountFor(material, "btc.bip84", BTC_MAINNET, 3)).rejects.toSatisfy(
        isDeviceRequired,
      );
      // Every bitcoin testnet coin type is 1', below an uncached hardened step.
      await expect(accountFor(material, "btc.bip84", BTC_TESTNET, 0)).rejects.toSatisfy(
        isDeviceRequired,
      );
      // m/44'/60'/0' is cached but the next index is hardened.
      await expect(
        material.secp256k1([44 + HARDENED, 60 + HARDENED, HARDENED, HARDENED]),
      ).rejects.toSatisfy(isDeviceRequired);
      // ed25519 is exact-hit only — the account parent alone is never enough.
      await expect(material.ed25519([44 + HARDENED, 501 + HARDENED, HARDENED])).rejects.toSatisfy(
        isDeviceRequired,
      );
      // An xpub's parent must resolve too.
      await expect(
        material.extendedPublicKey([84 + HARDENED, HARDENED, 3 + HARDENED], {
          private: 0x045f18bc,
          public: 0x045f1cf6,
        }),
      ).rejects.toSatisfy(isDeviceRequired);
    } finally {
      wipe(seed);
    }
  });

  it("a PSBT whose input path is a cache miss answers device-required, never external", async () => {
    const seed = await seedFromEntropy(entropyFromMnemonic(MNEMONIC), "", subtlePbkdf2);
    const master = HDKey.fromMasterSeed(seed);
    try {
      const material = cardMaterial(cardBody(Uint8Array.from(seed)));
      const child = master.derive("m/84'/0'/3'/0/0");
      const pub = child.publicKey!;
      const spend = p2wpkh(pub);
      const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
      prev.addInput({
        txid: hexToBytes("1111".repeat(16)),
        index: 0,
        sequence: 0xffffffff,
      });
      prev.addOutput({ script: spend.script, amount: 100_000n });
      const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
      tx.addInput({
        txid: hexToBytes(prev.id),
        index: 0,
        sequence: 0xff_ff_ff_fd,
        witnessUtxo: { script: spend.script, amount: 100_000n },
        nonWitnessUtxo: prev.toBytes(true, false),
        bip32Derivation: [
          [
            pub,
            {
              fingerprint: master.fingerprint,
              path: [84 + HARDENED, HARDENED, 3 + HARDENED, 0, 0],
            },
          ],
        ],
      });
      tx.addOutput({ script: spend.script, amount: 90_000n });
      const request = {
        kind: "bitcoin.psbt" as const,
        network: BTC_MAINNET,
        account: {
          kind: "hd" as const,
          walletId: "w",
          groupIndex: 3,
          template: "btc.bip84" as const,
        },
        psbt: tx.toPSBT(),
        sign: [{ index: 0, template: "btc.bip84" as const }],
      };
      // m/84'/0'/3' was never cached: the ownership probe must not be swallowed as "not ours".
      await expect(prepareBitcoin(request, request.account, material)).rejects.toSatisfy(
        isDeviceRequired,
      );
    } finally {
      master.wipePrivateData();
      wipe(seed);
    }
  });
});
