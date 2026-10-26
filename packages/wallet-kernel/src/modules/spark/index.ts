import { equalBytes } from "@noble/ciphers/utils.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { SparkCrypto } from "@qntx/spark/crypto";
import type { SparkOutflow, SparkSigner } from "@qntx/spark/signer";
import type {
  MethodName,
  SparkAccountRef,
  SparkApprovalSummary,
  SparkApproveIntent,
  SPARK_METHODS,
} from "@qntx/wallet/protocol";

import type { Handler, KernelContext, VaultHooks } from "../../commands/context.ts";
import { KernelError } from "../../errors.ts";
import { wipe } from "../../secret/secret.ts";
import { seedFromEntropy } from "../../seed/seed.ts";
import { openRecord, verifyFactor } from "../../vault/vault.ts";
/**
 * The spark module: the SparkSigner pool and every spark.* command. The module keeps no records —
 * signers are derived lazily per walletId/groupIndex/network from the wallet's entropy record and
 * live only while unlocked. The SparkCrypto backend is injected by the host (backends.spark) and
 * loaded on first use only, so a nostr-only session never touches wasm; a WasmPoisonedError drops
 * the instance and every signer built on it, and the next call reloads.
 */
import { loadSparkRuntime } from "./runtime.ts";
import type { SparkRuntime } from "./runtime.ts";

export type SparkModule = {
  readonly vault: VaultHooks;
  readonly handlers: { [M in keyof typeof SPARK_METHODS & MethodName]: Handler<M> };
};

const poolKey = (account: SparkAccountRef): string =>
  `${account.walletId}/${account.groupIndex}/${account.network}`;

/** Cross-realm error-name check: Spark error classes are not kernel classes. */
const approvalRequired = (): KernelError =>
  new KernelError("approval-required", "this outflow needs a matching approval");

const btcNet = (rt: SparkRuntime, network: SparkAccountRef["network"]) =>
  network === "mainnet" ? rt.NETWORK : { ...rt.TEST_NETWORK, bech32: "bcrt" };

/**
 * `addressToScript` accepts either network — an approval must bind the destination to the account's
 * own network, so decode under `network`'s parameters and reject other prefixes.
 */
const addressScriptFor = (
  rt: SparkRuntime,
  network: SparkAccountRef["network"],
  address: string,
): Uint8Array => {
  try {
    const net = rt.Address(btcNet(rt, network));
    const decoded = rt.OutScript.encode(net.decode(address));
    // `decode` accepts any prefix — re-encode under the account's network so a mainnet
    // `bc1…` string fails a regtest account and vice versa.
    if (net.encode(rt.OutScript.decode(decoded)).toLowerCase() !== address.toLowerCase()) {
      throw new KernelError("invalid-input", "address: wrong network");
    }
    return decoded;
  } catch (error) {
    if (error instanceof KernelError) {
      throw error;
    }
    throw new KernelError("invalid-input", "address: not a decodable Bitcoin address");
  }
};

function isNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

/** Approvals live as long as the unlock: 60 s each, max 8 live per account, gone on lock. */
const APPROVAL_TTL_MS = 60_000;
const APPROVAL_MAX_PER_ACCOUNT = 8;

type DecodedIntent = {
  readonly paymentHash?: Uint8Array;
  readonly invoiceAmountSats?: number;
  readonly addressScript?: Uint8Array;
};

type Approval = {
  readonly intent: SparkApproveIntent;
  readonly deadline: number;
  readonly decoded: DecodedIntent;
  readonly summary: SparkApprovalSummary;
  /** Consumed single-use approvals and cumulative budgets deduped by leaf public key. */
  spentLeaves: Map<string, number>;
};

/**
 * Kernel-decodes an approve intent into the returned summary plus the matching material.
 * `addressToScript` and `decodeBolt11` both reject malformed input — mapped to `invalid-input`.
 */
