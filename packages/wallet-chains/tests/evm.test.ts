import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { signTypedData as ethSignTypedData, SignTypedDataVersion } from "@metamask/eth-sig-util";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256 } from "viem/utils";
import { describe, expect, it } from "vite-plus/test";

import {
  checksumEvmAddress,
  decodeEvm,
  isEvmAddress,
  networkChainId,
  normalizeEvm,
  verifiabilityEvm,
} from "../src/evm/index.ts";
import { signEvmPersonalMessage, signEvmTransaction, signEvmTypedData } from "../src/evm/sign.ts";
import type { EvmTokenTable } from "../src/evm/tokens.ts";
import { ChainError } from "../src/index.ts";
import type { EvmTransaction } from "../src/index.ts";

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/evm.json"), "utf8"),
) as {
  mnemonic: string;
  addressPath: string;
  addresses: string[];
  privateKey: string;
  addressForKey: string;
  transactions: Array<{ name: string; network: string; tx: EvmTransaction }>;
  personalMessage: string;
  typedData: string;
  expected: {
    transactions: Array<{ name: string; expected: string }>;
    personalMessage: string;
    typedData: string;
  };
};

const keyBytes = Uint8Array.from(Buffer.from(vectors.privateKey.slice(2), "hex"));
const account = privateKeyToAccount(vectors.privateKey as `0x${string}`);

const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm" } as const;

type TxOver = {
  type: "legacy" | "eip2930" | "eip1559";
  chainId?: number;
  to?: string;
  data?: string;
  value?: string;
  nonce?: number;
  gas?: string;
  gasPrice?: string;
  accessList?: EvmTransaction extends { accessList?: infer A } ? A : never;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
};

const txReq = (over: TxOver, network = "eip155:1") => ({
  kind: "evm.transaction" as const,
  network,
  account: ACCOUNT,
  tx: {
    chainId: over.chainId ?? 1,
    to: over.to ?? vectors.addressForKey,
    data: over.data ?? "0x",
    value: over.value ?? "0x0",
    nonce: over.nonce ?? 0,
    gas: over.gas ?? "0x5208",
    ...(over.type === "eip1559"
      ? {
          maxFeePerGas: over.maxFeePerGas ?? "0x1",
          maxPriorityFeePerGas: over.maxPriorityFeePerGas ?? "0x1",
          accessList: over.accessList ?? [],
        }
      : over.type === "eip2930"
        ? { gasPrice: over.gasPrice ?? "0x1", accessList: over.accessList ?? [] }
        : { gasPrice: over.gasPrice ?? "0x1" }),
    type: over.type,
  },
});

describe("addresses", () => {
  it("matches the anvil derivation of the standard mnemonic", () => {
    const seed = mnemonicToSeedSync(vectors.mnemonic);
    const root = HDKey.fromMasterSeed(seed);
    const derived = vectors.addresses.map((expected, i) => {
      const node = root.derive(`${vectors.addressPath}/${i}`);
      const pub = secp256k1.Point.fromBytes(node.publicKey!).toBytes(false);
      return {
        expected,
        got: checksumEvmAddress(
          `0x${keccak256(`0x${Buffer.from(pub.slice(1)).toString("hex")}`).slice(-40)}`,
        ),
      };
    });
    for (const { expected, got } of derived) {
      expect(got).toBe(expected);
    }
  });

  it("accepts and checksums valid addresses", () => {
    expect(isEvmAddress(vectors.addressForKey)).toBe(true);
    expect(isEvmAddress("0xabcd")).toBe(false);
    expect(checksumEvmAddress(vectors.addressForKey.toLowerCase())).toBe(vectors.addressForKey);
  });
});

