import type { SparkCrypto } from "@qntx/spark/crypto";
/**
 * The spark module: the SparkSigner pool and every spark.* command. The module keeps no records —
 * signers are derived lazily per walletId/groupIndex/network from the wallet's entropy record and
 * live only while unlocked. The SparkCrypto backend is injected by the host (backends.spark) and
 * loaded on first use only, so a nostr-only session never touches wasm; a WasmPoisonedError drops
 * the instance and every signer built on it, and the next call reloads.
 */
import { createSparkSigner, sparkAccountKey } from "@qntx/spark/signer";
import type { SparkSigner } from "@qntx/spark/signer";
import type { MethodName, SparkAccountRef, SPARK_METHODS } from "@qntx/wallet/protocol";

import type { Handler, KernelContext, VaultHooks } from "../../commands/context.ts";
import { KernelError } from "../../errors.ts";
import { wipe } from "../../secret/secret.ts";
import { seedFromEntropy } from "../../seed/seed.ts";
import { openRecord } from "../../vault/vault.ts";

export type SparkModule = {
  readonly vault: VaultHooks;
  readonly handlers: { [M in keyof typeof SPARK_METHODS & MethodName]: Handler<M> };
};

const poolKey = (account: SparkAccountRef): string =>
  `${account.walletId}/${account.groupIndex}/${account.network}`;

/** Cross-realm error-name check: Spark error classes are not kernel classes. */
function isNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

