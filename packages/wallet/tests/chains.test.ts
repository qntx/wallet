import { utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Address, OutScript, p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
/**
 * `chains(wallet)` host proxy: `account` forwards `wallet.accounts` to the kernel and returns the
 * validated result. The kernel-side derivation is covered in packages/wallet-kernel/tests.
 */
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { bitcoinAddressFromXpub, bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import { signBitcoinMessage, signBitcoinPsbt } from "@qntx/wallet-chains/bitcoin/sign";
import { signEvmPersonalMessage, signEvmTransaction } from "@qntx/wallet-chains/evm/sign";

import { chains } from "../src/chains/index.ts";
import type { ChainSignRequest } from "../src/protocol/chains.ts";
import { connectKernel } from "../src/wallet.ts";
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
      verifyEvent,
      spawn: () => {
        const port = new ScriptedPort(kernel);
        kernel.attach(port);
        return port;
      },
      factors: "software",
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
      verifyEvent,
      spawn: () => {
        const port = new ScriptedPort(kernel);
        kernel.attach(port);
        return port;
      },
      factors: "software",
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

  describe("imported account", () => {
    const KEY_ID = "11".repeat(8);
    const importedParams = () => ({
      request: {
        kind: "evm.personal-message" as const,
        network: "eip155:1",
        account: { kind: "imported" as const, keyId: KEY_ID, family: "evm" as const },
        message: MESSAGE,
      },
      verify: { kind: "password" as const, password: "test password" },
    });
    const connectImported = async (signature: Uint8Array, listed: boolean) => {
      const kernel = new FakeKernel(unlockedStatus());
      kernel.handlers.set("chain.sign", () => ({
        ok: { kind: "evm.personal-message", signature },
      }));
      kernel.handlers.set("keys.list", () => ({
        ok: listed ? [{ keyId: KEY_ID, family: "evm", address: ADDRESS, createdAt: 1 }] : [],
      }));
      const wallet = await connectKernel({
        verifyEvent,
        spawn: () => {
          const port = new ScriptedPort(kernel);
          kernel.attach(port);
          return port;
        },
        factors: "software",
        passkey: PASSKEY,
        ceremony: undefined,
        setTimer: (ms, fn) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
      });
      return wallet;
    };

    it("verifies the signature against the imported key's address", async () => {
      const wallet = await connectImported(signEvmPersonalMessage(MESSAGE, PRIV), true);
      const result = await chains(wallet).sign(importedParams());
      expect(result.kind).toBe("evm.personal-message");
    });

    it("rejects a signature not made by the imported key with integrity", async () => {
      const wallet = await connectImported(
        signEvmPersonalMessage(MESSAGE, new Uint8Array(32).fill(8)),
        true,
      );
      await expect(chains(wallet).sign(importedParams())).rejects.toSatisfy(
        (e) => walletError(e).code === "integrity",
      );
    });

    it("rejects a keyId the vault does not list with integrity", async () => {
      const wallet = await connectImported(signEvmPersonalMessage(MESSAGE, PRIV), false);
      await expect(chains(wallet).sign(importedParams())).rejects.toSatisfy(
        (e) => walletError(e).code === "integrity",
      );
    });
  });

  const connectTx = async (raw: Uint8Array) => {
    const kernel = new FakeKernel(unlockedStatus());
    kernel.handlers.set("chain.sign", () => ({
      ok: { kind: "evm.transaction", signedTransaction: raw },
    }));
    kernel.handlers.set("wallet.accounts", () => ({
      ok: { template: "evm.bip44", network: "eip155:1", address: ADDRESS },
    }));
    const wallet = await connectKernel({
      verifyEvent,
      spawn: () => {
        const port = new ScriptedPort(kernel);
        kernel.attach(port);
        return port;
      },
      factors: "software",
      passkey: PASSKEY,
      ceremony: undefined,
      setTimer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
    });
    return { kernel, wallet };
  };

  it("accepts a signed eip7702; a mismatched authorization fails the result check", async () => {
    const TX = {
      type: "eip7702" as const,
      chainId: 1,
      nonce: 0,
      gas: "0x61a8",
      value: "0x0",
      data: "0x",
      to: ADDRESS,
      accessList: [] as const,
      maxFeePerGas: "0x4a817c800",
      maxPriorityFeePerGas: "0x3b9aca00",
      authorization: { address: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B" },
    };
    const account = {
      kind: "hd" as const,
      walletId: "0a".repeat(8),
      groupIndex: 0,
      template: "evm.bip44" as const,
    };
    const request: ChainSignRequest = {
      kind: "evm.transaction",
      network: "eip155:1",
      account,
      tx: TX,
    };
    const verify = { kind: "password" as const, password: "test password" };
    const { wallet } = await connectTx(signEvmTransaction(TX, PRIV));
    const ok = await chains(wallet).sign({ request, verify });
    expect(ok.kind).toBe("evm.transaction");

    const tampered = (tx: Record<string, unknown>) => ({
      request: { ...request, tx: { ...TX, ...tx } },
      verify,
    });
    const { wallet: wrongAddress } = await connectTx(signEvmTransaction(TX, PRIV));
    await expect(
      chains(wrongAddress).sign(
        tampered({
          authorization: { address: "0x0000000000000000000000000000000000000000" },
        }) as never,
      ),
    ).rejects.toMatchObject({ code: "invalid-request" });
    const { wallet: wrongNonce } = await connectTx(signEvmTransaction(TX, PRIV));
    await expect(chains(wrongNonce).sign(tampered({ nonce: 5 }) as never)).rejects.toMatchObject({
      code: "invalid-request",
    });
  });

  const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";
  const btcNode = (path: string) =>
    HDKey.fromMasterSeed(
      mnemonicToSeedSync(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      ),
    ).derive(path);
  const BTC_XPUB = btcNode("m/84'/0'/0'").publicExtendedKey;
  const BTC_XPUB86 = btcNode("m/86'/0'/0'").publicExtendedKey;
  const BTC_CHILD = btcNode("m/84'/0'/0'/0/0");
  const BTC_CHILD86 = btcNode("m/86'/0'/0'/0/0");

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

  const btcConnect = async (result: {
    readonly kind: string;
    readonly signedPsbt?: Uint8Array;
    readonly signature?: string;
  }) => {
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
      verifyEvent,
      spawn: () => {
        const port = new ScriptedPort(kernel);
        kernel.attach(port);
        return port;
      },
      factors: "software",
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
      btcParams({
        kind: "bitcoin.psbt",
        network: BTC_NETWORK,
        account: btcAccount(),
        psbt: btcPsbt(),
        sign: [{ index: 0, template: "btc.bip84" }],
      }),
    );
    expect(result.kind).toBe("bitcoin.psbt");
  });

  it("verifies a mixed bip84+bip86 psbt per template; a bad bip86 signature is integrity", async () => {
    const xonly86 = BTC_CHILD86.publicKey!.slice(1);
    const mixed = (): Uint8Array => {
      const tx = new Transaction({ version: 2 });
      tx.addInput({
        txid: new Uint8Array(32),
        index: 0,
        sequence: 0xfffffffd,
        witnessUtxo: { script: p2wpkh(BTC_CHILD.publicKey!).script, amount: 100000n },
        bip32Derivation: [
          [
            BTC_CHILD.publicKey!,
            { fingerprint: 0x73c5da0a, path: [0x80000054, 0x80000000, 0x80000000, 0, 0] },
          ],
        ],
      });
      tx.addInput({
        txid: new Uint8Array(32).fill(8),
        index: 1,
        sequence: 0xfffffffd,
        witnessUtxo: { script: p2tr(xonly86).script, amount: 50000n },
        tapInternalKey: xonly86,
        tapBip32Derivation: [
          [
            xonly86,
            {
              hashes: [],
              der: {
                fingerprint: 0x73c5da0a,
                path: [0x80000056, 0x80000000, 0x80000000, 0, 0],
              },
            },
          ],
        ],
      });
      tx.addOutput({
        script: OutScript.encode(
          Address(bitcoinNetwork(BTC_NETWORK).params).decode(
            "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g",
          ),
        ),
        amount: 140000n,
      });
      return tx.toPSBT(0);
    };
    const request = () => ({
      kind: "bitcoin.psbt" as const,
      network: BTC_NETWORK,
      account: btcAccount(),
      psbt: mixed(),
      sign: [
        { index: 0, template: "btc.bip84" as const },
        { index: 1, template: "btc.bip86" as const },
      ],
    });
    const connect = async (signedPsbt: Uint8Array) => {
      const kernel = new FakeKernel(unlockedStatus());
      kernel.handlers.set("chain.sign", () => ({ ok: { kind: "bitcoin.psbt", signedPsbt } }));
      const xpubByTemplate: Record<string, { xpub: string; path: string }> = {
        "btc.bip84": { xpub: BTC_XPUB, path: "m/84'/0'/0'" },
        "btc.bip86": { xpub: BTC_XPUB86, path: "m/86'/0'/0'" },
      };
      kernel.handlers.set("wallet.accounts", (request) => {
        const { template } = request.params as { template: string };
        const account = xpubByTemplate[template];
        return {
          ok: {
            template,
            network: BTC_NETWORK,
            xpub: account!.xpub,
            fingerprint: "73c5da0a",
            path: account!.path,
          },
        };
      });
      const wallet = await connectKernel({
        verifyEvent,
        spawn: () => {
          const port = new ScriptedPort(kernel);
          kernel.attach(port);
          return port;
        },
        factors: "software",
        passkey: PASSKEY,
        ceremony: undefined,
        setTimer: (ms, fn) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
      });
      return wallet;
    };
    const signed = signBitcoinPsbt(
      mixed(),
      [
        { index: 0, privateKey: BTC_CHILD.privateKey! },
        { index: 1, privateKey: BTC_CHILD86.privateKey! },
      ],
      () => new Uint8Array(32),
    );
    const good = await connect(signed);
    const result = await chains(good).sign(btcParams(request()));
    expect(result.kind).toBe("bitcoin.psbt");

    // A tampered bip86 signature fails verification for its claimed pubkey.
    const tapSig = Transaction.fromPSBT(signed).getInput(1).tapKeySig!;
    const raw = new Uint8Array(signed);
    const at = raw.findIndex((_, i) => tapSig.every((b, j) => raw[i + j] === b));
    expect(at).toBeGreaterThanOrEqual(0);
    raw.fill(0, at, at + tapSig.length);
    const tampered = await connect(raw);
    await expect(chains(tampered).sign(btcParams(request()))).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
  });

  it("rejects a kernel psbt signed by a foreign key with integrity", async () => {
    const foreignNode = HDKey.fromMasterSeed(
      mnemonicToSeedSync(
        "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title",
      ),
    ).derive("m/84'/0'/0'/0/0");
    const foreignPub = foreignNode.publicKey!;
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
        [{ index: 0, privateKey: foreignNode.privateKey! }],
        () => new Uint8Array(32),
      ),
    });
    await expect(
      chains(wallet).sign(
        btcParams({
          kind: "bitcoin.psbt",
          network: BTC_NETWORK,
          account: btcAccount(),
          psbt: btcPsbt(),
          sign: [{ index: 0, template: "btc.bip84" }],
        }),
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
        account: { ...btcAccount(), template: "btc.bip84" as const },
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
