import { ChainError } from "@qntx/wallet-chains";
import { EVM_NATIVE_ASSET, ZEROX_CHAINS, networkChainId } from "@qntx/wallet-chains/evm";

import { gatewayFetch } from "../gateway/client.ts";
import type { GatewayConfig } from "../gateway/client.ts";
import { parseWith, swapQuote } from "../gateway/contract/index.ts";
import { ZEROX_NATIVE_TOKEN } from "../gateway/contract/quotes.ts";
import type { AccountRef } from "../transactions/route.ts";
import type { SwapQuote } from "./index.ts";

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
