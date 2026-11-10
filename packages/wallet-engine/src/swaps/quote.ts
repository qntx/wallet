import { base64 } from "@scure/base";

import { ChainError } from "@qntx/wallet-chains";
import { EVM_NATIVE_ASSET, ZEROX_CHAINS, networkChainId } from "@qntx/wallet-chains/evm";
import { WSOL_MINT, SOLANA_NATIVE_ASSET } from "@qntx/wallet-chains/solana";

import { gatewayFetch } from "../gateway/client.ts";
import type { GatewayConfig } from "../gateway/client.ts";
import { bridgeQuote, parseWith, swapQuote, swapQuoteSolana } from "../gateway/contract/index.ts";
import { SOLANA_MAINNET, ZEROX_NATIVE_TOKEN } from "../gateway/contract/quotes.ts";
import type { AccountRef } from "../transactions/route.ts";
import type { AcrossBridgeQuote, AcrossBridgeStatus } from "./bridge.ts";
import type { JupiterSwapQuote, SwapQuote } from "./index.ts";

/** `amount` less `bps` basis points, rounded down — the floor a provider's minimum may not go below. */
const lessBps = (amount: bigint, bps: number): bigint => (amount * BigInt(10_000 - bps)) / 10_000n;

const bound = (ok: boolean, what: string): void => {
  if (!ok) {
    throw new ChainError("invalid-request", `the quote ${what} does not match the request`);
  }
};

const toZeroXToken = (asset: string): string =>
  asset === EVM_NATIVE_ASSET ? ZEROX_NATIVE_TOKEN : asset;
const fromZeroXToken = (token: string): string =>
  token.toLowerCase() === ZEROX_NATIVE_TOKEN.toLowerCase() ||
  token === "0x0000000000000000000000000000000000000000"
    ? EVM_NATIVE_ASSET
    : token;

/**
 * Fetches a gateway 0x quote and maps it to the engine's `SwapQuote` (bigint amounts, engine asset
 * ids, `fetchedAt`). The returned quote is bound to the request — tokens, sell amount and a minimum
 * within slippage — and `evm-swap` still verifies the call on-chain before signing. `undefined`
 * when the gateway reports no liquidity.
 */
export const fetchSwapQuote = async (
  deps: {
    readonly fetch: typeof globalThis.fetch;
    readonly gateway: GatewayConfig | undefined;
    /** The account's on-chain address — the same lookup the transaction routes use. */
    readonly address: (account: AccountRef, network: string) => Promise<string>;
    readonly now: () => number;
  },
  params: {
    readonly account: AccountRef;
    readonly network: string;
    readonly sell: string;
    readonly buy: string;
    readonly amount: bigint;
    readonly slippageBps: number;
  },
): Promise<SwapQuote | undefined> => {
  const { account, network, sell, buy, amount, slippageBps } = params;
  if (deps.gateway === undefined) {
    throw new ChainError("unsupported", "no gateway is configured");
  }
  if (!ZEROX_CHAINS.has(networkChainId(network))) {
    throw new ChainError("unsupported", "the network does not support 0x swaps");
  }
  const taker = await deps.address(account, network);
  const url = new URL(`${deps.gateway.url.replace(/\/+$/, "")}${swapQuote.path}`);
  url.searchParams.set("network", network);
  url.searchParams.set("sellToken", toZeroXToken(sell));
  url.searchParams.set("buyToken", toZeroXToken(buy));
  url.searchParams.set("sellAmount", amount.toString(10));
  url.searchParams.set("taker", taker);
  url.searchParams.set("slippageBps", String(slippageBps));
  const res = await gatewayFetch(deps.fetch, deps.gateway)(url, {});
  if (!res.ok) {
    throw new Error(`the quote service returned ${res.status}`);
  }
  const body = parseWith(swapQuote.response, await res.json());
  if (body === undefined) {
    throw new Error("the quote service returned a malformed response");
  }
  if (!body.liquidity) {
    return undefined;
  }
  const sellAmount = BigInt(body.sellAmount);
  const buyAmount = BigInt(body.buyAmount);
  const minBuyAmount = BigInt(body.minBuyAmount);
  bound(fromZeroXToken(body.sellToken).toLowerCase() === sell.toLowerCase(), "sell token");
  bound(fromZeroXToken(body.buyToken).toLowerCase() === buy.toLowerCase(), "buy token");
  bound(sellAmount === amount, "sell amount");
  bound(minBuyAmount >= lessBps(buyAmount, slippageBps), "minimum");
  return {
    provider: "0x",
    network,
    taker,
    sell: fromZeroXToken(body.sellToken),
    buy: fromZeroXToken(body.buyToken),
    sellAmount,
    buyAmount,
    minBuyAmount,
    allowanceTarget: body.allowanceTarget ?? undefined,
    transaction: {
      to: body.transaction.to,
      data: body.transaction.data,
      value: BigInt(body.transaction.value),
      gas: body.transaction.gas === null ? undefined : BigInt(body.transaction.gas),
    },
    fees: {
      integrator:
        body.fees.integrator === null
          ? undefined
          : {
              token: body.fees.integrator.token,
              amount: BigInt(body.fees.integrator.amount),
            },
      zeroEx:
        body.fees.zeroEx === null
          ? undefined
          : { token: body.fees.zeroEx.token, amount: BigInt(body.fees.zeroEx.amount) },
    },
    blockNumber: BigInt(body.blockNumber),
    fetchedAt: deps.now(),
  };
};

