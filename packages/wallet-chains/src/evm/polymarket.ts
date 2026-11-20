/**
 * Recognition of Polymarket typed-data documents (docs https://docs.polymarket.com,
 * refs/clob-client-v2, on-chain checks in evidence/polygon-onchain.txt):
 *
 * - `Order` under the shared "Polymarket CTF Exchange" domain — a CLOB order on one of the
 *   allow-listed exchanges. EOA orders require maker == signer == the signing account; proxy and
 *   Safe orders (signatureType 1/2) bind maker to the signer by the exchange's CREATE2 check
 *   (ctf-exchange-v2 Signatures.sol `_verifyPolyProxySignature`/`_verifyPolySafeSignature`), so the
 *   signer binding alone is enough.
 * - `TypedDataSign` under the same domain — the ERC-7739 nested signature a deposit wallet's owner
 *   signs; the full order sits inside the signed struct and its signatureType is 3. The wallet's
 *   own ERC-1271 check only accepts its owner's signature, and the wallet's address cannot be
 *   derived from the account (two proxy generations derive differently — docs
 *   trading/wallets-auth.md), so there is no account binding beyond the wallet itself.
 * - `ClobAuth` — the L1 signature that derives CLOB API credentials (docs
 *   developers/CLOB/authentication.md); bound to the signing account.
 * - `Batch` under the "DepositWallet" domain — a gasless call batch the deposit wallet executes; its
 *   calls go through the same call decoder as a Safe's, with the wallet as `self`.
 *
 * Fees are set by the operator at match time and are not signed (ctf-exchange-v2 Trading.sol;
 * Polygon `maxFeeRateBps` is 0 — no on-chain cap), so every recognised Polymarket form is at most
 * `partial`. Anything this file does not describe stays blind through the family rows.
 */
import type {
  ApprovalChange,
  AssetFlow,
  BlindReason,
  DisplayIntent,
  IntentSummary,
  PolymarketContent,
  Verifiability,
} from "../index.ts";
import type { EvmTokenTable } from "./tokens.ts";
import {
  MAX_UINT48,
  domainChainId,
  isTypedDataMessage,
  sameFields,
  typedDataAddress,
  typedDataBytes,
  typedDataMessages,
  typedDataUint,
} from "./typed-data.ts";
import type { TypedDataInput, TypedDataMessage } from "./typed-data.ts";

const MAX_UINT256 = 2n ** 256n - 1n;
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

/** The recognition context a decodeEvm call provides. */
export type PolymarketContext = {
  readonly network: string;
  readonly chainId: number;
  readonly table: EvmTokenTable;
  /** The signing account, EIP-55. */
  readonly signer: string;
};

/** Injected call decoder: decode.ts's decodeCall with `self` bound to the executing wallet. */
export type PolymarketDecodeCall = (
  call: { readonly to: string; readonly value: bigint; readonly data: string },
  self: string,
) => DisplayIntent;

export type PolymarketRecognition = {
  readonly content: { readonly polymarket: PolymarketContent };
  readonly summary: IntentSummary;
  readonly outflows: ReadonlyArray<AssetFlow>;
  readonly approvals: ReadonlyArray<ApprovalChange>;
  readonly verifiability: Verifiability;
  readonly blind?: BlindReason;
};

/* Exchange allow-list: an order is recognised only when (verifyingContract, chainId, version)
   match one row exactly. Sources: docs resources/contracts.md; clob-client-v2 src/config.ts
   (contractConfig + CTF_EXCHANGE_V2/V3_DOMAIN_VERSION); outcome contracts from on-chain
   eip712Domain()/getCollateral()/getCtf() checked 2026-11-20 (evidence/polygon-onchain.txt).
   No Amoy ExchangeV3 row: its PositionManager is unverified there, so Amoy v3 orders stay blind. */
