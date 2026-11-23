/**
 * The chains module of @qntx/wallet: `chains(wallet)` returns the wallet's chain API. `account`
 * calls the kernel's `wallet.accounts`; `sign` calls `chain.sign` and then verifies the returned
 * signature against the request and the account address — a kernel that answers with someone else's
 * signature, or a signature over other content, fails closed with `integrity`.
 */
import { internalsOf } from "../internal.ts";
import type { WalletInternals } from "../internal.ts";
import type {
  ChainAccount,
  ChainAccountsParams,
  ChainSignRequest,
  ChainSignResult,
} from "../protocol/chains.ts";
import type { VerifyFactor, Wallet } from "../types.ts";
import { checkSignResult } from "./check.ts";

export type {
  ChainAccount,
  ChainAccountsParams,
  ChainSignRequest,
  ChainSignResult,
  ChainTemplate,
} from "../protocol/chains.ts";

export type ChainsApi = {
  readonly account: (params: ChainAccountsParams) => Promise<ChainAccount>;
  readonly sign: (params: {
    readonly request: ChainSignRequest;
    readonly verify: VerifyFactor;
  }) => Promise<ChainSignResult>;
};

function createChainsApi(internals: WalletInternals): ChainsApi {
  return {
    account: async (params) => internals.call("wallet.accounts", params),
    sign: async (params) =>
      internals.withVerifying(async () => {
        const result = await internals.secretCall("chain.sign", async (wire) => ({
          request: params.request,
          verify: await internals.resolveVerifyFactor(params.verify, wire),
        }));
        await checkSignResult(internals, params.request, result);
        return result;
      }),
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
