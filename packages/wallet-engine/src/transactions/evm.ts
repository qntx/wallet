/** EVM route: native/ERC-20 send build → fee → decode → sign → broadcast, plus status poll. */
import { decodeEvm } from "@qntx/wallet-chains/evm";
import { chains } from "@qntx/wallet/chains";

import { EvmChainAdapter } from "../chains/evm.ts";
import {
  collectChecks,
  exceedsNetworkCap,
  feeReachesAmount,
  mergeEvmQuote,
} from "../requests/checks.ts";
import type { RequestCheckCode } from "../requests/checks.ts";
import { errorMessage, newId, replacementStaleReason } from "./route.ts";
import type {
  ChainApis,
  PrepareParams,
  PreparedRequest,
  RouteContext,
  SendParams,
  SignParams,
  SignResult,
  TrackedTransaction,
  TxState,
} from "./route.ts";

type PendingBuild = {
  readonly unsigned: Awaited<ReturnType<EvmChainAdapter["build"]>>;
  readonly request: SignParams["request"];
  readonly quote: { readonly tier: string };
  readonly chainId: number;
};

const bump = (v: bigint): bigint => (v * 11n + 9n) / 10n;

export type EvmRoute = {
  readonly prepare: (ctx: RouteContext, params: PrepareParams) => Promise<PreparedRequest>;
  readonly prepareCall: (
    ctx: RouteContext,
    request: {
      readonly account: PrepareParams["account"];
      readonly network: string;
      readonly tx: {
        readonly to?: string;
        readonly value: string;
        readonly data: string;
        readonly gas: string;
      };
    },
  ) => Promise<PreparedRequest>;
  readonly poll: (ctx: RouteContext, tx: TrackedTransaction) => Promise<TxState | undefined>;
  readonly prepareReplace: (
    ctx: RouteContext,
    old: TrackedTransaction,
    mode: "speed-up" | "cancel",
  ) => Promise<PreparedRequest>;
};

const signSubmit = async (
  ctx: RouteContext,
  tx: TrackedTransaction,
  apis: ChainApis,
  request: SignParams["request"],
  verify: SignParams["verify"],
  broadcast: (signed: SignResult) => Promise<string>,
): Promise<TrackedTransaction> => {
  let signed: SignResult;
  let tracked = tx;
  try {
    const result = await apis.sign({ request, verify });
    tracked = await ctx.transition(tracked, { state: "signed" });
    signed = result;
  } catch (error) {
    await ctx.transition(tracked, { state: "rejected", error: errorMessage(error) });
    throw error;
  }
  try {
    const hash = await broadcast(signed);
    tracked = await ctx.transition(tracked, {
      state: "submitted",
      hash,
      submittedAt: ctx.options.now(),
    });
    ctx.track(tracked.id, hash);
    return tracked;
  } catch (error) {
    await ctx.transition(tracked, { state: "failed", error: errorMessage(error) });
    throw error;
  }
};