const toMint = (asset: string): string => (asset === SOLANA_NATIVE_ASSET ? WSOL_MINT : asset);
const fromMint = (mint: string): string => (mint === WSOL_MINT ? SOLANA_NATIVE_ASSET : mint);

/**
 * Fetches a gateway Jupiter `/build` for a Solana exact-in sell and maps it to the engine's
 * `JupiterSwapQuote` (bigint amounts, `lamports` for wSOL). The returned quote is bound to the
 * request — mints, in-amount and a threshold within slippage — and `solana-swap` still verifies
 * everything on-chain before signing. `undefined` when the gateway reports no liquidity.
 */
export const fetchJupiterQuote = async (
  deps: {
    readonly fetch: typeof globalThis.fetch;
    readonly gateway: GatewayConfig | undefined;
    readonly address: (account: AccountRef, network: string) => Promise<string>;
    readonly now: () => number;
  },
  params: {
    readonly account: AccountRef;
    readonly network: string;
    readonly sell: string;
    readonly buy: string;
    readonly amount: bigint;
    readonly slippageBps: number;
  },
): Promise<JupiterSwapQuote | undefined> => {
  const { account, network, sell, buy, amount, slippageBps } = params;
  if (deps.gateway === undefined) {
    throw new ChainError("unsupported", "no gateway is configured");
  }
  if (network !== SOLANA_MAINNET) {
    throw new ChainError("unsupported", "the network does not support Jupiter swaps");
  }
  const taker = await deps.address(account, network);
  const url = new URL(`${deps.gateway.url.replace(/\/+$/, "")}${swapQuoteSolana.path}`);
  url.searchParams.set("network", network);
  url.searchParams.set("inputMint", toMint(sell));
  url.searchParams.set("outputMint", toMint(buy));
  url.searchParams.set("amount", amount.toString(10));
  url.searchParams.set("taker", taker);
  url.searchParams.set("slippageBps", String(slippageBps));
  const res = await gatewayFetch(deps.fetch, deps.gateway)(url, {});
  if (!res.ok) {
    throw new Error(`the quote service returned ${res.status}`);
  }
  const body = parseWith(swapQuoteSolana.response, await res.json());
  if (body === undefined) {
    throw new Error("the quote service returned a malformed response");
  }
  if (!body.liquidity) {
    return undefined;
  }
  const ix = (i: (typeof body.setup)[number]) => ({
    programId: i.programId,
    accounts: i.accounts.map((a) => ({
      address: a.address,
      signer: a.signer,
      writable: a.writable,
    })),
    data: base64.decode(i.data),
  });
  const inAmount = BigInt(body.inAmount);
  const outAmount = BigInt(body.outAmount);
  const threshold = BigInt(body.otherAmountThreshold);
  bound(fromMint(body.inputMint) === sell, "sell token");
  bound(fromMint(body.outputMint) === buy, "buy token");
  bound(inAmount === amount, "sell amount");
  bound(threshold >= lessBps(outAmount, slippageBps), "minimum");
  return {
    provider: "jupiter",
    network,
    taker,
    sell: fromMint(body.inputMint),
    buy: fromMint(body.outputMint),
    sellAmount: inAmount,
    buyAmount: outAmount,
    minBuyAmount: threshold,
    setup: body.setup.map(ix),
    swap: ix(body.swap),
    cleanup: body.cleanup === null ? undefined : ix(body.cleanup),
    lookupTables: [...body.lookupTables],
    fetchedAt: deps.now(),
  };
};

/** The deposit status Across reports for an origin transaction — display only. */
const ACROSS_STATUS_API = "https://app.across.to/api/deposit/status";

/** `eip155:<n>` → `<n>`; every other id is a client error since Across is EVM-only here. */
const chainIdOf = (network: string): string => {
  const id = /^eip155:([0-9]+)$/.exec(network)?.[1];
  if (id === undefined) {
    throw new ChainError("unsupported", "Across bridges only between eip155 networks");
  }
  return id;
};

