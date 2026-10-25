/**
 * The proxy SparkSigner: every method is one spark.* request on the kernel channel carrying the
 * account ref. List-shaped calls chunk by MAX_BATCH sequentially and concatenate in order — the
 * wire caps a batch at 64 while the signer interface allows up to 256 — exactly like the nostr
 * proxy's unwrapGiftWraps. `dispose` is a no-op: signer lifetime belongs to the kernel, which wipes
 * signers on lock and on wallet deletion.
 */
import type { SparkSigner } from "@qntx/spark/signer";

import type { WalletInternals } from "../internal.ts";
import { MAX_BATCH } from "../protocol/core.ts";
import type { SparkAccountRef } from "../protocol/index.ts";
import {
  frostAggregateJob,
  frostSignJob,
  htlcTimeoutRequest,
  identityStatement,
  leafKey,
  prepareClaimRequest,
  prepareTransferRequest,
  signingTarget,
  sparkKey,
  staticDepositClaimRequest,
} from "./wire.ts";

export function proxySigner(account: SparkAccountRef, internals: WalletInternals): SparkSigner {
  return {
    identityPublicKey: async () => internals.call("spark.identityPublicKey", { account }),

    publicKeys: async (keys) => {
      const wire = keys.map(leafKey);
      const results: Uint8Array[] = [];
      for (let start = 0; start < wire.length; start += MAX_BATCH) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential on purpose: chunks round-trip in order
        const batch = await internals.call("spark.publicKeys", {
          account,
          keys: wire.slice(start, start + MAX_BATCH),
        });
        results.push(...batch);
      }
      return results;
    },

    receivedPublicKeys: async (ciphertexts) => {
      const results: Uint8Array[] = [];
      for (let start = 0; start < ciphertexts.length; start += MAX_BATCH) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential on purpose: chunks round-trip in order
        const batch = await internals.call("spark.receivedPublicKeys", {
          account,
          ciphertexts: ciphertexts.slice(start, start + MAX_BATCH),
        });
        results.push(...batch);
      }
      return results;
    },

    newCommitments: async (count) => {
      const results: Array<Awaited<ReturnType<SparkSigner["newCommitments"]>>[number]> = [];
      for (let remaining = count; remaining > 0; remaining -= MAX_BATCH) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential on purpose: chunks round-trip in order
        const batch = await internals.call("spark.newCommitments", {
          account,
          count: Math.min(MAX_BATCH, remaining),
        });
        results.push(...batch);
      }
      return results;
    },

    signFrost: async (jobs) => {
      const wire = jobs.map(frostSignJob);
      const results: Uint8Array[] = [];
      for (let start = 0; start < wire.length; start += MAX_BATCH) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential on purpose: chunks round-trip in order
        const batch = await internals.call("spark.signFrost", {
          account,
          jobs: wire.slice(start, start + MAX_BATCH),
        });
        results.push(...batch);
      }
      return results;
    },

    aggregateFrost: async (jobs) => {
      const wire = jobs.map(frostAggregateJob);
      const results: Uint8Array[] = [];
      for (let start = 0; start < wire.length; start += MAX_BATCH) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential on purpose: chunks round-trip in order
        const batch = await internals.call("spark.aggregateFrost", {
          account,
          jobs: wire.slice(start, start + MAX_BATCH),
        });
        results.push(...batch);
      }
      return results;
    },

    signIdentity: async (statement) =>
      internals.call("spark.signIdentity", { account, statement: identityStatement(statement) }),

    signKeySpend: async (key, target) =>
      internals.call("spark.signKeySpend", {
        account,
        key: sparkKey(key),
        target: signingTarget(target),
      }),

    signHtlcTimeout: async (request) =>
      internals.call("spark.signHtlcTimeout", { account, request: htlcTimeoutRequest(request) }),

    prepareTransfer: async (request) =>
      internals.call("spark.prepareTransfer", {
        account,
        request: prepareTransferRequest(request),
      }),

    prepareClaim: async (request) =>
      internals.call("spark.prepareClaim", { account, request: prepareClaimRequest(request) }),

    prepareLightningReceive: async () =>
      internals.call("spark.prepareLightningReceive", { account }),

    claimStaticDeposit: async (request) =>
      internals.call("spark.claimStaticDeposit", {
        account,
        request: staticDepositClaimRequest(request),
      }),

    dispose: () => undefined,
  };
}
