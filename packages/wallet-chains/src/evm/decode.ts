import * as AbiFunction from "ox/AbiFunction";

import { ChainError } from "../index.ts";
import type {
  ApprovalChange,
  AssetFlow,
  DisplayIntent,
  IntentWarning,
  EvmTransaction,
  MessageContent,
  TypedDataDomain,
  SignRequest,
  Verifiability,
} from "../index.ts";
import { parseSignIn } from "../sign-in.ts";
import { checksumEvmAddress } from "./address.ts";
import { MAX_UINT160, MAX_UINT256, PERMIT2_ADDRESS, allowanceChange } from "./approval.ts";
import { EVM_NATIVE_ASSET } from "./assets.ts";
import { EVM_DELEGATOR, decodeBatchExecute } from "./delegation.ts";
import { assertNoExecutionGrant } from "./grants.ts";
import { recognizePermit } from "./permit.ts";
import { recognizeSafe } from "./safe.ts";
import { recognizeSeaport } from "./seaport.ts";
import { lookupEvmToken, evmTokenTable } from "./tokens.ts";
import type { EvmTokenTable } from "./tokens.ts";
import { quantityBigInt, assertHex, networkChainId } from "./transaction.ts";
import { domainChainId, parseTypedData } from "./typed-data.ts";
import type { TypedDataInput } from "./typed-data.ts";
import { decodeZeroX } from "./zerox.ts";

const ERC20_TRANSFER = AbiFunction.from("function transfer(address to, uint256 amount)");
const ERC20_APPROVE = AbiFunction.from("function approve(address spender, uint256 amount)");
const ERC20_INCREASE = AbiFunction.from(
  "function increaseAllowance(address spender, uint256 amount)",
);
const ERC20_DECREASE = AbiFunction.from(
  "function decreaseAllowance(address spender, uint256 subtractedValue)",
);
const SET_APPROVAL_FOR_ALL = AbiFunction.from(
  "function setApprovalForAll(address operator, bool approved)",
);
const PERMIT2_APPROVE = AbiFunction.from(
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
);
const PERMIT2_LOCKDOWN = AbiFunction.from(
  "function lockdown((address token, address spender)[] approvals)",
);
const ERC721_SAFE_FROM_DATA = AbiFunction.from(
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
);
const ERC1155_SAFE_BATCH_FROM = AbiFunction.from(
  "function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)",
);
const ERC721_TRANSFER_FROM = AbiFunction.from(
  "function transferFrom(address from, address to, uint256 tokenId)",
);
const ERC721_SAFE_FROM = AbiFunction.from(
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
);
const ERC1155_SAFE_FROM = AbiFunction.from(
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
);

const argAddress = (args: ReadonlyArray<unknown>, index: number): string => {
  const value = args[index];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new ChainError("invalid-request", "decoded argument is not an address");
  }
  return checksumEvmAddress(value);
};

const argUint = (args: ReadonlyArray<unknown>, index: number): bigint => {
  const value = args[index];
  if (typeof value !== "bigint") {
    throw new ChainError("invalid-request", "decoded argument is not a uint256");
  }
  return value;
};

/**
 * Decodes `data` as `fn` and verifies the encoding is canonical (re-encoding the decoded args
 * reproduces the input byte-for-byte). Returns undefined on selector mismatch, decode failure or a
 * non-canonical encoding — the caller falls through to the next candidate or the opaque class.
 */
const tryCall = (fn: AbiFunction.AbiFunction, data: string): ReadonlyArray<unknown> | undefined => {
  const selector = AbiFunction.getSelector(fn);
  if (!data.toLowerCase().startsWith(selector)) {
    return undefined;
  }
  try {
    assertHex(data, "data");
    const args: unknown = AbiFunction.decodeData(fn, data);
    if (!Array.isArray(args)) {
      return undefined;
    }
    const reencoded = AbiFunction.encodeData(fn, args);
    return reencoded.toLowerCase() === data.toLowerCase() ? args : undefined;
  } catch {
    return undefined;
  }
};

const weiAmount = (wei: bigint, symbol?: string, decimals?: number) => ({
  asset: EVM_NATIVE_ASSET,
  amount: wei.toString(10),
  ...(symbol === undefined ? {} : { symbol }),
  ...(decimals === undefined ? {} : { decimals }),
});

const feeWei = (tx: EvmTransaction): bigint =>
  quantityBigInt(tx.gas, "tx.gas") *
  (tx.type === "eip1559" || tx.type === "eip7702"
    ? quantityBigInt(tx.maxFeePerGas, "tx.maxFeePerGas")
    : quantityBigInt(tx.gasPrice, "tx.gasPrice"));

