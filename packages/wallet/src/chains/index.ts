/**
 * The chains module of @qntx/wallet: `chains(wallet)` returns the wallet's chain-account API.
 * `account` calls the kernel's `wallet.accounts` — the EVM/Solana arm returns the derived address,
 * the Bitcoin arm the account-level extended public key, master fingerprint and account path.
 */
import { internalsOf } from "../internal.ts";
import type { WalletInternals } from "../internal.ts";
import type { ChainAccount, ChainAccountsParams } from "../protocol/chains.ts";
import type { Wallet } from "../types.ts";

export type { ChainAccount, ChainAccountsParams, ChainTemplate } from "../protocol/chains.ts";

export type ChainsApi = {
  readonly account: (params: ChainAccountsParams) => Promise<ChainAccount>;
};

function createChainsApi(internals: WalletInternals): ChainsApi {
  return {
    account: async (params) => internals.call("wallet.accounts", params),
  };
}

const apis = new WeakMap<Wallet, ChainsApi>();

export function chains(wallet: Wallet): ChainsApi {
  const internals = internalsOf(wallet);
  let api = apis.get(wallet);
  if (api === undefined) {
    api = createChainsApi(internals);
    apis.set(wallet, api);
  }
  return api;
}