const EXCHANGES: ReadonlyArray<{
  readonly chainId: number;
  readonly address: string;
  readonly version: "2" | "3";
  readonly name: string;
  readonly outcomeToken: string;
}> = [
  {
    chainId: 137,
    address: "0xE111180000d2663C0091e4f400237545B87B996B",
    version: "2",
    name: "CTF Exchange",
    outcomeToken: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  },
  {
    chainId: 137,
    address: "0xe2222d279d744050d28e00520010520000310F59",
    version: "2",
    name: "Neg Risk CTF Exchange",
    outcomeToken: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  },
  {
    chainId: 137,
    address: "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa",
    version: "3",
    name: "Exchange V3",
    outcomeToken: "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF",
  },
  {
    chainId: 80002,
    address: "0xE111180000d2663C0091e4f400237545B87B996B",
    version: "2",
    name: "CTF Exchange",
    outcomeToken: "0x69308FB512518e39F9b16112fA8d994F4e2Bf8bB",
  },
  {
    chainId: 80002,
    address: "0xe2222d279d744050d28e00520010520000310F59",
    version: "2",
    name: "Neg Risk CTF Exchange",
    outcomeToken: "0x69308FB512518e39F9b16112fA8d994F4e2Bf8bB",
  },
];

/* Collateral on both chains (clob-client-v2 src/config.ts collateral; on-chain getCollateral()
   and symbol()/decimals(), evidence/polygon-onchain.txt). */
const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const DECIMALS = 6; // collateral and conditional tokens alike (config.ts)

/* Field lists, verbatim order — ctf-exchange-v2 Structs.sol ORDER_TYPEHASH and clob-client-v2
   model/ctfExchangeV2TypedData.ts CTF_EXCHANGE_V2_ORDER_STRUCT, exchangeOrderBuilderV2.ts
   TYPED_DATA_SIGN_STRUCT, signing/eip712.ts, docs trading/wallets-auth.md "Create the Batch
   Typed Data". */
const EIP712_DOMAIN = [
  "string name",
  "string version",
  "uint256 chainId",
  "address verifyingContract",
];
const EIP712_DOMAIN_AUTH = ["string name", "string version", "uint256 chainId"];
const ORDER_FIELDS = [
  "uint256 salt",
  "address maker",
  "address signer",
  "uint256 tokenId",
  "uint256 makerAmount",
  "uint256 takerAmount",
  "uint8 side",
  "uint8 signatureType",
  "uint256 timestamp",
  "bytes32 metadata",
  "bytes32 builder",
];
const TYPED_DATA_SIGN_FIELDS = [
  "Order contents",
  "string name",
  "string version",
  "uint256 chainId",
  "address verifyingContract",
  "bytes32 salt",
];
const CLOB_AUTH_FIELDS = ["address address", "string timestamp", "uint256 nonce", "string message"];
const BATCH_FIELDS = ["address wallet", "uint256 nonce", "uint256 deadline", "Call[] calls"];
const CALL_FIELDS = ["address target", "uint256 value", "bytes data"];

/* The fixed attestation text (clob-client-v2 signing/constants.ts MSG_TO_SIGN; docs
   developers/CLOB/authentication.md). */
const CLOB_AUTH_MESSAGE = "This message attests that I control the given wallet";
/* A deposit wallet runs at most this many calls per batch — the prompt must not truncate. */
const BATCH_CALLS_MAX = 8;

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const bytes32 = (value: unknown): string | undefined =>
  typeof value === "string" && BYTES32.test(value) ? value.toLowerCase() : undefined;

const nonZero = (hex: string): string | undefined => (hex === ZERO_BYTES32 ? undefined : hex);

const uint = (value: unknown): bigint | undefined => typedDataUint(value, MAX_UINT256);

const sameAddress = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

type OrderWallet = Extract<PolymarketContent, { kind: "order" }>["wallet"];

type OrderValues = {
  readonly maker: string;
  readonly signer: string;
  readonly tokenId: string;
  readonly side: "buy" | "sell";
  readonly signatureType: bigint;
  readonly makerAmount: bigint;
  readonly takerAmount: bigint;
  readonly metadata?: string;
  readonly builder?: string;
};

