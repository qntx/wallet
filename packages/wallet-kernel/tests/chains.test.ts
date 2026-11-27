/**
 * Chains module `wallet.accounts` through the real protocol: import the vector mnemonic, then
 * derive each template's account and compare against vectors/templates/chains.json (BIP-84/86
 * texts, MetaMask-compatible EVM accounts, SLIP-10-checked Solana).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { SigHash, Transaction } from "@scure/btc-signer/transaction.js";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import { describe, expect, it } from "vite-plus/test";

import type { KeyPath, SignRequest } from "@qntx/wallet-chains";
import {
  bitcoinNetwork,
  decodeBitcoinPsbt,
  normalizeBitcoin,
  verifiabilityBitcoin,
  verifyBitcoinMessage,
  verifyBitcoinPsbtSignatures,
} from "@qntx/wallet-chains/bitcoin";
import {
  DELEGATION_MANAGER,
  encodeBatchExecute,
  EVM_DELEGATOR,
  normalizeEvm,
  recoverEvmSigner,
} from "@qntx/wallet-chains/evm";
import { decodeSolana, normalizeSolana, verifySolanaSignature } from "@qntx/wallet-chains/solana";
import { buildTronRawData, verifyTronTransactionSignature } from "@qntx/wallet-chains/tron";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { KernelError } from "../src/errors.ts";
import { prepareBitcoin } from "../src/modules/chains/bitcoin.ts";
import { seedKeys } from "../src/modules/chains/keys.ts";
import { chainPrompt } from "../src/modules/chains/prompt.ts";
import { signPlan, taskSignerFor } from "../src/modules/chains/run.ts";
import type { Pbkdf2 } from "../src/platform.ts";
import { createHarness } from "./harness.ts";
import type { KernelResponse } from "./harness.ts";
import { subtlePbkdf2 } from "./helpers.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}
function errCode(response: KernelResponse): string | undefined {
  return "err" in response ? response.err.code : undefined;
}
function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const v = value[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
}
function bytesField(value: ProtocolValue, key: string): Uint8Array {
  const v = field(value, key);
  if (!(v instanceof Uint8Array)) {
    throw new TypeError("expected bytes");
  }
  return v;
}
function strField(value: ProtocolValue, key: string): string {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`field ${key}: not a string`);
  }
  return v;
}

const tronTypedDataVectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/tron-typed-data.json"), "utf8"),
) as {
  signer: string;
  cases: Array<{ name: string; typedData: string; signature: string }>;
};

const tronVectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/chains/tron.json"), "utf8"),
) as {
  keys: Array<{ name: string; privateKey: string; address: string }>;
  transactions: Array<{ name: string; rawDataHex: string; signature: string; input: unknown }>;
  messages: Array<{
    name: string;
    privateKey: string;
    address: string;
    messageHex: string;
    signature: string;
  }>;
};

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../vectors/templates/chains.json"), "utf8"),
) as {
  mnemonic: string;
  master: { fingerprint: string };
  evm: {
    template: string;
    network: string;
    accounts: Array<{ groupIndex: number; address: string }>;
  };
  solana: {
    template: string;
    network: string;
    accounts: Array<{ groupIndex: number; address: string }>;
  };
  tron: {
    template: string;
    network: string;
    accounts: Array<{ groupIndex: number; address: string }>;
  };
  bitcoin: Array<{
    template: string;
    network: string;
    path: string;
    xpub: string;
    receive: string[];
    change: string[];
  }>;
};

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const PRF_VAULT = hexToBytes("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
const PASSKEY = () => ({
  kind: "passkey",
  credentialId: new Uint8Array(CREDENTIAL_ID),
  prf: new Uint8Array(PRF_VAULT),
});
const EVM_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const SOL_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
const MASTER_FP = 0x73c5da0a;
const HARDENED = 0x80000000;
const btcVector = (template: string) => {
  const v = vectors.bitcoin.find(
    (entry) => entry.template === template && entry.network === BTC_NETWORK,
  );
  if (v === undefined) {
    throw new Error(`no ${template} mainnet vector`);
  }
  return v;
};

/** Child node of the vector wallet's account at `change/index` under `template`. */
const btcChild = (template: string, change: number, index: number): HDKey =>
  btcChildAt(template, 0, change, index);

/** Same at coin element `coin` — 0' for mainnet, 1' for every test network. */
const btcChildAt = (template: string, coin: number, change: number, index: number): HDKey => {
  const purpose = BTC_PURPOSE_T[template] ?? 84;
  return HDKey.fromMasterSeed(mnemonicToSeedSync(vectors.mnemonic)).derive(
    `m/${purpose}'/${coin}'/0'/${change}/${index}`,
  );
};

const hex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const PAYEE = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
const PAYEE_SCRIPT = OutScript.encode(Address(bitcoinNetwork(BTC_NETWORK).params).decode(PAYEE));
const asPsbt = (r: SignRequest): Extract<SignRequest, { kind: "bitcoin.psbt" }> => {
  if (r.kind !== "bitcoin.psbt") {
    throw new Error("expected bitcoin.psbt");
  }
  return r;
};

type PsbtOpts = {
  readonly template: string;
  readonly change?: number;
  readonly index?: number;
  readonly coin?: number;
  readonly crossScript?: boolean;
  readonly fingerprint?: number;
  readonly wrongPub?: boolean;
  readonly wrongScript?: boolean;
  readonly changeOutput?: boolean;
  readonly foreignOutput?: boolean;
  readonly extraInput?: boolean;
  /** Bip49: keep the our-key prevout and derivation but carry another key's redeemScript. */
  readonly badRedeem?: boolean;
  /** Bip49: carry no redeemScript at all. */
  readonly missingRedeem?: boolean;
  /** Attach a non-default sighash to input 0. */
  readonly sighash?: number;
  /** Bip86: drop tapInternalKey and carry a script-tree merkle root instead. */
  readonly tapMerkleRoot?: boolean;
};

/** A one-input PSBT with correct derivation entries for the vector wallet's account. */
const BTC_PURPOSE_T: Readonly<Record<string, number>> = {
  "btc.bip44": 44,
  "btc.bip49": 49,
  "btc.bip84": 84,
  "btc.bip86": 86,
};

const btcPsbt = (opts: PsbtOpts): Uint8Array => {
  const purpose = BTC_PURPOSE_T[opts.template] ?? 84;
  const change = opts.change ?? 0;
  const index = opts.index ?? 0;
  const fp = opts.fingerprint ?? MASTER_FP;
  const coin = opts.coin ?? 0;
  const foreignPub = btcChild(opts.template, 0, 7).publicKey!;
  const foreignXonly = foreignPub.slice(1);
  const child = btcChildAt(opts.template, coin, change, index);
  const pub = child.publicKey!;
  const xonly = pub.slice(1);
  /* `crossScript` spends the *other* coin's key at the same change/index while the derivation
     entry still claims `coin` — the network the request runs under decides which is wrong. */
  const scriptPub =
    opts.crossScript === true
      ? btcChildAt(opts.template, coin === 0 ? 1 : 0, change, index).publicKey!
      : pub;
  const scriptXonly = scriptPub.slice(1);
  const spend =
    purpose === 86
      ? p2tr(scriptXonly)
      : purpose === 49
        ? p2sh(p2wpkh(scriptPub))
        : purpose === 44
          ? p2pkh(scriptPub)
          : p2wpkh(scriptPub);
  const path = [purpose + HARDENED, coin + HARDENED, HARDENED, change, index];
  // A redeemScript that disagrees with the p2sh prevout is unbuildable without skipping the
  // script-consistency check; the kernel must still refuse the resulting PSBT.
  const tx = new Transaction({
    version: 2,
    allowUnknownOutputs: true,
    ...(opts.badRedeem === true ? { disableScriptCheck: true } : {}),
  });
  const input: Record<string, unknown> = {
    txid: hex("0707".repeat(16)),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: {
      script:
        opts.wrongScript === true
          ? purpose === 86
            ? p2tr(foreignXonly).script
            : p2wpkh(foreignPub).script
          : spend.script,
      amount: 100000n,
    },
  };

  if (purpose === 86) {
    if (opts.tapMerkleRoot === true) {
      input["tapMerkleRoot"] = new Uint8Array(32).fill(0xaa);
    } else {
      input["tapInternalKey"] = opts.wrongScript === true ? foreignXonly : scriptXonly;
    }
    input["tapBip32Derivation"] = [
      [
        opts.wrongPub === true ? foreignPub.slice(1) : xonly,
        { hashes: [], der: { fingerprint: fp, path } },
      ],
    ];
  } else {
    input["bip32Derivation"] = [
      [opts.wrongPub === true ? foreignPub : pub, { fingerprint: fp, path }],
    ];
  }
  if (opts.sighash !== undefined) {
    input["sighashType"] = opts.sighash;
  }
  if (purpose === 49) {
    if (opts.missingRedeem !== true) {
      input["redeemScript"] =
        opts.badRedeem === true || opts.wrongScript === true
          ? p2wpkh(foreignPub).script
          : p2wpkh(scriptPub).script;
    }
    if (opts.wrongScript === true) {
      input["witnessUtxo"] = {
        script: p2sh(p2wpkh(foreignPub)).script,
        amount: 100000n,
      };
    }
  }
  if (purpose !== 86) {
    // Non-taproot spends must carry the full previous transaction — it pays whatever script the
    // (possibly wrong) witnessUtxo declares so the two agree at parse.
    const prevScript =
      purpose === 44
        ? opts.wrongScript === true
          ? p2pkh(foreignPub).script
          : p2pkh(scriptPub).script
        : (input["witnessUtxo"] as { script: Uint8Array }).script;
    const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
    prev.addInput({ txid: hex("1111".repeat(16)), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: prevScript, amount: 100000n });
    input["txid"] = hex(prev.id);
    input["index"] = 0;
    input["nonWitnessUtxo"] = prev.toBytes(true, false);
    if (purpose === 44) {
      delete input["witnessUtxo"];
    }
  }
  tx.addInput(input);
  if (opts.extraInput === true) {
    const foreign = new Transaction({ version: 2, allowUnknownOutputs: true });
    void foreign;
    tx.addInput({
      txid: hex("0808".repeat(16)),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: spend.script, amount: 5000n },
    });
  }
  tx.addOutput({ script: PAYEE_SCRIPT, amount: 90000n });
  if (opts.changeOutput === true) {
    const changePub = btcChild(opts.template, 1, 0).publicKey!;
    const changeScript =
      purpose === 86 ? p2tr(changePub.slice(1)).script : p2wpkh(changePub).script;
    const changePath = [purpose + HARDENED, HARDENED, HARDENED, 1, 0];
    const changeKey = purpose === 86 ? changePub.slice(1) : changePub;
    tx.addOutput({ script: changeScript, amount: 5000n });
    tx.updateOutput(
      1,
      purpose === 86
        ? {
            tapBip32Derivation: [
              [changeKey, { hashes: [], der: { fingerprint: MASTER_FP, path: changePath } }],
            ],
          }
        : { bip32Derivation: [[changeKey, { fingerprint: MASTER_FP, path: changePath }]] },
    );
  }
  return tx.toPSBT(0);
};

