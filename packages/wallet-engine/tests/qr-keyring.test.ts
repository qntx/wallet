/**
 * Differential QR tests against `@keystonehq/base-eth-keyring` — the keyring a MetaMask/Rabby "QR
 * hardware wallet" watch-only session runs. Its `getInteraction().requestSignature` is faked to run
 * the real QR loop: `EthSignRequest` → UR → `readQrRequest` → digest signed in-test → `assembleEvm`
 * (the kernel's assembler) → `qrResponse` → `ETHSignature` — and the keyring assembles the signed
 * artefact whose sender must recover to the test leaf. Solana/TRON responses are decoded by the
 * matching vendor registry classes.
 */
import { createRequire } from "node:module";

import { BaseKeyring } from "@keystonehq/base-eth-keyring";
import { SignType, SolSignature, SolSignRequest } from "@keystonehq/bc-ur-registry-sol";
import {
  DataType as TronDataType,
  TronSignRequest,
  TronSignature,
} from "@keystonehq/bc-ur-registry-tron";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";
import { recoverMessageAddress, recoverTypedDataAddress } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { TaskKey } from "@qntx/wallet-chains";
import { assembleEvm, planEvm } from "@qntx/wallet-chains/evm";
import { tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";
import { qrParts } from "@qntx/wallet/hardware";
import type { QrPayload } from "@qntx/wallet/hardware";
import type { ChainExportResult } from "@qntx/wallet/protocol";

import vectors from "../../../vectors/chains/export-account.json" with { type: "json" };
import { createQrScanner, qrExport, qrResponse, readQrRequest } from "../src/qr/index.ts";
import type { QrRequest } from "../src/qr/index.ts";

const [wallet] = vectors.wallets;
if (wallet === undefined) {
  throw new Error("export-account vector is empty");
}
const { fingerprint } = wallet;
const ACCOUNT_PATH = "m/44'/60'/0'";

const seed = mnemonicToSeedSync(wallet.mnemonic);
const root = HDKey.fromMasterSeed(seed);
const evmLeaf = (index: number): HDKey => root.derive(`${ACCOUNT_PATH}/0/${index}`);

const evmAddress = (key: HDKey): string => {
  if (key.publicKey === null) {
    throw new Error("no public key");
  }
  return `0x${bytesToHex(
    keccak_256(secp256k1.Point.fromBytes(key.publicKey).toBytes(false).subarray(1)).subarray(12),
  )}`;
};

const leaf0 = evmLeaf(0);
const leaf0Private = leaf0.privateKey;
const leaf0Public = leaf0.publicKey;
if (leaf0Private === null || leaf0Public === null) {
  throw new Error("vector derivation failed");
}
const leaf0Address = evmAddress(leaf0);

const taskKey: TaskKey = {
  path: [0x8000002c, 0x8000003c, 0x80000000, 0, 0],
  publicKey: leaf0Public,
};

const accountNode = wallet.keys.find((key) => key.node.kind === "evm.account");
if (
  accountNode === undefined ||
  accountNode.chainCode === undefined ||
  accountNode.parentFingerprint === undefined
) {
  throw new Error("export-account vector lacks the evm.account key");
}

const evmExport = (): QrPayload =>
  qrExport(
    {
      fingerprint,
      keys: [
        {
          node: { kind: "evm.account" },
          path: ACCOUNT_PATH,
          curve: "secp256k1",
          publicKey: hexToBytes(accountNode.publicKey),
          chainCode: hexToBytes(accountNode.chainCode),
          parentFingerprint: accountNode.parentFingerprint,
        },
      ],
    } satisfies ChainExportResult,
    "crypto-hdkey",
  ).payload;

/* The ethereumjs/tx copy the keyring itself links, loaded through createRequire: the hoisted
 * copy's ESM build pulls a `kzg` re-export Bun cannot evaluate, the CJS build cannot. */
const require_ = createRequire(import.meta.url);
const vendorRequire = createRequire(require_.resolve("@keystonehq/base-eth-keyring/package.json"));

type EthTx = {
  readonly type: number;
  readonly getSenderAddress: () => { readonly toString: () => string };
};
/* The keyring's own nested registry-eth / ethereumjs copies: its public types name the nested
   0.19.1/0.6.4 classes, so the value-level classes are loaded through its own require. */
type SyncArg = Parameters<BaseKeyring["syncKeyring"]>[0];
type EthSignature = Awaited<
  ReturnType<ReturnType<BaseKeyring["getInteraction"]>["requestSignature"]>
>;
type TypedTransaction = Parameters<BaseKeyring["signTransaction"]>[1];
const { LegacyTransaction, FeeMarketEIP1559Transaction, AccessListEIP2930Transaction } =
  vendorRequire("@ethereumjs/tx") as {
    LegacyTransaction: { fromTxData: (data: Record<string, unknown>) => EthTx };
    FeeMarketEIP1559Transaction: { fromTxData: (data: Record<string, unknown>) => EthTx };
    AccessListEIP2930Transaction: { fromTxData: (data: Record<string, unknown>) => EthTx };
  };
const { CryptoHDKey, ETHSignature } = vendorRequire("@keystonehq/bc-ur-registry-eth") as {
  CryptoHDKey: { fromCBOR: (cbor: Buffer) => SyncArg };
  ETHSignature: { fromCBOR: (cbor: Buffer) => EthSignature };
};

/** Signs a scanned request with the vector leaf key through the kernel's plan/assemble code. */
const respondTo = (request: QrRequest): Uint8Array => {
  if (request.family !== "evm") {
    throw new Error("not an EVM request");
  }
  const chainId =
    request.chainId ?? (request.kind === "transaction" ? request.tx.chainId : undefined) ?? 1;
  const network = `eip155:${chainId}`;
  const account = {
    kind: "hd" as const,
    walletId: "",
    groupIndex: 0,
    template: "evm.bip44",
  };
  const plan =
    request.kind === "transaction"
      ? planEvm({ kind: "evm.transaction", network, account, tx: request.tx }, taskKey)
      : request.kind === "typed-data"
        ? planEvm(
            { kind: "evm.typed-data", network, account, typedData: request.typedData },
            taskKey,
          )
        : planEvm(
            { kind: "evm.personal-message", network, account, message: request.message },
            taskKey,
          );
  const digest = plan.tasks[0]?.digest;
  if (digest === undefined) {
    throw new Error("plan produced no task");
  }
  const compact = secp256k1.sign(digest, leaf0Private, { lowS: true, prehash: false });
  const assembled = assembleEvm(plan, [compact]);
  if (assembled.kind !== "signed") {
    throw new Error("unexpected next-stage plan");
  }
  const result =
    request.kind === "transaction"
      ? { kind: "evm.transaction" as const, signedTransaction: assembled.artefact }
      : {
          kind:
            request.kind === "typed-data"
              ? ("evm.typed-data" as const)
              : ("evm.personal-message" as const),
          signature: assembled.artefact,
        };
  return qrResponse(request, result, { address: leaf0Address }).cbor;
};

const keyringWithScan = (): BaseKeyring => {
  const keyring = new BaseKeyring();
  keyring.syncKeyring(CryptoHDKey.fromCBOR(Buffer.from(evmExport().cbor)));
  keyring.getInteraction = () => ({
    // oxlint-disable-next-line typescript/require-await -- the interaction contract is async
    readCryptoHDKeyOrCryptoAccount: async () => {
      throw new Error("sync is pinned by the test");
    },
    // oxlint-disable-next-line typescript/require-await -- the interaction contract is async
    requestSignature: async (signRequest) => {
      const ur = signRequest.toUR();
      const request = readQrRequest({ type: ur.type, cbor: new Uint8Array(ur.cbor) });
      return ETHSignature.fromCBOR(Buffer.from(respondTo(request)));
    },
  });
  return keyring;
};

describe("keystone base-eth-keyring differential", () => {
  it("lists the vector's addresses 0..4 after syncKeyring", async () => {
    const keyring = keyringWithScan();
    const page = await keyring.getFirstPage();
    expect(page).toHaveLength(5);
    for (const [index, row] of page.entries()) {
      expect(row.index).toBe(index);
      expect(row.address.toLowerCase()).toBe(evmAddress(evmLeaf(index)));
    }
  });

  it("assembles a signed legacy transaction that recovers the signer", async () => {
    const keyring = keyringWithScan();
    const tx = LegacyTransaction.fromTxData({
      nonce: 0,
      gasPrice: 20_000_000_000n,
      gasLimit: 21_000,
      to: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      value: 10n ** 15n,
    });
    const signed = (await keyring.signTransaction(leaf0Address, tx as TypedTransaction)) as EthTx;
    expect(signed.getSenderAddress().toString().toLowerCase()).toBe(leaf0Address);
  });

  it("assembles a signed eip1559 transaction that recovers the signer", async () => {
    const keyring = keyringWithScan();
    const tx = FeeMarketEIP1559Transaction.fromTxData({
      nonce: 3,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_500_000_000n,
      gasLimit: 50_000,
      to: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      value: 7n,
      accessList: [],
    });
    const signed = (await keyring.signTransaction(leaf0Address, tx as TypedTransaction)) as EthTx;
    expect(signed.getSenderAddress().toString().toLowerCase()).toBe(leaf0Address);
  });

  it("assembles a signed eip2930 transaction that recovers the signer", async () => {
    const keyring = keyringWithScan();
    const tx = AccessListEIP2930Transaction.fromTxData({
      nonce: 1,
      gasPrice: 10_000_000_000n,
      gasLimit: 60_000,
      to: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      value: 2n,
      accessList: [
        {
          address: "0x0000000000000000000000000000000000000001",
          storageKeys: [`0x${"00".repeat(31)}01`],
        },
      ],
    });
    const signed = (await keyring.signTransaction(leaf0Address, tx as TypedTransaction)) as EthTx;
    expect(signed.getSenderAddress().toString().toLowerCase()).toBe(leaf0Address);
  });

  it("returns a personal-message signature that recovers the signer", async () => {
    const keyring = keyringWithScan();
    const message = `0x${bytesToHex(new TextEncoder().encode("hello qr"))}`;
    const signature = await keyring.signPersonalMessage(leaf0Address, message);
    const recovered = await recoverMessageAddress({
      message: "hello qr",
      signature: signature as `0x${string}`,
    });
    expect(recovered.toLowerCase()).toBe(leaf0Address);
  });

  it("returns a typed-data signature that recovers the signer", async () => {
    const keyring = keyringWithScan();
    const typedData = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        Mail: [
          { name: "from", type: "string" },
          { name: "content", type: "string" },
        ],
      },
      primaryType: "Mail" as const,
      domain: { name: "qr", version: "1", chainId: 1 },
      message: { from: "alice", content: "hello" },
    };
    const signature = await keyring.signTypedData(leaf0Address, typedData);
    const recovered = await recoverTypedDataAddress({
      domain: typedData.domain,
      types: { Mail: typedData.types.Mail },
      primaryType: "Mail",
      message: typedData.message,
      signature: signature as `0x${string}`,
    });
    expect(recovered.toLowerCase()).toBe(leaf0Address);
  });
});

