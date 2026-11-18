/**
 * What the engine already holds, as priceable holdings: the balances the AssetsController and the
 * SparkController hold in state, each with the CAIP-19 id the price route knows it by. Nothing here
 * reads a chain — valuation shows exactly the balances the host already displays.
 */
import type { SparkNetwork } from "@qntx/spark";

import type { AccountBalances } from "../assets/controller.ts";
import { nativeAssetId, tokenAssetId } from "../gateway/contract/index.ts";
import { networkById } from "../networks/registry.ts";
import type { SparkAccountState } from "../spark/controller.ts";

export type Holding = {
  /** The state key the balance came from: an assets-state key, or `spark:<spark account key>`. */
  readonly key: string;
  readonly network: string;
  /** CAIP-19 id — `undefined` on a network without prices (every testnet). */
  readonly asset: string | undefined;
  readonly symbol: string;
  readonly decimals: number;
  /** Base units. */
  readonly amount: bigint;
};

const BITCOIN_MAINNET = "bip122:000000000019d6689c085ae165831e93";
const BITCOIN_REGTEST = "bip122:0f9188f13cb7b2c71f2a335e3a4fc328";

/** The CAIP-2 network of an assets-state key (`<caip2>:<address>` or `<caip2>:<wallet>:<group>`). */
const keyNetwork = (key: string): string => key.split(":").slice(0, 2).join(":");

/**
 * One balance entry's holdings: the native coin, then every token. Bitcoin's native holding is
 * every sat the account owns — confirmed, its own unconfirmed change and the protected outputs (all
 * of a taproot account's coins are protected); a Solana token counts its frozen amount too.
 */
export function balanceHoldings(key: string, balances: AccountBalances): ReadonlyArray<Holding> {
  const network = keyNetwork(key);
  const meta = networkById(network);
  if (meta === undefined) {
    return [];
  }
  const native: Holding = {
    key,
    network,
    asset: nativeAssetId(network),
    symbol: meta.symbol,
    decimals: meta.decimals,
    amount:
      BigInt(balances.native) +
      BigInt(balances.unconfirmed ?? "0") +
      BigInt(balances.frozen ?? "0"),
  };
  return [
    native,
    ...balances.tokens.flatMap((token): Holding[] =>
      // A hidden token is display-only dead weight — no price is fetched and it has no value.
      token.hidden
        ? []
        : [
            {
              key,
              network,
              asset: tokenAssetId(network, token.address),
              symbol: token.symbol,
              decimals: token.decimals,
              amount: BigInt(token.balance) + BigInt(token.frozen ?? "0"),
            },
          ],
    ),
  ];
}

/** A Spark account's sats as Bitcoin, once its balance is known. */
export function sparkHolding(
  key: string,
  account: SparkAccountState,
  sparkNetwork: SparkNetwork,
): Holding | undefined {
  if (account.balanceSats === undefined) {
    return undefined;
  }
  const network = sparkNetwork === "mainnet" ? BITCOIN_MAINNET : BITCOIN_REGTEST;
  return {
    key: `spark:${key}`,
    network,
    asset: nativeAssetId(network),
    symbol: "BTC",
    decimals: 8,
    amount: BigInt(account.balanceSats),
  };
}

/** Every priceable asset held anywhere in state, each once, sorted. */
export function heldAssets(
  balances: Readonly<Record<string, AccountBalances>>,
  spark: Readonly<Record<string, SparkAccountState>>,
  sparkNetwork: SparkNetwork,
): ReadonlyArray<string> {
  const holdings = [
    ...Object.entries(balances).flatMap(([key, entry]) => balanceHoldings(key, entry)),
    ...Object.entries(spark).flatMap(
      ([key, account]) => sparkHolding(key, account, sparkNetwork) ?? [],
    ),
  ];
  return [...new Set(holdings.flatMap((h) => (h.asset === undefined ? [] : [h.asset])))].sort();
}

/**
 * One account group's holdings: the EVM and Solana entries of its `addresses`, its Bitcoin group
 * entry on each of `bitcoin`, and its Spark account — only the entries already in state.
 */
export function groupHoldings(input: {
  readonly balances: Readonly<Record<string, AccountBalances>>;
  readonly spark: Readonly<Record<string, SparkAccountState>>;
  readonly sparkNetwork: SparkNetwork;
  readonly group: { readonly walletId: string; readonly groupIndex: number };
  readonly addresses: ReadonlyArray<{ readonly network: string; readonly address: string }>;
  readonly bitcoin: ReadonlyArray<string>;
}): ReadonlyArray<Holding> {
  const { walletId, groupIndex } = input.group;
  const keys = [
    ...input.addresses.map(({ network, address }) => `${network}:${address}`),
    ...input.bitcoin.map((network) => `${network}:${walletId}:${groupIndex}`),
  ];
  const sparkKey = `${walletId}:${groupIndex}:${input.sparkNetwork}`;
  const sparkAccount = input.spark[sparkKey];
  const spark =
    sparkAccount === undefined
      ? undefined
      : sparkHolding(sparkKey, sparkAccount, input.sparkNetwork);
  return [
    ...keys.flatMap((key) => {
      const entry = input.balances[key];
      return entry === undefined ? [] : balanceHoldings(key, entry);
    }),
    ...(spark === undefined ? [] : [spark]),
  ];
}