/**
 * Fetches a gateway bridge quote and maps it to `AcrossBridgeQuote` (bigint amounts, `taker`,
 * `fetchedAt`). The returned quote is bound to the request — tokens, in-amount, destination network
 * and an output above the caller's relay-fee ceiling — and `evm-bridge` still rebuilds and verifies
 * everything on-chain. `undefined` when the gateway reports no liquidity.
 */
export const fetchBridgeQuote = async (
  deps: {
    readonly fetch: typeof globalThis.fetch;
    readonly gateway: GatewayConfig | undefined;
    readonly address: (account: AccountRef, network: string) => Promise<string>;
    readonly now: () => number;
  },
  params: {
    readonly account: AccountRef;
    readonly network: string;
    readonly destinationNetwork: string;
    readonly inputToken: string;
    readonly outputToken: string;
    readonly amount: bigint;
    /** Highest relay fee accepted, in basis points of the input amount. */
    readonly maxFeeBps: number;
  },
): Promise<AcrossBridgeQuote | undefined> => {
  const { account, network, destinationNetwork, inputToken, outputToken, amount, maxFeeBps } =
    params;
  if (!Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > 10_000) {
    throw new ChainError("invalid-request", "maxFeeBps must be an integer between 0 and 10000");
  }
  if (deps.gateway === undefined) {
    throw new ChainError("unsupported", "no gateway is configured");
  }
  const taker = await deps.address(account, network);
  const url = new URL(`${deps.gateway.url.replace(/\/+$/, "")}${bridgeQuote.path}`);
  url.searchParams.set("network", network);
  url.searchParams.set("destinationNetwork", destinationNetwork);
  url.searchParams.set("inputToken", inputToken);
  url.searchParams.set("outputToken", outputToken);
  url.searchParams.set("amount", amount.toString(10));
  url.searchParams.set("taker", taker);
  const res = await gatewayFetch(deps.fetch, deps.gateway)(url, {});
  if (!res.ok) {
    throw new ChainError("invalid-request", `bridge quote failed: ${res.status}`);
  }
  const body = parseWith(bridgeQuote.response, await res.json());
  if (body === undefined) {
    throw new ChainError("invalid-request", "the gateway returned a malformed bridge quote");
  }
  if (!body.liquidity) {
    return undefined;
  }
  const inputAmount = BigInt(body.inputAmount);
  const outputAmount = BigInt(body.outputAmount);
  bound(body.inputToken.toLowerCase() === inputToken.toLowerCase(), "input token");
  bound(body.outputToken.toLowerCase() === outputToken.toLowerCase(), "output token");
  bound(inputAmount === amount, "input amount");
  bound(body.destinationNetwork === destinationNetwork, "destination network");
  bound(outputAmount >= lessBps(inputAmount, maxFeeBps), "output amount");
  return {
    provider: "across",
    inputToken: body.inputToken,
    outputToken: body.outputToken,
    inputAmount,
    outputAmount,
    destinationNetwork: body.destinationNetwork,
    quoteTimestamp: body.quoteTimestamp,
    fillDeadline: body.fillDeadline,
    exclusiveRelayer: body.exclusiveRelayer,
    exclusivityParameter: body.exclusivityParameter,
    spokePool: body.spokePool,
    taker,
    fetchedAt: deps.now(),
  };
};

/**
 * Queries the Across deposit-status API for an origin-chain transaction — display only, never gates
 * signing. A `filled` fill carries `fillTxHash`; anything the API doesn't recognise is reported
 * `unknown` rather than guessed.
 */
export const fetchBridgeStatus = async (
  deps: { readonly fetch: typeof globalThis.fetch },
  params: { readonly network: string; readonly txHash: string },
): Promise<AcrossBridgeStatus> => {
  const url = new URL(ACROSS_STATUS_API);
  url.searchParams.set("originChainId", chainIdOf(params.network));
  url.searchParams.set("txHash", params.txHash);
  const res = await deps.fetch(url, {});
  if (!res.ok) {
    throw new ChainError("invalid-request", `bridge status failed: ${res.status}`);
  }
  const body: unknown = await res.json();
  const record = typeof body === "object" && body !== null ? body : {};
  const s = "status" in record && typeof record.status === "string" ? record.status : undefined;
  return {
    status:
      s === "filled" || s === "expired" || s === "refunded" || s === "failed"
        ? s
        : s === "pending"
          ? "pending"
          : "unknown",
    ...("fillTx" in record && typeof record.fillTx === "string"
      ? { fillTxHash: record.fillTx }
      : {}),
  };
};