const decodeIntent = (
  rt: SparkRuntime,
  account: SparkAccountRef,
  intent: SparkApproveIntent,
): { summary: SparkApprovalSummary; decoded: DecodedIntent } => {
  let result: { summary: SparkApprovalSummary; decoded: DecodedIntent };
  switch (intent.kind) {
    case "transfer":
      result = {
        summary: {
          kind: "transfer",
          receivers: intent.receivers.map((receiver) => ({
            identityPublicKey: Uint8Array.from(receiver.identityPublicKey),
            amountSats: receiver.amountSats,
          })),
        },
        decoded: {},
      };
      break;
    case "lightning": {
      const invoice = rt.decodeBolt11(intent.invoice);
      if (invoice.amountMsat === undefined) {
        if (intent.amountSats === undefined) {
          throw new KernelError("invalid-input", "zero-amount invoice requires amountSats");
        }
        result = {
          summary: {
            kind: "lightning",
            paymentHash: Uint8Array.from(invoice.paymentHash),
            invoiceAmountSats: intent.amountSats,
            maxFeeSats: intent.maxFeeSats,
          },
          decoded: { paymentHash: invoice.paymentHash, invoiceAmountSats: intent.amountSats },
        };
      } else {
        if (intent.amountSats !== undefined) {
          throw new KernelError("invalid-input", "amount invoice must not carry amountSats");
        }
        const invoiceAmountSats = Math.ceil(Number(invoice.amountMsat) / 1000);
        result = {
          summary: {
            kind: "lightning",
            paymentHash: Uint8Array.from(invoice.paymentHash),
            invoiceAmountSats,
            maxFeeSats: intent.maxFeeSats,
          },
          decoded: { paymentHash: invoice.paymentHash, invoiceAmountSats },
        };
      }
      break;
    }
    case "exit":
      result = {
        summary: {
          kind: "exit",
          address: intent.address,
          amountSats: intent.amountSats,
          maxFeeSats: intent.maxFeeSats,
        },
        decoded: { addressScript: addressScriptFor(rt, account.network, intent.address) },
      };
      break;
    case "onchain":
      result = {
        summary: { kind: "onchain", address: intent.address, maxFeeSats: intent.maxFeeSats },
        decoded: { addressScript: addressScriptFor(rt, account.network, intent.address) },
      };
      break;
    case "token":
      result = {
        summary: {
          kind: "token",
          tokenIdentifier: Uint8Array.from(intent.tokenIdentifier),
          receivers: intent.receivers.map((receiver) => ({
            ownerPublicKey: Uint8Array.from(receiver.ownerPublicKey),
            amount: receiver.amount,
          })),
        },
        decoded: {},
      };
      break;
  }
  return result;
};

