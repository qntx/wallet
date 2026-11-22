/**
 * Polymarket order math and EIP-712 construction (design.md §订单数学) — pure bigint arithmetic in
 * 6-decimal integer units (pUSD and shares are both 6-decimal assets); no float ever touches an
 * amount. Directional rounding only: a BUY limit price rounds down to the tick, a SELL up, sizes
 * round down to two decimals, and a market order's bound-side amount rounds the way that can only
 * improve the user's implied price — the signed order is never worse than the user's limit
 * (invariant 6). Sources: docs trading/place-orders.md §Calculate the Order Amounts for the
 * precision table (verified against `@polymarket/clob-client-v2` `roundingConfig.ts`) and §Create
 * the Order Typed Data for the `TypedDataSign` envelope — byte-identical to
 * `exchangeOrderBuilderV2.ts`, whose `Order` field order is ctf-exchange-v2 `Structs.sol`
 * ORDER_TYPEHASH. Domain by book (research.md §3): `version:"v2"` → ExchangeV3 v"3"; otherwise the
 * V2 exchanges by `neg_risk`, v"2".
 */
import {
  concat,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  keccak256,
  numberToHex,
  toHex,
} from "viem";

import { formatDecimal, parseDecimal } from "../spi.ts";
import {
  CTF_EXCHANGE_NAME,
  CTF_EXCHANGE_V2,
  CTF_EXCHANGE_V3,
  EXCHANGE_CHAIN_ID,
  NEG_RISK_EXCHANGE_V2,
} from "./constants.ts";
import { PolymarketError } from "./errors.ts";
import type { PolymarketBook, PolymarketMarket } from "./markets.ts";

const SCALE = 1_000_000n;
const ONE = SCALE;
const SIZE_GRID = 10_000n; // two decimals of a 6-decimal unit
const MAX_SLIPPAGE_BPS = 5000;

/**
 * Tick → {price, size, amount} decimals + the tick in 6-decimal units (docs trading/place-orders.md
 * §Calculate the Order Amounts; clob-client-v2 `roundingConfig.ts`).
 */
const TICKS: Readonly<
  Record<string, { readonly price: number; readonly size: number; readonly amount: number }>
> = {
  "0.1": { price: 1, size: 2, amount: 3 },
  "0.01": { price: 2, size: 2, amount: 4 },
  "0.005": { price: 3, size: 2, amount: 5 },
  "0.0025": { price: 4, size: 2, amount: 6 },
  "0.001": { price: 3, size: 2, amount: 5 },
  "0.0001": { price: 4, size: 2, amount: 6 },
};

const tickOf = (tickSize: string): { readonly grid: bigint; readonly amount: number } => {
  const config = TICKS[tickSize];
  if (config === undefined) {
    throw new PolymarketError("invalid-input", `unsupported tick size ${tickSize}`);
  }
  const grid = toUnits(tickSize, "tick size");
  return { grid, amount: config.amount };
};

/** A decimal string in 6-decimal units — anything else or > 6 decimals is `invalid-input`. */
const toUnits = (text: string, what: string): bigint => {
  let decimal;
  try {
    decimal = parseDecimal(text);
  } catch {
    throw new PolymarketError("invalid-input", `${what} is not a decimal: ${text}`);
  }
  if (decimal.scale > 6 || decimal.units < 0n) {
    throw new PolymarketError("invalid-input", `${what} ${text} does not fit 6 decimals`);
  }
  return decimal.units * 10n ** BigInt(6 - decimal.scale);
};

const fromUnits = (units: bigint): string => formatDecimal({ units, scale: 6 });

const floorTo = (value: bigint, grid: bigint): bigint => value - (value % grid);
const ceilTo = (value: bigint, grid: bigint): bigint => {
  const rest = value % grid;
  return rest === 0n ? value : value + grid - rest;
};
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** `(a·b)/1e6` — exact or `invalid-input`; a product needing more decimals never rounds silently. */
const mulUnits = (a: bigint, b: bigint): bigint => {
  const product = a * b;
  if (product % SCALE !== 0n) {
    throw new PolymarketError(
      "invalid-input",
      "the order's amounts need more than 6 decimals to express",
    );
  }
  return product / SCALE;
};

export type PolymarketSide = "BUY" | "SELL";

export type PolymarketLimitParams = {
  readonly assetId: string;
  readonly side: PolymarketSide;
  readonly price: string;
  readonly size: string;
};

