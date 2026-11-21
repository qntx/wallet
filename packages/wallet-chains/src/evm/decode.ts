import * as AbiFunction from "ox/AbiFunction";
import * as ContractAddress from "ox/ContractAddress";

import { ChainError, messageBlindReason, messageContent } from "../index.ts";
import type {
  ApprovalChange,
  AssetFlow,
  BlindReason,
  DisplayIntent,
  IntentWarning,
  EvmTransaction,
  MessageContent,
  SeaportOrder,
  TypedDataDomain,
  SignRequest,
  Verifiability,
} from "../index.ts";
import { withNativeAmountMeta } from "../networks.ts";
import { decodeAcross } from "./across.ts";
import { checksumEvmAddress } from "./address.ts";
import { MAX_UINT160, PERMIT2_ADDRESS, allowanceChange } from "./approval.ts";
import { recognizeApp } from "./apps.ts";
import type { AppRecognition } from "./apps.ts";
import { EVM_NATIVE_ASSET } from "./assets.ts";
import { decodeCctp, isCctpMessenger } from "./cctp.ts";
import { recognizeCow } from "./cow.ts";
import { EVM_DELEGATOR, decodeBatchExecute } from "./delegation.ts";
import { callNearMiss, typedDataNearMiss } from "./families.ts";
import { assertNoExecutionGrant } from "./grants.ts";
import { decodeLido } from "./lido.ts";
import { recognizeOneinch } from "./oneinch.ts";
import { ORDER_ITEMS } from "./order.ts";
import { recognizePermit } from "./permit.ts";
import { recognizeSafe } from "./safe.ts";
import type { SafeRecognition } from "./safe.ts";
import { recognizeSeaport } from "./seaport.ts";
import { recognizeSnapshot } from "./snapshot.ts";
import { decodeTokenCall } from "./token-call.ts";
import { lookupEvmToken, evmTokenTable } from "./tokens.ts";
import type { EvmTokenTable } from "./tokens.ts";
import { quantityBigInt, assertHex, networkChainId } from "./transaction.ts";
import { domainChainId, parseTypedData, typedDataFields } from "./typed-data.ts";
import type { TypedDataInput } from "./typed-data.ts";
import { decodeWrappedNative } from "./wrapped-native.ts";
import { decodeZeroX } from "./zerox.ts";

const PERMIT2_APPROVE = AbiFunction.from(
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
);
const PERMIT2_LOCKDOWN = AbiFunction.from(
  "function lockdown((address token, address spender)[] approvals)",
);

// Private copies of the token-call.ts helpers the Permit2 branch needs — that module's
// exports are exactly TokenCall and decodeTokenCall.
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
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new ChainError("invalid-request", "decoded argument is not an address");
  }
  return checksumEvmAddress(value);
};

/**
 * One EVM call; `value` and `data` are always present. A contract creation has no `to` and names
 * the address it deploys to in `created`.
 */
type EvmCall = {
  readonly to: string | undefined;
  readonly created?: string;
  readonly value: bigint;
  readonly data: string;
};

type CallContext = {
  readonly network: string;
  readonly fee: DisplayIntent["fee"];
  readonly table: EvmTokenTable;
  readonly signer: string;
  /**
   * The account whose own code a call to it runs: the signer for a transaction and its batch calls,
   * the Safe for a Safe's inner calls.
   */
  readonly self: string;
};

/** A call into a protocol the decoder models in full, native value included. */
const protocolIntent = (
  call: EvmCall,
  { network, fee, table, signer, self }: CallContext,
): DisplayIntent | undefined => {
  const chainId = networkChainId(network);
  const base = { family: "evm" as const, network, approvals: [], warnings: [] };

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

  const across = decodeAcross(chainId, call, table);
  if (across !== undefined) {
    return {
      ...base,
      summary: "bridge",
      outflows: across.outflows,
      minimumReceived: across.minimumReceived,
      bridge: across.bridge,
      fee,
      verifiability: "partial",
    };
  }

  if (isCctpMessenger(chainId, call.to)) {
    const cctp = decodeCctp(chainId, call, signer, table);
    if (cctp !== undefined) {
      return {
        ...base,
        summary: "transfer",
        outflows: cctp.outflows,
        hyperliquidDeposit: cctp.hyperliquidDeposit,
        fee,
        verifiability: "partial",
      };
    }
    return {
      ...base,
      summary: "contract-call",
      outflows: call.value > 0n ? nativeOutflow(call.value, call.to ?? "") : [],
      fee,
      verifiability: "opaque",
      blind: "cctp-destination",
    };
  }

  const lido = decodeLido(chainId, call, self, table);
  if (lido !== undefined) {
    return {
      ...base,
      summary: "stake",
      outflows: lido.outflows,
      staking: lido.staking,
      fee,
      verifiability: "partial",
    };
  }

  const wrapped = decodeWrappedNative(chainId, call, self, table);
  if (wrapped !== undefined) {
    return {
      ...base,
      summary: "swap",
      outflows: wrapped.outflows,
      approvals: [],
      minimumReceived: wrapped.minimumReceived,
      fee,
      verifiability: "full",
    };
  }

  return undefined;
};