/** A one-input PSBT spending `script` via a bip84 derivation; `nonWitness` is the raw prev tx. */
const prevoutPsbt = (
  pub: Uint8Array,
  script: Uint8Array,
  nonWitness: Uint8Array | undefined,
): Uint8Array => {
  const tx = new Transaction({ version: 2 });
  const prev = new Transaction({ version: 2 });
  prev.addInput({ txid: hex("0707".repeat(16)), index: 0, sequence: 0xffffffff });
  prev.addOutput({ script, amount: 100000n });
  tx.addInput({
    txid: nonWitness === undefined ? hex("0707".repeat(16)) : prev.id,
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script, amount: 100000n },
    ...(nonWitness === undefined ? {} : { nonWitnessUtxo: nonWitness }),
    bip32Derivation: [
      [pub, { fingerprint: MASTER_FP, path: [0x80000054, HARDENED, HARDENED, 0, 0] }],
    ],
  });
  tx.addOutput({ script: PAYEE_SCRIPT, amount: 90000n });
  return tx.toPSBT(0);
};

/**
 * Rewrite input 0's witnessUtxo amount inside a serialized PSBT. btc-signer refuses a disagreeing
 * witness/nonWitness pair at construction, so the lie exists only on the wire.
 */
const lieWitness = (psbt: Uint8Array, amount: bigint): Uint8Array => {
  const out = new Uint8Array(psbt);
  // witnessUtxo KV: keyLen 0x01, key 0x01, valueLen 0x1f, then LE64 amount before the script.
  const mark = [0x01, 0x01, 0x1f, 0xa0, 0x86, 0x01];
  outer: for (let i = 0; i + mark.length + 8 <= out.length; i++) {
    for (let j = 0; j < mark.length; j++) {
      if (out[i + j] !== mark[j]) {
        continue outer;
      }
    }
    new DataView(out.buffer, out.byteOffset).setBigUint64(i + 3, amount, true);
    return out;
  }
  throw new Error("witnessUtxo field not found");
};

/** A compiled legacy message: SetComputeUnitPrice(5e12 microlamports) + a 0.001 SOL transfer. */
const cuPriceMessage = (): Uint8Array => {
  const seed = mnemonicToSeedSync(vectors.mnemonic);
  const priv = Slip10.fromMasterSeed(seed).derive("m/44'/501'/0'/0'").privateKey;
  const payer = ed25519.getPublicKey(priv);
  const dest = new Uint8Array(32).fill(0x22);
  const system = base58.decode("11111111111111111111111111111111");
  const budget = base58.decode("ComputeBudget111111111111111111111111111111");
  const price = new Uint8Array(9);
  price[0] = 3;
  new DataView(price.buffer).setBigUint64(1, 5_000_000_000_000n, true);
  const transfer = new Uint8Array(12);
  const dv = new DataView(transfer.buffer);
  dv.setUint32(0, 2, true);
  dv.setBigUint64(4, 1_000_000n, true);
  const ix1 = [3, 0, 9, ...price];
  const ix2 = [2, 2, 0, 1, 12, ...transfer];
  return new Uint8Array([
    1,
    0,
    2,
    4,
    ...payer,
    ...dest,
    ...system,
    ...budget,
    ...new Uint8Array(32).fill(0x33),
    2,
    ...ix1,
    ...ix2,
  ]);
};

/** A legacy Solana transfer whose fee payer is account 0's public key. */
const solanaTransferMessage = (): Uint8Array => {
  const seed = mnemonicToSeedSync(vectors.mnemonic);
  const priv = Slip10.fromMasterSeed(seed).derive("m/44'/501'/0'/0'").privateKey;
  const fp = ed25519.getPublicKey(priv);
  const dest = new Uint8Array(32).fill(0x22);
  const system = new Uint8Array(32);
  system[31] = 2;
  const blockhash = new Uint8Array(32).fill(0x33);
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true);
  dv.setBigUint64(4, 1000n, true);
  return new Uint8Array([
    1,
    0,
    1,
    3,
    ...fp,
    ...dest,
    ...system,
    ...blockhash,
    1,
    2,
    2,
    0,
    1,
    12,
    ...data,
  ]);
};

const hd = (walletId: string, template: string) => ({
  kind: "hd",
  walletId,
  groupIndex: 0,
  template,
});

const grp = (walletId: string, groupIndex = 0) => ({ kind: "hd", walletId, groupIndex });
const entry = (index: number, template: string) => ({ index, template });

/** A PBKDF2 that counts BIP-39 seed derivations (the only SHA-512 use). */
const seedSpy = (): { readonly pbkdf2: Pbkdf2; readonly seeds: () => number } => {
  const hashes: string[] = [];
  return {
    pbkdf2: async (hash, password, salt, iterations, length) => {
      hashes.push(hash);
      return subtlePbkdf2(hash, password, salt, iterations, length);
    },
    seeds: () => hashes.filter((hash) => hash === "sha512").length,
  };
};

describe("wallet.accounts", () => {
  const setup = async () => {
    const h = createHarness();
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(vectors.mnemonic),
        factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    return {
      h,
      session: strField(res, "session"),
      walletId: strField(field(res, "wallet"), "walletId"),
    };
  };

  it("derives each account once per session and again after a lock", async () => {
    const spy = seedSpy();
    const h = createHarness({ maxSessionMs: 60_000, pbkdf2: spy.pbkdf2 });
    await h.settle();
    const imported = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(vectors.mnemonic),
        factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    const walletId = strField(field(imported, "wallet"), "walletId");
    const params = {
      walletId,
      groupIndex: 0,
      template: vectors.evm.template,
      network: vectors.evm.network,
    };
    const accounts = async (session: string) =>
      field(ok(await h.call("wallet.accounts", params, session)), "address");
    let session = strField(imported, "session");
    const before = spy.seeds();
    const address = await accounts(session);
    const again = await Promise.all(Array.from({ length: 5 }, async () => accounts(session)));
    expect(again).toStrictEqual(Array.from({ length: 5 }, () => address));
    expect(spy.seeds() - before).toBe(1);
    h.advance(60_001);
    expect(field(ok(await h.call("status")), "vault")).toBe("locked");
    session = strField(ok(await h.call("vault.unlock", { factor: PASSKEY() })), "session");
    const unlocked = spy.seeds();
    await expect(accounts(session)).resolves.toBe(address);
    expect(spy.seeds() - unlocked).toBe(1);
  });

  it("derives the vector EVM accounts", async () => {
    const { h, session, walletId } = await setup();
    const results = await Promise.all(
      vectors.evm.accounts.map(async ({ groupIndex }) =>
        h.call(
          "wallet.accounts",
          { walletId, groupIndex, template: vectors.evm.template, network: vectors.evm.network },
          session,
        ),
      ),
    );
    for (const [i, { address }] of vectors.evm.accounts.entries()) {
      expect(field(ok(results[i]!), "address")).toBe(address);
    }
  });

  it("derives the vector Solana accounts", async () => {
    const { h, session, walletId } = await setup();
    const results = await Promise.all(
      vectors.solana.accounts.map(async ({ groupIndex }) =>
        h.call(
          "wallet.accounts",
          {
            walletId,
            groupIndex,
            template: vectors.solana.template,
            network: vectors.solana.network,
          },
          session,
        ),
      ),
    );
    for (const [i, { address }] of vectors.solana.accounts.entries()) {
      expect(field(ok(results[i]!), "address")).toBe(address);
    }
  });

  it("derives the vector TRON accounts", async () => {
    const { h, session, walletId } = await setup();
    const results = await Promise.all(
      vectors.tron.accounts.map(async ({ groupIndex }) =>
        h.call(
          "wallet.accounts",
          {
            walletId,
            groupIndex,
            template: vectors.tron.template,
            network: vectors.tron.network,
          },
          session,
        ),
      ),
    );
    for (const [i, { address }] of vectors.tron.accounts.entries()) {
      expect(field(ok(results[i]!), "address")).toBe(address);
    }
  });

  it("derives the vector Bitcoin account xpubs and paths", async () => {
    const { h, session, walletId } = await setup();
    const results = await Promise.all(
      vectors.bitcoin.map(async (v) =>
        h.call(
          "wallet.accounts",
          { walletId, groupIndex: 0, template: v.template, network: v.network },
          session,
        ),
      ),
    );
    for (const [i, v] of vectors.bitcoin.entries()) {
      const res = ok(results[i]!);
      expect(field(res, "xpub")).toBe(v.xpub);
      expect(field(res, "fingerprint")).toBe(vectors.master.fingerprint);
      expect(field(res, "path")).toBe(v.path);
    }
  });

  it("separates bitcoin accounts by coin type — 0' mainnet, 1' for every test network", async () => {
    const { h, session, walletId } = await setup();
    const TEST_NETS = [
      "bip122:00000000da84f2bafbbc53dee25a72ae", // testnet
      "bip122:00000008819873e925422c1ff0f99f7c", // signet
      "bip122:0f9188f13cb7b2c71f2a335e3a4fc328", // regtest
    ];
    const NETWORKS = [BTC_NETWORK, ...TEST_NETS];
    const TEMPLATES: ReadonlyArray<readonly [string, number]> = [
      ["btc.bip44", 44],
      ["btc.bip49", 49],
      ["btc.bip84", 84],
      ["btc.bip86", 86],
    ];
    const results = await Promise.all(
      TEMPLATES.flatMap(([template]) =>
        NETWORKS.map(async (network) =>
          ok(
            await h.call(
              "wallet.accounts",
              { walletId, groupIndex: 0, template, network },
              session,
            ),
          ),
        ),
      ),
    );
    for (const [t, [, purpose]] of TEMPLATES.entries()) {
      const at = (n: number) => results[t * NETWORKS.length + n]!;
      const main = at(0);
      expect(field(main, "path")).toBe(`m/${purpose}'/0'/0'`);
      for (const n of [1, 2, 3]) {
        const test = at(n);
        expect(field(test, "path")).toBe(`m/${purpose}'/1'/0'`);
        expect(field(test, "xpub")).not.toBe(field(main, "xpub"));
        /* No value lives on the test networks, so they share the coin-1' account. */
        expect(field(test, "xpub")).toBe(field(at(1), "xpub"));
      }
    }
  });

  it("rejects a family/network mismatch and a missing wallet", async () => {
    const { h, session, walletId } = await setup();
    const mismatch = await h.call(
      "wallet.accounts",
      {
        walletId,
        groupIndex: 0,
        template: "evm.bip44",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      },
      session,
    );
    expect("err" in mismatch).toBe(true);
    const results = await Promise.all(
      ["eip155:1", "tron:0x2b6653dc"].map(async (network) =>
        h.call(
          "wallet.accounts",
          { walletId, groupIndex: 0, template: "tron.bip44", network },
          session,
        ),
      ),
    );
    for (const res of results) {
      expect(errCode(res)).toBe("invalid-input");
    }
    const missing = await h.call(
      "wallet.accounts",
      { walletId: "0000000000000000", groupIndex: 0, template: "evm.bip44", network: "eip155:1" },
      session,
    );
    expect("err" in missing).toBe(true);
  });
});

