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
  ChainExportNode,
  ChainExportResult,
  ChainSignRequest,
  ChainSignResult,
} from "../protocol/chains.ts";
import type { VerifyFactor, Wallet } from "../types.ts";
import { checkExportResult, checkSignResult } from "./check.ts";

export type {
  ChainAccount,
  ChainAccountsParams,
  ChainExportedKey,
  ChainExportNode,
  ChainExportParams,
  ChainExportResult,
  ChainSignRequest,
  ChainSignResult,
  ChainTemplate,
} from "../protocol/chains.ts";

export type ChainsApi = {
  readonly account: (params: ChainAccountsParams) => Promise<ChainAccount>;
  readonly sign: (params: {
    readonly request: ChainSignRequest;
    readonly verify: VerifyFactor;
    /* Sending to a key served by device material never confirmed on the device refuses with
       `approval-required` unless the host acknowledged the danger-row warning. */
    readonly acknowledgeUnconfirmed?: true;
  }) => Promise<ChainSignResult>;
  readonly exportAccount: (params: {
    readonly walletId: string;
    readonly groupIndex: number;
    readonly nodes: ReadonlyArray<ChainExportNode>;
    readonly verify: VerifyFactor;
    /* A node served by device material never confirmed on the device refuses with
       `approval-required` unless the host acknowledged the danger-row warning. */
    readonly acknowledgeUnconfirmed?: true;
  }) => Promise<ChainExportResult>;
};

function createChainsApi(internals: WalletInternals): ChainsApi {
  return {
    account: async (params) => internals.call("wallet.accounts", params),
    sign: async (params) =>
      internals.withVerifying(async () => {
        const result = await internals.secretCall("chain.sign", async (wire) => ({
          request: params.request,
          verify: await internals.resolveVerifyFactor(params.verify, wire),
          ...(params.acknowledgeUnconfirmed === undefined
            ? {}
            : { acknowledgeUnconfirmed: params.acknowledgeUnconfirmed }),
        }));
        await checkSignResult(internals, params.request, result);
        return result;
      }),
    exportAccount: async (params) =>
      internals.withVerifying(async () => {
        const result = await internals.secretCall("chain.exportAccount", async (wire) => ({
          walletId: params.walletId,
          groupIndex: params.groupIndex,
          nodes: params.nodes,
          verify: await internals.resolveVerifyFactor(params.verify, wire),
          ...(params.acknowledgeUnconfirmed === undefined
            ? {}
            : { acknowledgeUnconfirmed: params.acknowledgeUnconfirmed }),
        }));
        await checkExportResult(internals, params, result);
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