const nativeOutflow = (value: bigint, to: string): ReadonlyArray<AssetFlow> => [
  { to, amount: weiAmount(value), verified: true },
];

const tokenFlow = (
  target: string,
  to: string,
  amount: bigint,
  chainId: number,
  table: EvmTokenTable,
): { flows: ReadonlyArray<AssetFlow>; verified: boolean } => {
  const token = lookupEvmToken(table, chainId, target);
  return {
    flows: [
      {
        to,
        amount: {
          asset: target,
          amount: amount.toString(10),
          ...(token === undefined ? {} : { symbol: token.symbol, decimals: token.decimals }),
        },
        verified: token !== undefined,
      },
    ],
    verified: token !== undefined,
  };
};

const argBool = (args: ReadonlyArray<unknown>, index: number): boolean => {
  const value = args[index];
  if (typeof value !== "boolean") {
    throw new ChainError("invalid-request", "decoded argument is not a bool");
  }
  return value;
};

const argList = (args: ReadonlyArray<unknown>, index: number): ReadonlyArray<unknown> => {
  const value = args[index];
  if (!Array.isArray(value)) {
    throw new ChainError("invalid-request", "decoded argument is not an array");
  }
  return value;
};

const argSeconds = (args: ReadonlyArray<unknown>, index: number): number => {
  const value = args[index];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new ChainError("invalid-request", "decoded argument is not an integer");
  }
  return Number(value);
};

const pairField = (pair: unknown, key: "token" | "spender"): string => {
  const value: unknown = typeof pair === "object" && pair !== null ? Reflect.get(pair, key) : "";
  return argAddress([value], 0);
};

const nftFlow = (asset: string, to: string, id: bigint): ReadonlyArray<AssetFlow> => [
  { to, amount: { asset, amount: id.toString(10) }, verified: false },
];

/** One EVM call, `to` absent for contract creation; `value` and `data` are always present. */
type EvmCall = {
  readonly to: string | undefined;
  readonly value: bigint;
  readonly data: string;
};

/**
 * The call rules shared by a whole transaction and a Safe's inner calls: the same selector table
 * produces the intent; `fee` is `undefined` for a call that is not itself a transaction.
 */