describe("chain.sign", () => {
  const setup = async () => {
    const h = createHarness();
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(vectors.mnemonic),
        factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    const session = strField(res, "session");
    ok(await h.call("vault.setBlindSigning", { enabled: true, verify: PASSKEY() }, session));
    return { h, session, walletId: strField(field(res, "wallet"), "walletId") };
  };

  const callSign = async (
    h: ReturnType<typeof createHarness>,
    session: string,
    request: unknown,
    verify: unknown = PASSKEY(),
  ) => h.call("chain.sign", { request, verify }, session);

  it("signs an eip1559 transaction, personal message and typed data", async () => {
    const { h, session, walletId } = await setup();
    const account = hd(walletId, "evm.bip44");
    const txReq = normalizeEvm({
      kind: "evm.transaction",
      network: "eip155:1",
      account,
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        value: "0x0",
        data: "0x",
        to: "0x00000000000000000000000000000000deadbeef",
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x1",
        accessList: [],
      },
    });
    const txRes = ok(await callSign(h, session, txReq));
    expect(
      recoverEvmSigner(txReq, {
        signedTransaction: field(txRes, "signedTransaction") as Uint8Array,
      }),
    ).toBe(EVM_ADDRESS.toLowerCase());
    const msgReq = normalizeEvm({
      kind: "evm.personal-message",
      network: "eip155:1",
      account,
      message: utf8ToBytes("hello"),
    });
    const msgRes = ok(await callSign(h, session, msgReq));
    expect(recoverEvmSigner(msgReq, { signature: field(msgRes, "signature") as Uint8Array })).toBe(
      EVM_ADDRESS.toLowerCase(),
    );
    const td = JSON.stringify({
      types: {
        EIP712Domain: [{ name: "name", type: "string" }],
        Mail: [{ name: "m", type: "string" }],
      },
      domain: { name: "X" },
      primaryType: "Mail",
      message: { m: "hi" },
    });
    const tdReq = normalizeEvm({
      kind: "evm.typed-data",
      network: "eip155:1",
      account,
      typedData: td,
    });
    const tdRes = ok(await callSign(h, session, tdReq));
    expect(recoverEvmSigner(tdReq, { signature: field(tdRes, "signature") as Uint8Array })).toBe(
      EVM_ADDRESS.toLowerCase(),
    );
  });

  it("refuses typed data that grants execution over the account", async () => {
    const { h, session, walletId } = await setup();
    const account = hd(walletId, "evm.bip44");
    const td = (verifyingContract: string) =>
      normalizeEvm({
        kind: "evm.typed-data",
        network: "eip155:1",
        account,
        typedData: JSON.stringify({
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "verifyingContract", type: "address" },
            ],
            Mail: [{ name: "m", type: "string" }],
          },
          domain: { name: "X", verifyingContract },
          primaryType: "Mail",
          message: { m: "hi" },
        }),
      });
    const delegated = await callSign(h, session, td(DELEGATION_MANAGER));
    expect(delegated).toMatchObject({ err: { code: "invalid-input" } });
    const self = await callSign(h, session, td(EVM_ADDRESS));
    expect(self).toMatchObject({ err: { code: "invalid-input" } });
  });

  it("refuses eip7702 requests outside the authorization allowlist", async () => {
    const { h, session, walletId } = await setup();
    const account = hd(walletId, "evm.bip44");
    const base = {
      chainId: 1,
      nonce: 0,
      gas: "0x61a8",
      value: "0x0",
      data: "0x",
      to: EVM_ADDRESS,
      accessList: [],
      maxFeePerGas: "0x4a817c800",
      maxPriorityFeePerGas: "0x3b9aca00",
    };
    const req = async (tx: Record<string, unknown>) =>
      callSign(h, session, {
        kind: "evm.transaction",
        network: "eip155:1",
        account,
        tx: { ...base, type: "eip7702", ...tx },
      });
    await expect(req({ authorization: { address: EVM_ADDRESS } })).resolves.toMatchObject({
      err: { code: "invalid-input" },
    });
    expect(
      "err" in (await req({ to: undefined, authorization: { address: EVM_DELEGATOR.address } })),
    ).toBe(true);
    expect(
      "err" in
        (await req({
          authorization: { address: EVM_DELEGATOR.address, nonce: 3 },
        })),
    ).toBe(true);
    expect(
      "err" in
        (await req({
          authorization: { address: EVM_DELEGATOR.address },
          extra: 1,
        })),
    ).toBe(true);
  });

  it("refuses a chain-universal eip7702 authorization before verification", async () => {
    const { h, session, walletId } = await setup();
    const account = hd(walletId, "evm.bip44");
    const tx = {
      type: "eip7702",
      chainId: 0,
      nonce: 0,
      gas: "0x61a8",
      value: "0x0",
      data: "0x",
      to: EVM_ADDRESS,
      accessList: [],
      maxFeePerGas: "0x4a817c800",
      maxPriorityFeePerGas: "0x3b9aca00",
      authorization: { address: EVM_DELEGATOR.address },
    };
    /* chainId 0 is the "any chain" authorization of EIP-7702 — replayable everywhere, so it is
       refused before any prompt: even a wrong factor must not reach verification. */
    const wrongFactor = {
      kind: "passkey",
      credentialId: utf8ToBytes("other-credential"),
      prf: new Uint8Array(32),
    };
    for (const verify of [wrongFactor, PASSKEY()]) {
      for (const network of ["eip155:0", "eip155:1"]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential kernel calls
        const res = await callSign(
          h,
          session,
          { kind: "evm.transaction", network, account, tx },
          verify,
        );
        expect(res).toMatchObject({ err: { code: "invalid-input" } });
      }
    }
    /* No eip155:0 account may be derived either: the network check refuses it independently of
       the transaction shape. */
    const accounts = await h.call(
      "wallet.accounts",
      { walletId, groupIndex: 0, template: "evm.bip44", network: "eip155:0" },
      session,
    );
    expect(accounts).toMatchObject({ err: { code: "invalid-input" } });
  });

  it("signs a solana transaction and a raw message", async () => {
    const { h, session, walletId } = await setup();
    const account = hd(walletId, "solana.bip44-change");
    const txMsg = solanaTransferMessage();
    const txReq = normalizeSolana(
      {
        kind: "solana.transaction",
        network: vectors.solana.network,
        account,
        message: txMsg,
      },
      SOL_ADDRESS,
    );
    const txRes = ok(await callSign(h, session, txReq));
    expect(verifySolanaSignature(txMsg, bytesField(txRes, "signature"), SOL_ADDRESS)).toBe(true);
    const msg = utf8ToBytes("hello solana");
    const msgReq = normalizeSolana(
      {
        kind: "solana.message",
        network: vectors.solana.network,
        account,
        message: msg,
        format: "raw",
      },
      SOL_ADDRESS,
    );
    const msgRes = ok(await callSign(h, session, msgReq));
    expect(verifySolanaSignature(msg, bytesField(msgRes, "signature"), SOL_ADDRESS)).toBe(true);
  });

  it("signs a v1 transaction message but still refuses it as a raw message", async () => {
    const { h, session, walletId } = await setup();
    const account = hd(walletId, "solana.bip44-change");
    const data = new Uint8Array(12);
    const view = new DataView(data.buffer);
    view.setUint32(0, 2, true);
    view.setBigUint64(4, 1000n, true);
    const v1 = new Uint8Array(
      getCompiledTransactionMessageEncoder().encode(
        compileTransactionMessage(
          appendTransactionMessageInstruction(
            {
              programAddress: address("11111111111111111111111111111111"),
              accounts: [
                { address: address(SOL_ADDRESS), role: AccountRole.WRITABLE_SIGNER },
                {
                  address: address("8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR"),
                  role: AccountRole.WRITABLE,
                },
              ],
              data,
            },
            setTransactionMessageLifetimeUsingBlockhash(
              {
                blockhash: blockhash("11111111111111111111111111111111"),
                lastValidBlockHeight: 1000n,
              },
              setTransactionMessageFeePayer(
                address(SOL_ADDRESS),
                createTransactionMessage({ version: 1 }),
              ),
            ),
          ),
        ),
      ),
    );
    expect(
      errCode(
        await callSign(h, session, {
          kind: "solana.message",
          network: vectors.solana.network,
          account,
          message: v1,
          format: "raw",
        }),
      ),
    ).toBe("invalid-input");
    const txReq = normalizeSolana(
      {
        kind: "solana.transaction",
        network: vectors.solana.network,
        account,
        message: v1,
      },
      SOL_ADDRESS,
    );
    const txRes = ok(await callSign(h, session, txReq));
    expect(verifySolanaSignature(v1, bytesField(txRes, "signature"), SOL_ADDRESS)).toBe(true);
    const msg = utf8ToBytes("hello solana");
    const msgReq = normalizeSolana(
      {
        kind: "solana.message",
        network: vectors.solana.network,
        account,
        message: msg,
        format: "raw",
      },
      SOL_ADDRESS,
    );
    const msgRes = ok(await callSign(h, session, msgReq));
    expect(verifySolanaSignature(msg, bytesField(msgRes, "signature"), SOL_ADDRESS)).toBe(true);
  });

  it("rejects non-normalized, wrong-factor, mismatched, missing and bitcoin requests", async () => {
    const { h, session, walletId } = await setup();
    const badHex = {
      kind: "evm.personal-message",
      network: "eip155:1",
      account: hd(walletId, "evm.bip44"),
      message: utf8ToBytes("hello"),
    };
    const nonNormalized = {
      kind: "evm.transaction",
      network: "eip155:1",
      account: hd(walletId, "evm.bip44"),
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        value: "0x0",
        data: "0x",
        to: "0x00000000000000000000000000000000DEADBEEF",
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x1",
        accessList: [],
      },
    };
    expect("err" in (await callSign(h, session, nonNormalized))).toBe(true);
    const wrongFactor = await callSign(h, session, normalizeEvm(badHex), {
      kind: "password",
      password: utf8ToBytes("wrong password"),
    });
    expect("err" in wrongFactor).toBe(true);
    const mismatch = {
      ...normalizeEvm(badHex),
      account: hd(walletId, "solana.bip44-change"),
    };
    expect("err" in (await callSign(h, session, mismatch))).toBe(true);
    const missing = {
      kind: "evm.personal-message",
      network: "eip155:1",
      account: hd("0000000000000000", "evm.bip44"),
      message: utf8ToBytes("hello"),
    };
    expect("err" in (await callSign(h, session, missing))).toBe(true);
    const imported = {
      ...normalizeEvm(badHex),
      account: { kind: "imported", keyId: "0123456789abcdef", family: "evm" },
    };
    expect("err" in (await callSign(h, session, imported))).toBe(true);
  });

  it("signs a P2WPKH psbt and a bip86 message", async () => {
    const { h, session, walletId } = await setup();
    const bip84 = btcVector("btc.bip84");
    const txReq = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: btcPsbt({ template: "btc.bip84" }),
      sign: [entry(0, "btc.bip84")],
    });
    const txRes = ok(await callSign(h, session, txReq));
    const signedPsbt = bytesField(txRes, "signedPsbt");
    expect(verifyBitcoinPsbtSignatures(signedPsbt, [0], bip84.xpub, "btc.bip84", BTC_NETWORK)).toBe(
      true,
    );
    const bip86 = btcVector("btc.bip86");
    const msgReq = normalizeBitcoin({
      kind: "bitcoin.message",
      network: BTC_NETWORK,
      account: hd(walletId, "btc.bip86"),
      address: bip86.receive[0],
      message: "hello bitcoin",
      format: "bip322-simple",
      change: 0,
      index: 0,
    });
    const msgRes = ok(await callSign(h, session, msgReq));
    const signature = strField(msgRes, "signature");
    expect(signature.startsWith("smp")).toBe(true);
    expect(verifyBitcoinMessage(bip86.receive[0]!, "hello bitcoin", signature, BTC_NETWORK)).toBe(
      true,
    );
  });

  it("rejects a bip49 input whose redeemScript is missing or wrong", async () => {
    const { h, session, walletId } = await setup();
    const wrong = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: btcPsbt({ template: "btc.bip49", wrongScript: true }),
      sign: [entry(0, "btc.bip49")],
    });
    expect("err" in (await callSign(h, session, wrong))).toBe(true);
    const right = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: btcPsbt({ template: "btc.bip49" }),
      sign: [entry(0, "btc.bip49")],
    });
    const res = await callSign(h, session, right);
    expect("err" in res).toBe(false);
  });

  it("rejects a bip49 input whose redeemScript is another key's or absent", async () => {
    const { h, session, walletId } = await setup();
    for (const psbt of [
      btcPsbt({ template: "btc.bip49", badRedeem: true }),
      btcPsbt({ template: "btc.bip49", missingRedeem: true }),
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential kernel calls
      const res = await callSign(h, session, {
        kind: "bitcoin.psbt",
        origin: "internal",
        network: BTC_NETWORK,
        account: grp(walletId),
        psbt,
        sign: [entry(0, "btc.bip49")],
      });
      expect("err" in res).toBe(true);
    }
  });

  it("rejects an input signed under a non-default sighash", async () => {
    const { h, session, walletId } = await setup();
    const res = await callSign(h, session, {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: btcPsbt({ template: "btc.bip84", sighash: SigHash.NONE }),
      sign: [entry(0, "btc.bip84")],
    });
    expect("err" in res).toBe(true);
  });

  it("rejects a bip86 input carrying script-path fields", async () => {
    const { h, session, walletId } = await setup();
    const res = await callSign(h, session, {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: btcPsbt({ template: "btc.bip86", tapMerkleRoot: true }),
      sign: [entry(0, "btc.bip86")],
    });
    expect("err" in res).toBe(true);
  });

  it("rejects a self execute whose calldata is not the canonical batch", async () => {
    // No vault.setBlindSigning here: the canonical-encoding check is what separates a decoded
    // batch from a blind account-code call, so the refusal must hold under the default policy.
    const h = createHarness();
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(vectors.mnemonic),
        factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    const session = strField(res, "session");
    const walletId = strField(field(res, "wallet"), "walletId");
    const canonical = encodeBatchExecute([
      { to: "0x0000000000000000000000000000000000C0FFEE", value: 1n, data: "0x" },
    ]);
    // The same batch with the executions tuple shifted one word deeper inside executionData:
    // decodes to the identical calls but is not the canonical encoding the decoder reads back.
    const argsEnd = 2 + 8 + 64 + 64; // 0x + selector + mode + executionData offset
    const inner = canonical.slice(argsEnd + 64); // tuple encoding the offset word points at
    const shifted = `${"0".repeat(62)}40${"0".repeat(64)}${inner.slice(64)}`;
    const aliased = `${canonical.slice(0, argsEnd)}${(shifted.length / 2)
      .toString(16)
      .padStart(64, "0")}${shifted}`;
    const req = (data: string): Record<string, unknown> => ({
      kind: "evm.transaction",
      network: "eip155:1",
      account: hd(walletId, "evm.bip44"),
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        gas: "0x61a8",
        value: "0x0",
        data,
        to: EVM_ADDRESS,
        accessList: [],
        maxFeePerGas: "0x4a817c800",
        maxPriorityFeePerGas: "0x3b9aca00",
      },
    });
    expect(errCode(await callSign(h, session, req(aliased)))).toBe("blind-signing-disabled");
    expect("err" in (await callSign(h, session, req(canonical)))).toBe(false);
  });

  it("rejects a bip44 input missing nonWitnessUtxo or with the wrong prevout", async () => {
    const { h, session, walletId } = await setup();
    const badPrev = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: btcPsbt({ template: "btc.bip44", wrongScript: true }),
      sign: [entry(0, "btc.bip44")],
    });
    expect("err" in (await callSign(h, session, badPrev))).toBe(true);
    const right = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: btcPsbt({ template: "btc.bip44" }),
      sign: [entry(0, "btc.bip44")],
    });
    const res = await callSign(h, session, right);
    expect("err" in res).toBe(false);
  });

  it("rejects legacy message on bip84 and verifies it on bip44", async () => {
    const { h, session, walletId } = await setup();
    const bip44 = btcVector("btc.bip44");
    const bip84 = btcVector("btc.bip84");
    expect(() =>
      normalizeBitcoin({
        kind: "bitcoin.message",
        network: BTC_NETWORK,
        account: hd(walletId, "btc.bip84"),
        address: bip84.receive[0],
        message: "hello",
        format: "legacy",
        change: 0,
        index: 0,
      }),
    ).toThrow(/only for P2PKH/);
    const legacy = normalizeBitcoin({
      kind: "bitcoin.message",
      network: BTC_NETWORK,
      account: hd(walletId, "btc.bip44"),
      address: bip44.receive[0],
      message: "hello",
      format: "legacy",
      change: 0,
      index: 0,
    });
    const res = ok(await callSign(h, session, legacy));
    const sig = strField(res, "signature");
    const raw = Buffer.from(sig, "base64");
    expect(raw).toHaveLength(65);
    const expected = btcChild("btc.bip44", 0, 0).publicKey!;
    const msg = utf8ToBytes("hello");
    const prefix = utf8ToBytes(`Bitcoin Signed Message:${String.fromCodePoint(10)}`);
    const data = new Uint8Array(1 + prefix.length + 1 + msg.length);
    data[0] = prefix.length;
    data.set(prefix, 1);
    data[1 + prefix.length] = msg.length;
    data.set(msg, 2 + prefix.length);
    expect(
      secp256k1.verify(raw.subarray(1), sha256(sha256(data)), expected, { prehash: false }),
    ).toBe(true);
  });

  it("treats our change output as change and an external input as opaque", async () => {
    const { h, session, walletId } = await setup();
    const changeReq = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: btcPsbt({ template: "btc.bip84", changeOutput: true }),
      sign: [entry(0, "btc.bip84")],
    });
    const changeRes = ok(await callSign(h, session, changeReq));
    const bip84 = btcVector("btc.bip84");
    expect(
      verifyBitcoinPsbtSignatures(
        bytesField(changeRes, "signedPsbt"),
        [0],
        bip84.xpub,
        "btc.bip84",
        BTC_NETWORK,
      ),
    ).toBe(true);
    const externalReq = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: btcPsbt({ template: "btc.bip84", extraInput: true }),
      sign: [entry(0, "btc.bip84")],
    });
    const externalRes = ok(await callSign(h, session, externalReq));
    const extTx = Transaction.fromPSBT(bytesField(externalRes, "signedPsbt"));
    expect(extTx.getInput(0).partialSig).toBeDefined();
    expect(extTx.getInput(1).partialSig).toBeUndefined();
    expect(verifiabilityBitcoin(asPsbt(externalReq))).toBe("opaque");
  });

  it("signs one PSBT spending bip84 and bip86 inputs of the same group", async () => {
    const { h, session, walletId } = await setup();
    const pub84 = btcChild("btc.bip84", 0, 0).publicKey!;
    const child86 = btcChild("btc.bip86", 0, 0);
    const xonly86 = child86.publicKey!.slice(1);
    const tx = new Transaction({ version: 2 });
    const prev = new Transaction({ version: 2 });
    prev.addInput({ txid: hex("0707".repeat(16)), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: p2wpkh(pub84).script, amount: 100000n });
    tx.addInput({
      txid: hex(prev.id),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: p2wpkh(pub84).script, amount: 100000n },
      nonWitnessUtxo: prev.toBytes(true, false),
      bip32Derivation: [
        [pub84, { fingerprint: MASTER_FP, path: [0x80000054, HARDENED, HARDENED, 0, 0] }],
      ],
    });
    tx.addInput({
      txid: hex("0808".repeat(16)),
      index: 1,
      sequence: 0xfffffffd,
      witnessUtxo: { script: p2tr(xonly86).script, amount: 50000n },
      tapInternalKey: xonly86,
      tapBip32Derivation: [
        [
          xonly86,
          {
            hashes: [],
            der: { fingerprint: MASTER_FP, path: [0x80000056, HARDENED, HARDENED, 0, 0] },
          },
        ],
      ],
    });
    tx.addOutput({ script: PAYEE_SCRIPT, amount: 140000n });
    const req = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: tx.toPSBT(0),
      sign: [entry(0, "btc.bip84"), entry(1, "btc.bip86")],
    });
    const res = ok(await callSign(h, session, req));
    const signedPsbt = bytesField(res, "signedPsbt");
    const bip84 = btcVector("btc.bip84");
    const bip86 = btcVector("btc.bip86");
    expect(verifyBitcoinPsbtSignatures(signedPsbt, [0], bip84.xpub, "btc.bip84", BTC_NETWORK)).toBe(
      true,
    );
    expect(verifyBitcoinPsbtSignatures(signedPsbt, [1], bip86.xpub, "btc.bip86", BTC_NETWORK)).toBe(
      true,
    );
  });

  it("rejects a witnessUtxo-only bip84 input and a lying witnessUtxo amount", async () => {
    const { h, session, walletId } = await setup();
    const pub = btcChild("btc.bip84", 0, 0).publicKey!;
    const { script } = p2wpkh(pub);
    const mk = (nonWitness: Uint8Array | undefined): Uint8Array =>
      prevoutPsbt(pub, script, nonWitness);
    // E-06: the fee shown came from an unattested witnessUtxo — now the request cannot normalize.
    const witnessOnly = await callSign(h, session, {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: mk(undefined),
      sign: [entry(0, "btc.bip84")],
    });
    expect("err" in witnessOnly).toBe(true);
    // An honest nonWitnessUtxo beside a lying witnessUtxo fails strictPrevoutValidation.
    const prev = new Transaction({ version: 2 });
    prev.addInput({ txid: hex("0707".repeat(16)), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script, amount: 100000n });
    const lying = await callSign(h, session, {
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: lieWitness(mk(prev.toBytes(true, false)), 99999n),
      sign: [entry(0, "btc.bip84")],
    });
    expect("err" in lying).toBe(true);
  });

  it("shows the proven nonWitnessUtxo fee for a P2PKH spend", async () => {
    const { h, session, walletId } = await setup();
    const pub = btcChild("btc.bip44", 0, 0).publicKey!;
    const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
    prev.addInput({ txid: hex("0707".repeat(16)), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: p2pkh(pub).script, amount: 100_000_000n });
    const tx = new Transaction({ version: 2 });
    tx.addInput({
      txid: prev.id,
      index: 0,
      sequence: 0xfffffffd,
      nonWitnessUtxo: prev.toBytes(true, false),
      bip32Derivation: [
        [pub, { fingerprint: MASTER_FP, path: [0x8000002c, HARDENED, HARDENED, 0, 0] }],
      ],
    });
    tx.addOutput({ script: PAYEE_SCRIPT, amount: 1_000_000n });
    const req = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: tx.toPSBT(0),
      sign: [entry(0, "btc.bip44")],
    });
    const res = ok(await callSign(h, session, req));
    expect(bytesField(res, "signedPsbt").length).toBeGreaterThan(0);
    const intent = decodeBitcoinPsbt(asPsbt(req));
    expect(chainPrompt("en", intent).description).toContain("Max fee 0.99 BTC");
  });

  it("E-28: a priority fee without SetComputeUnitLimit shows the default-limit max fee", () => {
    const seed = mnemonicToSeedSync(vectors.mnemonic);
    const priv = Slip10.fromMasterSeed(seed).derive("m/44'/501'/0'/0'").privateKey;
    const payer = base58.encode(ed25519.getPublicKey(priv));
    const req = normalizeSolana(
      {
        kind: "solana.transaction",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44-change" },
        message: cuPriceMessage(),
      },
      payer,
    ) as never;
    const intent = decodeSolana(req, payer);
    expect(intent.verifiability).toBe("full");
    expect(chainPrompt("en", intent).description).toContain("Max fee 30.000005 SOL");
  });

  it("rejects a sign entry whose template disagrees with the input's script", async () => {
    const { h, session, walletId } = await setup();
    const pub84 = btcChild("btc.bip84", 0, 0).publicKey!;
    const xonly86 = btcChild("btc.bip86", 0, 0).publicKey!.slice(1);
    // A taproot prevout carrying a bip32 derivation entry: normalizes for a bip84 sign entry,
    // but the kernel's prevout check binds the input to its own template.
    const tx = new Transaction({ version: 2 });
    const prev = new Transaction({ version: 2 });
    prev.addInput({ txid: hex("0707".repeat(16)), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: p2tr(xonly86).script, amount: 100000n });
    tx.addInput({
      txid: hex(prev.id),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: p2tr(xonly86).script, amount: 100000n },
      nonWitnessUtxo: prev.toBytes(true, false),
      bip32Derivation: [
        [pub84, { fingerprint: MASTER_FP, path: [0x80000054, HARDENED, HARDENED, 0, 0] }],
      ],
    });
    tx.addOutput({ script: PAYEE_SCRIPT, amount: 90000n });
    const wrong = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: tx.toPSBT(0),
      sign: [entry(0, "btc.bip84")],
    });
    expect("err" in (await callSign(h, session, wrong))).toBe(true);
    // ...and the honest bip86 entry signs the same prevout.
    tx.updateInput(0, {
      tapInternalKey: xonly86,
      tapBip32Derivation: [
        [
          xonly86,
          {
            hashes: [],
            der: { fingerprint: MASTER_FP, path: [0x80000056, HARDENED, HARDENED, 0, 0] },
          },
        ],
      ],
    });
    const right = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: tx.toPSBT(0),
      sign: [entry(0, "btc.bip86")],
    });
    const res = await callSign(h, session, right);
    expect("err" in res).toBe(false);
  });

  it("rejects an input whose derivation names another group index", async () => {
    const { h, session, walletId } = await setup();
    const other = HDKey.fromMasterSeed(mnemonicToSeedSync(vectors.mnemonic)).derive(
      "m/84'/0'/1'/0/0",
    );
    const pub = other.publicKey!;
    const tx = new Transaction({ version: 2 });
    const prev = new Transaction({ version: 2 });
    prev.addInput({ txid: hex("0707".repeat(16)), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: p2wpkh(pub).script, amount: 100000n });
    tx.addInput({
      txid: hex(prev.id),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: p2wpkh(pub).script, amount: 100000n },
      nonWitnessUtxo: prev.toBytes(true, false),
      bip32Derivation: [
        [pub, { fingerprint: MASTER_FP, path: [0x80000054, HARDENED, 0x80000001, 0, 0] }],
      ],
    });
    tx.addOutput({ script: PAYEE_SCRIPT, amount: 90000n });
    const req = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: tx.toPSBT(0),
      sign: [entry(0, "btc.bip84")],
    });
    expect("err" in (await callSign(h, session, req))).toBe(true);
  });

  it("rejects wrong derivations, foreign scripts, bad addresses and wrong factors", async () => {
    const { h, session, walletId } = await setup();
    const foreignFp = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: btcPsbt({ template: "btc.bip84", fingerprint: 0xdeadbeef }),
      sign: [entry(0, "btc.bip84")],
    });
    expect("err" in (await callSign(h, session, foreignFp))).toBe(true);
    const wrongPub = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: btcPsbt({ template: "btc.bip84", wrongPub: true }),
      sign: [entry(0, "btc.bip84")],
    });
    expect("err" in (await callSign(h, session, wrongPub))).toBe(true);
    const wrongScript = normalizeBitcoin({
      kind: "bitcoin.psbt",
      origin: "internal",
      network: BTC_NETWORK,
      account: grp(walletId),
      psbt: btcPsbt({ template: "btc.bip86", wrongScript: true }),
      sign: [entry(0, "btc.bip86")],
    });
    expect("err" in (await callSign(h, session, wrongScript))).toBe(true);
    const wrongFactor = await callSign(
      h,
      session,
      normalizeBitcoin({
        kind: "bitcoin.psbt",
        origin: "internal",
        network: BTC_NETWORK,
        account: grp(walletId),
        psbt: btcPsbt({ template: "btc.bip84" }),
        sign: [entry(0, "btc.bip84")],
      }),
      { kind: "password", password: utf8ToBytes("wrong password") },
    );
    expect("err" in wrongFactor).toBe(true);
    const bip86 = btcVector("btc.bip86");
    const notOurs = normalizeBitcoin({
      kind: "bitcoin.message",
      network: BTC_NETWORK,
      account: hd(walletId, "btc.bip86"),
      address: bip86.receive[1]!,
      message: "hi",
      format: "bip322-simple",
      change: 0,
      index: 0,
    });
    expect("err" in (await callSign(h, session, notOurs))).toBe(true);
    const legacy = {
      kind: "bitcoin.message",
      network: BTC_NETWORK,
      account: hd(walletId, "btc.bip84"),
      address: btcVector("btc.bip84").receive[0],
      message: "hi",
      format: "legacy",
      change: 0,
      index: 0,
    };
    expect("err" in (await callSign(h, session, legacy))).toBe(true);
  });

  describe("bitcoin network separation", () => {
    const TESTNET = "bip122:00000000da84f2bafbbc53dee25a72ae";
    const seed = mnemonicToSeedSync(vectors.mnemonic);
    const rng = () => new Uint8Array(32);
    const account = { kind: "hd" as const, walletId: "w", groupIndex: 0 };

    const signedPsbtOf = (res: Awaited<ReturnType<typeof signPlan>>): Uint8Array => {
      if (!("signedPsbt" in res)) {
        throw new Error("expected a signed psbt");
      }
      return res.signedPsbt;
    };
    const runBitcoin = async (
      request: Parameters<typeof prepareBitcoin>[0],
      hd: Parameters<typeof prepareBitcoin>[1],
    ) => {
      const keys = seedKeys(seed, rng);
      try {
        const prepared = await prepareBitcoin(request, hd, keys.material, () => 0);
        return await signPlan(prepared.plan, keys.backend(taskSignerFor(prepared.plan)));
      } finally {
        keys.wipe();
      }
    };
    const partialSigner = (psbt: Uint8Array): Uint8Array => {
      const signer = Transaction.fromPSBT(psbt).getInput(0).partialSig?.[0]?.[0];
      if (signer === undefined) {
        throw new Error("expected a partial signature");
      }
      return signer;
    };
    const asHex = (b: Uint8Array): string =>
      Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

    it("refuses a coin-0' derivation claim under a test network before normalize", async () => {
      /* The kernel's childAt guard — not normalize's coin-type check — is what refuses the
         claim, so assert its exact message on a raw (un-normalized) request. */
      const request = {
        kind: "bitcoin.psbt",
        origin: "internal",
        network: TESTNET,
        account,
        psbt: btcPsbt({ template: "btc.bip84" }),
        sign: [{ index: 0, template: "btc.bip84" }],
      } as const;
      await expect(runBitcoin(request, account)).rejects.toThrow(
        "derivation path is not this account's",
      );
    });

    it("refuses a coin-1' derivation claim under mainnet the same way", async () => {
      const request = {
        kind: "bitcoin.psbt",
        origin: "internal",
        network: BTC_NETWORK,
        account,
        psbt: btcPsbt({ template: "btc.bip84", coin: 1 }),
        sign: [{ index: 0, template: "btc.bip84" }],
      } as const;
      await expect(runBitcoin(request, account)).rejects.toThrow(
        "derivation path is not this account's",
      );
    });

    it("refuses a prevout script of the other coin's key at the claimed path", async () => {
      /* The coin-1' path and pubkey are consistent, only the spent script is the mainnet
         key's — the prevout binding, not the path guard, is what refuses. */
      const request = {
        kind: "bitcoin.psbt",
        origin: "internal",
        network: TESTNET,
        account,
        psbt: btcPsbt({ template: "btc.bip84", coin: 1, crossScript: true }),
        sign: [{ index: 0, template: "btc.bip84" }],
      } as const;
      await expect(runBitcoin(request, account)).rejects.toThrow(
        "prevout script is not this key's",
      );
    });

    it("refuses a message for a mainnet address under a test network", async () => {
      const account84 = { ...account, template: "btc.bip84" as const };
      const request = {
        kind: "bitcoin.message",
        network: TESTNET,
        account: account84,
        address: btcVector("btc.bip84").receive[0]!,
        message: "hi",
        format: "bip322-simple",
        change: 0,
        index: 0,
      } as const;
      await expect(runBitcoin(request, account84)).rejects.toThrow("address is not ours");
    });

    it("signs a testnet PSBT with the coin-1' key — not the mainnet key at the same path", async () => {
      /* One sorted sign entry — already in normalized form for `deepEqual(normalized, request)`. */
      const request = {
        kind: "bitcoin.psbt",
        origin: "internal",
        network: TESTNET,
        account,
        psbt: btcPsbt({ template: "btc.bip84", coin: 1 }),
        sign: [{ index: 0, template: "btc.bip84" }],
      } as const;
      const res = await runBitcoin(request, account);
      const signer = partialSigner(signedPsbtOf(res));
      expect(asHex(signer)).toBe(asHex(btcChildAt("btc.bip84", 1, 0, 0).publicKey!));
      expect(asHex(signer)).not.toBe(asHex(btcChild("btc.bip84", 0, 0).publicKey!));
    });
  });

  describe("bitcoin own-output classification", () => {
    const seed = mnemonicToSeedSync(vectors.mnemonic);
    const rng = () => new Uint8Array(32);
    const account = { kind: "hd" as const, walletId: "w", groupIndex: 0 };

    const scriptFor = (purpose: number, pub: Uint8Array): Uint8Array =>
      purpose === 86
        ? p2tr(pub.slice(1)).script
        : purpose === 49
          ? p2sh(p2wpkh(pub)).script
          : purpose === 44
            ? p2pkh(pub).script
            : p2wpkh(pub).script;
    const childOf = (purpose: number, change: number, index: number): HDKey =>
      HDKey.fromMasterSeed(seed).derive(
        `m/${purpose}'/0'/0'/${change}/${index >= HARDENED ? `${index - HARDENED}'` : index}`,
      );
    const addrOf = (purpose: number, change: number, index: number): string =>
      Address(bitcoinNetwork(BTC_NETWORK).params).encode(
        OutScript.decode(scriptFor(purpose, childOf(purpose, change, index).publicKey!)),
      );

    /**
     * A PSBT spending one own key per input spec (each bound by its own derivation entry) to a
     * payee plus each listed own output — the outputs bound by a derivation entry claiming the
     * group, exactly the binding a crafted change output carries.
     */
    const ownPsbt = (
      inputs: ReadonlyArray<{
        readonly template: string;
        readonly change?: number;
        readonly index?: number;
      }>,
      outputs: ReadonlyArray<{
        readonly purpose: number;
        readonly change: number;
        readonly index: number;
        readonly amount?: bigint;
      }>,
    ): Uint8Array => {
      const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
      for (const [i, spec] of inputs.entries()) {
        const purpose = BTC_PURPOSE_T[spec.template] ?? 84;
        const change = spec.change ?? 0;
        const index = spec.index ?? 0;
        const pub = btcChild(spec.template, change, index).publicKey!;
        const script = scriptFor(purpose, pub);
        const path = [purpose + HARDENED, HARDENED, HARDENED, change, index];
        const prev = new Transaction({ version: 2, allowUnknownOutputs: true });
        prev.addInput({
          txid: hex((i + 16).toString(16).padStart(4, "0").repeat(16)),
          index: 0,
          sequence: 0xffffffff,
        });
        prev.addOutput({ script, amount: 100_000n });
        if (purpose === 86) {
          tx.addInput({
            txid: prev.id,
            index: 0,
            sequence: 0xfffffffd,
            witnessUtxo: { script, amount: 100_000n },
            tapInternalKey: pub.slice(1),
            tapBip32Derivation: [
              [pub.slice(1), { hashes: [], der: { fingerprint: MASTER_FP, path } }],
            ],
          });
        } else {
          const entry: Record<string, unknown> = {
            txid: prev.id,
            index: 0,
            sequence: 0xfffffffd,
            witnessUtxo: { script, amount: 100_000n },
            nonWitnessUtxo: prev.toBytes(true, false),
            bip32Derivation: [[pub, { fingerprint: MASTER_FP, path }]],
          };
          if (purpose === 49) {
            entry["redeemScript"] = p2wpkh(pub).script;
          }
          if (purpose === 44) {
            delete entry["witnessUtxo"];
          }
          tx.addInput(entry);
        }
      }
      tx.addOutput({ script: PAYEE_SCRIPT, amount: 90_000n });
      for (const spec of outputs) {
        const pub = childOf(spec.purpose, spec.change, spec.index).publicKey!;
        const path = [spec.purpose + HARDENED, HARDENED, HARDENED, spec.change, spec.index];
        tx.addOutput({ script: scriptFor(spec.purpose, pub), amount: spec.amount ?? 1000n });
        tx.updateOutput(
          tx.outputsLength - 1,
          spec.purpose === 86
            ? {
                tapBip32Derivation: [
                  [pub.slice(1), { hashes: [], der: { fingerprint: MASTER_FP, path } }],
                ],
              }
            : { bip32Derivation: [[pub, { fingerprint: MASTER_FP, path }]] },
        );
      }
      return tx.toPSBT(0);
    };

    /** Prepare the built PSBT under the vector seed, then sign its plan. */
    const prepare = async (
      inputs: Parameters<typeof ownPsbt>[0],
      outputs: Parameters<typeof ownPsbt>[1],
      opts?: {
        readonly origin?: "internal" | "external";
        readonly storedMark?: (purpose: number) => number;
      },
    ) => {
      const keys = seedKeys(seed, rng);
      try {
        const request = asPsbt(
          normalizeBitcoin({
            kind: "bitcoin.psbt",
            origin: opts?.origin ?? "internal",
            network: BTC_NETWORK,
            account,
            psbt: ownPsbt(inputs, outputs),
            sign: inputs.map((i, index) => ({ index, template: i.template })),
          }),
        );
        const prepared = await prepareBitcoin(
          request,
          account,
          keys.material,
          opts?.storedMark ?? (() => 0),
        );
        const result = await signPlan(prepared.plan, keys.backend(taskSignerFor(prepared.plan)));
        return { prompt: prepared.prompt, result };
      } finally {
        keys.wipe();
      }
    };
    const warningsOf = (prompt: Awaited<ReturnType<typeof prepare>>["prompt"]) =>
      prompt.warnings ?? [];
    /** `material.secp256k1` that answers every path except those in `missing` (device-required). */
    const unservable = (keys: ReturnType<typeof seedKeys>, missing: ReadonlyArray<KeyPath>) => {
      const serve = keys.material.secp256k1;
      return async (path: KeyPath): Promise<Uint8Array> => {
        if (missing.some((p) => p.length === path.length && p.every((v, i) => v === path[i]))) {
          throw new KernelError("device-required", "the pin has no such path");
        }
        return serve(path);
      };
    };

    it("shows change at an index beyond the scan's reach — with its path — and still signs", async () => {
      const { prompt, result } = await prepare(
        [{ template: "btc.bip84" }],
        [{ purpose: 84, change: 1, index: 2_147_483_646 }],
      );
      const path = "m/84'/0'/0'/1/2147483646";
      const flow = prompt.outflows.find((o) => o.ownPath !== undefined);
      expect(flow?.ownPath).toBe(path);
      expect(flow?.to).toBe(addrOf(84, 1, 2_147_483_646));
      expect(prompt.warnings).toContainEqual({ kind: "unusual-own-output", message: path });
      const text = chainPrompt("en", prompt).description;
      expect(text).toContain(`at unusual path ${path}`);
      expect(text).toContain("may not appear in this wallet");
      expect("signedPsbt" in result).toBe(true);
    });

    it("shows the group's bip44 key under a bip84 spend — a purpose no input signs", async () => {
      const { prompt, result } = await prepare(
        [{ template: "btc.bip84" }],
        [{ purpose: 44, change: 0, index: 5 }],
      );
      const path = "m/44'/0'/0'/0/5";
      const flow = prompt.outflows.find((o) => o.ownPath !== undefined);
      expect(flow?.ownPath).toBe(path);
      expect(flow?.to).toBe(addrOf(44, 0, 5));
      expect(prompt.warnings).toContainEqual({ kind: "unusual-own-output", message: path });
      expect(chainPrompt("en", prompt).description).toContain(`at unusual path ${path}`);
      expect("signedPsbt" in result).toBe(true);
    });

    it("hides change exactly at the bound and shows the index past it", async () => {
      const { prompt, result } = await prepare(
        [{ template: "btc.bip84" }],
        [
          { purpose: 84, change: 1, index: 20 },
          { purpose: 84, change: 1, index: 21 },
        ],
      );
      expect(prompt.outflows.filter((o) => o.ownPath !== undefined)).toHaveLength(1);
      const flow = prompt.outflows.find((o) => o.ownPath !== undefined);
      expect(flow?.ownPath).toBe("m/84'/0'/0'/1/21");
      expect(prompt.warnings).toContainEqual({
        kind: "unusual-own-output",
        message: "m/84'/0'/0'/1/21",
      });
      expect("signedPsbt" in result).toBe(true);
    });

    it("shows an own receive-chain output rather than hiding it as change", async () => {
      const { prompt } = await prepare(
        [{ template: "btc.bip84" }],
        [{ purpose: 84, change: 0, index: 5 }],
      );
      const flow = prompt.outflows.find((o) => o.ownPath !== undefined);
      expect(flow?.ownPath).toBe("m/84'/0'/0'/0/5");
      expect(flow?.to).toBe(addrOf(84, 0, 5));
      expect(prompt.warnings).toContainEqual({
        kind: "unusual-own-output",
        message: "m/84'/0'/0'/0/5",
      });
    });

    it("shows change on the group's other-purpose key under a bip84 spend", async () => {
      const { prompt } = await prepare(
        [{ template: "btc.bip84" }],
        [{ purpose: 44, change: 1, index: 0 }],
      );
      const flow = prompt.outflows.find((o) => o.ownPath !== undefined);
      expect(flow?.ownPath).toBe("m/44'/0'/0'/1/0");
      expect(prompt.warnings).toContainEqual({
        kind: "unusual-own-output",
        message: "m/44'/0'/0'/1/0",
      });
    });

    it("hides a bip44 change output under a bip44 spend", async () => {
      const { prompt, result } = await prepare(
        [{ template: "btc.bip44" }],
        [{ purpose: 44, change: 1, index: 0 }],
      );
      expect(prompt.outflows.filter((o) => o.ownPath !== undefined)).toHaveLength(0);
      expect(prompt.warnings?.filter((w) => w.kind === "unusual-own-output")).toHaveLength(0);
      expect("signedPsbt" in result).toBe(true);
    });

    it("an internal request's signed far change input raises the hidden-change bound", async () => {
      const { prompt, result } = await prepare(
        [{ template: "btc.bip84" }, { template: "btc.bip84", change: 1, index: 30 }],
        [{ purpose: 84, change: 1, index: 50 }],
      );
      expect(prompt.outflows.filter((o) => o.ownPath !== undefined)).toHaveLength(0);
      expect(prompt.warnings?.filter((w) => w.kind === "unusual-own-output")).toHaveLength(0);
      expect("signedPsbt" in result).toBe(true);
    });

    it("an external request's signed far change input never raises the bound", async () => {
      const { prompt, result } = await prepare(
        [{ template: "btc.bip84" }, { template: "btc.bip84", change: 1, index: 30 }],
        [{ purpose: 84, change: 1, index: 50 }],
        { origin: "external" },
      );
      const flow = prompt.outflows.find((o) => o.ownPath !== undefined);
      expect(flow?.ownPath).toBe("m/84'/0'/0'/1/50");
      expect(prompt.warnings).toContainEqual({
        kind: "unusual-own-output",
        message: "m/84'/0'/0'/1/50",
      });
      expect("signedPsbt" in result).toBe(true);
    });

    it("a dusted /1/1000000 input under an external request cannot hide /1/1000020", async () => {
      const { prompt, result } = await prepare(
        [{ template: "btc.bip84" }, { template: "btc.bip84", change: 1, index: 1_000_000 }],
        [{ purpose: 84, change: 1, index: 1_000_020 }],
        { origin: "external" },
      );
      const flow = prompt.outflows.find((o) => o.ownPath !== undefined);
      expect(flow?.ownPath).toBe("m/84'/0'/0'/1/1000020");
      expect(flow?.to).toBe(addrOf(84, 1, 1_000_020));
      expect(prompt.warnings).toContainEqual({
        kind: "unusual-own-output",
        message: "m/84'/0'/0'/1/1000020",
      });
      expect("signedPsbt" in result).toBe(true);
    });

    it("a dusted /1/2147483600 input under an external request cannot hide /1/2147483620", async () => {
      const { prompt, result } = await prepare(
        [{ template: "btc.bip84" }, { template: "btc.bip84", change: 1, index: 2_147_483_600 }],
        [{ purpose: 84, change: 1, index: 2_147_483_620 }],
        { origin: "external" },
      );
      const flow = prompt.outflows.find((o) => o.ownPath !== undefined);
      expect(flow?.ownPath).toBe("m/84'/0'/0'/1/2147483620");
      expect(flow?.to).toBe(addrOf(84, 1, 2_147_483_620));
      expect(prompt.warnings).toContainEqual({
        kind: "unusual-own-output",
        message: "m/84'/0'/0'/1/2147483620",
      });
      expect("signedPsbt" in result).toBe(true);
    });

    it("an internal request's own far input cannot hide an output past the scan limit", async () => {
      // Even a legitimate raise — an internal request really does spend /1/2147483600 — can
      // never hide an output at or past index 2000: the wallet provably cannot scan there.
      const { prompt, result } = await prepare(
        [{ template: "btc.bip84" }, { template: "btc.bip84", change: 1, index: 2_147_483_600 }],
        [
          { purpose: 84, change: 1, index: 1999 },
          { purpose: 84, change: 1, index: 2000 },
        ],
      );
      expect(prompt.outflows.filter((o) => o.ownPath !== undefined)).toHaveLength(1);
      const flow = prompt.outflows.find((o) => o.ownPath !== undefined);
      expect(flow?.ownPath).toBe("m/84'/0'/0'/1/2000");
      expect(prompt.warnings).toContainEqual({
        kind: "unusual-own-output",
        message: "m/84'/0'/0'/1/2000",
      });
      expect("signedPsbt" in result).toBe(true);
    });

    it("the sealed mark widens the hidden bound — a stored 20 hides /1/40, not /1/41", async () => {
      const { prompt, result } = await prepare(
        [{ template: "btc.bip84" }],
        [
          { purpose: 84, change: 1, index: 40 },
          { purpose: 84, change: 1, index: 41 },
        ],
        { storedMark: () => 20 },
      );
      expect(prompt.outflows.filter((o) => o.ownPath !== undefined)).toHaveLength(1);
      const flow = prompt.outflows.find((o) => o.ownPath !== undefined);
      expect(flow?.ownPath).toBe("m/84'/0'/0'/1/41");
      expect(prompt.warnings).toContainEqual({
        kind: "unusual-own-output",
        message: "m/84'/0'/0'/1/41",
      });
      expect("signedPsbt" in result).toBe(true);
    });

    it("shows a change-chain output whose purpose no signed input shares", async () => {
      const { prompt, result } = await prepare(
        [{ template: "btc.bip84" }],
        [{ purpose: 44, change: 1, index: 0 }],
      );
      const flow = prompt.outflows.find((o) => o.ownPath !== undefined);
      expect(flow?.ownPath).toBe("m/44'/0'/0'/1/0");
      expect(prompt.warnings).toContainEqual({
        kind: "unusual-own-output",
        message: "m/44'/0'/0'/1/0",
      });
      expect("signedPsbt" in result).toBe(true);
    });

    it("a change input of another purpose does not raise the bound", async () => {
      const { prompt, result } = await prepare(
        [{ template: "btc.bip84" }, { template: "btc.bip44", change: 1, index: 30 }],
        [{ purpose: 84, change: 1, index: 25 }],
      );
      const flow = prompt.outflows.find((o) => o.ownPath !== undefined);
      expect(flow?.ownPath).toBe("m/84'/0'/0'/1/25");
      expect(prompt.warnings).toContainEqual({
        kind: "unusual-own-output",
        message: "m/84'/0'/0'/1/25",
      });
      expect("signedPsbt" in result).toBe(true);
    });

    it("a signed receive-chain input does not raise the bound", async () => {
      const { prompt, result } = await prepare(
        [{ template: "btc.bip84", change: 0, index: 30 }],
        [{ purpose: 84, change: 1, index: 25 }],
      );
      const flow = prompt.outflows.find((o) => o.ownPath !== undefined);
      expect(flow?.ownPath).toBe("m/84'/0'/0'/1/25");
      expect(prompt.warnings).toContainEqual({
        kind: "unusual-own-output",
        message: "m/84'/0'/0'/1/25",
      });
      expect("signedPsbt" in result).toBe(true);
    });

    it("an output bound on a hardened index shows as a foreign payee, never the account's own", async () => {
      /* The derivation path m/84'/0'/0'/1/0' names a hardened leaf — no index of this account —
         so claiming the fingerprint changes nothing: the output is shown by address alone. */
      const { prompt, result } = await prepare(
        [{ template: "btc.bip84" }],
        [{ purpose: 84, change: 1, index: HARDENED }],
      );
      expect(prompt.outflows.every((o) => o.ownPath === undefined)).toBe(true);
      expect(warningsOf(prompt)).toHaveLength(0);
      expect("signedPsbt" in result).toBe(true);
    });

    it("an output bound past the two account chains shows as a foreign payee", async () => {
      // m/84'/0'/0'/2/5 is a real key the seed derives — but no chain this account owns.
      const { prompt, result } = await prepare(
        [{ template: "btc.bip84" }],
        [{ purpose: 84, change: 2, index: 5 }],
      );
      expect(prompt.outflows.every((o) => o.ownPath === undefined)).toBe(true);
      expect(warningsOf(prompt)).toHaveLength(0);
      expect("signedPsbt" in result).toBe(true);
    });

    it("an output whose path the material cannot serve fails instead of reading as foreign", async () => {
      /* `device-required` while an output is classified is a real answer — the signer must
         serve or the request fails; swallowing it as "not own" would show a crafted own-key
         output as a plain payee. Only the output's path is unservable — the signed input's
         derivation must resolve or the request fails before classification even runs. */
      const keys = seedKeys(seed, rng);
      try {
        const material = {
          ...keys.material,
          secp256k1: unservable(keys, [[84 + HARDENED, HARDENED, HARDENED, 1, 3]]),
        };
        const request = asPsbt(
          normalizeBitcoin({
            kind: "bitcoin.psbt",
            origin: "internal",
            network: BTC_NETWORK,
            account,
            psbt: ownPsbt([{ template: "btc.bip84" }], [{ purpose: 84, change: 1, index: 3 }]),
            sign: [{ index: 0, template: "btc.bip84" }],
          }),
        );
        await expect(prepareBitcoin(request, account, material, () => 0)).rejects.toMatchObject({
          code: "device-required",
        });
      } finally {
        keys.wipe();
      }
    });
  });
});