/** The token-standard selectors, else an opaque call. None of them accounts for native value. */
const standardIntent = (call: EvmCall, { network, fee, table }: CallContext): DisplayIntent => {
  const chainId = networkChainId(network);
  const data = call.data.toLowerCase();
  const base = { family: "evm" as const, network, approvals: [], warnings: [] };
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

  // Permit2's approve/lockdown are recognised only on Permit2 itself — the callee gates them,
  // not the selector, so this stays ahead of the shared token table.
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
  const tokenCall = decodeTokenCall(token, data, chainId, table);
  if (tokenCall !== undefined) {
    return {
      ...base,
      summary: tokenCall.summary,
      outflows: tokenCall.outflows,
      approvals: tokenCall.approvals,
      fee,
      verifiability: tokenCall.verifiability,
    };
  }
  return { ...base, summary: "contract-call", outflows: [], fee, verifiability: "opaque" };
};

/**
 * The call rules shared by a whole transaction and a Safe's inner calls: the same selector table
 * produces the intent; `fee` is `undefined` for a call that is not itself a transaction. Native
 * value sent along with calldata is always an outflow to the contract that receives it.
 */
const decodeCall = (call: EvmCall, context: CallContext): DisplayIntent => {
  if (call.data === "0x" && call.to !== undefined) {
    return {
      family: "evm",
      network: context.network,
      summary: "transfer",
      outflows: nativeOutflow(call.value, call.to),
      approvals: [],
      fee: context.fee,
      warnings: [],
      verifiability: "full",
    };
  }
  const address = call.to ?? call.created;
  const token =
    call.to === undefined
      ? undefined
      : lookupEvmToken(context.table, networkChainId(context.network), call.to);
  const contract =
    address === undefined
      ? {}
      : {
          contract: {
            address,
            created: call.to === undefined,
            ...(call.to === undefined ? {} : { selector: call.data.slice(0, 10).toLowerCase() }),
            ...(token === undefined ? {} : { symbol: token.symbol }),
          },
        };
  if (call.to !== undefined && call.to.toLowerCase() === context.self.toLowerCase()) {
    // Calldata to the signing account runs the account's own (possibly delegated) code — even a
    // selector the standard table would recognise means nothing certain there.
    return {
      family: "evm",
      network: context.network,
      summary: "contract-call",
      outflows: call.value > 0n ? nativeOutflow(call.value, call.to ?? "") : [],
      approvals: [],
      fee: context.fee,
      warnings: [],
      verifiability: "opaque",
      blind: "account-code",
      ...contract,
    };
  }
  const protocol = protocolIntent(call, context);
  if (protocol !== undefined) {
    return { ...protocol, ...contract };
  }
  const standard = standardIntent(call, context);
  const nearMiss =
    standard.verifiability === "opaque" && call.to !== undefined
      ? callNearMiss(call.to, networkChainId(context.network), context.table)
      : undefined;
  return {
    ...standard,
    ...contract,
    ...(nearMiss === undefined ? {} : { blind: nearMiss }),
    outflows:
      call.value > 0n && address !== undefined
        ? [...nativeOutflow(call.value, address), ...standard.outflows]
        : standard.outflows,
  };
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

/** The address a contract creation from `signer` at `nonce` deploys to (CREATE). */
const createdAddress = (signer: string, nonce: number): string => {
  assertHex(signer, "signer");
  return checksumEvmAddress(ContractAddress.fromCreate({ from: signer, nonce: BigInt(nonce) }));
};

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
  const context = { network: request.network, table, signer, self: signer };
  if (calls !== undefined && calls.length > 0) {
    const decoded = calls.map((call) => decodeCall(call, { ...context, fee: undefined }));
    const minimumReceived = decoded.flatMap((d) => d.minimumReceived ?? []);
    const staking = decoded.flatMap((d) => d.staking ?? []);
    const blind = decoded.find((call) => call.blind !== undefined)?.blind;
    return {
      family: "evm",
      network: request.network,
      warnings: [],
      fee,
      summary: "batch",
      calls: decoded,
      outflows: decoded.flatMap((d) => d.outflows),
      approvals: decoded.flatMap((d) => d.approvals),
      ...(staking.length === 0 ? {} : { staking }),
      ...(minimumReceived.length === 0 ? {} : { minimumReceived }),
      verifiability: weakest(decoded),
      ...(blind === undefined ? {} : { blind }),
      ...(delegation === undefined ? {} : { delegation }),
    };
  }
  const intent = decodeCall(
    {
      to: tx.to,
      ...(tx.to === undefined ? { created: createdAddress(signer, tx.nonce) } : {}),
      value: quantityBigInt(tx.value, "tx.value"),
      data: tx.data,
    },
    { ...context, fee },
  );
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

/**
 * The blind reason for a typed-data request, if any. Shown content is never truncated — an order
 * with more items than the prompt lists, or a document over the leaf budget, would silently
 * authorise what it hides, so it blinds the request instead. `unclaimed` is the blind the caller
 * computed for a document no recognised family decoded.
 */
const typedDataBlind = (
  safe: SafeRecognition | undefined,
  seaport: SeaportOrder | undefined,
  app: AppRecognition | undefined,
  unclaimed: BlindReason | undefined,
): BlindReason | undefined => {
  if (safe !== undefined) {
    return (
      safe.safe.calls.find((call) => call.blind !== undefined)?.blind ??
      (safe.safe.refund === undefined ? undefined : "safe-refund-unbounded")
    );
  }
  if (seaport !== undefined) {
    return seaport.offer.length > ORDER_ITEMS || seaport.consideration.length > ORDER_ITEMS
      ? "typed-data-oversize"
      : undefined;
  }
  if (app !== undefined) {
    return app.blind;
  }
  return unclaimed;
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
    return withNativeAmountMeta(
      decodeTransaction(request, signer, table),
      request.network,
      EVM_NATIVE_ASSET,
      18,
    );
  }
  if (request.kind === "evm.personal-message") {
    const content = messageContent(request.message, "evm");
    const blind = messageBlindReason(content);
    return {
      family: "evm",
      network: request.network,
      summary: "message",
      outflows: [],
      approvals: [],
      fee: undefined,
      warnings: [],
      message: content,
      verifiability: "opaque",
      ...(blind === undefined ? {} : { blind }),
    };
  }
  if (request.kind !== "evm.typed-data") {
    throw new ChainError("unsupported", `unsupported sign request kind: ${request.kind}`);
  }
  const { json } = parseTypedData(request.typedData);
  assertNoExecutionGrant(json.domain, signer);
  const chainId = networkChainId(request.network);
  const permit = recognizePermit(json, chainId, table, signer);
  const seaport = permit === undefined ? recognizeSeaport(json, chainId, table) : undefined;
  const safe =
    permit === undefined && seaport === undefined
      ? recognizeSafe(json, { network: request.network, chainId, table }, (call, safeAddress) =>
          decodeCall(call, {
            network: request.network,
            fee: undefined,
            table,
            signer,
            self: safeAddress,
          }),
        )
      : undefined;
  const app =
    permit === undefined && seaport === undefined && safe === undefined
      ? recognizeApp(json, { network: request.network, chainId, table, signer }, (call, self) =>
          decodeCall(call, {
            network: request.network,
            fee: undefined,
            table,
            signer,
            self,
          }),
        )
      : undefined;
  const order =
    permit === undefined
      ? seaport === undefined && safe === undefined && app === undefined
        ? (recognizeCow(json, chainId, signer, table) ?? recognizeOneinch(json, chainId, table))
        : undefined
      : permit.order;
  const snapshot =
    permit === undefined &&
    seaport === undefined &&
    safe === undefined &&
    app === undefined &&
    order === undefined &&
    recognizeSnapshot(json);
  const unclaimed =
    permit === undefined &&
    seaport === undefined &&
    safe === undefined &&
    app === undefined &&
    order === undefined &&
    !snapshot;
  const nearMiss = unclaimed ? typedDataNearMiss(json, chainId, table) : undefined;
  /* A recognised vote shows its leaves like an unclaimed document — the family names `proposal`,
     so an encoded-bytes string there is no commitment. */
  const shown = unclaimed || snapshot ? typedDataFields(json) : undefined;
  const fields = shown?.fields;
  const unclaimedBlind =
    nearMiss ??
    (unclaimed || snapshot
      ? shown === undefined
        ? "typed-data-oversize"
        : unclaimed && shown.hasCommitment
          ? "typed-data-commitment"
          : undefined
      : undefined);
  const blind = permit?.blind ?? typedDataBlind(safe, seaport, app, unclaimedBlind);
  const message: MessageContent = {
    kind: "typed-data",
    primaryType: json.primaryType,
    domain: displayDomain(json.domain),
    data: json.message,
    ...(seaport === undefined ? {} : { seaport }),
    ...(order === undefined ? {} : { order }),
    ...(safe === undefined ? {} : { safe: safe.safe }),
    ...(app === undefined ? {} : app.content),
    ...(fields === undefined ? {} : { fields }),
    ...(permit?.fields === undefined ? {} : { fields: permit.fields }),
  };
  const summary =
    order !== undefined || seaport !== undefined
      ? "swap"
      : safe === undefined
        ? permit === undefined
          ? (app?.summary ?? "message")
          : "approve"
        : safe.multisend
          ? "batch"
          : (safe.safe.calls[0]?.summary ?? "contract-call");
  return withNativeAmountMeta(
    {
      family: "evm",
      network: request.network,
      summary,
      outflows: app?.outflows ?? [],
      approvals: permit?.approvals ?? app?.approvals ?? [],
      fee: undefined,
      warnings: permit?.warnings ?? app?.warnings ?? [],
      message,
      verifiability:
        app?.verifiability ?? (permit === undefined && order === undefined ? "opaque" : "partial"),
      ...(blind === undefined ? {} : { blind }),
    },
    request.network,
    EVM_NATIVE_ASSET,
    18,
  );
};