const decodeCall = (
  call: EvmCall,
  network: string,
  fee: DisplayIntent["fee"],
  table: EvmTokenTable,
): DisplayIntent => {
  const chainId = networkChainId(network);
  const data = call.data.toLowerCase();
  const base = { family: "evm" as const, network, approvals: [], warnings: [] };

  if (data === "0x") {
    if (call.to === undefined) {
      return { ...base, summary: "contract-call", outflows: [], fee, verifiability: "opaque" };
    }
    return {
      ...base,
      summary: "transfer",
      outflows: nativeOutflow(call.value, call.to),
      fee,
      verifiability: "full",
    };
  }

  const zeroX = decodeZeroX(chainId, call, table);
  if (zeroX !== undefined) {
    const { summary, outflows, approvals, verifiability, minimumReceived } = zeroX;
    return {
      ...base,
      summary,
      outflows,
      approvals,
      ...(minimumReceived === undefined ? {} : { minimumReceived }),
      fee,
      verifiability,
    };
  }

  const transferArgs = tryCall(ERC20_TRANSFER, data);
  if (transferArgs !== undefined) {
    const { flows, verified } = tokenFlow(
      call.to ?? "",
      argAddress(transferArgs, 0),
      argUint(transferArgs, 1),
      chainId,
      table,
    );
    return {
      ...base,
      summary: "transfer",
      outflows: flows,
      fee,
      verifiability: verified ? "full" : "partial",
    };
  }
  const partial = (
    summary: "approve" | "transfer",
    outflows: ReadonlyArray<AssetFlow>,
    approvals: ReadonlyArray<ApprovalChange>,
  ): DisplayIntent => ({
    ...base,
    summary,
    outflows,
    approvals,
    fee,
    verifiability: "partial",
  });
  const token = call.to ?? "";

  if (token.toLowerCase() === PERMIT2_ADDRESS.toLowerCase()) {
    const permitArgs = tryCall(PERMIT2_APPROVE, data);
    if (permitArgs !== undefined) {
      const amount = argUint(permitArgs, 2);
      return partial(
        "approve",
        [],
        [
          allowanceChange(
            argAddress(permitArgs, 0),
            argAddress(permitArgs, 1),
            amount,
            "set",
            MAX_UINT160,
            chainId,
            table,
            { via: "permit2", expiration: argSeconds(permitArgs, 3) },
          ),
        ],
      );
    }
    const lockdownArgs = tryCall(PERMIT2_LOCKDOWN, data);
    if (lockdownArgs !== undefined) {
      return partial(
        "approve",
        [],
        argList(lockdownArgs, 0).map((pair) =>
          allowanceChange(
            pairField(pair, "token"),
            pairField(pair, "spender"),
            0n,
            "set",
            MAX_UINT160,
            chainId,
            table,
            { via: "permit2" },
          ),
        ),
      );
    }
  }
  for (const [fn, change] of [
    [ERC20_APPROVE, "set"],
    [ERC20_INCREASE, "increase"],
    [ERC20_DECREASE, "decrease"],
  ] as const) {
    const args = tryCall(fn, data);
    if (args !== undefined) {
      return partial(
        "approve",
        [],
        [
          allowanceChange(
            token,
            argAddress(args, 0),
            argUint(args, 1),
            change,
            MAX_UINT256,
            chainId,
            table,
          ),
        ],
      );
    }
  }
  const operatorArgs = tryCall(SET_APPROVAL_FOR_ALL, data);
  if (operatorArgs !== undefined) {
    return partial(
      "approve",
      [],
      [
        {
          kind: "operator",
          asset: token,
          spender: argAddress(operatorArgs, 0),
          approved: argBool(operatorArgs, 1),
          verified: false,
        },
      ],
    );
  }
  const transferFromArgs = tryCall(ERC721_TRANSFER_FROM, data);
  if (transferFromArgs !== undefined) {
    const to = argAddress(transferFromArgs, 1);
    const id = argUint(transferFromArgs, 2);
    if (lookupEvmToken(table, chainId, token) !== undefined) {
      return partial("transfer", tokenFlow(token, to, id, chainId, table).flows, []);
    }
    return partial("transfer", nftFlow(token, to, id), []);
  }
  for (const fn of [ERC721_SAFE_FROM, ERC721_SAFE_FROM_DATA]) {
    const args = tryCall(fn, data);
    if (args !== undefined) {
      return partial("transfer", nftFlow(token, argAddress(args, 1), argUint(args, 2)), []);
    }
  }
  const erc1155Args = tryCall(ERC1155_SAFE_FROM, data);
  if (erc1155Args !== undefined) {
    return partial(
      "transfer",
      nftFlow(token, argAddress(erc1155Args, 1), argUint(erc1155Args, 2)),
      [],
    );
  }
  const batchArgs = tryCall(ERC1155_SAFE_BATCH_FROM, data);
  if (batchArgs !== undefined) {
    const ids = argList(batchArgs, 2);
    if (ids.length > 0 && ids.length === argList(batchArgs, 3).length) {
      const to = argAddress(batchArgs, 1);
      return partial(
        "transfer",
        ids.flatMap((id) => nftFlow(token, to, argUint([id], 0))),
        [],
      );
    }
  }
  return { ...base, summary: "contract-call", outflows: [], fee, verifiability: "opaque" };
};

/** The delegation field a request carries, present iff the transaction is eip7702. */
const delegationOf = (tx: EvmTransaction): DisplayIntent["delegation"] => {
  if (tx.type !== "eip7702") {
    return undefined;
  }
  return tx.authorization.address === "0x0000000000000000000000000000000000000000"
    ? { kind: "revoke" }
    : {
        kind: "set",
        delegator: EVM_DELEGATOR.address,
        name: EVM_DELEGATOR.name,
        version: EVM_DELEGATOR.version,
      };
};

const weakest = (intents: ReadonlyArray<DisplayIntent>): Verifiability =>
  intents.some((i) => i.verifiability === "opaque")
    ? "opaque"
    : intents.some((i) => i.verifiability === "partial")
      ? "partial"
      : "full";