/** The strict parse both `Order` and `TypedDataSign.contents` share. */
const orderValues = (message: TypedDataMessage): OrderValues | undefined => {
  const maker = typedDataAddress(message["maker"]);
  const signer = typedDataAddress(message["signer"]);
  const tokenId = uint(message["tokenId"]);
  const makerAmount = uint(message["makerAmount"]);
  const takerAmount = uint(message["takerAmount"]);
  const side = uint(message["side"]);
  const signatureType = uint(message["signatureType"]);
  const metadata = bytes32(message["metadata"]);
  const builder = bytes32(message["builder"]);
  if (
    maker === undefined ||
    signer === undefined ||
    tokenId === undefined ||
    makerAmount === undefined ||
    makerAmount === 0n ||
    takerAmount === undefined ||
    takerAmount === 0n ||
    side === undefined ||
    side > 1n ||
    signatureType === undefined ||
    signatureType > 3n ||
    /* salt and timestamp sign but are not shown; they must still be well-formed uint256s. */
    uint(message["salt"]) === undefined ||
    uint(message["timestamp"]) === undefined ||
    metadata === undefined ||
    builder === undefined
  ) {
    return undefined;
  }
  const meta = nonZero(metadata);
  const code = nonZero(builder);
  return {
    maker,
    signer,
    tokenId: tokenId.toString(10),
    side: side === 0n ? "buy" : "sell",
    signatureType,
    makerAmount,
    takerAmount,
    ...(meta === undefined ? {} : { metadata: meta }),
    ...(code === undefined ? {} : { builder: code }),
  };
};

type Exchange = (typeof EXCHANGES)[number];

const orderContent = (
  order: OrderValues,
  exchange: Exchange,
  wallet: OrderWallet,
): Extract<PolymarketContent, { kind: "order" }> => {
  const buy = order.side === "buy";
  /* The order gives makerAmount of one asset and takes takerAmount of the other: pUSD for BUY,
     outcome shares for SELL. */
  const pusd = { asset: PUSD, decimals: DECIMALS, symbol: "pUSD" };
  const shares = {
    asset: exchange.outcomeToken,
    decimals: DECIMALS,
    tokenId: order.tokenId,
  };
  const give = buy
    ? { ...pusd, amount: order.makerAmount.toString(10) }
    : { ...shares, amount: order.makerAmount.toString(10) };
  const receive = buy
    ? { ...shares, amount: order.takerAmount.toString(10) }
    : { ...pusd, amount: order.takerAmount.toString(10) };
  const collateral = buy ? order.makerAmount : order.takerAmount;
  const amount = buy ? order.takerAmount : order.makerAmount;
  const price = (collateral * 10n ** BigInt(DECIMALS)) / amount;
  return {
    kind: "order",
    exchange: { address: exchange.address, name: exchange.name, version: exchange.version },
    side: order.side,
    tokenId: order.tokenId,
    maker: order.maker,
    signer: order.signer,
    wallet,
    give,
    receive,
    price: {
      amount: price.toString(10),
      exact: price * amount === collateral * 10n ** BigInt(DECIMALS),
    },
    ...(order.builder === undefined ? {} : { builder: order.builder }),
    ...(order.metadata === undefined ? {} : { metadata: order.metadata }),
  };
};

/** The "Polymarket CTF Exchange" domain against the exchange allow-list. */
const exchangeDomain = (json: TypedDataInput): Exchange | undefined => {
  const { domain, types } = json;
  const chainId = domainChainId(domain);
  if (
    domain["name"] !== "Polymarket CTF Exchange" ||
    chainId === undefined ||
    !sameFields(types, "EIP712Domain", EIP712_DOMAIN)
  ) {
    return undefined;
  }
  const verifying = typedDataAddress(domain["verifyingContract"]);
  return EXCHANGES.find(
    (row) =>
      row.chainId === chainId &&
      row.address.toLowerCase() === verifying?.toLowerCase() &&
      row.version === domain["version"],
  );
};

