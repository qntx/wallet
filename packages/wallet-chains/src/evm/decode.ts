import type {
  ApprovalChange,
  AssetFlow,
  DisplayIntent,
  EvmTransaction,
  SignRequest,
  Verifiability,
} from "../index.ts";
import { lookupEvmToken, evmTokenTable } from "./tokens.ts";
import type { EvmTokenTable } from "./tokens.ts";
import { networkChainId } from "./transaction.ts";
import { parseTypedData, typedDataWarnings } from "./typed-data.ts";

// Function selectors (first 4 bytes of keccak-256 of the signature).
const SEL = {
  erc20Transfer: "0xa9059cbb", // transfer(address,uint256)
  erc20Approve: "0x095ea7b3", // approve(address,uint256)
  erc20IncreaseAllowance: "0x39509351", // increaseAllowance(address,uint256)
  erc721TransferFrom: "0x23b872dd", // transferFrom(address,address,uint256)
  erc721SafeTransferFrom: "0x42842e0e", // safeTransferFrom(address,address,uint256)
  erc721SafeTransferFromData: "0xb88d4fde", // safeTransferFrom(address,address,uint256,bytes)
  erc1155SafeTransferFrom: "0xf242432a", // safeTransferFrom(address,address,uint256,uint256,bytes)
  erc1155SafeBatchTransferFrom: "0x2eb2c2d6", // safeBatchTransferFrom(...)
} as const;

const NATIVE_ASSET = "native";

const MAX_UINT256 = 2n ** 256n - 1n;

const hexData = (data: string | undefined): string => (data ?? "0x").toLowerCase();

const selector = (data: string): string => data.slice(0, 10);

const addressParam = (data: string, wordIndex: number): string => {
  const word = data.slice(10 + wordIndex * 64, 10 + (wordIndex + 1) * 64);
  return `0x${word.slice(24)}`;
};

const uintParam = (data: string, wordIndex: number): bigint => {
  const word = data.slice(10 + wordIndex * 64, 10 + (wordIndex + 1) * 64);
  return BigInt(`0x${word}`);
};

const hasLength = (data: string, words: number): boolean => data.length === 10 + words * 64;

const weiAmount = (wei: bigint, symbol?: string, decimals?: number) => ({
  asset: NATIVE_ASSET,
  amount: wei.toString(10),
  ...(symbol === undefined ? {} : { symbol }),
  ...(decimals === undefined ? {} : { decimals }),
});

const feeWei = (tx: EvmTransaction): bigint | undefined => {
  const gas = tx.gas === undefined ? undefined : BigInt(tx.gas);
  const price =
    tx.maxFeePerGas === undefined
      ? tx.gasPrice === undefined
        ? undefined
        : BigInt(tx.gasPrice)
      : BigInt(tx.maxFeePerGas);
  if (gas === undefined || price === undefined) {
    return undefined;
  }
  return gas * price;
};

const nativeOutflow = (tx: EvmTransaction, to: string): ReadonlyArray<AssetFlow> => {
  const value = tx.value === undefined ? 0n : BigInt(tx.value);
  return [{ to, amount: weiAmount(value), verified: true }];
};

const base = (request: Extract<SignRequest, { kind: "evm.transaction" }>) => ({
  family: "evm" as const,
  network: request.network,
  approvals: [] as ReadonlyArray<ApprovalChange>,
  warnings: [] as const,
});

const tokenFlow = (
  tx: EvmTransaction,
  data: string,
  chainId: number,
  table: EvmTokenTable,
): { flows: ReadonlyArray<AssetFlow>; verified: boolean } => {
  const to = addressParam(data, 0);
  const amount = uintParam(data, 1);
  const token = lookupEvmToken(table, chainId, tx.to ?? "");
  return {
    flows: [
      {
        to,
        amount: {
          asset: tx.to ?? "",
          amount: amount.toString(10),
          ...(token ? { symbol: token.symbol, decimals: token.decimals } : {}),
        },
        verified: token !== undefined,
      },
    ],
    verified: token !== undefined,
  };
};

const approvalChange = (tx: EvmTransaction, data: string): ApprovalChange => ({
  asset: tx.to ?? "",
  spender: addressParam(data, 0),
  amount: uintParam(data, 1).toString(10),
  unlimited: uintParam(data, 1) === MAX_UINT256,
  verified: false,
});

