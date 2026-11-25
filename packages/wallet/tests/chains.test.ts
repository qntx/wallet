import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
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
import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import { signEvmPersonalMessage, signEvmTransaction } from "@qntx/wallet-chains/evm/sign";
import { solanaAddressFromPublicKey } from "@qntx/wallet-chains/solana";
import { signSolanaMessage } from "@qntx/wallet-chains/solana/sign";
import { tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";
import {
  signTronMessage,
  signTronTransaction,
  signTronTypedData,
} from "@qntx/wallet-chains/tron/sign";

import { chains } from "../src/chains/index.ts";
import type {
  ChainExportedKey,
  ChainExportResult,
  ChainSignRequest,
  ChainTemplate,
} from "../src/protocol/chains.ts";
import type { ProtocolValue } from "../src/protocol/index.ts";
import { connectKernel } from "../src/wallet.ts";
import { FakeKernel, unlockedStatus, PASSKEY, ScriptedPort, walletError } from "./host.test.ts";

const RESULT = {
  template: "evm.bip44" as const,
  network: "eip155:1",
  address: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
  confirmed: true,
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
      ok: { template: "evm.bip44", network: "eip155:1", address: ADDRESS, confirmed: true },
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
      ok: { template: "evm.bip44", network: "eip155:1", address: ADDRESS, confirmed: true },
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
    ).rejects.toMatchObject({ code: "integrity" });
    const { wallet: wrongNonce } = await connectTx(signEvmTransaction(TX, PRIV));
    await expect(chains(wrongNonce).sign(tampered({ nonce: 5 }) as never)).rejects.toMatchObject({
      code: "integrity",
    });
  });

  it("rejects a valid account signature over a different transaction with integrity", async () => {
    const TX = {
      type: "eip1559" as const,
      chainId: 1,
      nonce: 0,
      gas: "0x5208",
      value: "0x1",
      data: "0x",
      to: ADDRESS,
      accessList: [] as const,
      maxFeePerGas: "0x4a817c800",
      maxPriorityFeePerGas: "0x3b9aca00",
    };
    const request: ChainSignRequest = {
      kind: "evm.transaction",
      network: "eip155:1",
      account: { kind: "hd", walletId: "0a".repeat(8), groupIndex: 0, template: "evm.bip44" },
      tx: TX,
    };
    const verify = { kind: "password" as const, password: "test password" };
    const { wallet: honest } = await connectTx(signEvmTransaction(TX, PRIV));
    await expect(chains(honest).sign({ request, verify })).resolves.toMatchObject({
      kind: "evm.transaction",
    });
    const { wallet } = await connectTx(
      signEvmTransaction({ ...TX, value: "0xde0b6b3a7640000" }, PRIV),
    );
    await expect(chains(wallet).sign({ request, verify })).rejects.toSatisfy(
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
  const BTC_XPUB86 = btcNode("m/86'/0'/0'").publicExtendedKey;
  const BTC_CHILD = btcNode("m/84'/0'/0'/0/0");
  const BTC_CHILD86 = btcNode("m/86'/0'/0'/0/0");
  const BTC_XPUB44 = btcNode("m/44'/0'/0'").publicExtendedKey;
  const BTC_CHILD44 = btcNode("m/44'/0'/0'/0/0");

  const btcPsbt = (pay = 90000n): Uint8Array => {
    const pub = BTC_CHILD.publicKey;
    if (pub === null) {
      throw new Error("no pubkey");
    }
    const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
    const prev = new Transaction({ version: 2 });
    prev.addInput({ txid: new Uint8Array(32), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: p2wpkh(pub).script, amount: 100000n });
    tx.addInput({
      txid: prev.id,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: p2wpkh(pub).script, amount: 100000n },
      nonWitnessUtxo: prev.toBytes(true, false),
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
      amount: pay,
    });
    return tx.toPSBT(0);
  };

  const BIP84_ACCOUNT = {
    template: "btc.bip84",
    network: BTC_NETWORK,
    xpub: BTC_XPUB,
    fingerprint: "73c5da0a",
    path: "m/84'/0'/0'",
    changeMark: 0,
    confirmed: true,
  };

  const btcConnect = async (
    result: {
      readonly kind: string;
      readonly signedPsbt?: Uint8Array;
      readonly signature?: string;
    },
    account: typeof BIP84_ACCOUNT = BIP84_ACCOUNT,
  ) => {
    const kernel = new FakeKernel(unlockedStatus());
    kernel.handlers.set("chain.sign", () => ({ ok: result }));
    kernel.handlers.set("wallet.accounts", () => ({ ok: account }));
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

  it("rejects a kernel psbt that signs a different transaction with integrity", async () => {
    const { wallet } = await btcConnect({
      kind: "bitcoin.psbt",
      signedPsbt: signBitcoinPsbt(
        btcPsbt(10000n),
        [{ index: 0, privateKey: BTC_CHILD.privateKey! }],
        () => new Uint8Array(32),
      ),
    });
    await expect(
      chains(wallet).sign(
        btcParams({
          kind: "bitcoin.psbt",
          origin: "internal",
          network: BTC_NETWORK,
          account: btcAccount(),
          psbt: btcPsbt(),
          sign: [{ index: 0, template: "btc.bip84" }],
        }),
      ),
    ).rejects.toSatisfy((e) => walletError(e).code === "integrity");
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
        origin: "internal",
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
      const prev = new Transaction({ version: 2 });
      prev.addInput({ txid: new Uint8Array(32), index: 0, sequence: 0xffffffff });
      prev.addOutput({ script: p2wpkh(BTC_CHILD.publicKey!).script, amount: 100000n });
      tx.addInput({
        txid: prev.id,
        index: 0,
        sequence: 0xfffffffd,
        witnessUtxo: { script: p2wpkh(BTC_CHILD.publicKey!).script, amount: 100000n },
        nonWitnessUtxo: prev.toBytes(true, false),
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
      origin: "internal" as const,
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
            changeMark: 0,
            confirmed: true,
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
    const foreignPrev = new Transaction({ version: 2 });
    foreignPrev.addInput({ txid: new Uint8Array(32), index: 0, sequence: 0xffffffff });
    foreignPrev.addOutput({ script: p2wpkh(foreignPub).script, amount: 100000n });
    foreignTx.addInput({
      txid: foreignPrev.id,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: p2wpkh(foreignPub).script, amount: 100000n },
      nonWitnessUtxo: foreignPrev.toBytes(true, false),
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
          origin: "internal",
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

  it("accepts a kernel legacy message signed by the bip44 account's child key", async () => {
    const address = bitcoinAddressFromXpub(BTC_XPUB44, "btc.bip44", BTC_NETWORK, 0, 0);
    const { wallet } = await btcConnect(
      {
        kind: "bitcoin.message",
        signature: signBitcoinMessage(
          { network: BTC_NETWORK, address, message: "hello", format: "legacy" },
          BTC_CHILD44.privateKey!,
          () => new Uint8Array(32),
        ),
      },
      {
        template: "btc.bip44",
        network: BTC_NETWORK,
        xpub: BTC_XPUB44,
        fingerprint: "73c5da0a",
        path: "m/44'/0'/0'",
        changeMark: 0,
        confirmed: true,
      },
    );
    const result = await chains(wallet).sign(
      btcParams({
        kind: "bitcoin.message",
        network: BTC_NETWORK,
        account: { ...btcAccount(), template: "btc.bip44" as const },
        address,
        message: "hello",
        format: "legacy",
        change: 0,
        index: 0,
      }),
    );
    expect(result.kind).toBe("bitcoin.message");
  });

  describe("tron", () => {
    const TRON_PRIV = hexToBytes(
      "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    );
    const TRON_ADDR = "TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG";
    const RAW = hexToBytes(
      "0a026e5022081a2b3c4d5e6f789040e0a4eeb6b7335a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541f39fd6e51aad88f6f4ce6ab8827279cfffb922661215415cd0fb0ab3ce40f3051414c604b27756e69e43db18c0843d7080d0eab6b733",
    );
    const KEY_ID = "22".repeat(8);

    const TYPED_DATA = JSON.stringify({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        Ping: [{ name: "nonce", type: "uint64" }],
      },
      primaryType: "Ping",
      domain: { name: "T", chainId: "0x2b6653dc" },
      message: { nonce: "3" },
    });

    const tronParams = (kind: "tron.transaction" | "tron.message" | "tron.typed-data") => ({
      request:
        kind === "tron.transaction"
          ? {
              kind: "tron.transaction" as const,
              network: "tron:728126428",
              account: {
                kind: "hd" as const,
                walletId: "0a".repeat(8),
                groupIndex: 0,
                template: "tron.bip44" as const,
              },
              rawData: RAW,
            }
          : kind === "tron.typed-data"
            ? {
                kind: "tron.typed-data" as const,
                network: "tron:728126428",
                account: {
                  kind: "imported" as const,
                  keyId: KEY_ID,
                  family: "tron" as const,
                },
                typedData: TYPED_DATA,
              }
            : {
                kind: "tron.message" as const,
                network: "tron:728126428",
                account: { kind: "imported" as const, keyId: KEY_ID, family: "tron" as const },
                message: utf8ToBytes("hello tron"),
              },
      verify: { kind: "password" as const, password: "test password" },
    });

    const tronConnect = async (result: ProtocolValue) => {
      const kernel = new FakeKernel(unlockedStatus());
      kernel.handlers.set("chain.sign", () => ({ ok: result }));
      kernel.handlers.set("wallet.accounts", () => ({
        ok: { template: "tron.bip44", network: "tron:728126428", address: TRON_ADDR, confirmed: true },
      }));
      kernel.handlers.set("keys.list", () => ({
        ok: [{ keyId: KEY_ID, family: "tron", address: TRON_ADDR, createdAt: 1 }],
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

    it("accepts a transaction signature that verifies for the account", async () => {
      const wallet = await tronConnect({
        kind: "tron.transaction",
        signature: signTronTransaction(RAW, TRON_PRIV),
      });
      const result = await chains(wallet).sign(tronParams("tron.transaction"));
      expect(result.kind).toBe("tron.transaction");
    });

    /* A tron.transaction request must refuse a tron.message result even when the signature it
       carries would verify as a transaction signature — the kind check fires before the
       signature is recovered. */
    it("refuses a tron.message result whose signature verifies as a transaction signature", async () => {
      const wallet = await tronConnect({
        kind: "tron.message",
        signature: signTronTransaction(RAW, TRON_PRIV),
      });
      await expect(chains(wallet).sign(tronParams("tron.transaction"))).rejects.toSatisfy(
        (e) => walletError(e).code === "integrity",
      );
    });

    it("accepts a message signature that verifies for the imported key", async () => {
      const wallet = await tronConnect({
        kind: "tron.message",
        signature: signTronMessage(utf8ToBytes("hello tron"), TRON_PRIV),
      });
      const result = await chains(wallet).sign(tronParams("tron.message"));
      expect(result.kind).toBe("tron.message");
    });

    it("accepts a typed-data signature that verifies for the account", async () => {
      const wallet = await tronConnect({
        kind: "tron.typed-data",
        signature: signTronTypedData(TYPED_DATA, TRON_PRIV),
      });
      const result = await chains(wallet).sign(tronParams("tron.typed-data"));
      expect(result.kind).toBe("tron.typed-data");
    });

    it("rejects a typed-data signature over different content", async () => {
      const other = signTronTypedData(TYPED_DATA.replace('"nonce":"3"', '"nonce":"4"'), TRON_PRIV);
      const wallet = await tronConnect({ kind: "tron.typed-data", signature: other });
      await expect(chains(wallet).sign(tronParams("tron.typed-data"))).rejects.toSatisfy(
        (e) => walletError(e).code === "integrity",
      );
    });

    it("rejects a foreign-key signature with integrity", async () => {
      const wallet = await tronConnect({
        kind: "tron.transaction",
        signature: signTronTransaction(RAW, new Uint8Array(32).fill(9)),
      });
      await expect(chains(wallet).sign(tronParams("tron.transaction"))).rejects.toSatisfy(
        (e) => walletError(e).code === "integrity",
      );
    });

    it("rejects a mismatched result kind with integrity", async () => {
      const wallet = await tronConnect({
        kind: "tron.message",
        signature: signTronMessage(utf8ToBytes("hello tron"), TRON_PRIV),
      });
      await expect(chains(wallet).sign(tronParams("tron.transaction"))).rejects.toSatisfy(
        (e) => walletError(e).code === "integrity",
      );
    });
  });

  describe("result kind check", () => {
    const kindConnect = async (result: ProtocolValue, account: ProtocolValue) => {
      const kernel = new FakeKernel(unlockedStatus());
      kernel.handlers.set("chain.sign", () => ({ ok: result }));
      kernel.handlers.set("wallet.accounts", () => ({ ok: account }));
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

    const hd = (template: ChainTemplate) =>
      ({
        kind: "hd" as const,
        walletId: "0a".repeat(8),
        groupIndex: 0,
        template,
      }) as const;

    const evmTx: ChainSignRequest = {
      kind: "evm.transaction",
      network: "eip155:1",
      account: hd("evm.bip44"),
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        value: "0x0",
        data: "0x",
        to: ADDRESS,
        accessList: [],
        maxFeePerGas: "0x4a817c800",
        maxPriorityFeePerGas: "0x3b9aca00",
      },
    };

    const solanaSig = { kind: "solana.message", signature: new Uint8Array(64) };
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly request: ChainSignRequest;
      readonly result: ProtocolValue;
    }> = [
      { name: "evm.transaction", request: evmTx, result: solanaSig },
      {
        name: "evm.personal-message",
        request: {
          kind: "evm.personal-message",
          network: "eip155:1",
          account: hd("evm.bip44"),
          message: MESSAGE,
        },
        result: solanaSig,
      },
      {
        name: "evm.typed-data",
        request: {
          kind: "evm.typed-data",
          network: "eip155:1",
          account: hd("evm.bip44"),
          typedData: "{}",
        },
        result: solanaSig,
      },
      {
        name: "solana.transaction",
        request: {
          kind: "solana.transaction",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          account: hd("solana.bip44-change"),
          message: MESSAGE,
        },
        result: { kind: "evm.personal-message", signature: new Uint8Array(65) },
      },
      {
        name: "solana.message",
        request: {
          kind: "solana.message",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          account: hd("solana.bip44-change"),
          message: MESSAGE,
          format: "raw",
        },
        result: { kind: "evm.personal-message", signature: new Uint8Array(65) },
      },
      {
        name: "tron.transaction",
        request: {
          kind: "tron.transaction",
          network: "tron:728126428",
          account: hd("tron.bip44"),
          rawData: utf8ToBytes("raw"),
        },
        result: solanaSig,
      },
      {
        name: "tron.message",
        request: {
          kind: "tron.message",
          network: "tron:728126428",
          account: hd("tron.bip44"),
          message: MESSAGE,
        },
        result: solanaSig,
      },
      {
        name: "bitcoin.message",
        request: {
          kind: "bitcoin.message",
          network: BTC_NETWORK,
          account: hd("btc.bip84"),
          address: bitcoinAddressFromXpub(BTC_XPUB, "btc.bip84", BTC_NETWORK, 0, 0),
          message: "hello",
          format: "bip322-simple",
          change: 0,
          index: 0,
        },
        result: solanaSig,
      },
      {
        name: "bitcoin.psbt",
        request: {
          kind: "bitcoin.psbt",
          origin: "internal",
          network: BTC_NETWORK,
          account: btcAccount(),
          psbt: btcPsbt(),
          sign: [{ index: 0, template: "btc.bip84" }],
        },
        result: { kind: "bitcoin.message", signature: "AAAA" },
      },
    ];

    it.each(cases)(
      "a $name request refuses a result of a different kind with integrity",
      async ({ request, result }) => {
        const wallet = await kindConnect(result, {
          template: "evm.bip44",
          network: "eip155:1",
          address: ADDRESS,
          confirmed: true,
        });
        await expect(
          chains(wallet).sign({ request, verify: { kind: "password", password: "test password" } }),
        ).rejects.toSatisfy((e) => walletError(e).code === "integrity");
      },
    );

    it("a solana transaction request refuses a solana message signature it would verify", async () => {
      const privateKey = new Uint8Array(32).fill(5);
      const wallet = await kindConnect(
        { kind: "solana.message", signature: signSolanaMessage(MESSAGE, privateKey) },
        {
          template: "solana.bip44-change",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          address: base58.encode(ed25519.getPublicKey(privateKey)),
          confirmed: true,
        },
      );
      await expect(
        chains(wallet).sign({
          request: {
            kind: "solana.transaction",
            network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            account: hd("solana.bip44-change"),
            message: MESSAGE,
          },
          verify: { kind: "password", password: "test password" },
        }),
      ).rejects.toSatisfy((e) => walletError(e).code === "integrity");
    });
  });

  describe("exportAccount", () => {
    const fp8 = (value: number): string => value.toString(16).padStart(8, "0");
    const master = HDKey.fromMasterSeed(
      mnemonicToSeedSync(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      ),
    );
    const FINGERPRINT = fp8(master.fingerprint);
    const evmLeaf = master.derive("m/44'/60'/0'/0/0");
    const tronLeaf = master.derive("m/44'/195'/0'/0/0");
    const btcNode = master.derive("m/84'/0'/0'");
    const solanaPub = ed25519.getPublicKey(new Uint8Array(32).fill(9));
    const evmAccountNode = master.derive("m/44'/60'/0'");
    const pubOf = (node: HDKey): Uint8Array => {
      if (node.publicKey === null) {
        throw new Error("derivation produced no key");
      }
      return node.publicKey;
    };
    const ccOf = (node: HDKey): Uint8Array => {
      if (node.chainCode === null) {
        throw new Error("derivation produced no chain code");
      }
      return node.chainCode;
    };
    const BTC_NETWORK = "bip122:000000000019d6689c085ae165831e93";

    const nodes = [
      { kind: "leaf", template: "evm.bip44" },
      { kind: "leaf", template: "tron.bip44" },
      { kind: "leaf", template: "solana.bip44-change" },
      { kind: "btc.account", template: "btc.bip84", network: BTC_NETWORK },
    ] as const;
    const result = (): ChainExportResult => ({
      fingerprint: FINGERPRINT,
      keys: [
        {
          node: nodes[0],
          path: "m/44'/60'/0'/0/0",
          curve: "secp256k1",
          publicKey: pubOf(evmLeaf),
        },
        {
          node: nodes[1],
          path: "m/44'/195'/0'/0/0",
          curve: "secp256k1",
          publicKey: pubOf(tronLeaf),
        },
        {
          node: nodes[2],
          path: "m/44'/501'/0'/0'",
          curve: "ed25519",
          publicKey: solanaPub,
        },
        {
          node: nodes[3],
          path: "m/84'/0'/0'",
          curve: "secp256k1",
          publicKey: pubOf(btcNode),
          chainCode: ccOf(btcNode),
          parentFingerprint: fp8(btcNode.parentFingerprint),
        },
      ],
    });
    const accountsAnswer = (request: { params: unknown }): { ok: ProtocolValue } => {
      const { template, network } = request.params as { template: string; network: string };
      if (template === "evm.bip44") {
        return {
          ok: { template, network, address: evmAddressFromPublicKey(pubOf(evmLeaf)), confirmed: true },
        };
      }
      if (template === "tron.bip44") {
        return {
          ok: { template, network, address: tronAddressFromPublicKey(pubOf(tronLeaf)), confirmed: true },
        };
      }
      if (template === "solana.bip44-change") {
        return {
          ok: { template, network, address: solanaAddressFromPublicKey(solanaPub), confirmed: true },
        };
      }
      return {
        ok: {
          template,
          network,
          xpub: btcNode.publicExtendedKey,
          fingerprint: FINGERPRINT,
          path: "m/84'/0'/0'",
          changeMark: 0,
          confirmed: true,
        },
      };
    };
    const exportConnect = async (answer: ProtocolValue, seen: { verify?: unknown }) => {
      const kernel = new FakeKernel(unlockedStatus());
      kernel.handlers.set("chain.exportAccount", (request) => {
        seen.verify = (request.params as { verify: unknown }).verify;
        return { ok: answer };
      });
      kernel.handlers.set("wallet.accounts", accountsAnswer);
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
    const params = () => ({
      walletId: "0a".repeat(8),
      groupIndex: 0,
      nodes: [...nodes],
      verify: { kind: "password" as const, password: "test password" },
    });
    const mutable = (r: ChainExportResult): { fingerprint: string; keys: ChainExportedKey[] } => ({
      fingerprint: r.fingerprint,
      keys: [...r.keys],
    });
    const at = (r: { keys: ReadonlyArray<ChainExportedKey> }, i: number): ChainExportedKey => {
      const key = r.keys[i];
      if (key === undefined) {
        throw new Error("missing key");
      }
      return key;
    };

    it("returns the kernel's material after the re-checks pass", async () => {
      const seen: { verify?: unknown } = {};
      const { kernel, wallet } = await exportConnect(result(), seen);
      const out = await chains(wallet).exportAccount(params());
      expect(out.fingerprint).toBe(FINGERPRINT);
      expect(out.keys).toHaveLength(4);
      expect(seen.verify).toStrictEqual({
        kind: "password",
        password: utf8ToBytes("test password"),
      });
      expect(kernel.received).toStrictEqual(
        expect.arrayContaining(["chain.exportAccount", "wallet.accounts"]),
      );
    });

    it("rejects a leaf key that does not hash to the account address", async () => {
      const tampered = mutable(result());
      const leaf = at(tampered, 0);
      tampered.keys[0] = {
        node: leaf.node,
        path: leaf.path,
        curve: leaf.curve,
        publicKey: pubOf(tronLeaf),
      };
      const { wallet } = await exportConnect(tampered, {});
      await expect(chains(wallet).exportAccount(params())).rejects.toSatisfy(
        (e) => walletError(e).code === "integrity",
      );
    });

    it("rejects a solana leaf whose public key does not match the account", async () => {
      const tampered = mutable(result());
      const leaf = at(tampered, 2);
      tampered.keys[2] = {
        node: leaf.node,
        path: leaf.path,
        curve: leaf.curve,
        publicKey: ed25519.getPublicKey(new Uint8Array(32).fill(4)),
      };
      const { wallet } = await exportConnect(tampered, {});
      await expect(chains(wallet).exportAccount(params())).rejects.toSatisfy(
        (e) => walletError(e).code === "integrity",
      );
    });

    it("rejects a tampered chain code and a foreign fingerprint", async () => {
      for (const mutate of [
        (key: ChainExportedKey): ChainExportedKey => ({
          ...key,
          chainCode: new Uint8Array(32).fill(1),
        }),
        (key: ChainExportedKey): ChainExportedKey => ({
          ...key,
          parentFingerprint: "00000000",
        }),
      ]) {
        const tampered = mutable(result());
        tampered.keys[3] = mutate(at(tampered, 3));
        // oxlint-disable-next-line no-await-in-loop -- each tampered answer gets its own connect
        const { wallet } = await exportConnect(tampered, {});
        // oxlint-disable-next-line no-await-in-loop -- sequential tamper cases
        await expect(chains(wallet).exportAccount(params())).rejects.toSatisfy(
          (e) => walletError(e).code === "integrity",
        );
      }
      const { wallet } = await exportConnect({ ...result(), fingerprint: "00000000" }, {});
      await expect(chains(wallet).exportAccount(params())).rejects.toSatisfy(
        (e) => walletError(e).code === "integrity",
      );
    });

    it("rejects a leaf carrying account fields and a reordered key list", async () => {
      const echo = mutable(result());
      const echoed = at(echo, 0);
      echo.keys[0] = {
        node: { kind: "leaf", template: "tron.bip44" },
        path: echoed.path,
        curve: echoed.curve,
        publicKey: echoed.publicKey,
      };
      const { wallet: w0 } = await exportConnect(echo, {});
      await expect(chains(w0).exportAccount(params())).rejects.toSatisfy(
        (e) => walletError(e).code === "integrity",
      );
      const tampered = mutable(result());
      const leaf = at(tampered, 0);
      tampered.keys[0] = {
        node: leaf.node,
        path: leaf.path,
        curve: leaf.curve,
        publicKey: leaf.publicKey,
        chainCode: new Uint8Array(32),
      };
      const { wallet } = await exportConnect(tampered, {});
      await expect(chains(wallet).exportAccount(params())).rejects.toSatisfy(
        (e) => walletError(e).code === "integrity",
      );
      const reordered = result();
      const { wallet: w2 } = await exportConnect(
        {
          ...reordered,
          keys: [
            ...reordered.keys.slice(1, 2),
            ...reordered.keys.slice(0, 1),
            ...reordered.keys.slice(2),
          ],
        },
        {},
      );
      await expect(chains(w2).exportAccount(params())).rejects.toSatisfy(
        (e) => walletError(e).code === "integrity",
      );
    });

    it("checks the evm account node's fixed path and fields", async () => {
      const key = {
        node: { kind: "evm.account" as const },
        path: "m/44'/60'/0'",
        curve: "secp256k1",
        publicKey: pubOf(evmAccountNode),
        chainCode: ccOf(evmAccountNode),
        parentFingerprint: fp8(evmAccountNode.parentFingerprint),
      };
      const accountParams = () => ({
        walletId: "0a".repeat(8),
        groupIndex: 0,
        nodes: [{ kind: "evm.account" as const }],
        verify: { kind: "password" as const, password: "test password" },
      });
      const { wallet } = await exportConnect({ fingerprint: FINGERPRINT, keys: [key] }, {});
      await expect(chains(wallet).exportAccount(accountParams())).resolves.toMatchObject({
        fingerprint: FINGERPRINT,
      });
      const { wallet: bad } = await exportConnect(
        { fingerprint: FINGERPRINT, keys: [{ ...key, path: "m/44'/60'/1'" }] },
        {},
      );
      await expect(chains(bad).exportAccount(accountParams())).rejects.toSatisfy(
        (e) => walletError(e).code === "integrity",
      );
    });

    it("rejects an answer with more keys than the nodes it requested", async () => {
      /* The wire result may carry up to four keys independent of the request's node count, so a
         kernel answering a two-node request with four valid keys is only caught by the count
         check — the per-node loop would look at the first two and pass. */
      const { wallet } = await exportConnect(result(), {});
      await expect(
        chains(wallet).exportAccount({ ...params(), nodes: nodes.slice(0, 2) }),
      ).rejects.toSatisfy((e) => walletError(e).code === "integrity");
    });
  });
});