const typeSet = (types: TypedDataInput["types"], names: ReadonlyArray<string>): boolean =>
  Object.keys(types).length === names.length && names.every((name) => types[name] !== undefined);

const orderResult = (
  json: TypedDataInput,
  exchange: Exchange,
  context: PolymarketContext,
): PolymarketRecognition | undefined => {
  if (
    json.primaryType !== "Order" ||
    !typeSet(json.types, ["EIP712Domain", "Order"]) ||
    !sameFields(json.types, "Order", ORDER_FIELDS)
  ) {
    return undefined;
  }
  const order = orderValues(json.message);
  if (
    order === undefined ||
    /* signatureType 3 (ERC-1271) only appears inside the TypedDataSign envelope; a plain
       Order can be an EOA, proxy or Safe signature bound to the signing account. */
    order.signatureType > 2n ||
    !sameAddress(order.signer, context.signer) ||
    (order.signatureType === 0n && !sameAddress(order.maker, order.signer))
  ) {
    return undefined;
  }
  const wallet =
    order.signatureType === 0n ? "account" : order.signatureType === 1n ? "proxy" : "safe";
  const content = orderContent(order, exchange, wallet);
  return {
    content: { polymarket: content },
    summary: "swap",
    outflows: [
      {
        to: exchange.address,
        amount: content.give,
        verified: content.give.asset === PUSD,
      },
    ],
    approvals: [],
    verifiability: "partial",
  };
};

const typedDataSignResult = (
  json: TypedDataInput,
  exchange: Exchange,
): PolymarketRecognition | undefined => {
  if (
    json.primaryType !== "TypedDataSign" ||
    !typeSet(json.types, ["EIP712Domain", "TypedDataSign", "Order"]) ||
    !sameFields(json.types, "TypedDataSign", TYPED_DATA_SIGN_FIELDS) ||
    !sameFields(json.types, "Order", ORDER_FIELDS)
  ) {
    return undefined;
  }
  const { message } = json;
  const wallet = typedDataAddress(message["verifyingContract"]);
  const { contents } = message;
  if (
    message["name"] !== "DepositWallet" ||
    message["version"] !== "1" ||
    wallet === undefined ||
    message["salt"] !== ZERO_BYTES32 ||
    uint(message["chainId"]) !== BigInt(exchange.chainId) ||
    !isTypedDataMessage(contents)
  ) {
    return undefined;
  }
  const order = orderValues(contents);
  if (
    order === undefined ||
    order.signatureType !== 3n ||
    /* The wallet signs for itself: its 1271 check only accepts the owner's signature over an
       order whose signer and maker are the wallet (clob-client-v2 exchangeOrderBuilderV2.ts). */
    !sameAddress(order.signer, wallet) ||
    !sameAddress(order.maker, wallet)
  ) {
    return undefined;
  }
  const content = orderContent(order, exchange, "deposit-wallet");
  return {
    content: { polymarket: content },
    summary: "swap",
    outflows: [
      {
        to: exchange.address,
        amount: content.give,
        verified: content.give.asset === PUSD,
      },
    ],
    approvals: [],
    verifiability: "partial",
  };
};

const clobAuthResult = (
  json: TypedDataInput,
  context: PolymarketContext,
): PolymarketRecognition | undefined => {
  const { types, domain, message } = json;
  const chainId = domainChainId(domain);
  if (
    json.primaryType !== "ClobAuth" ||
    domain["name"] !== "ClobAuthDomain" ||
    domain["version"] !== "1" ||
    (chainId !== 137 && chainId !== 80002) ||
    !sameFields(types, "EIP712Domain", EIP712_DOMAIN_AUTH) ||
    !typeSet(types, ["EIP712Domain", "ClobAuth"]) ||
    !sameFields(types, "ClobAuth", CLOB_AUTH_FIELDS)
  ) {
    return undefined;
  }
  const address = typedDataAddress(message["address"]);
  const { timestamp } = message;
  const nonce = uint(message["nonce"]);
  if (
    address === undefined ||
    !sameAddress(address, context.signer) ||
    message["message"] !== CLOB_AUTH_MESSAGE ||
    typeof timestamp !== "string" ||
    !/^[0-9]{1,12}$/.test(timestamp) ||
    nonce === undefined
  ) {
    return undefined;
  }
  return {
    content: {
      polymarket: {
        kind: "auth",
        address,
        timestamp: Number(timestamp),
        nonce: nonce.toString(10),
      },
    },
    summary: "message",
    outflows: [],
    approvals: [],
    verifiability: "partial",
  };
};

