import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { signTypedData as ethSignTypedData, SignTypedDataVersion } from "@metamask/eth-sig-util";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import * as AbiFunction from "ox/AbiFunction";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256 } from "viem/utils";
import { describe, expect, it } from "vite-plus/test";

import {
  DELEGATION_MANAGER,
  ENTRY_POINT_V08,
  PERMIT2_ADDRESS,
  checksumEvmAddress,
  EVM_NATIVE_ASSET,
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

const SIGNER = "0x1111111111111111111111111111111111111111";

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

  it('rejects a bare "0x" quantity in normalize and decode', () => {
    const cases: ReadonlyArray<{ type: "eip1559" | "legacy"; field: string; decoded: boolean }> = [
      { type: "eip1559", field: "value", decoded: true },
      { type: "eip1559", field: "gas", decoded: true },
      { type: "eip1559", field: "maxFeePerGas", decoded: true },
      { type: "eip1559", field: "maxPriorityFeePerGas", decoded: false },
      { type: "legacy", field: "gasPrice", decoded: true },
    ];
    for (const { type, field } of cases) {
      expect(() => normalizeEvm(txReq({ type, [field]: "0x" }))).toThrow(ChainError);
    }
    for (const { type, field } of cases.filter((c) => c.decoded)) {
      expect(() => decodeEvm(txReq({ type, [field]: "0x" }) as never, SIGNER)).toThrow(ChainError);
    }
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
    const intent = decodeEvm(txReq({ type: "eip1559" }) as never, SIGNER);
    expect(intent.verifiability).toBe("full");
    expect(intent.summary).toBe("transfer");
    expect(intent.fee?.max.amount).toBe((0x5208).toString());
    expect(verifiabilityEvm(txReq({ type: "eip1559" }) as never, SIGNER)).toBe("full");
  });

  it("erc20 transfer → full only in the token table", () => {
    expect(
      decodeEvm(txReq({ type: "eip1559", data: erc20Transfer }) as never, SIGNER, table)
        .verifiability,
    ).toBe("full");
    expect(
      decodeEvm(txReq({ type: "eip1559", data: erc20Transfer }) as never, SIGNER, {}).verifiability,
    ).toBe("partial");
  });

  it("approve → partial, unlimited on max uint256", () => {
    expect(
      decodeEvm(txReq({ type: "eip1559", data: approve }) as never, SIGNER).verifiability,
    ).toBe("partial");
    const intent = decodeEvm(txReq({ type: "eip1559", data: maxApprove }) as never, SIGNER);
    expect(intent.approvals[0]).toMatchObject({ kind: "allowance", unlimited: true });
  });

  it("contract call and contract creation → opaque", () => {
    expect(
      decodeEvm(txReq({ type: "eip1559", data: "0x12345678" }) as never, SIGNER).verifiability,
    ).toBe("opaque");
    const noTo = txReq({ type: "eip1559" });
    expect(
      decodeEvm({ ...noTo, tx: { ...noTo.tx, to: undefined } } as never, SIGNER).verifiability,
    ).toBe("opaque");
  });

  it("messages → opaque; generic typed data shows its content", () => {
    const pm = decodeEvm(
      {
        kind: "evm.personal-message",
        network: "eip155:1",
        account: ACCOUNT,
        message: new Uint8Array(1),
      },
      SIGNER,
    );
    expect(pm.verifiability).toBe("opaque");
    const intent = decodeEvm(
      {
        kind: "evm.typed-data",
        network: "eip155:1",
        account: ACCOUNT,
        typedData: vectors.typedData,
      },
      SIGNER,
    );
    expect(intent).toMatchObject({ summary: "message", verifiability: "opaque", approvals: [] });
    const doc = JSON.parse(vectors.typedData);
    expect(intent.message).toMatchObject({
      kind: "typed-data",
      primaryType: doc.primaryType,
      data: doc.message,
    });
    expect(intent.warnings).toStrictEqual([]);
  });

  it("refuses typed data addressed to the signer or an execution context", () => {
    const req = (doc: unknown) =>
      ({
        kind: "evm.typed-data",
        network: "eip155:1",
        account: ACCOUNT,
        typedData: JSON.stringify(doc),
      }) as never;
    const doc = () => JSON.parse(vectors.typedData);
    const refused = (verifyingContract: string, signer = SIGNER) => {
      const d = doc();
      d.domain["verifyingContract"] = verifyingContract;
      return () => decodeEvm(req(d), signer);
    };
    expect(refused(SIGNER.toLowerCase())).toThrow(ChainError);
    expect(refused(checksumEvmAddress(SIGNER))).toThrow(ChainError);
    expect(refused(DELEGATION_MANAGER)).toThrow(ChainError);
    expect(refused(DELEGATION_MANAGER.toLowerCase())).toThrow(ChainError);
    expect(refused(ENTRY_POINT_V08)).toThrow(ChainError);
    expect(refused("0x0000000000000000000000000000000000c0ffee")).not.toThrow();
    expect(() => decodeEvm(req(doc()), SIGNER)).not.toThrow();
  });

  it("normalizeEvm checks typed-data domain.chainId against the network", () => {
    const withChain = (chainId: unknown, network = "eip155:1") => {
      const doc = JSON.parse(vectors.typedData);
      doc.domain.chainId = chainId;
      return normalizeEvm({
        kind: "evm.typed-data",
        network,
        account: ACCOUNT,
        typedData: JSON.stringify(doc),
      });
    };
    expect(withChain(1).kind).toBe("evm.typed-data");
    expect(withChain("1").kind).toBe("evm.typed-data");
    expect(withChain("0x1").kind).toBe("evm.typed-data");
    expect(() => withChain(5)).toThrow(expect.objectContaining({ code: "chain-id-mismatch" }));
    expect(() => withChain("0x5")).toThrow(expect.objectContaining({ code: "chain-id-mismatch" }));
    for (const bad of [-1, 1.5, "abc", "", true, null, 2 ** 60]) {
      expect(() => withChain(bad)).toThrow(expect.objectContaining({ code: "invalid-typed-data" }));
    }
  });

  it("parses CAIP-2 chain ids", () => {
    expect(networkChainId("eip155:56")).toBe(56);
    expect(() => networkChainId("solana:4sg")).toThrow(ChainError);
  });
});

