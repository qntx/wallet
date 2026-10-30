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
  isEvmAddress,
  normalizeEvm,
  decodeEvm,
  verifiabilityEvm,
  networkChainId,
} from "../src/evm/index.ts";
import { signEvmTransaction, signEvmPersonalMessage, signEvmTypedData } from "../src/evm/sign.ts";
import type { EvmTokenTable } from "../src/evm/tokens.ts";
import { ChainError } from "../src/index.ts";

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/evm.json"), "utf8"),
) as {
  mnemonic: string;
  addressPath: string;
  addresses: string[];
  privateKey: string;
  addressForKey: string;
  transactions: Array<{ name: string; network: string; tx: Record<string, unknown> }>;
  personalMessage: string;
  typedData: string;
};

const keyBytes = Uint8Array.from(Buffer.from(vectors.privateKey.slice(2), "hex"));
const account = privateKeyToAccount(vectors.privateKey as `0x${string}`);

describe("addresses", () => {
  it("matches the anvil derivation of the standard mnemonic", () => {
    const seed = mnemonicToSeedSync(vectors.mnemonic);
    const root = HDKey.fromMasterSeed(seed);
    vectors.addresses.forEach((expected, i) => {
      const node = root.derive(`${vectors.addressPath}/${i}`);
      const pub = secp256k1.Point.fromBytes(node.publicKey!).toBytes(false);
      const hex = keccak256(`0x${Buffer.from(pub.slice(1)).toString("hex")}`);
      expect(checksumEvmAddress(`0x${hex.slice(-40)}`)).toBe(expected);
    });
  });

  it("accepts and checksums valid addresses", () => {
    expect(isEvmAddress(vectors.addressForKey)).toBe(true);
    expect(isEvmAddress("0xabcd")).toBe(false);
    expect(checksumEvmAddress(vectors.addressForKey.toLowerCase())).toBe(vectors.addressForKey);
  });
});

describe("sign", () => {
  for (const v of vectors.transactions) {
    it(`byte-matches viem for ${v.name}`, async () => {
      const ours = signEvmTransaction(v.tx as never, keyBytes);
      const theirs = await account.signTransaction(v.tx as never);
      expect(`0x${Buffer.from(ours).toString("hex")}`).toBe(theirs);
    });
  }

  it("byte-matches viem for a personal message", async () => {
    const ours = signEvmPersonalMessage(
      Uint8Array.from(Buffer.from(vectors.personalMessage.slice(2), "hex")),
      keyBytes,
    );
    const theirs = await account.signMessage({
      message: { raw: vectors.personalMessage as `0x${string}` },
    });
    expect(`0x${Buffer.from(ours).toString("hex")}`).toBe(theirs);
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
  });
});

const baseReq = (tx: Record<string, unknown>) => ({
  kind: "evm.transaction" as const,
  network: "eip155:1" as const,
  account: { kind: "hd" as const, walletId: "w", groupIndex: 0, template: "evm" },
  tx,
});

describe("normalize", () => {
  const tx = {
    type: "eip1559",
    chainId: 1,
    to: vectors.addressForKey.toLowerCase(),
    value: "0x0",
    gas: "0x5208",
    maxFeePerGas: "0x1",
  };

  it("canonicalizes addresses and quantities", () => {
    const n = normalizeEvm(baseReq(tx) as never);
    const ntx = (n as { tx: Record<string, unknown> }).tx;
    expect(ntx["to"]).toBe(vectors.addressForKey);
    expect(normalizeEvm(n)).toStrictEqual(n); // idempotent
  });

  it("rejects an unknown field", () => {
    expect(() => normalizeEvm(baseReq({ ...tx, foo: 1 }) as never)).toThrowError(ChainError);
  });

  it("rejects a chainId/network mismatch", () => {
    expect(() => normalizeEvm({ ...baseReq(tx), network: "eip155:5" } as never)).toThrowError(
      ChainError,
    );
  });

  it("canonicalizes non-canonical hex or rejects invalid quantities", () => {
    const n = normalizeEvm(baseReq({ ...tx, value: "0x00010" }) as never);
    expect((n as { tx: { value: string } }).tx.value).toBe("0x10");
    expect(() => normalizeEvm(baseReq({ ...tx, gas: "zzz" }) as never)).toThrowError(ChainError);
  });

  it("rejects eip7702 as unsupported", () => {
    expect(() => normalizeEvm(baseReq({ ...tx, type: "eip7702" }) as never)).toThrowError(
      /not supported|unsupported/i,
    );
  });
});

describe("verifiability + decode", () => {
  const network = "eip155:1";
  const txReq = (over: Record<string, unknown>) =>
    baseReq({
      type: "eip1559",
      chainId: 1,
      to: vectors.addressForKey,
      gas: "0x5208",
      maxFeePerGas: "0x1",
      ...over,
    });
  const table: EvmTokenTable = {
    "1": { [vectors.addressForKey]: { symbol: "USDC", decimals: 6 } },
  };
  const erc20Transfer = `0xa9059cbb${vectors.addressForKey.slice(2).toLowerCase().padStart(64, "0")}${"64".padStart(64, "0")}`;
  const approve = `0x095ea7b3${vectors.addressForKey.slice(2).toLowerCase().padStart(64, "0")}${"f".repeat(64)}`;

  it("native transfer → full", () => {
    const intent = decodeEvm(txReq({}) as never);
    expect(intent.verifiability).toBe("full");
    expect(intent.summary).toBe("transfer");
    expect(intent.fee?.max.amount).toBe((0x5208).toString());
    expect(verifiabilityEvm(txReq({}) as never)).toBe("full");
  });

  it("erc20 transfer → full only in the token table", () => {
    expect(decodeEvm(txReq({ data: erc20Transfer }) as never, table).verifiability).toBe("full");
    expect(decodeEvm(txReq({ data: erc20Transfer }) as never, {}).verifiability).toBe("partial");
  });

  it("approve → partial, unlimited on max uint256", () => {
    const intent = decodeEvm(txReq({ data: approve }) as never);
    expect(intent.verifiability).toBe("partial");
    const max = `0x095ea7b3${vectors.addressForKey.slice(2).toLowerCase().padStart(64, "0")}${"f".repeat(64)}`;
    expect(decodeEvm(txReq({ data: max }) as never).approvals[0]?.unlimited).toBe(true);
  });

  it("contract call → opaque", () => {
    expect(decodeEvm(txReq({ data: "0x12345678" }) as never).verifiability).toBe("opaque");
    expect(decodeEvm(txReq({ to: undefined }) as never).verifiability).toBe("opaque");
  });

  it("messages → opaque; typed-data chainId mismatch warns", () => {
    const pm = decodeEvm({
      kind: "evm.personal-message",
      network,
      account: baseReq({}).account,
      message: new Uint8Array(1),
    } as never);
    expect(pm.verifiability).toBe("opaque");
    const td = JSON.parse(vectors.typedData);
    td.domain.chainId = 5;
    const intent = decodeEvm({
      kind: "evm.typed-data",
      network,
      account: baseReq({}).account,
      typedData: JSON.stringify(td),
    } as never);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.warnings[0]?.kind).toBe("chain-id-mismatch");
  });

  it("parses CAIP-2 chain ids", () => {
    expect(networkChainId("eip155:56")).toBe(56);
    expect(() => networkChainId("solana:4sg")).toThrowError(ChainError);
  });
});