export type PolymarketMarketParams = {
  readonly assetId: string;
  readonly side: PolymarketSide;
  /** PUSD to spend (BUY) or shares to sell (SELL). */
  readonly amount: string;
  /** Worst-price headroom past the last touched book level — 0..5000. */
  readonly slippageBps: number;
  /** Fill-or-kill refuses insufficient depth; fill-and-kill takes what exists. */
  readonly orderType: "FOK" | "FAK";
};

/** Display-only market metadata — never signed (invariant 6: the V2 struct has no fee field). */
export type PolymarketQuoteFees = {
  readonly makerBaseFee?: number;
  readonly takerBaseFee?: number;
};

export type PolymarketQuote = {
  readonly kind: "limit" | "market";
  readonly assetId: string;
  readonly side: PolymarketSide;
  /** Limit: the tick-aligned price. Market: absent. */
  readonly price?: string;
  /** Limit: the size after rounding down to two decimals. */
  readonly size?: string;
  /** Market: the pUSD/shares amount the order carries — the fillable part when `partial`. */
  readonly amount?: string;
  /** The worst signed price — the limit price itself, or the slippage bound for a market order. */
  readonly bound: string;
  /** 6-decimal integer strings, as signed. */
  readonly makerAmount: string;
  readonly takerAmount: string;
  /** `makerAmount/takerAmount` for BUY, `takerAmount/makerAmount` for SELL — display only. */
  readonly impliedPrice: string;
  /** The pUSD notional of the order — display only. */
  readonly notional: string;
  readonly minOrderSize: string;
  /** Market FAK that cannot fill in full — the order carries the depth that exists. */
  readonly partial?: boolean;
  /** From the market object, unsigned. */
  readonly fees?: PolymarketQuoteFees;
};

const quoteFees = (market?: PolymarketMarket): { readonly fees?: PolymarketQuoteFees } =>
  market?.fees === undefined ? {} : { fees: market.fees };

/**
 * The signed `[maker, taker]` amounts for a limit order — `size·price` exactly in 6-decimal units
 * (BUY pays notional/demands shares, SELL swapped); a product needing more than 6 decimals refuses.
 * Exported for the exactness test — the public path reaches it only through `quoteLimit`.
 */
export const limitAmounts = (
  side: PolymarketSide,
  size: bigint,
  price: bigint,
): readonly [bigint, bigint] => {
  const notional = mulUnits(size, price);
  return side === "BUY" ? [notional, size] : [size, notional];
};

const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** `floor((a·b)/1e6)` for book-depth sums — an approximation is fine for coverage, never signed. */
const mulFloor = (a: bigint, b: bigint): bigint => (a * b) / SCALE;

/** A limit quote — the book supplies tick and minimum; the price rounds in the user's favour. */
export const quoteLimit = (
  params: PolymarketLimitParams,
  book: Pick<PolymarketBook, "tickSize" | "minOrderSize">,
  market?: PolymarketMarket,
): PolymarketQuote => {
  const tick = tickOf(book.tickSize);
  const aligned =
    params.side === "BUY"
      ? floorTo(toUnits(params.price, "price"), tick.grid)
      : ceilTo(toUnits(params.price, "price"), tick.grid);
  if (aligned < tick.grid || aligned > ONE - tick.grid) {
    throw new PolymarketError(
      "invalid-input",
      `price ${params.price} must stay within [${book.tickSize}, 1 − ${book.tickSize}]`,
    );
  }
  const size = floorTo(toUnits(params.size, "size"), SIZE_GRID);
  if (size <= 0n) {
    throw new PolymarketError("invalid-input", "size rounds to zero");
  }
  const minSize = toUnits(book.minOrderSize, "minimum order size");
  if (size < minSize) {
    throw new PolymarketError(
      "invalid-input",
      `size ${params.size} is below the market minimum ${book.minOrderSize}`,
    );
  }
  const [maker, taker] = limitAmounts(params.side, size, aligned);
  const notional = params.side === "BUY" ? maker : taker;
  return {
    kind: "limit",
    assetId: params.assetId,
    side: params.side,
    price: fromUnits(aligned),
    size: fromUnits(size),
    bound: fromUnits(aligned),
    makerAmount: maker.toString(10),
    takerAmount: taker.toString(10),
    impliedPrice: fromUnits(aligned),
    notional: fromUnits(notional),
    minOrderSize: book.minOrderSize,
    ...quoteFees(market),
  };
};