/** The byte offset of the field-11 (contract) tag in a raw_data buffer, or -1. */
const contractTagAt = (base: Uint8Array): number => base.findIndex((b, i) => b === 0x5a && i > 2);

/** The prompt of the last prompted keystore `open`, if the kernel prompted at all. */
const lastOpenPrompt = (calls: ReadonlyArray<KeystoreCall>) => {
  const last = calls.findLast((c) => c.op === "open" && c.prompt !== undefined);
  return last?.op === "open" ? last.prompt : undefined;
};

describe("chain.sign tron", () => {
  const ANVIL = tronVectors.keys.find((k) => k.name === "anvil");
  if (ANVIL === undefined) {
    throw new Error("vectors: no anvil key");
  }
  const NETWORK = "tron:728126428";
  const TAKEOVER_KEYS =
    "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6, TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG, TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC";
  const PERMISSION_UPDATE = tronVectors.transactions.find(
    (t) => t.name === "account-permission-update",
  );
  if (PERMISSION_UPDATE === undefined) {
    throw new Error("vectors: no account-permission-update");
  }

  const setup = async () => {
    const h = createHarness();
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(vectors.mnemonic),
        factor: { kind: "passkey", credentialId: CREDENTIAL_ID, prf: new Uint8Array(PRF_VAULT) },
      }),
    );
    const session = strField(res, "session");
    ok(await h.call("vault.setBlindSigning", { enabled: true, verify: PASSKEY() }, session));
    return { h, session, walletId: strField(field(res, "wallet"), "walletId") };
  };

  const callSign = async (
    h: ReturnType<typeof createHarness>,
    session: string,
    request: unknown,
    verify: unknown = PASSKEY(),
  ) => h.call("chain.sign", { request, verify }, session);

  const importTronKey = async (
    h: ReturnType<typeof createHarness>,
    session: string,
    privateKey: string,
  ) => {
    const res = ok(
      await h.call("keys.import", { family: "tron", secret: hexToBytes(privateKey) }, session),
    );
    return { kind: "imported" as const, keyId: strField(res, "keyId"), family: "tron" as const };
  };

  it("signs every transactions and messages vector with an imported key", async () => {
    const { h, session } = await setup();
    const account = await importTronKey(h, session, ANVIL.privateKey);
    for (const vector of tronVectors.transactions.filter((v) => v.input !== null)) {
      const res = ok(
        // oxlint-disable-next-line no-await-in-loop -- signatures are asserted one vector at a time
        await callSign(h, session, {
          kind: "tron.transaction",
          network: NETWORK,
          account,
          rawData: hexToBytes(vector.rawDataHex),
        }),
      );
      expect(Buffer.from(bytesField(res, "signature")).toString("hex")).toBe(
        vector.signature.toLowerCase(),
      );
    }
    for (const vector of tronVectors.messages.filter((m) => m.privateKey === ANVIL.privateKey)) {
      const res = ok(
        // oxlint-disable-next-line no-await-in-loop -- signatures are asserted one vector at a time
        await callSign(h, session, {
          kind: "tron.message",
          network: NETWORK,
          account,
          message: hexToBytes(vector.messageHex),
        }),
      );
      expect(Buffer.from(bytesField(res, "signature")).toString("hex")).toBe(vector.signature);
    }
  });

  it("HD and imported keys sign identically (BIP-44 group 0)", async () => {
    const h1 = createHarness();
    await h1.settle();
    const imported1 = ok(
      await h1.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes("test test test test test test test test test test test junk"),
        factor: {
          kind: "passkey",
          credentialId: CREDENTIAL_ID,
          prf: new Uint8Array(PRF_VAULT),
        },
      }),
    );
    const session1 = strField(imported1, "session");
    const walletId1 = strField(field(imported1, "wallet"), "walletId");
    const accountRes = ok(
      await h1.call(
        "wallet.accounts",
        { walletId: walletId1, groupIndex: 0, template: "tron.bip44", network: NETWORK },
        session1,
      ),
    );
    const address = strField(accountRes, "address");
    const rawData = buildTronRawData(
      {
        refBlock: { number: 1, id: "a".repeat(64) },
        expiration: 1_700_000_000_000,
        timestamp: 1_699_999_000_000,
      },
      { type: "TransferContract", owner: address, to: ANVIL.address, amount: 1n },
    );
    const hdRes = ok(
      await callSign(h1, session1, {
        kind: "tron.transaction",
        network: NETWORK,
        account: hd(walletId1, "tron.bip44"),
        rawData,
      }),
    );
    const h2 = createHarness();
    await h2.settle();
    const session2 = strField(
      ok(
        await h2.call("wallet.importMnemonic", {
          mnemonic: utf8ToBytes(vectors.mnemonic),
          factor: {
            kind: "passkey",
            credentialId: CREDENTIAL_ID,
            prf: new Uint8Array(PRF_VAULT),
          },
        }),
      ),
      "session",
    );
    const account2 = await importTronKey(
      h2,
      session2,
      "15f0bbb1774be40b7a8d7965d637f324bda2f711fc5726a3dcc19585c6950954",
    );
    const impRes = ok(
      await callSign(h2, session2, {
        kind: "tron.transaction",
        network: NETWORK,
        account: account2,
        rawData,
      }),
    );
    expect(bytesField(impRes, "signature")).toStrictEqual(bytesField(hdRes, "signature"));
    expect(verifyTronTransactionSignature(rawData, bytesField(impRes, "signature"), address)).toBe(
      true,
    );
  });

  it("signs the TIP-712 typed-data vectors byte-for-byte with an imported key", async () => {
    const { h, session } = await setup();
    const account = await importTronKey(h, session, ANVIL.privateKey);
    for (const vector of tronTypedDataVectors.cases) {
      const res = ok(
        // oxlint-disable-next-line no-await-in-loop -- signatures are asserted one vector at a time
        await callSign(h, session, {
          kind: "tron.typed-data",
          network: NETWORK,
          account,
          typedData: vector.typedData,
        }),
      );
      expect(`0x${Buffer.from(bytesField(res, "signature")).toString("hex")}`).toBe(
        vector.signature,
      );
    }
  });

  it("refuses malformed typed data and a chainId mismatch", async () => {
    const { h, session } = await setup();
    const account = await importTronKey(h, session, ANVIL.privateKey);
    const doc = tronTypedDataVectors.cases[0]?.typedData;
    expect(
      errCode(
        await callSign(h, session, {
          kind: "tron.typed-data",
          network: NETWORK,
          account,
          typedData: `${doc} null`,
        }),
      ),
    ).toBe("invalid-input");
    expect(
      errCode(
        await callSign(h, session, {
          kind: "tron.typed-data",
          network: "tron:2494104990",
          account,
          typedData: doc,
        }),
      ),
    ).toBe("invalid-input");
  });

  it("refuses a transaction whose owner differs from the account", async () => {
    const { h, session, walletId } = await setup();
    const rawData = buildTronRawData(
      {
        refBlock: { number: 1, id: "a".repeat(64) },
        expiration: 1_700_000_000_000,
        timestamp: 1_699_999_000_000,
      },
      { type: "TransferContract", owner: ANVIL.address, to: ANVIL.address, amount: 1n },
    );
    const res = await callSign(h, session, {
      kind: "tron.transaction",
      network: NETWORK,
      account: hd(walletId, "tron.bip44"),
      rawData,
    });
    expect(errCode(res)).toBe("invalid-input");
  });

  it("refuses a bare 32-byte digest and a two-contract transaction", async () => {
    const { h, session, walletId } = await setup();
    const account = hd(walletId, "tron.bip44");
    const digest = await callSign(h, session, {
      kind: "tron.transaction",
      network: NETWORK,
      account,
      rawData: new Uint8Array(32).fill(1),
    });
    expect(errCode(digest)).toBe("invalid-input");
    const base = hexToBytes(tronVectors.transactions[0]!.rawDataHex);
    /* Duplicate the field-11 (contract) entry at the end: the decoder rejects either the
       non-ascending field order or the second contract outright. */
    const tag = contractTagAt(base);
    expect(tag).toBeGreaterThan(0);
    const contractField = base.subarray(tag);
    const twoContracts = new Uint8Array([...base, ...contractField]);
    const res = await callSign(h, session, {
      kind: "tron.transaction",
      network: NETWORK,
      account,
      rawData: twoContracts,
    });
    expect(errCode(res)).toBe("invalid-input");
  });

  it("refuses transaction-shaped bytes as a tron.message", async () => {
    const { h, session, walletId } = await setup();
    const res = await callSign(h, session, {
      kind: "tron.message",
      network: NETWORK,
      account: hd(walletId, "tron.bip44"),
      message: hexToBytes(tronVectors.transactions[0]!.rawDataHex),
    });
    expect(errCode(res)).toBe("invalid-input");
  });

  it("refuses a tron request under an evm.bip44 template", async () => {
    const { h, session, walletId } = await setup();
    const res = await callSign(h, session, {
      kind: "tron.transaction",
      network: NETWORK,
      account: hd(walletId, "evm.bip44"),
      rawData: hexToBytes(tronVectors.transactions[0]!.rawDataHex),
    });
    expect(errCode(res)).toBe("invalid-input");

    // Same refusal when the contract owner is the tron.bip44-derived address, so the
    // template check — not owner binding — is the refusing check.
    const accountRes = ok(
      await h.call(
        "wallet.accounts",
        { walletId, groupIndex: 0, template: "tron.bip44", network: NETWORK },
        session,
      ),
    );
    const tronAddress = strField(accountRes, "address");
    const rawData = buildTronRawData(
      {
        refBlock: { number: 1, id: "a".repeat(64) },
        expiration: 1_700_000_000_000,
        timestamp: 1_699_999_000_000,
      },
      { type: "TransferContract", owner: tronAddress, to: ANVIL.address, amount: 1n },
    );
    const res2 = await callSign(h, session, {
      kind: "tron.transaction",
      network: NETWORK,
      account: hd(walletId, "evm.bip44"),
      rawData,
    });
    expect(errCode(res2)).toBe("invalid-input");
  });

  it("refuses an evm-family imported key for a tron request", async () => {
    const { h, session } = await setup();
    const res = ok(
      await h.call(
        "keys.import",
        { family: "evm", secret: new Uint8Array(32).fill(0x22) },
        session,
      ),
    );
    const keyId = strField(res, "keyId");
    const signRes = await callSign(h, session, {
      kind: "tron.transaction",
      network: NETWORK,
      account: { kind: "imported", keyId, family: "tron" },
      rawData: hexToBytes(tronVectors.transactions[0]!.rawDataHex),
    });
    expect(errCode(signRes)).toBe("invalid-input");
  });

  it("refuses a permission update before any prompt while blind signing is off", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(vectors.mnemonic),
        factor: { kind: "device" },
      }),
    );
    const session = strField(res, "session");
    const account = await importTronKey(h, session, ANVIL.privateKey);
    const opens = fake.calls.filter((c: KeystoreCall) => c.op === "open").length;
    const response = await callSign(
      h,
      session,
      {
        kind: "tron.transaction",
        network: NETWORK,
        account,
        rawData: hexToBytes(PERMISSION_UPDATE.rawDataHex),
      },
      { kind: "hardware" },
    );
    expect(errCode(response)).toBe("blind-signing-disabled");
    expect(fake.calls.filter((c: KeystoreCall) => c.op === "open")).toHaveLength(opens);
  });

  it("leads the permission-update prompt with the takeover line naming every new key", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(vectors.mnemonic),
        factor: { kind: "device" },
      }),
    );
    const session = strField(res, "session");
    const account = await importTronKey(h, session, ANVIL.privateKey);
    ok(
      await h.call(
        "vault.setBlindSigning",
        { enabled: true, verify: { kind: "hardware" } },
        session,
      ),
    );
    await callSign(
      h,
      session,
      {
        kind: "tron.transaction",
        network: NETWORK,
        account,
        rawData: hexToBytes(PERMISSION_UPDATE.rawDataHex),
      },
      { kind: "hardware" },
    );
    const prompt = lastOpenPrompt(fake.calls);
    const takeover = prompt?.description.split("\n")[0];
    expect(takeover).toBe(
      `Account takeover: this gives control of this account to ${TAKEOVER_KEYS}. Whoever holds these keys can move all of its assets.`,
    );
    /* Every key of the owner permission and of each active permission is named. */
    const update = (
      PERMISSION_UPDATE.input as {
        contract: {
          ownerPermission: { keys: ReadonlyArray<{ address: string }> };
          actives: ReadonlyArray<{ keys: ReadonlyArray<{ address: string }> }>;
        };
      }
    ).contract;
    const expectedKeys = [
      ...update.ownerPermission.keys.map((k: { address: string }) => k.address),
      ...update.actives.flatMap((p: { keys: ReadonlyArray<{ address: string }> }) =>
        p.keys.map((k) => k.address),
      ),
    ];
    expect(expectedKeys).toStrictEqual(TAKEOVER_KEYS.split(", "));
    for (const address of expectedKeys) {
      expect(takeover).toContain(address);
    }
  });

  it("a session that ends during the prompt fails locked without signing", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore, maxSessionMs: 60_000 });
    await h.settle();
    const res = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(vectors.mnemonic),
        factor: { kind: "device" },
      }),
    );
    const session = strField(res, "session");
    const account = await importTronKey(h, session, ANVIL.privateKey);
    const release = fake.hold();
    const prompted = new Promise<void>((resolve) => {
      fake.watchOpen(resolve);
    });
    const pending = callSign(
      h,
      session,
      {
        kind: "tron.transaction",
        network: NETWORK,
        account,
        rawData: hexToBytes(tronVectors.transactions[0]!.rawDataHex),
      },
      { kind: "hardware" },
    );
    await prompted;
    h.advance(60_001);
    release();
    const response = await pending;
    expect(errCode(response)).toBe("locked");
    expect("ok" in response).toBe(false);
  });
});