const batchResult = (
  json: TypedDataInput,
  decodeCall: PolymarketDecodeCall,
): PolymarketRecognition | undefined => {
  const { types, domain, message } = json;
  const chainId = domainChainId(domain);
  const wallet = typedDataAddress(domain["verifyingContract"]);
  if (
    json.primaryType !== "Batch" ||
    domain["name"] !== "DepositWallet" ||
    domain["version"] !== "1" ||
    (chainId !== 137 && chainId !== 80002) ||
    wallet === undefined ||
    !sameFields(types, "EIP712Domain", EIP712_DOMAIN) ||
    !typeSet(types, ["EIP712Domain", "Batch", "Call"]) ||
    !sameFields(types, "Batch", BATCH_FIELDS) ||
    !sameFields(types, "Call", CALL_FIELDS) ||
    !sameAddress(typedDataAddress(message["wallet"]), wallet)
  ) {
    return undefined;
  }
  const nonce = uint(message["nonce"]);
  const deadline = typedDataUint(message["deadline"], MAX_UINT48);
  const calls = typedDataMessages(message["calls"]);
  if (nonce === undefined || deadline === undefined || calls === undefined || calls.length === 0) {
    return undefined;
  }
  const batch = (decoded: ReadonlyArray<DisplayIntent>, blind?: BlindReason) => ({
    content: {
      polymarket: {
        kind: "batch" as const,
        wallet,
        nonce: nonce.toString(10),
        deadline: Number(deadline),
        calls: decoded,
      },
    },
    summary: "batch" as const,
    outflows: decoded.flatMap((call) => call.outflows),
    approvals: decoded.flatMap((call) => call.approvals),
    /* An oversize batch decodes no call: nothing about it can be verified. */
    verifiability:
      decoded.length === 0 || decoded.some((call) => call.verifiability === "opaque")
      ? ("opaque" as const)
      : decoded.some((call) => call.verifiability === "partial")
        ? ("partial" as const)
        : ("full" as const),
    ...(blind === undefined ? {} : { blind }),
  });
  /* More calls than the prompt lists must not be silently truncated — blind instead. */
  if (calls.length > BATCH_CALLS_MAX) {
    return batch([], "typed-data-oversize");
  }
  const decoded: DisplayIntent[] = [];
  for (const call of calls) {
    const target = typedDataAddress(call["target"]);
    const value = uint(call["value"]);
    const data = typedDataBytes(call["data"]);
    if (target === undefined || value === undefined || data === undefined) {
      return undefined;
    }
    decoded.push(decodeCall({ to: target, value, data }, wallet));
  }
  return batch(decoded, decoded.find((call) => call.blind !== undefined)?.blind);
};

/**
 * The Polymarket request a typed-data document signs, or `undefined` when the document is not one
 * of the described shapes — the family rows then make it blind `typed-data-variant`.
 */
export function recognizePolymarket(
  json: TypedDataInput,
  context: PolymarketContext,
  decodeCall: PolymarketDecodeCall,
): PolymarketRecognition | undefined {
  if (json.primaryType === "ClobAuth") {
    return clobAuthResult(json, context);
  }
  if (json.primaryType === "Batch") {
    return batchResult(json, decodeCall);
  }
  const exchange = exchangeDomain(json);
  if (exchange === undefined) {
    return undefined;
  }
  return json.primaryType === "TypedDataSign"
    ? typedDataSignResult(json, exchange)
    : orderResult(json, exchange, context);
}
