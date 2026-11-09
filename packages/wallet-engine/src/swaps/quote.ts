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

const toZeroXToken = (asset: string): string =>
  asset === EVM_NATIVE_ASSET ? ZEROX_NATIVE_TOKEN : asset;
const fromZeroXToken = (token: string): string =>
  token.toLowerCase() === ZEROX_NATIVE_TOKEN.toLowerCase() ||
  token === "0x0000000000000000000000000000000000000000"
    ? EVM_NATIVE_ASSET
    : token;

/**
 * Fetches a gateway 0x quote and maps it to the engine's `SwapQuote` (bigint amounts, engine asset
 * ids, `fetchedAt`). Display-only — `evm-swap` verifies everything on-chain before signing.
 * `undefined` when the gateway reports no liquidity.
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
  return {
    provider: "0x",
    network,
    taker,
    sell: fromZeroXToken(body.sellToken),
    buy: fromZeroXToken(body.buyToken),
    sellAmount: BigInt(body.sellAmount),
    buyAmount: BigInt(body.buyAmount),
    minBuyAmount: BigInt(body.minBuyAmount),
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
 * `JupiterSwapQuote` (bigint amounts, `lamports` for wSOL). Display-only — `solana-swap` verifies
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
  return {
    provider: "jupiter",
    network,
    taker,
    sell: fromMint(body.inputMint),
    buy: fromMint(body.outputMint),
    sellAmount: BigInt(body.inAmount),
    buyAmount: BigInt(body.outAmount),
    minBuyAmount: BigInt(body.otherAmountThreshold),
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
 * `fetchedAt`). Display-only — `evm-bridge` rebuilds and verifies everything on-chain. `undefined`
 * when the gateway reports no liquidity.
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
  },
): Promise<AcrossBridgeQuote | undefined> => {
  const { account, network, destinationNetwork, inputToken, outputToken, amount } = params;
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
  return {
    provider: "across",
    inputToken: body.inputToken,
    outputToken: body.outputToken,
    inputAmount: BigInt(body.inputAmount),
    outputAmount: BigInt(body.outputAmount),
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