describe("EVM_NATIVE_ASSET", () => {
  it("is the asset id the decode uses for the native coin", () => {
    expect(EVM_NATIVE_ASSET).toBe("native");
    const intent = decodeEvm(txReq({ type: "eip1559", value: "0x1" }) as never, SIGNER);
    expect(intent.outflows[0]?.amount.asset).toBe(EVM_NATIVE_ASSET);
  });
});

describe("approval and transfer decode", () => {
  const TOKEN = vectors.addressForKey;
  const table: EvmTokenTable = { "1": { [TOKEN]: { symbol: "TKN", decimals: 6 } } };
  const SPENDER = "0x1111111254EEB25477B68fb85Ed929f73A960582";
  const OWNER = "0x00000000000000000000000000000000DeaDBeef";
  const RECIPIENT = "0x2222222222222222222222222222222222222222";
  const MAX_256 = 2n ** 256n - 1n;
  const MAX_160 = 2n ** 160n - 1n;

  const calldata = (signature: string, args: unknown[]): string =>
    AbiFunction.encodeData(AbiFunction.from(signature) as AbiFunction.AbiFunction, args);
  const decode = (data: string, to = TOKEN, tokens: EvmTokenTable = table) =>
    decodeEvm(txReq({ type: "eip1559", to, data }) as never, SIGNER, tokens);

  it("approve sets the allowance; the max is unlimited; the token table adds metadata", () => {
    const sig = "function approve(address spender, uint256 amount)";
    const limited = decode(calldata(sig, [SPENDER, 5n]));
    expect(limited).toMatchObject({ summary: "approve", verifiability: "partial", outflows: [] });
    expect(limited.approvals).toStrictEqual([
      {
        kind: "allowance",
        spender: SPENDER,
        amount: { asset: TOKEN, amount: "5", symbol: "TKN", decimals: 6 },
        change: "set",
        unlimited: false,
        verified: true,
      },
    ]);
    const unlimited = decode(calldata(sig, [SPENDER, MAX_256]), TOKEN, {});
    expect(unlimited.approvals[0]).toMatchObject({ unlimited: true, verified: false });
    expect(unlimited.approvals[0]).toMatchObject({ amount: { amount: MAX_256.toString(10) } });
  });

  it("approve with trailing bytes is not canonical → opaque", () => {
    const data = `${calldata("function approve(address spender, uint256 amount)", [SPENDER, 5n])}00`;
    expect(decode(data).verifiability).toBe("opaque");
  });

  it("increaseAllowance increases, decreaseAllowance decreases and is never unlimited", () => {
    const up = decode(
      calldata("function increaseAllowance(address spender, uint256 amount)", [SPENDER, MAX_256]),
    );
    expect(up.approvals[0]).toMatchObject({ change: "increase", unlimited: true });
    const down = decode(
      calldata("function decreaseAllowance(address spender, uint256 subtractedValue)", [
        SPENDER,
        MAX_256,
      ]),
    );
    expect(down.approvals[0]).toMatchObject({
      kind: "allowance",
      change: "decrease",
      unlimited: false,
    });
    expect(down.verifiability).toBe("partial");
  });

  it("decreaseAllowance with a wrong selector is opaque", () => {
    const data = calldata("function decreaseAllowance(address spender, uint256 subtractedValue)", [
      SPENDER,
      1n,
    ]);
    expect(decode(`0x00000000${data.slice(10)}`).verifiability).toBe("opaque");
  });

  it("setApprovalForAll grants or revokes an operator on the called contract", () => {
    const sig = "function setApprovalForAll(address operator, bool approved)";
    expect(decode(calldata(sig, [SPENDER, true])).approvals).toStrictEqual([
      { kind: "operator", asset: TOKEN, spender: SPENDER, approved: true, verified: false },
    ]);
    const revoke = decode(calldata(sig, [SPENDER, false]));
    expect(revoke.approvals[0]).toMatchObject({ kind: "operator", approved: false });
    expect(revoke).toMatchObject({ summary: "approve", verifiability: "partial" });
  });

  it("setApprovalForAll with a non-canonical bool is opaque", () => {
    const data = calldata("function setApprovalForAll(address operator, bool approved)", [
      SPENDER,
      true,
    ]);
    expect(decode(`${data.slice(0, -1)}2`).verifiability).toBe("opaque");
  });

  it("transferFrom on a table token is an ERC-20 outflow", () => {
    const data = calldata("function transferFrom(address from, address to, uint256 tokenId)", [
      OWNER,
      RECIPIENT,
      7n,
    ]);
    const intent = decode(data);
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows).toStrictEqual([
      {
        to: RECIPIENT,
        amount: { asset: TOKEN, amount: "7", symbol: "TKN", decimals: 6 },
        verified: true,
      },
    ]);
  });

  it("transferFrom on another contract stays an NFT flow", () => {
    const data = calldata("function transferFrom(address from, address to, uint256 tokenId)", [
      OWNER,
      RECIPIENT,
      7n,
    ]);
    expect(decode(data, TOKEN, {}).outflows).toStrictEqual([
      { to: RECIPIENT, amount: { asset: TOKEN, amount: "7" }, verified: false },
    ]);
  });

  it("ERC-721 safeTransferFrom with data is an NFT flow", () => {
    const data = calldata(
      "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
      [OWNER, RECIPIENT, 9n, "0x1234"],
    );
    const intent = decode(data);
    expect(intent).toMatchObject({ summary: "transfer", verifiability: "partial" });
    expect(intent.outflows).toStrictEqual([
      { to: RECIPIENT, amount: { asset: TOKEN, amount: "9" }, verified: false },
    ]);
  });

  it("ERC-1155 safeBatchTransferFrom yields one flow per id", () => {
    const sig =
      "function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)";
    const intent = decode(calldata(sig, [OWNER, RECIPIENT, [1n, 2n], [10n, 20n], "0x"]));
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows.map((f) => [f.to, f.amount.asset, f.amount.amount])).toStrictEqual([
      [RECIPIENT, TOKEN, "1"],
      [RECIPIENT, TOKEN, "2"],
    ]);
  });

  it("ERC-1155 batch with mismatched arrays or no ids is opaque", () => {
    const sig =
      "function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)";
    expect(decode(calldata(sig, [OWNER, RECIPIENT, [1n, 2n], [10n], "0x"])).verifiability).toBe(
      "opaque",
    );
    expect(decode(calldata(sig, [OWNER, RECIPIENT, [], [], "0x"])).verifiability).toBe("opaque");
  });

  it("Permit2 approve is an allowance via Permit2 with an expiration", () => {
    const sig =
      "function approve(address token, address spender, uint160 amount, uint48 expiration)";
    const intent = decode(calldata(sig, [TOKEN, SPENDER, 100n, 1_800_000_000]), PERMIT2_ADDRESS);
    expect(intent).toMatchObject({ summary: "approve", verifiability: "partial" });
    expect(intent.approvals).toStrictEqual([
      {
        kind: "allowance",
        spender: SPENDER,
        amount: { asset: TOKEN, amount: "100", symbol: "TKN", decimals: 6 },
        change: "set",
        unlimited: false,
        expiration: 1_800_000_000,
        via: "permit2",
        verified: true,
      },
    ]);
    const lower = decode(
      calldata(sig, [TOKEN, SPENDER, MAX_160, 0]),
      PERMIT2_ADDRESS.toLowerCase(),
    );
    expect(lower.approvals[0]).toMatchObject({ via: "permit2", unlimited: true });
  });

  it("a Permit2 approve sent to another address is not decoded as Permit2", () => {
    const sig =
      "function approve(address token, address spender, uint160 amount, uint48 expiration)";
    const intent = decode(calldata(sig, [TOKEN, SPENDER, 100n, 1_800_000_000]));
    expect(intent.verifiability).toBe("opaque");
    expect(intent.approvals).toStrictEqual([]);
  });

  it("Permit2 lockdown revokes every pair", () => {
    const sig = "function lockdown((address token, address spender)[] approvals)";
    const intent = decode(
      calldata(sig, [
        [
          { token: TOKEN, spender: SPENDER },
          { token: OWNER, spender: RECIPIENT },
        ],
      ]),
      PERMIT2_ADDRESS,
    );
    expect(intent.verifiability).toBe("partial");
    expect(intent.approvals).toHaveLength(2);
    expect(intent.approvals[0]).toMatchObject({
      kind: "allowance",
      spender: SPENDER,
      amount: { asset: TOKEN, amount: "0" },
      change: "set",
      unlimited: false,
      via: "permit2",
    });
    expect(intent.approvals[1]).toMatchObject({ spender: RECIPIENT, amount: { asset: OWNER } });
  });

  it("lockdown on a non-Permit2 address is opaque", () => {
    const sig = "function lockdown((address token, address spender)[] approvals)";
    expect(decode(calldata(sig, [[{ token: TOKEN, spender: SPENDER }]])).verifiability).toBe(
      "opaque",
    );
  });
});
