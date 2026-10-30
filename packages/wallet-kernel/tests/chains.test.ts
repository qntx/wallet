/**
 * Chains module `wallet.accounts` through the real protocol: import the vector mnemonic, then
 * derive each template's account and compare against vectors/templates/chains.json (BIP-84/86
 * texts, MetaMask-compatible EVM accounts, SLIP-10-checked Solana).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { ed25519 } from "@noble/curves/ed25519.js";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";

import { normalizeEvm } from "@qntx/wallet-chains/evm";
import { normalizeSolana, verifySolanaSignature } from "@qntx/wallet-chains/solana";
import { recoverEvmSigner } from "@qntx/wallet-chains/evm";
import { solanaAddressFromPublicKey } from "@qntx/wallet-chains/solana";
import { mnemonicToSeedSync } from "@scure/bip39";

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
const PASSKEY = () => ({ kind: "passkey", credentialId: new Uint8Array(CREDENTIAL_ID), prf: new Uint8Array(PRF_VAULT) });
const EVM_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const SOL_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";

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
    1, 0, 1, 3, ...fp, ...dest, ...system, ...blockhash, 1, 2, 2, 0, 1, 12, ...data,
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
      recoverEvmSigner(txReq, { signedTransaction: field(txRes, "signedTransaction") as Uint8Array }),
    ).toBe(EVM_ADDRESS.toLowerCase());
    const msgReq = normalizeEvm({
      kind: "evm.personal-message",
      network: "eip155:1",
      account,
      message: utf8ToBytes("hello"),
    });
    const msgRes = ok(await callSign(h, session, msgReq));
    expect(
      recoverEvmSigner(msgReq, { signature: field(msgRes, "signature") as Uint8Array }),
    ).toBe(EVM_ADDRESS.toLowerCase());
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
    expect(
      recoverEvmSigner(tdReq, { signature: field(tdRes, "signature") as Uint8Array }),
    ).toBe(EVM_ADDRESS.toLowerCase());
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
    const txSig = field(txRes, "signature");
    expect(txSig instanceof Uint8Array && verifySolanaSignature(txMsg, txSig, SOL_ADDRESS)).toBe(
      true,
    );
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
    const sig = field(msgRes, "signature");
    expect(sig instanceof Uint8Array && verifySolanaSignature(msg, sig, SOL_ADDRESS)).toBe(true);
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
    const bitcoin = await h.call(
      "chain.sign",
      {
        request: {
          kind: "bitcoin.psbt",
          network: "bip122:000000000019d6689c085ae165831e93",
          account: hd(walletId, "btc.bip84"),
          psbt: new Uint8Array(4),
          sign: [0],
        },
        verify: PASSKEY(),
      },
      session,
    );
    expect("err" in bitcoin).toBe(true);
  });
});