export function createSparkModule(): SparkModule {
  const signers = new Map<string, SparkSigner>();
  const approvals = new Map<string, Approval[]>();
  let backendPromise: Promise<SparkCrypto> | undefined;
  let runtimePromise: Promise<SparkRuntime> | undefined;

  /** The memoized runtime chunk; a failed load is not cached, so the next spark call retries. */
  const sparkRuntime = async (): Promise<SparkRuntime> => {
    runtimePromise ??= loadSparkRuntime().catch((error: unknown) => {
      runtimePromise = undefined;
      throw error instanceof KernelError
        ? error
        : new KernelError("unavailable", "spark runtime failed to load");
    });
    return runtimePromise;
  };

  const liveApprovals = (ctx: KernelContext, key: string): Approval[] => {
    const now = ctx.platform.elapsed();
    const live = (approvals.get(key) ?? []).filter((approval) => approval.deadline > now);
    if (live.length === 0) {
      approvals.delete(key);
    } else {
      approvals.set(key, live);
    }
    return live;
  };

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
    approvals.clear();
  };

  const disposeWallet = (walletId: string): void => {
    for (const [key, signer] of signers) {
      if (key.startsWith(`${walletId}/`)) {
        signer.dispose();
        signers.delete(key);
      }
    }
    for (const key of approvals.keys()) {
      if (key.startsWith(`${walletId}/`)) {
        approvals.delete(key);
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
    const rt = await sparkRuntime();
    try {
      // Upstream defaults: mainnet accounts start at 1, regtest at 0.
      accountKey = rt.sparkAccountKey(
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
      const signer = rt.createSparkSigner({
        crypto,
        accountKey,
        network: account.network,
        random: ctx.platform.random,
        authorize: async (outflow) => authorizeWithCtx(ctx, account, outflow),
      });
      signers.set(poolKey(account), signer);
      return signer;
    } catch (error) {
      throw mapError(error);
    } finally {
      wipe(accountKey);
    }
  };

  /**
   * The per-signer `authorize`: `swap` always passes; every other outflow needs a live approval
   * matching it exactly per the E1-b table — single-use kinds consume, lightning/exit spend a
   * cumulative budget deduped by leaf public key.
   */
  const authorizeWithCtx = async (
    ctx: KernelContext,
    account: SparkAccountRef,
    outflow: SparkOutflow,
  ): Promise<void> => {
    const rt = await sparkRuntime();
    if (outflow.kind === "swap") {
      return;
    }
    const key = poolKey(account);
    const live = liveApprovals(ctx, key);
    for (const approval of live) {
      const { intent } = approval;
      if (outflow.kind === "transfer" && intent.kind === "transfer") {
        const covered = outflow.receivers.every((receiver) =>
          intent.receivers.some(
            (wanted) =>
              equalBytes(wanted.identityPublicKey, receiver.identityPublicKey) &&
              receiver.amountSats <= wanted.amountSats,
          ),
        );
        if (covered) {
          live.splice(live.indexOf(approval), 1);
          return;
        }
        continue;
      }
      if (outflow.kind === "lightning" && intent.kind === "lightning") {
        const signer = signers.get(key);
        const { paymentHash } = approval.decoded;
        const budget = approval.decoded.invoiceAmountSats;
        if (signer === undefined || paymentHash === undefined || budget === undefined) {
          continue;
        }
        const expected = rt.lightningSendHtlcScript({
          paymentHash,
          sspIdentityPublicKey: rt.sparkNetworkConfig(account.network).ssp.identityPublicKey,
          // oxlint-disable-next-line eslint/no-await-in-loop -- candidates short-circuit in order
          identityPublicKey: await signer.identityPublicKey(),
        });
        if (!equalBytes(expected, outflow.htlcOutputScript)) {
          continue;
        }
        const fresh = outflow.leaves.filter(
          (leaf) => !approval.spentLeaves.has(bytesToHex(leaf.publicKey)),
        );
        const total =
          fresh.reduce((sum, leaf) => sum + leaf.amountSats, 0) +
          [...approval.spentLeaves.values()].reduce((sum, v) => sum + v, 0);
        if (total > budget + intent.maxFeeSats) {
          continue;
        }
        for (const leaf of fresh) {
          approval.spentLeaves.set(bytesToHex(leaf.publicKey), leaf.amountSats);
        }
        return;
      }
      if (outflow.kind === "exit" && intent.kind === "exit") {
        const { addressScript } = approval.decoded;
        if (addressScript === undefined) {
          continue;
        }
        const pays = outflow.exitOutputs.some(
          (output) =>
            equalBytes(output.script, addressScript) && output.amountSats >= intent.amountSats,
        );
        if (!pays) {
          continue;
        }
        const fresh = outflow.leaves.filter(
          (leaf) => !approval.spentLeaves.has(bytesToHex(leaf.publicKey)),
        );
        const total =
          fresh.reduce((sum, leaf) => sum + leaf.amountSats, 0) +
          [...approval.spentLeaves.values()].reduce((sum, v) => sum + v, 0);
        if (total > intent.amountSats + intent.maxFeeSats) {
          continue;
        }
        for (const leaf of fresh) {
          approval.spentLeaves.set(bytesToHex(leaf.publicKey), leaf.amountSats);
        }
        return;
      }
      if (outflow.kind === "onchain" && intent.kind === "onchain") {
        const { addressScript } = approval.decoded;
        if (addressScript === undefined) {
          continue;
        }
        const every = outflow.outputs.every(
          (output) =>
            equalBytes(output.script, rt.EPHEMERAL_ANCHOR_SCRIPT) ||
            equalBytes(output.script, addressScript),
        );
        if (!every) {
          continue;
        }
        const fee = outflow.inputSats - outflow.totalSats;
        if (fee > intent.maxFeeSats) {
          continue;
        }
        live.splice(live.indexOf(approval), 1);
        return;
      }
      if (outflow.kind === "token" && intent.kind === "token") {
        const signer = signers.get(key);
        if (signer === undefined) {
          continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- candidates short-circuit in order
        const identity = await signer.identityPublicKey();
        const covered = outflow.outputs.every((output) => {
          if (equalBytes(output.ownerPublicKey, identity)) {
            return true;
          }
          if (!equalBytes(output.tokenIdentifier, intent.tokenIdentifier)) {
            return false;
          }
          return intent.receivers.some(
            (wanted) =>
              equalBytes(wanted.ownerPublicKey, output.ownerPublicKey) &&
              output.amount <= BigInt(wanted.amount),
          );
        });
        if (!covered) {
          continue;
        }
        live.splice(live.indexOf(approval), 1);
        return;
      }
    }
    throw approvalRequired();
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
    "spark.approve": async (ctx, params, session) => {
      const { dek } = ctx.session.require(session);
      const record = ctx.image.records.find(
        (entry) => entry.kind === "entropy" && entry.id === params.account.walletId,
      );
      if (record === undefined) {
        throw new KernelError("not-found", "no such wallet");
      }
      // The factor gates registration — a wrong verify registers nothing.
      await verifyFactor(ctx.platform, ctx.image, params.verify, dek);
      const key = poolKey(params.account);
      const live = liveApprovals(ctx, key);
      if (live.length >= APPROVAL_MAX_PER_ACCOUNT) {
        throw new KernelError("invalid-input", "approval cap reached for this account");
      }
      const { summary, decoded } = decodeIntent(
        await sparkRuntime(),
        params.account,
        params.intent,
      );
      live.push({
        intent: params.intent,
        deadline: ctx.platform.elapsed() + APPROVAL_TTL_MS,
        decoded,
        summary,
        spentLeaves: new Map(),
      });
      approvals.set(key, live);
      return summary;
    },
  };

  return { vault, handlers };
}