describe("solana and tron signature responses", () => {
  const solPrivate = new Uint8Array(
    Slip10.fromMasterSeed(seed).derive("m/44'/501'/0'/0'").privateKey,
  );
  const solAddress = base58.encode(ed25519.getPublicKey(solPrivate));

  const tronLeaf = root.derive("m/44'/195'/0'/0/0");
  const tronPrivate = tronLeaf.privateKey;
  const tronPublic = tronLeaf.publicKey;
  if (tronPrivate === null || tronPublic === null) {
    throw new Error("vector derivation failed");
  }
  const tronAddress = tronAddressFromPublicKey(tronPublic);

  const scannedSolana = (request: QrRequest): Extract<QrRequest, { family: "solana" }> => {
    if (request.family !== "solana") {
      throw new Error("unexpected request shape");
    }
    return request;
  };

  const scannedTron = (request: QrRequest): Extract<QrRequest, { family: "tron" }> => {
    if (request.family !== "tron") {
      throw new Error("unexpected request shape");
    }
    return request;
  };

  const mustRequestId = (request: { readonly requestId?: Uint8Array }): Uint8Array => {
    if (request.requestId === undefined) {
      throw new Error("missing request id");
    }
    return request.requestId;
  };

  const sign65 = (digest: Uint8Array, key: Uint8Array): Uint8Array => {
    const raw = secp256k1.sign(digest, key, { lowS: true, format: "recovered", prehash: false });
    const [recid] = raw;
    if (raw.length !== 65 || recid === undefined) {
      throw new Error("bad recovered signature");
    }
    const out = new Uint8Array(65);
    out.set(raw.subarray(1), 0);
    out[64] = recid + 27;
    return out;
  };

  const scanRequest = (payload: QrPayload): QrRequest => {
    const scanner = createQrScanner({ kind: "request", now: () => 0 });
    const next = qrParts(payload);
    for (let i = 0; i < 64; i += 1) {
      const out = scanner.receive(next());
      if (out.status === "complete") {
        return readQrRequest(out.payload);
      }
    }
    throw new Error("scan did not complete");
  };

  it("decodes a sol-signature whose requestId matches", () => {
    const ur = SolSignRequest.constructSOLRequest(
      Buffer.from(new TextEncoder().encode("hello solana")),
      "m/44'/501'/0'/0'",
      fingerprint,
      SignType.Transaction,
      "12345678-1234-4321-abcd-1234567890ab",
    ).toUR();
    const request = scannedSolana(scanRequest({ type: ur.type, cbor: new Uint8Array(ur.cbor) }));
    const signature = ed25519.sign(request.data, solPrivate);
    const answer = qrResponse(
      request,
      { kind: "solana.transaction", signature },
      { address: solAddress },
    );
    const decoded = SolSignature.fromCBOR(Buffer.from(answer.cbor));
    expect(decoded.getRequestId()?.toString("hex")).toBe(bytesToHex(mustRequestId(request)));
    expect(decoded.getSignature().toString("hex")).toBe(bytesToHex(signature));
  });

  it("decodes a tron-signature whose requestId matches", () => {
    const rawData = sha256(new TextEncoder().encode("tron raw data"));
    const ur = TronSignRequest.constructTronRequest(
      Buffer.from(rawData),
      TronDataType.transaction,
      "m/44'/195'/0'/0/0",
      fingerprint,
      "12345678-1234-4321-abcd-1234567890ab",
    ).toUR();
    const request = scannedTron(scanRequest({ type: ur.type, cbor: new Uint8Array(ur.cbor) }));
    const signature = sign65(sha256(request.data), tronPrivate);
    const answer = qrResponse(
      request,
      { kind: "tron.transaction", signature },
      { address: tronAddress },
    );
    const decoded = TronSignature.fromCBOR(Buffer.from(answer.cbor));
    expect(decoded.getRequestId()?.toString("hex")).toBe(bytesToHex(mustRequestId(request)));
    expect(decoded.getSignature()).toHaveLength(65);
    // tron transaction signatures carry recovery parity, not the +27 message offset
    expect(Number(decoded.getSignature().at(-1))).toBe(Number(signature[64]) - 27);
  });
});
