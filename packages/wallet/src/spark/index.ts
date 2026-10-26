/**
 * The spark module of @qntx/wallet: `spark(wallet)` returns the wallet's Spark API — proxy
 * SparkSigners backed by the enclave's signer pool. The API is memoized per wallet so repeated
 * calls return the same object (stable React identity); a foreign object is rejected because only a
 * Wallet from this package holds a registered channel.
 */
import { internalsOf } from "../internal.ts";
import type { WalletInternals } from "../internal.ts";
import type { Wallet } from "../types.ts";
import { proxySigner } from "./signer.ts";
import type { SparkApi } from "./types.ts";

export type { SparkAccountRef, SparkApi, SparkSigner } from "./types.ts";

function createSparkApi(internals: WalletInternals): SparkApi {
  return {
    signer: (ref) => proxySigner(ref, internals),
    approve: async (params) =>
      internals.withVerifying(async () => {
        const transfer: ArrayBuffer[] = [];
        const verify = await internals.resolveFactor(params.verify, transfer);
        return internals.call("spark.approve", { ...params, verify });
      }),
  };
}

const apis = new WeakMap<Wallet, SparkApi>();

export function spark(wallet: Wallet): SparkApi {
  const internals = internalsOf(wallet);
  let api = apis.get(wallet);
  if (api === undefined) {
    api = createSparkApi(internals);
    apis.set(wallet, api);
  }
  return api;
}