/**
 * A market quote — walks the book's asks (BUY, notional accumulation) or bids (SELL, share
 * accumulation) to the last level the amount touches, then applies the slippage bound: BUY
 * `ceilToTick(w·(1+s))` capped at `1−tick`, SELL `floorToTick(w·(1−s))` floored at `tick`. The
 * bound-side amount is `ceil` — a BUY demands at least `amount/P` shares and a SELL at least
 * `shares·P` pUSD, so the implied price can never be worse than `P`. (clob-client-v2 floors both —
 * a strictly better bound for us, inside one unit of the last amount decimal.)
 */
export const quoteMarket = (
  params: PolymarketMarketParams,
  book: PolymarketBook,
  market?: PolymarketMarket,
): PolymarketQuote => {
  if (
    !Number.isInteger(params.slippageBps) ||
    params.slippageBps < 0 ||
    params.slippageBps > MAX_SLIPPAGE_BPS
  ) {
    throw new PolymarketError("invalid-input", "slippageBps must be an integer in 0..5000");
  }
  const tick = tickOf(book.tickSize);
  const amount = floorTo(toUnits(params.amount, "amount"), SIZE_GRID);
  if (amount <= 0n) {
    throw new PolymarketError("invalid-input", "amount rounds to zero");
  }
  const minSize = toUnits(book.minOrderSize, "minimum order size");
  const buy = params.side === "BUY";

  /* Walk the book to the last level touched — BUY accumulates pUSD notional over asks, SELL
     share quantity over bids. */
  const levels = buy ? book.asks : book.bids;
  let worst = 0n;
  let fillable = 0n;
  let covered = false;
  for (const level of levels) {
    const price = toUnits(level.price, "book price");
    const size = toUnits(level.size, "book size");
    worst = price;
    fillable += buy ? mulFloor(size, price) : size;
    if (fillable >= amount) {
      covered = true;
      break;
    }
  }
  if (!covered && params.orderType === "FOK") {
    throw new PolymarketError("invalid-input", "insufficient liquidity for a fill-or-kill order");
  }
  if (worst === 0n) {
    throw new PolymarketError("invalid-input", "the book has no liquidity on this side");
  }
  /* FAK partial: the order carries the fillable amount, floored back to the size grid. */
  const carried = covered ? amount : floorTo(fillable, SIZE_GRID);
  if (carried <= 0n) {
    throw new PolymarketError("invalid-input", "insufficient liquidity");
  }

  const bound = buy
    ? minBig(
        ceilTo(ceilDiv(worst * (10_000n + BigInt(params.slippageBps)), 10_000n), tick.grid),
        ONE - tick.grid,
      )
    : maxBig(
        floorTo((worst * (10_000n - BigInt(params.slippageBps))) / 10_000n, tick.grid),
        tick.grid,
      );
  if (bound <= 0n || bound >= ONE) {
    throw new PolymarketError("invalid-input", "the slippage bound leaves no valid price");
  }

  /* `ceil` on the bound side: BUY demands shares ≥ amount/P, SELL demands pUSD ≥ shares·P —
     implied price never worse than P (design invariant 6). */
  const amountGrid = 10n ** BigInt(6 - tick.amount);
  const [maker, taker] = buy
    ? [carried, ceilDiv(carried * 10n ** BigInt(tick.amount), bound) * amountGrid]
    : [carried, ceilDiv(carried * bound * 10n ** BigInt(tick.amount), SCALE * SCALE) * amountGrid];
  const shares = buy ? taker : maker;
  if (shares < minSize) {
    throw new PolymarketError(
      "invalid-input",
      `the order is below the market minimum ${book.minOrderSize} shares`,
    );
  }
  const notional = buy ? maker : taker;
  const impliedUnits = buy ? (maker * SCALE) / taker : (taker * SCALE) / maker;
  return {
    kind: "market",
    assetId: params.assetId,
    side: params.side,
    amount: fromUnits(carried),
    bound: fromUnits(bound),
    makerAmount: maker.toString(10),
    takerAmount: taker.toString(10),
    impliedPrice: fromUnits(impliedUnits),
    notional: fromUnits(notional),
    minOrderSize: book.minOrderSize,
    ...(covered ? {} : { partial: true }),
    ...quoteFees(market),
  };
};

/* ------------------------------------------------------------------ wire --- */

/**
 * The exchange the order commits to — selected from the book's own version/negRisk, refetched for
 * every placement (docs trading/place-orders.md §Order Domain).
 */
export type PolymarketExchangeDomain = {
  readonly verifyingContract: `0x${string}`;
  readonly version: "2" | "3";
};

export const exchangeDomain = (
  book: Pick<PolymarketBook, "version" | "negRisk">,
): PolymarketExchangeDomain =>
  book.version === "v2"
    ? { verifyingContract: CTF_EXCHANGE_V3, version: "3" }
    : book.negRisk
      ? { verifyingContract: NEG_RISK_EXCHANGE_V2, version: "2" }
      : { verifyingContract: CTF_EXCHANGE_V2, version: "2" };