export function createSparkModule(): SparkModule {
  const signers = new Map<string, SparkSigner>();
  let backendPromise: Promise<SparkCrypto> | undefined;

  /** The memoized backend promise; host KernelErrors (e.g. wasm integrity) pass through. */
  const backend = async (ctx: KernelContext): Promise<SparkCrypto> => {
    backendPromise ??= (async () => {
      try {
        return await ctx.platform.backends.spark();
      } catch (error) {
        backendPromise = undefined;
        throw error instanceof KernelError
          ? error
          : new KernelError("unavailable", "spark backend failed to load");
      }
    })();
    return backendPromise;
  };

  const disposeAll = (): void => {
    for (const signer of signers.values()) {
      signer.dispose();
    }
    signers.clear();
  };

  const disposeWallet = (walletId: string): void => {
    for (const [key, signer] of signers) {
      if (key.startsWith(`${walletId}/`)) {
        signer.dispose();
        signers.delete(key);
      }
    }
  };

  /**
   * The poisoned-backend path: the instance is dropped (the host promise is re-requested next call)
   * and every signer is disposed — nonce state held against a corrupted instance cannot be trusted.
   * The call itself reports `unavailable`.
   */
  const poison = (): KernelError => {
    backendPromise = undefined;
    disposeAll();
    return new KernelError("unavailable", "spark backend was disposed after a wasm fault");
  };

  /** Signer-call error mapping: never include request bytes in the message. */
  const mapError = (error: unknown): KernelError => {
    if (error instanceof KernelError) {
      return error;
    }
    if (isNamed(error, "WasmPoisonedError")) {
      return poison();
    }
    if (isNamed(error, "SparkInputError")) {
      return new KernelError("invalid-input", "spark signer rejected the request");
    }
    return new KernelError("integrity", "spark signer call failed");
  };

  /**
   * The pooled signer for an account, created on first use. The wallet's entropy record must still
   * exist — a deleted wallet's signers are disposed and the call reports `not-found`. Seed and
   * accountKey copies are wiped on every path; `openKeys` slices the account key into its own
   * buffers (verified), so the kernel's copy is safe to wipe once `createSparkSigner` returns.
   */
  const signerFor = async (
    ctx: KernelContext,
    account: SparkAccountRef,
    requestSession: string | undefined,
  ): Promise<SparkSigner> => {
    const { dek } = ctx.session.require(requestSession);
    const record = ctx.image.records.find(
      (entry) => entry.kind === "entropy" && entry.id === account.walletId,
    );
    if (record === undefined) {
      disposeWallet(account.walletId);
      throw new KernelError("not-found", "no such wallet");
    }
    const existing = signers.get(poolKey(account));
    if (existing !== undefined) {
      return existing;
    }
    const entropy = openRecord(dek, record);
    const seed = await seedFromEntropy(entropy, ctx.platform.pbkdf2);
    wipe(entropy);
    let accountKey: Uint8Array;
    try {
      // Upstream defaults: mainnet accounts start at 1, regtest at 0.
      accountKey = sparkAccountKey(
        seed,
        account.network,
        account.network === "mainnet" ? account.groupIndex + 1 : account.groupIndex,
      );
    } catch (error) {
      throw mapError(error);
    } finally {
      wipe(seed);
    }
    const crypto = await backend(ctx);
    try {
      const signer = createSparkSigner({
        crypto,
        accountKey,
        network: account.network,
        random: ctx.platform.random,
      });
      signers.set(poolKey(account), signer);
      return signer;
    } catch (error) {
      throw mapError(error);
    } finally {
      wipe(accountKey);
    }
  };

  const call = async <T>(
    ctx: KernelContext,
    account: SparkAccountRef,
    requestSession: string | undefined,
    run: (signer: SparkSigner) => Promise<T>,
  ): Promise<T> => {
    const signer = await signerFor(ctx, account, requestSession);
    try {
      return await run(signer);
    } catch (error) {
      throw mapError(error);
    }
  };

  const vault: VaultHooks = {
    ownsRecord: () => false,
    claimUnlocked: (records) => records,
    forget: () => undefined,
    lock: () => {
      disposeAll();
    },
    walletDeleteOps: (_image, walletId) => {
      // The entropy record's removal is committed by the core; the live signers die here. A later
      // call would catch the missing record anyway — this keeps no secret state past the delete.
      disposeWallet(walletId);
      return [];
    },
  };

  const handlers: { [M in keyof typeof SPARK_METHODS & MethodName]: Handler<M> } = {
    "spark.identityPublicKey": async (ctx, params, session) =>
      call(ctx, params.account, session, async (signer) => signer.identityPublicKey()),
    "spark.publicKeys": async (ctx, params, session) =>
      call(ctx, params.account, session, async (signer) => signer.publicKeys(params.keys)),
    "spark.receivedPublicKeys": async (ctx, params, session) =>
      call(ctx, params.account, session, async (signer) =>
        signer.receivedPublicKeys(params.ciphertexts),
      ),
    "spark.newCommitments": async (ctx, params, session) =>
      call(ctx, params.account, session, async (signer) => signer.newCommitments(params.count)),
    "spark.signFrost": async (ctx, params, session) =>
      call(ctx, params.account, session, async (signer) => signer.signFrost(params.jobs)),
    "spark.aggregateFrost": async (ctx, params, session) =>
      call(ctx, params.account, session, async (signer) => signer.aggregateFrost(params.jobs)),
    "spark.signIdentity": async (ctx, params, session) =>
      call(ctx, params.account, session, async (signer) => signer.signIdentity(params.statement)),
    "spark.signKeySpend": async (ctx, params, session) =>
      call(ctx, params.account, session, async (signer) =>
        signer.signKeySpend(params.key, params.target),
      ),
    "spark.signHtlcTimeout": async (ctx, params, session) =>
      call(ctx, params.account, session, async (signer) => signer.signHtlcTimeout(params.request)),
    "spark.prepareTransfer": async (ctx, params, session) =>
      call(ctx, params.account, session, async (signer) => signer.prepareTransfer(params.request)),
    "spark.prepareClaim": async (ctx, params, session) =>
      call(ctx, params.account, session, async (signer) => signer.prepareClaim(params.request)),
    "spark.prepareLightningReceive": async (ctx, params, session) =>
      call(ctx, params.account, session, async (signer) => signer.prepareLightningReceive()),
    "spark.claimStaticDeposit": async (ctx, params, session) =>
      call(ctx, params.account, session, async (signer) =>
        signer.claimStaticDeposit(params.request),
      ),
  };

  return { vault, handlers };
}