const decodeTransaction = (
  request: Extract<SignRequest, { kind: "evm.transaction" }>,
  signer: string,
  table: EvmTokenTable,
): DisplayIntent => {
  const { tx } = request;
  const fee = { max: weiAmount(feeWei(tx)) };
  const delegation = delegationOf(tx);
  const isSelf =
    tx.to !== undefined && tx.to.toLowerCase() === signer.toLowerCase() && BigInt(tx.value) === 0n;
  if (isSelf && tx.data === "0x") {
    const base = {
      family: "evm" as const,
      network: request.network,
      outflows: [] as ReadonlyArray<AssetFlow>,
      approvals: [] as ReadonlyArray<ApprovalChange>,
      fee,
      warnings: [] as ReadonlyArray<IntentWarning>,
      verifiability: "full" as const,
      ...(delegation === undefined ? {} : { delegation }),
    };
    return {
      ...base,
      summary: tx.type === "eip7702" ? ("authorization" as const) : ("transfer" as const),
    };
  }
  const calls = isSelf ? decodeBatchExecute(tx.data) : undefined;
  const intent = decodeCall(
    { to: tx.to, value: quantityBigInt(tx.value, "tx.value"), data: tx.data },
    request.network,
    fee,
    table,
  );
  if (calls !== undefined && calls.length > 0) {
    const decoded = calls.map((call) =>
      decodeCall(
        { to: call.to, value: call.value, data: call.data },
        request.network,
        undefined,
        table,
      ),
    );
    return {
      ...intent,
      summary: "batch",
      calls: decoded,
      outflows: decoded.flatMap((d) => d.outflows),
      approvals: decoded.flatMap((d) => d.approvals),
      verifiability: weakest(decoded),
      ...(delegation === undefined ? {} : { delegation }),
    };
  }
  return { ...intent, ...(delegation === undefined ? {} : { delegation }) };
};

/** The five EIP-712 domain fields a wallet shows; anything malformed is left out. */
const displayDomain = (domain: TypedDataInput["domain"]): TypedDataDomain => {
  const { name, version, verifyingContract, salt } = domain;
  const chainId = domainChainId(domain);
  return {
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof version === "string" ? { version } : {}),
    ...(chainId === undefined ? {} : { chainId }),
    ...(typeof verifyingContract === "string" && /^0x[0-9a-fA-F]{40}$/.test(verifyingContract)
      ? { verifyingContract: checksumEvmAddress(verifyingContract) }
      : {}),
    ...(typeof salt === "string" ? { salt } : {}),
  };
};

/** Strict UTF-8 text with any sign-in recognition, else the raw bytes as hex. */
const messageContent = (bytes: Uint8Array): MessageContent => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const signIn = parseSignIn(text, "evm");
    return signIn === undefined ? { kind: "text", text } : { kind: "text", text, signIn };
  } catch {
    return {
      kind: "bytes",
      hex: `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
    };
  }
};

/** What the signer can guarantee about this request (WD-065). */
export const verifiabilityEvm = (request: SignRequest, signer: string): Verifiability =>
  decodeEvm(request, signer).verifiability;

/**
 * Decodes a normalized request into a DisplayIntent. `signer` is the address of the signing
 * account; the token table parameter is for tests.
 */
export const decodeEvm = (
  request: SignRequest,
  signer: string,
  table: EvmTokenTable = evmTokenTable,
): DisplayIntent => {
  if (request.kind === "evm.transaction") {
    return decodeTransaction(request, signer, table);
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
      message: messageContent(request.message),
      verifiability: "opaque",
    };
  }
  if (request.kind !== "evm.typed-data") {
    throw new ChainError("unsupported", `unsupported sign request kind: ${request.kind}`);
  }
  const { json } = parseTypedData(request.typedData);
  assertNoExecutionGrant(json.domain, signer);
  const chainId = networkChainId(request.network);
  const permit = recognizePermit(json, chainId, table);
  const seaport = permit === undefined ? recognizeSeaport(json, chainId, table) : undefined;
  const safe =
    permit === undefined && seaport === undefined
      ? recognizeSafe(json, (call) => decodeCall(call, request.network, undefined, table))
      : undefined;
  const message: MessageContent = {
    kind: "typed-data",
    primaryType: json.primaryType,
    domain: displayDomain(json.domain),
    data: json.message,
    ...(seaport === undefined ? {} : { seaport }),
    ...(safe === undefined ? {} : { safe: safe.safe }),
  };
  const summary =
    seaport === undefined
      ? safe === undefined
        ? permit === undefined
          ? "message"
          : "approve"
        : safe.multisend
          ? "batch"
          : (safe.safe.calls[0]?.summary ?? "contract-call")
      : "swap";
  return {
    family: "evm",
    network: request.network,
    summary,
    outflows: [],
    approvals: permit?.approvals ?? [],
    fee: undefined,
    warnings: permit?.warnings ?? [],
    message,
    verifiability: permit === undefined ? "opaque" : "partial",
  };
};