/**
 * The unsigned order — the V2 `Order` struct's fields as wire strings (ctf-exchange-v2
 * `Structs.sol`; `expiration` rides the wire unsigned — the kernel cannot bound it, so the order
 * description marks it unsigned and it is validated here instead).
 */
export type PolymarketOrderDraft = {
  /** Decimal string ≤ 2^53−1 — serialized as a JSON number on the wire. */
  readonly salt: string;
  readonly maker: `0x${string}`;
  readonly signer: `0x${string}`;
  readonly tokenId: string;
  readonly makerAmount: string;
  readonly takerAmount: string;
  /** 0 = BUY, 1 = SELL. */
  readonly side: 0 | 1;
  /** Deposit-wallet orders sign type 3 (ERC-1271 through TypedDataSign). */
  readonly signatureType: 3;
  /** Milliseconds since epoch, decimal string. */
  readonly timestamp: string;
  readonly metadata: `0x${string}`;
  readonly builder: `0x${string}`;
  /** Unix seconds, decimal string; `"0"` unless GTD. */
  readonly expiration: string;
};

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as const;

export const buildPolymarketOrder = (input: {
  readonly wallet: `0x${string}`;
  readonly assetId: string;
  readonly side: PolymarketSide;
  readonly makerAmount: string;
  readonly takerAmount: string;
  readonly salt: string;
  readonly timestampMs: number;
  readonly builderCode?: `0x${string}`;
  readonly expiration?: string;
}): PolymarketOrderDraft =>
  Object.freeze({
    salt: input.salt,
    maker: input.wallet,
    signer: input.wallet,
    tokenId: input.assetId,
    makerAmount: input.makerAmount,
    takerAmount: input.takerAmount,
    side: input.side === "BUY" ? 0 : 1,
    signatureType: 3,
    timestamp: Math.floor(input.timestampMs).toString(10),
    metadata: ZERO_BYTES32,
    builder: input.builderCode ?? ZERO_BYTES32,
    expiration: input.expiration ?? "0",
  });

/** `Order`'s EIP-712 field list — ctf-exchange-v2 `Structs.sol` ORDER_TYPEHASH, verbatim order. */
const ORDER_FIELDS = [
  { name: "salt", type: "uint256" },
  { name: "maker", type: "address" },
  { name: "signer", type: "address" },
  { name: "tokenId", type: "uint256" },
  { name: "makerAmount", type: "uint256" },
  { name: "takerAmount", type: "uint256" },
  { name: "side", type: "uint8" },
  { name: "signatureType", type: "uint8" },
  { name: "timestamp", type: "uint256" },
  { name: "metadata", type: "bytes32" },
  { name: "builder", type: "bytes32" },
] as const;

const EIP712_DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** `TypedDataSign` — the ERC-7739 envelope a deposit wallet's owner signs (phase-1 vectors). */
const TYPED_DATA_SIGN_FIELDS = [
  { name: "contents", type: "Order" },
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
] as const;

const orderMessage = (draft: PolymarketOrderDraft) => ({
  salt: draft.salt,
  maker: draft.maker,
  signer: draft.signer,
  tokenId: draft.tokenId,
  makerAmount: draft.makerAmount,
  takerAmount: draft.takerAmount,
  side: draft.side,
  signatureType: draft.signatureType,
  timestamp: draft.timestamp,
  metadata: draft.metadata,
  builder: draft.builder,
});

const domainOf = (domain: PolymarketExchangeDomain) => ({
  name: CTF_EXCHANGE_NAME,
  version: domain.version,
  chainId: EXCHANGE_CHAIN_ID,
  verifyingContract: domain.verifyingContract,
});

/** The `TypedDataSign` document the kernel signs — the phase-1 vector shape, `EIP712Domain` present. */
export const typedDataSignDocument = (
  draft: PolymarketOrderDraft,
  domain: PolymarketExchangeDomain,
): string =>
  JSON.stringify({
    types: {
      EIP712Domain: EIP712_DOMAIN_FIELDS,
      TypedDataSign: TYPED_DATA_SIGN_FIELDS,
      Order: ORDER_FIELDS,
    },
    primaryType: "TypedDataSign",
    domain: domainOf(domain),
    message: {
      contents: orderMessage(draft),
      name: "DepositWallet",
      version: "1",
      chainId: EXCHANGE_CHAIN_ID,
      verifyingContract: draft.signer,
      salt: ZERO_BYTES32,
    },
  });