const transferFlow = (data: string, asset: string, verified: boolean): ReadonlyArray<AssetFlow> => {
  // transferFrom/safeTransferFrom (ERC-721): (from, to, tokenId)
  const to = addressParam(data, 1);
  return [{ to, amount: { asset, amount: uintParam(data, 2).toString(10) }, verified }];
};

const decodeTransaction = (
  request: Extract<SignRequest, { kind: "evm.transaction" }>,
  table: EvmTokenTable,
): Omit<DisplayIntent, "verifiability"> & { readonly verifiability: Verifiability } => {
  const { tx } = request;
  const chainId = networkChainId(request.network);
  const data = hexData(tx.data);
  const b = base(request);
  const fee = feeWei(tx);
  const feeMax = fee === undefined ? undefined : { max: weiAmount(fee) };
  const sel = selector(data);

  if (data === "0x" || data === "") {
    const { to } = tx;
    if (to === undefined) {
      return { ...b, summary: "contract-call", outflows: [], fee: feeMax, verifiability: "opaque" };
    }
    return {
      ...b,
      summary: "transfer",
      outflows: nativeOutflow(tx, to),
      fee: feeMax,
      verifiability: "full",
    };
  }

  if (sel === SEL.erc20Transfer && hasLength(data, 2)) {
    const { flows, verified } = tokenFlow(tx, data, chainId, table);
    return {
      ...b,
      summary: "transfer",
      outflows: flows,
      fee: feeMax,
      verifiability: verified ? "full" : "partial",
    };
  }
  if (sel === SEL.erc20Approve && hasLength(data, 2)) {
    return {
      ...b,
      summary: "approve",
      outflows: [],
      approvals: [approvalChange(tx, data)],
      fee: feeMax,
      verifiability: "partial",
    };
  }
  if (sel === SEL.erc20IncreaseAllowance && hasLength(data, 2)) {
    return {
      ...b,
      summary: "approve",
      outflows: [],
      approvals: [approvalChange(tx, data)],
      fee: feeMax,
      verifiability: "partial",
    };
  }
  if (
    (sel === SEL.erc721TransferFrom || sel === SEL.erc721SafeTransferFrom) &&
    hasLength(data, 3)
  ) {
    return {
      ...b,
      summary: "transfer",
      outflows: transferFlow(data, tx.to ?? "", false),
      fee: feeMax,
      verifiability: "partial",
    };
  }
  if (sel === SEL.erc721SafeTransferFromData && hasLength(data, 4)) {
    return {
      ...b,
      summary: "transfer",
      outflows: transferFlow(data, tx.to ?? "", false),
      fee: feeMax,
      verifiability: "partial",
    };
  }
  if (sel === SEL.erc1155SafeTransferFrom && hasLength(data, 5)) {
    return {
      ...b,
      summary: "transfer",
      outflows: transferFlow(data, tx.to ?? "", false),
      fee: feeMax,
      verifiability: "partial",
    };
  }
  if (sel === SEL.erc1155SafeBatchTransferFrom) {
    return { ...b, summary: "transfer", outflows: [], fee: feeMax, verifiability: "partial" };
  }
  return { ...b, summary: "contract-call", outflows: [], fee: feeMax, verifiability: "opaque" };
};

/** What the signer can guarantee about this request (WD-065). */
export const verifiabilityEvm = (request: SignRequest): Verifiability =>
  decodeEvm(request).verifiability;

/**
 * Decodes a normalized request into a DisplayIntent. The token table parameter is for tests;
 * production callers use the built-in table.
 */
export const decodeEvm = (
  request: SignRequest,
  table: EvmTokenTable = evmTokenTable,
): DisplayIntent => {
  if (request.kind === "evm.transaction") {
    const intent = decodeTransaction(request, table);
    return intent;
  }
  if (request.kind === "evm.personal-message") {
    return {
      family: "evm",
      network: request.network,
      summary: "message",
      outflows: [],
      approvals: [],
      fee: undefined,
      warnings: [],
      verifiability: "opaque",
    };
  }
  if (request.kind === "evm.typed-data") {
    const parsed = parseTypedData(request.typedData, request.network);
    return {
      family: "evm",
      network: request.network,
      summary: "message",
      outflows: [],
      approvals: [],
      fee: undefined,
      warnings: typedDataWarnings(parsed),
      verifiability: "opaque",
    };
  }
  // eip7702 authorization and future kinds: reject as unsupported here too.
  const never: never = request;
  throw new Error(`unsupported sign request kind: ${(never as { kind: string }).kind}`);
};