/** Per-controller route — the adapter's nonce queue and the replace stash are engine state. */
export const createEvmRoute = (): EvmRoute => {
  const evm = new EvmChainAdapter();
  /** In-memory build context keyed by tx id — the inputs a replace rebuilds from. */
  const pending = new Map<string, PendingBuild>();

  type BuildIntent = Parameters<EvmChainAdapter["build"]>[3];
  type PrepareSpec = {
    readonly account: PrepareParams["account"];
    readonly network: string;
    readonly intent: BuildIntent;
    readonly fee: PrepareParams["fee"];
    /** Native value moved; the worst-case fee reaching it is flagged. */
    readonly nativeValue: bigint | undefined;
  };

  const prepareSpec = async (ctx: RouteContext, spec: PrepareSpec): Promise<PreparedRequest> => {
    const { account, network, fee } = spec;
    const { networks } = ctx.options;
    if (account.kind !== "hd") {
      throw new Error("imported accounts are not yet supported");
    }
    const info = networks.info(network);
    const client = networks.client(network);
    const independent = networks.independentClient(network);
    const apis = ctx.options.chains ?? chains(ctx.options.wallet);
    const evmAccount = await apis.account({
      walletId: account.walletId,
      groupIndex: account.groupIndex,
      template: "evm.bip44",
      network,
    });
    const from = "address" in evmAccount ? evmAccount.address : "";
    const flags: Array<RequestCheckCode | undefined> = [
      independent.kind === "unavailable" ? "reads-unverified" : undefined,
    ];

    let nonce = await evm.nextNonce(client, network, from);
    if (independent.kind === "available") {
      try {
        const [primary, other] = await Promise.all([
          evm.pendingCount(client, from),
          evm.pendingCount(independent.client, from),
        ]);
        nonce = Math.max(nonce, other);
        flags.push(primary === other ? undefined : "nonce-mismatch");
      } catch {
        flags.push("reads-unverified");
      }
    }
    const unsigned = await evm.build(client, network, from, spec.intent, nonce);
    const quotes = await evm.estimateFee(client);
    let quote = quotes.find((q) => q.tier === fee) ?? quotes[1];
    if (quote === undefined) {
      throw new Error("no fee quote");
    }
    if (independent.kind === "available") {
      try {
        const others = await evm.estimateFee(independent.client);
        const other = others.find((q) => q.tier === quote?.tier);
        if (other === undefined) {
          flags.push("reads-unverified");
        } else {
          const merged = mergeEvmQuote(quote, other);
          ({ quote } = merged);
          flags.push(
            merged.mismatch ? "fee-mismatch" : undefined,
            exceedsNetworkCap(quote.maxFeePerGas, other.maxFeePerGas)
              ? "fee-above-network"
              : undefined,
          );
        }
      } catch {
        flags.push("reads-unverified");
      }
    }
    const feed = evm.applyFee(unsigned, quote);
    if (
      spec.nativeValue !== undefined &&
      feeReachesAmount(feed.gas * (feed.maxFeePerGas ?? feed.gasPrice ?? 0n), spec.nativeValue)
    ) {
      flags.push("fee-exceeds-amount");
    }
    const request = evm.toSignRequest(feed, account, info.chainId);
    const intent = decodeEvm(request);
    const txId = newId(ctx.options.random);
    const chosen = quote;

    const submit = async (verify: SendParams["verify"]): Promise<TrackedTransaction> => {
      pending.set(txId, { unsigned: feed, request, quote: chosen, chainId: info.chainId });
      let tx: TrackedTransaction = {
        id: txId,
        family: "evm",
        network,
        account: account.walletId,
        hash: undefined,
        state: "draft",
        intent,
        nonce: unsigned.nonce,
        submittedAt: ctx.options.now(),
        error: undefined,
      };
      tx = await ctx.transition(tx, {});
      return signSubmit(ctx, tx, apis, request, verify, async (signed) => {
        const raw = evm.finalize(feed, signed);
        const hash = await evm.broadcast(client, raw);
        evm.commitNonce(network, from, unsigned.nonce);
        return hash;
      });
    };

    return {
      txId,
      account,
      network,
      intent,
      checks: collectChecks(flags),
      staleReason: () =>
        evm.nonceConsumed(network, from, unsigned.nonce)
          ? "nonce already used by a newer transaction — start over"
          : undefined,
      submit,
      release: () => undefined,
    };
  };

  const prepare = async (ctx: RouteContext, params: PrepareParams): Promise<PreparedRequest> =>
    prepareSpec(ctx, {
      account: params.account,
      network: params.network,
      fee: params.fee,
      intent:
        params.token === undefined
          ? { kind: "native", to: params.to, value: params.amount }
          : { kind: "erc20", token: params.token, to: params.to, value: params.amount },
      nativeValue: params.token === undefined ? params.amount : undefined,
    });

  /**
   * A dApp transaction, already normalized: only `to`, `value` and `data` are kept; nonce and fees
   * are read again and the dApp's `gas` only raises the floor under our own estimate.
   */
  const prepareCall = async (
    ctx: RouteContext,
    request: {
      readonly account: PrepareParams["account"];
      readonly network: string;
      readonly tx: {
        readonly to?: string;
        readonly value: string;
        readonly data: string;
        readonly gas: string;
      };
    },
  ): Promise<PreparedRequest> => {
    const { tx } = request;
    if (tx.to === undefined) {
      throw new Error("contract creation is not supported");
    }
    const value = BigInt(tx.value);
    return prepareSpec(ctx, {
      account: request.account,
      network: request.network,
      fee: "normal",
      intent: { kind: "call", to: tx.to, value, data: tx.data, minGas: BigInt(tx.gas) },
      nativeValue: value > 0n ? value : undefined,
    });
  };

  /**
   * EVM speed-up/cancel — replaces a pending tx at the same nonce with a bumped fee (cancel = a
   * 0-value transfer to self). The fee is cross-checked and merged first, then the replacement
   * floor (+10% on both fee fields, never below the merged estimate) is applied on top, so a low
   * quote can never push the replacement under the node's replacement rule. A rejected signature
   * never reaches the network and leaves the original.
   */
  const prepareReplace = async (
    ctx: RouteContext,
    old: TrackedTransaction,
    mode: "speed-up" | "cancel",
  ): Promise<PreparedRequest> => {
    const stash = pending.get(old.id);
    if (stash === undefined) {
      throw new Error("the original build context is gone — cannot replace after restart");
    }
    const { networks } = ctx.options;
    const client = networks.client(old.network);
    const independent = networks.independentClient(old.network);
    const apis = ctx.options.chains ?? chains(ctx.options.wallet);
    const { tier } = stash.quote;
    const estimates = await evm.estimateFee(client);
    let estimate = estimates.find((q) => q.tier === tier) ?? estimates[1];
    if (estimate === undefined) {
      throw new Error("no fee quote");
    }
    const flags: Array<RequestCheckCode | undefined> = [
      independent.kind === "unavailable" ? "reads-unverified" : undefined,
    ];
    let independentCap: bigint | undefined;
    if (independent.kind === "available") {
      try {
        const others = await evm.estimateFee(independent.client);
        const other = others.find((q) => q.tier === estimate?.tier);
        if (other === undefined) {
          flags.push("reads-unverified");
        } else {
          const merged = mergeEvmQuote(estimate, other);
          ({ quote: estimate } = merged);
          independentCap = other.maxFeePerGas;
          flags.push(merged.mismatch ? "fee-mismatch" : undefined);
        }
      } catch {
        flags.push("reads-unverified");
      }
    }
    const oldFee = stash.unsigned;
    const bumpedFee = bump(oldFee.maxFeePerGas ?? oldFee.gasPrice ?? 0n);
    const maxFeePerGas = bumpedFee > estimate.maxFeePerGas ? bumpedFee : estimate.maxFeePerGas;
    const priorityBump =
      oldFee.maxPriorityFeePerGas === undefined && estimate.maxPriorityFeePerGas === undefined
        ? undefined
        : bump(oldFee.maxPriorityFeePerGas ?? 0n) > (estimate.maxPriorityFeePerGas ?? 0n)
          ? bump(oldFee.maxPriorityFeePerGas ?? 0n)
          : (estimate.maxPriorityFeePerGas ?? 0n);
    const feeFields =
      priorityBump === undefined
        ? { maxFeePerGas }
        : { maxFeePerGas, maxPriorityFeePerGas: priorityBump };
    if (independentCap !== undefined) {
      flags.push(exceedsNetworkCap(maxFeePerGas, independentCap) ? "fee-above-network" : undefined);
    }
    const unsigned =
      mode === "cancel"
        ? {
            ...stash.unsigned,
            to: stash.unsigned.from,
            value: 0n,
            data: "0x" as const,
            gas: 21000n,
            ...feeFields,
          }
        : { ...stash.unsigned, ...feeFields };
    const request = evm.toSignRequest(unsigned, stash.request.account, stash.chainId);
    const intent = decodeEvm(request);
    const txId = newId(ctx.options.random);

    const submit = async (verify: SendParams["verify"]): Promise<TrackedTransaction> => {
      pending.set(txId, { unsigned, request, quote: stash.quote, chainId: stash.chainId });
      let tx: TrackedTransaction = {
        id: txId,
        family: "evm",
        network: old.network,
        account: old.account,
        hash: undefined,
        state: "draft",
        intent,
        nonce: old.nonce,
        replaces: old.id,
        submittedAt: ctx.options.now(),
        error: undefined,
      };
      tx = await ctx.transition(tx, {});
      return signSubmit(ctx, tx, apis, request, verify, async (signed) =>
        evm.broadcast(client, evm.finalize(unsigned, signed)),
      );
    };

    return {
      txId,
      account: stash.request.account,
      network: old.network,
      target: old.id,
      intent,
      checks: collectChecks(flags),
      staleReason: () => replacementStaleReason(ctx, old.id),
      submit,
      release: () => undefined,
    };
  };

  /** Returns the terminal state once the receipt lands, or `undefined` to keep polling. */
  const poll = async (ctx: RouteContext, tx: TrackedTransaction): Promise<TxState | undefined> => {
    if (tx.hash === undefined) {
      return "failed";
    }
    const state = await evm.status(ctx.options.networks.client(tx.network), tx.hash);
    if (state === "pending") {
      return undefined;
    }
    pending.delete(tx.id);
    return state === "finalized" ? "confirmed" : state;
  };

  return { prepare, prepareCall, poll, prepareReplace };
};