const toViemTx = (tx: EvmTransaction) => ({
  type: tx.type === "legacy" ? "legacy" : tx.type === "eip2930" ? "eip2930" : "eip1559",
  chainId: tx.chainId,
  to: tx.to === undefined ? undefined : (tx.to as `0x${string}`),
  data: tx.data === undefined ? undefined : (tx.data as `0x${string}`),
  value: BigInt(tx.value),
  nonce: BigInt(tx.nonce),
  gas: BigInt(tx.gas),
  ...(tx.type === "eip1559"
    ? {
        maxFeePerGas: BigInt(tx.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
        accessList: tx.accessList,
      }
    : tx.type === "eip2930"
      ? { gasPrice: BigInt(tx.gasPrice), accessList: tx.accessList }
      : { gasPrice: BigInt(tx.gasPrice) }),
});

describe("sign", () => {
  it.each(vectors.transactions)("byte-matches viem for $name", async ({ tx }) => {
    const ours = signEvmTransaction(tx, keyBytes);
    const theirs = await account.signTransaction(toViemTx(tx) as never);
    expect(`0x${Buffer.from(ours).toString("hex")}`).toBe(theirs);
  });

  it("matches the stored expected outputs", () => {
    for (const v of vectors.transactions) {
      const ours = `0x${Buffer.from(signEvmTransaction(v.tx, keyBytes)).toString("hex")}`;
      const stored = vectors.expected.transactions.find((e) => e.name === v.name);
      expect(stored).toBeDefined();
      expect(ours).toBe(stored!.expected);
    }
  });

  it("byte-matches viem for a personal message", async () => {
    const ours = signEvmPersonalMessage(
      Uint8Array.from(Buffer.from(vectors.personalMessage.slice(2), "hex")),
      keyBytes,
    );
    const theirs = await account.signMessage({
      message: { raw: vectors.personalMessage as `0x${string}` },
    });
    expect(`0x${Buffer.from(ours).toString("hex")}`).toBe(theirs);
    expect(`0x${Buffer.from(ours).toString("hex")}`).toBe(vectors.expected.personalMessage);
    expect(ours).toHaveLength(65);
    expect([27, 28]).toContain(ours[64]);
  });

  it("byte-matches viem and eth-sig-util V4 for typed data", async () => {
    const ours = signEvmTypedData(vectors.typedData, keyBytes);
    const parsed = JSON.parse(vectors.typedData);
    const theirs = await account.signTypedData(parsed as never);
    expect(`0x${Buffer.from(ours).toString("hex")}`).toBe(theirs);
    const mm = ethSignTypedData({
      data: parsed,
      version: SignTypedDataVersion.V4,
      privateKey: Buffer.from(keyBytes),
    });
    expect(`0x${Buffer.from(ours).toString("hex")}`).toBe(mm);
    expect(`0x${Buffer.from(ours).toString("hex")}`).toBe(vectors.expected.typedData);
  });
});

describe("normalize", () => {
  it("canonicalizes addresses and quantities", () => {
    const req = txReq({ type: "eip1559", to: vectors.addressForKey.toLowerCase(), value: "0x0" });
    const normalized = normalizeEvm(req);
    const { tx } = normalized as { tx: { to: string; value: string } };
    expect(tx.to).toBe(vectors.addressForKey);
    expect(tx.value).toBe("0x0");
    expect(normalizeEvm(normalized)).toStrictEqual(normalized);
  });

  it("rejects an unknown field", () => {
    const req = { ...txReq({ type: "eip1559" }), tx: { ...txReq({ type: "eip1559" }).tx, foo: 1 } };
    expect(() => normalizeEvm(req)).toThrow(ChainError);
  });

  it("rejects a missing required field", () => {
    const req = txReq({ type: "eip1559" });
    const { nonce: _nonce, ...rest } = req.tx;
    expect(() => normalizeEvm({ ...req, tx: rest })).toThrow(ChainError);
  });

  it("rejects a chainId/network mismatch", () => {
    expect(() => normalizeEvm(txReq({ type: "eip1559" }, "eip155:5"))).toThrow(ChainError);
  });

  it("canonicalizes non-canonical hex or rejects invalid quantities", () => {
    const normalized = normalizeEvm(txReq({ type: "eip1559", value: "0x00010" }));
    expect((normalized as { tx: { value: string } }).tx.value).toBe("0x10");
    expect(() => normalizeEvm(txReq({ type: "eip1559", gas: "zzz" }))).toThrow(ChainError);
  });

  it("rejects eip7702 as unsupported", () => {
    const req = txReq({ type: "eip1559" });
    const bad = { ...req, tx: { ...req.tx, type: "eip7702" } };
    expect(() => normalizeEvm(bad)).toThrow(/not supported|unsupported/i);
  });
});

describe("verifiability + decode", () => {
  const table: EvmTokenTable = {
    "1": { [vectors.addressForKey]: { symbol: "USDC", decimals: 6 } },
  };
  const erc20Transfer = `0xa9059cbb${vectors.addressForKey.slice(2).toLowerCase().padStart(64, "0")}${"64".padStart(64, "0")}`;
  const approve = `0x095ea7b3${vectors.addressForKey.slice(2).toLowerCase().padStart(64, "0")}${"f".repeat(64)}`;
  const maxApprove = `0x095ea7b3${vectors.addressForKey.slice(2).toLowerCase().padStart(64, "0")}${"f".repeat(64)}`;

  it("native transfer → full", () => {
    const intent = decodeEvm(txReq({ type: "eip1559" }) as never);
    expect(intent.verifiability).toBe("full");
    expect(intent.summary).toBe("transfer");
    expect(intent.fee?.max.amount).toBe((0x5208).toString());
    expect(verifiabilityEvm(txReq({ type: "eip1559" }) as never)).toBe("full");
  });

  it("erc20 transfer → full only in the token table", () => {
    expect(
      decodeEvm(txReq({ type: "eip1559", data: erc20Transfer }) as never, table).verifiability,
    ).toBe("full");
    expect(
      decodeEvm(txReq({ type: "eip1559", data: erc20Transfer }) as never, {}).verifiability,
    ).toBe("partial");
  });

  it("approve → partial, unlimited on max uint256", () => {
    expect(decodeEvm(txReq({ type: "eip1559", data: approve }) as never).verifiability).toBe(
      "partial",
    );
    const intent = decodeEvm(txReq({ type: "eip1559", data: maxApprove }) as never);
    expect(intent.approvals[0]?.unlimited).toBe(true);
  });

  it("contract call and contract creation → opaque", () => {
    expect(decodeEvm(txReq({ type: "eip1559", data: "0x12345678" }) as never).verifiability).toBe(
      "opaque",
    );
    const noTo = txReq({ type: "eip1559" });
    expect(decodeEvm({ ...noTo, tx: { ...noTo.tx, to: undefined } } as never).verifiability).toBe(
      "opaque",
    );
  });

  it("messages → opaque; typed-data chainId mismatch warns", () => {
    const pm = decodeEvm({
      kind: "evm.personal-message",
      network: "eip155:1",
      account: ACCOUNT,
      message: new Uint8Array(1),
    });
    expect(pm.verifiability).toBe("opaque");
    const td = JSON.parse(vectors.typedData);
    td.domain.chainId = 5;
    const intent = decodeEvm({
      kind: "evm.typed-data",
      network: "eip155:1",
      account: ACCOUNT,
      typedData: JSON.stringify(td),
    });
    expect(intent.verifiability).toBe("opaque");
    expect(intent.warnings[0]?.kind).toBe("chain-id-mismatch");
  });

  it("parses CAIP-2 chain ids", () => {
    expect(networkChainId("eip155:56")).toBe(56);
    expect(() => networkChainId("solana:4sg")).toThrow(ChainError);
  });
});