/**
 * The order id — the EIP-712 hash of `Order` under the exchange domain (clob-client-v2
 * `buildOrderHash`; apiref get-order-by-id: "the order hash").
 */
export const polymarketOrderId = (
  draft: PolymarketOrderDraft,
  domain: PolymarketExchangeDomain,
): `0x${string}` =>
  hashTypedData({
    domain: domainOf(domain),
    types: { Order: ORDER_FIELDS },
    primaryType: "Order",
    message: {
      salt: BigInt(draft.salt),
      maker: getAddress(draft.maker),
      signer: getAddress(draft.signer),
      tokenId: BigInt(draft.tokenId),
      makerAmount: BigInt(draft.makerAmount),
      takerAmount: BigInt(draft.takerAmount),
      side: draft.side,
      signatureType: draft.signatureType,
      timestamp: BigInt(draft.timestamp),
      metadata: draft.metadata,
      builder: draft.builder,
    },
  });

/* The wire signature's 7739 trailer — exchangeOrderBuilderV2.ts `buildOrderSignature`, byte
   for byte: the domain separator of the exchange app, the Order struct hash, the type string's
   UTF-8 bytes, and its length as uint16BE. */
const ORDER_TYPE_STRING =
  "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)";
const ORDER_TYPE_HASH = keccak256(toHex(ORDER_TYPE_STRING));
const DOMAIN_TYPE_HASH = keccak256(
  toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);
const ORDER_TYPE_HEX = toHex(ORDER_TYPE_STRING);
/** The type string's byte length as uint16BE — 0x00ba for the Order type. */
const ORDER_TYPE_LENGTH = numberToHex(ORDER_TYPE_STRING.length, { size: 2 });

const appDomainSeparator = (domain: PolymarketExchangeDomain): `0x${string}` =>
  keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        DOMAIN_TYPE_HASH,
        keccak256(toHex(CTF_EXCHANGE_NAME)),
        keccak256(toHex(domain.version)),
        BigInt(EXCHANGE_CHAIN_ID),
        domain.verifyingContract,
      ],
    ),
  );

const contentsHash = (draft: PolymarketOrderDraft): `0x${string}` =>
  keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint8" },
        { type: "uint8" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        ORDER_TYPE_HASH,
        BigInt(draft.salt),
        draft.maker,
        draft.signer,
        BigInt(draft.tokenId),
        BigInt(draft.makerAmount),
        BigInt(draft.takerAmount),
        draft.side,
        draft.signatureType,
        BigInt(draft.timestamp),
        draft.metadata,
        draft.builder,
      ],
    ),
  );

/**
 * The wire signature: the owner's 65-byte `TypedDataSign` signature, then the 7739 trailer —
 * `appDomainSeparator ‖ contentsHash ‖ ORDER_TYPE utf-8 ‖ uint16BE(len)` — so the deposit wallet's
 * ERC-1271 `isValidSignature` can re-derive what the owner signed (docs §Create the Order Typed
 * Data; exchangeOrderBuilderV2.ts).
 */
export const wireSignature = (
  inner: Uint8Array,
  draft: PolymarketOrderDraft,
  domain: PolymarketExchangeDomain,
): `0x${string}` =>
  concat([
    toHex(inner),
    appDomainSeparator(domain),
    contentsHash(draft),
    ORDER_TYPE_HEX,
    ORDER_TYPE_LENGTH,
  ]);

export type PolymarketOrderType = "GTC" | "GTD" | "FOK" | "FAK";

/**
 * The exact `POST /order` body — serialized once, never reserialized after signing. Field set
 * matches clob-client-v2 `orderToJsonV2` (`taker` absent on V2 orders; `postOnly` always present so
 * the body parses equal to the oracle's output).
 */
export const orderBody = (
  draft: PolymarketOrderDraft,
  signature: `0x${string}`,
  owner: string,
  orderType: PolymarketOrderType,
  postOnly: boolean,
): string =>
  JSON.stringify({
    deferExec: false,
    order: {
      builder: draft.builder,
      expiration: draft.expiration,
      maker: draft.maker,
      makerAmount: draft.makerAmount,
      metadata: draft.metadata,
      salt: Number(draft.salt),
      side: draft.side === 0 ? "BUY" : "SELL",
      signature,
      signatureType: draft.signatureType,
      signer: draft.signer,
      takerAmount: draft.takerAmount,
      timestamp: draft.timestamp,
      tokenId: draft.tokenId,
    },
    orderType,
    owner,
    postOnly,
  });
