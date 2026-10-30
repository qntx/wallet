/**
 * Chains module `wallet.accounts` through the real protocol: import the vector mnemonic, then
 * derive each template's account and compare against vectors/templates/chains.json (BIP-84/86
 * texts, MetaMask-compatible EVM accounts, SLIP-10-checked Solana).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import { describe, expect, it } from "vite-plus/test";

import type { SignRequest } from "@qntx/wallet-chains";
import {
  bitcoinNetwork,
  normalizeBitcoin,
  verifiabilityBitcoin,
  verifyBitcoinMessage,
  verifyBitcoinPsbtSignatures,
} from "@qntx/wallet-chains/bitcoin";
import { normalizeEvm, recoverEvmSigner } from "@qntx/wallet-chains/evm";
import { normalizeSolana, verifySolanaSignature } from "@qntx/wallet-chains/solana";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { createHarness } from "./harness.ts";
import type { KernelResponse } from "./harness.ts";

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
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
    throw new Error("expected bytes");
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
const btcChild = (template: string, change: number, index: number): HDKey => {
  const purpose = template === "btc.bip86" ? 86 : 84;
  return HDKey.fromMasterSeed(mnemonicToSeedSync(vectors.mnemonic)).derive(
    `m/${purpose}'/0'/0'/${change}/${index}`,
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
  readonly fingerprint?: number;
  readonly wrongPub?: boolean;
  readonly wrongScript?: boolean;
  readonly changeOutput?: boolean;
  readonly foreignOutput?: boolean;
  readonly extraInput?: boolean;
};

/** A one-input PSBT with correct derivation entries for the vector wallet's account. */
const btcPsbt = (opts: PsbtOpts): Uint8Array => {
  const purpose = opts.template === "btc.bip86" ? 86 : 84;
  const change = opts.change ?? 0;
  const index = opts.index ?? 0;
  const fp = opts.fingerprint ?? MASTER_FP;
  const foreignPub = btcChild(opts.template, 0, 7).publicKey!;
  const foreignXonly = foreignPub.slice(1);
  const child = btcChild(opts.template, change, index);
  const pub = child.publicKey!;
  const xonly = pub.slice(1);
  const spend = purpose === 86 ? p2tr(xonly) : p2wpkh(pub);
  const path = [purpose + HARDENED, HARDENED, HARDENED, change, index];
  const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
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
    input["tapInternalKey"] = opts.wrongScript === true ? foreignXonly : xonly;
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
    return {
      h,
      session: strField(res, "session"),
      walletId: strField(field(res, "wallet"), "walletId"),
    };
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
      network: BTC_NETWORK,
      account: hd(walletId, "btc.bip84"),
      psbt: btcPsbt({ template: "btc.bip84" }),
      sign: [0],
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

  it("treats our change output as change and an external input as opaque", async () => {
    const { h, session, walletId } = await setup();
    const changeReq = normalizeBitcoin({
      kind: "bitcoin.psbt",
      network: BTC_NETWORK,
      account: hd(walletId, "btc.bip84"),
      psbt: btcPsbt({ template: "btc.bip84", changeOutput: true }),
      sign: [0],
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
      network: BTC_NETWORK,
      account: hd(walletId, "btc.bip84"),
      psbt: btcPsbt({ template: "btc.bip84", extraInput: true }),
      sign: [0],
    });
    const externalRes = ok(await callSign(h, session, externalReq));
    const extTx = Transaction.fromPSBT(bytesField(externalRes, "signedPsbt"));
    expect(extTx.getInput(0).partialSig).toBeDefined();
    expect(extTx.getInput(1).partialSig).toBeUndefined();
    expect(verifiabilityBitcoin(asPsbt(externalReq))).toBe("opaque");
  });

  it("rejects wrong derivations, foreign scripts, bad addresses and wrong factors", async () => {
    const { h, session, walletId } = await setup();
    const foreignFp = normalizeBitcoin({
      kind: "bitcoin.psbt",
      network: BTC_NETWORK,
      account: hd(walletId, "btc.bip84"),
      psbt: btcPsbt({ template: "btc.bip84", fingerprint: 0xdeadbeef }),
      sign: [0],
    });
    expect("err" in (await callSign(h, session, foreignFp))).toBe(true);
    const wrongPub = normalizeBitcoin({
      kind: "bitcoin.psbt",
      network: BTC_NETWORK,
      account: hd(walletId, "btc.bip84"),
      psbt: btcPsbt({ template: "btc.bip84", wrongPub: true }),
      sign: [0],
    });
    expect("err" in (await callSign(h, session, wrongPub))).toBe(true);
    const wrongScript = normalizeBitcoin({
      kind: "bitcoin.psbt",
      network: BTC_NETWORK,
      account: hd(walletId, "btc.bip86"),
      psbt: btcPsbt({ template: "btc.bip86", wrongScript: true }),
      sign: [0],
    });
    expect("err" in (await callSign(h, session, wrongScript))).toBe(true);
    const wrongFactor = await callSign(
      h,
      session,
      normalizeBitcoin({
        kind: "bitcoin.psbt",
        network: BTC_NETWORK,
        account: hd(walletId, "btc.bip84"),
        psbt: btcPsbt({ template: "btc.bip84" }),
        sign: [0],
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
});
