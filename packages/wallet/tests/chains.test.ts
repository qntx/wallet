import { utf8ToBytes } from "@noble/hashes/utils.js";
/**
 * `chains(wallet)` host proxy: `account` forwards `wallet.accounts` to the kernel and returns the
 * validated result. The kernel-side derivation is covered in packages/wallet-kernel/tests.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  bitcoinAddressFromXpub,
  bitcoinNetwork,
} from "@qntx/wallet-chains/bitcoin";
import { signBitcoinMessage, signBitcoinPsbt } from "@qntx/wallet-chains/bitcoin/sign";
import { signEvmPersonalMessage } from "@qntx/wallet-chains/evm/sign";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";

import { chains } from "../src/chains/index.ts";
import { connectKernel } from "../src/wallet.ts";
import type { ChainSignRequest } from "../src/protocol/chains.ts";

import { FakeKernel, unlockedStatus, PASSKEY, ScriptedPort, walletError } from "./host.test.ts";

const RESULT = {
  template: "evm.bip44" as const,
  network: "eip155:1",
  address: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
};

describe("chains(wallet)", () => {
  it("forwards wallet.accounts and returns the result", async () => {
    const kernel = new FakeKernel(unlockedStatus());
    const params = {
      walletId: "0a".repeat(8),
      groupIndex: 0,
      template: "evm.bip44" as const,
      network: "eip155:1",
    };
    kernel.handlers.set("wallet.accounts", () => ({ ok: RESULT }));
    const wallet = await connectKernel({
      spawn: () => {
        const port = new ScriptedPort(kernel);
        kernel.attach(port);
        return port;
      },
      passkey: PASSKEY,
      ceremony: undefined,
      setTimer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
    });
    const account = await chains(wallet).account(params);
    expect(account).toStrictEqual(RESULT);
    expect(kernel.received).toContain("wallet.accounts");
  });

  const PRIV = new Uint8Array(32).fill(7);
  const ADDRESS = "0x4a62316623ad457F02cDC5D997deD67a383EC569";
  const MESSAGE = utf8ToBytes("hello");

  const connect = async (signature: Uint8Array) => {
    const kernel = new FakeKernel(unlockedStatus());
    kernel.handlers.set("chain.sign", () => ({ ok: { kind: "evm.personal-message", signature } }));
    kernel.handlers.set("wallet.accounts", () => ({
      ok: { template: "evm.bip44", network: "eip155:1", address: ADDRESS },
    }));
    const wallet = await connectKernel({
      spawn: () => {
        const port = new ScriptedPort(kernel);
        kernel.attach(port);
        return port;
      },
      passkey: PASSKEY,
      ceremony: undefined,
      setTimer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
    });
    return { kernel, wallet };
  };

  const signParams = () => ({
    request: {
      kind: "evm.personal-message" as const,
      network: "eip155:1",
      account: {
        kind: "hd" as const,
        walletId: "0a".repeat(8),
        groupIndex: 0,
        template: "evm.bip44" as const,
      },
      message: MESSAGE,
    },
    verify: { kind: "password" as const, password: "test password" },
  });

  it("returns the kernel's signature when it verifies for the account", async () => {
    const { kernel, wallet } = await connect(signEvmPersonalMessage(MESSAGE, PRIV));
    const result = await chains(wallet).sign(signParams());
    expect(result.kind).toBe("evm.personal-message");
    expect(kernel.received).toContain("chain.sign");
    expect(kernel.received).toContain("wallet.accounts");
  });

  it("rejects a forged kernel signature with integrity", async () => {
    const { wallet } = await connect(signEvmPersonalMessage(MESSAGE, new Uint8Array(32).fill(8)));
    await expect(chains(wallet).sign(signParams())).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
  });

  const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
  const btcNode = (path: string) =>
    HDKey.fromMasterSeed(
      mnemonicToSeedSync(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      ),
    ).derive(path);
  const BTC_XPUB = btcNode("m/84'/0'/0'").publicExtendedKey;
  const BTC_CHILD = btcNode("m/84'/0'/0'/0/0");

  const btcPsbt = (): Uint8Array => {
    const pub = BTC_CHILD.publicKey;
    if (pub === null) {
      throw new Error("no pubkey");
    }
    const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
    tx.addInput({
      txid: new Uint8Array(32),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: p2wpkh(pub).script, amount: 100000n },
      bip32Derivation: [
        [pub, { fingerprint: 0x73c5da0a, path: [0x80000054, 0x80000000, 0x80000000, 0, 0] }],
      ],
    });
    tx.addOutput({
      script: OutScript.encode(
        Address(bitcoinNetwork(BTC_NETWORK).params).decode(
          "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g",
        ),
      ),
      amount: 90000n,
    });
    return tx.toPSBT(0);
  };

  const btcConnect = async (result: { readonly kind: string; readonly signedPsbt?: Uint8Array; readonly signature?: string }) => {
    const kernel = new FakeKernel(unlockedStatus());
    kernel.handlers.set("chain.sign", () => ({ ok: result }));
    kernel.handlers.set("wallet.accounts", () => ({
      ok: {
        template: "btc.bip84",
        network: BTC_NETWORK,
        xpub: BTC_XPUB,
        fingerprint: "73c5da0a",
        path: "m/84'/0'/0'",
      },
    }));
    const wallet = await connectKernel({
      spawn: () => {
        const port = new ScriptedPort(kernel);
        kernel.attach(port);
        return port;
      },
      passkey: PASSKEY,
      ceremony: undefined,
      setTimer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
    });
    return { kernel, wallet };
  };

  const btcParams = (request: ChainSignRequest) => ({
    request,
    verify: { kind: "password" as const, password: "test password" },
  });

  const btcAccount = () => ({
    kind: "hd" as const,
    walletId: "0a".repeat(8),
    groupIndex: 0,
    template: "btc.bip84" as const,
  });

  it("accepts a kernel psbt signed by the account's own child key", async () => {
    const { wallet } = await btcConnect({
      kind: "bitcoin.psbt",
      signedPsbt: signBitcoinPsbt(
        btcPsbt(),
        [{ index: 0, privateKey: BTC_CHILD.privateKey! }],
        () => new Uint8Array(32),
      ),
    });
    const result = await chains(wallet).sign(
      btcParams({ kind: "bitcoin.psbt", network: BTC_NETWORK, account: btcAccount(), psbt: btcPsbt(), sign: [0] }),
    );
    expect(result.kind).toBe("bitcoin.psbt");
  });

  it("rejects a kernel psbt signed by a foreign key with integrity", async () => {
    const foreignNode = HDKey.fromMasterSeed(
      mnemonicToSeedSync(
        "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title",
      ),
    ).derive("m/84'/0'/0'/0/0");
    const foreignPub = foreignNode.publicKey;
    if (foreignPub === null || foreignNode.privateKey === null) {
      throw new Error("no foreign key");
    }
    const foreignTx = new Transaction({ version: 2, allowUnknownOutputs: true });
    foreignTx.addInput({
      txid: new Uint8Array(32),
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: p2wpkh(foreignPub).script, amount: 100000n },
      bip32Derivation: [
        [foreignPub, { fingerprint: 0x73c5da0a, path: [0x80000054, 0x80000000, 0x80000000, 0, 0] }],
      ],
    });
    foreignTx.addOutput({ script: p2wpkh(foreignPub).script, amount: 90000n });
    const { wallet } = await btcConnect({
      kind: "bitcoin.psbt",
      signedPsbt: signBitcoinPsbt(
        foreignTx.toPSBT(0),
        [{ index: 0, privateKey: foreignNode.privateKey }],
        () => new Uint8Array(32),
      ),
    });
    await expect(
      chains(wallet).sign(
        btcParams({ kind: "bitcoin.psbt", network: BTC_NETWORK, account: btcAccount(), psbt: btcPsbt(), sign: [0] }),
      ),
    ).rejects.toSatisfy((e) => walletError(e).code === "integrity");
  });

  it("accepts a kernel bip322 message signed by the account's child key", async () => {
    const { wallet } = await btcConnect({
      kind: "bitcoin.message",
      signature: signBitcoinMessage(
        {
          network: BTC_NETWORK,
          address: bitcoinAddressFromXpub(BTC_XPUB, "btc.bip84", BTC_NETWORK, 0, 0),
          message: "hello",
          format: "bip322-simple",
        },
        BTC_CHILD.privateKey!,
        () => new Uint8Array(32),
      ),
    });
    const result = await chains(wallet).sign(
      btcParams({
        kind: "bitcoin.message",
        network: BTC_NETWORK,
        account: btcAccount(),
        address: bitcoinAddressFromXpub(BTC_XPUB, "btc.bip84", BTC_NETWORK, 0, 0),
        message: "hello",
        format: "bip322-simple",
        change: 0,
        index: 0,
      }),
    );
    expect(result.kind).toBe("bitcoin.message");
  });
});
