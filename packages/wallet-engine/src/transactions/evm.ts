/** EVM route: native/ERC-20 send build → fee → decode → sign → broadcast, plus status poll. */
import { decodeEvm } from "@qntx/wallet-chains/evm";
import { chains } from "@qntx/wallet/chains";

import { EvmChainAdapter } from "../chains/evm.ts";
import { errorMessage, newId } from "./route.ts";
import type { RouteContext, SendParams, TrackedTransaction, TxState } from "./route.ts";

type PendingBuild = {
  readonly unsigned: Awaited<ReturnType<EvmChainAdapter["build"]>>;
  readonly request: Parameters<ReturnType<typeof chains>["sign"]>[0]["request"];
  readonly quote: { readonly tier: string };
  readonly chainId: number;
};

const bump = (v: bigint): bigint => (v * 11n + 9n) / 10n;

export type EvmRoute = {
  readonly send: (ctx: RouteContext, params: SendParams) => Promise<TrackedTransaction>;
  readonly poll: (ctx: RouteContext, tx: TrackedTransaction) => Promise<TxState | undefined>;
  readonly replace: (
    ctx: RouteContext,
    old: TrackedTransaction,
    mode: "speed-up" | "cancel",
    verify: SendParams["verify"],
  ) => Promise<TrackedTransaction>;
};

/** Per-controller route — the adapter's nonce queue and the replace stash are engine state. */
export const createEvmRoute = (): EvmRoute => {
  const evm = new EvmChainAdapter();
  /** In-memory build context keyed by tx id — the inputs a replace rebuilds from. */
  const pending = new Map<string, PendingBuild>();

  const send = async (ctx: RouteContext, params: SendParams): Promise<TrackedTransaction> => {
    const { account, network, to, amount, fee, verify } = params;
    const { networks } = ctx.options;
    if (account.kind !== "hd") {
      throw new Error("imported accounts are not yet supported");
    }
    const info = networks.info(network);
    const client = networks.client(network);
    const apis = ctx.options.chains ?? chains(ctx.options.wallet);
    const evmAccount = await apis.account({
      walletId: account.walletId,
      groupIndex: account.groupIndex,
      template: "evm.bip44",
      network,
    });
    const from = "address" in evmAccount ? evmAccount.address : "";
    const unsigned = await evm.build(
      client,
      network,
      from,
      params.token === undefined
        ? { kind: "native", to, value: amount }
        : { kind: "erc20", token: params.token, to, value: amount },
    );
    const quotes = await evm.estimateFee(client);
    const quote = quotes.find((q) => q.tier === fee) ?? quotes[1];
    if (quote === undefined) {
      throw new Error("no fee quote");
    }
    const feed = evm.applyFee(unsigned, quote);
    const request = evm.toSignRequest(feed, account, info.chainId);
    const intent = decodeEvm(request);
    const id = newId(ctx.options.random);
    pending.set(id, { unsigned: feed, request, quote, chainId: info.chainId });
    let tx: TrackedTransaction = {
      id,
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
    let signed: Awaited<ReturnType<ReturnType<typeof chains>["sign"]>>;
    try {
      const result = await apis.sign({ request, verify });
      tx = await ctx.transition(tx, { state: "signed" });
      signed = result;
    } catch (error) {
      await ctx.transition(tx, { state: "rejected", error: errorMessage(error) });
      throw error;
    }
    try {
      const raw = evm.finalize(feed, signed);
      const hash = await evm.broadcast(client, raw);
      tx = await ctx.transition(tx, {
        state: "submitted",
        hash,
        submittedAt: ctx.options.now(),
      });
      ctx.track(tx.id, hash);
      return tx;
    } catch (error) {
      await ctx.transition(tx, { state: "failed", error: errorMessage(error) });
      throw error;
    }
  };

  /**
   * EVM speed-up/cancel — replaces a pending tx at the same nonce with a bumped fee (cancel = a
   * 0-value transfer to self). The new tx carries `replaces` and needs a fresh signature; a
   * rejected one never reaches the network and leaves the original.
   */
  const replace = async (
    ctx: RouteContext,
    old: TrackedTransaction,
    mode: "speed-up" | "cancel",
    verify: SendParams["verify"],
  ): Promise<TrackedTransaction> => {
    const stash = pending.get(old.id);
    if (stash === undefined) {
      throw new Error("the original build context is gone — cannot replace after restart");
    }
    const { networks } = ctx.options;
    const client = networks.client(old.network);
    const apis = ctx.options.chains ?? chains(ctx.options.wallet);
    const { tier } = stash.quote;
    const estimates = await evm.estimateFee(client);
    const estimate = estimates.find((q) => q.tier === tier) ?? estimates[1];
    if (estimate === undefined) {
      throw new Error("no fee quote");
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
    const id = newId(ctx.options.random);
    pending.set(id, { unsigned, request, quote: stash.quote, chainId: stash.chainId });
    let tx: TrackedTransaction = {
      id,
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
    let signed: Awaited<ReturnType<ReturnType<typeof chains>["sign"]>>;
    try {
      const result = await apis.sign({ request, verify });
      tx = await ctx.transition(tx, { state: "signed" });
      signed = result;
    } catch (error) {
      await ctx.transition(tx, { state: "rejected", error: errorMessage(error) });
      throw error;
    }
    try {
      const raw = evm.finalize(unsigned, signed);
      const hash = await evm.broadcast(client, raw);
      tx = await ctx.transition(tx, {
        state: "submitted",
        hash,
        submittedAt: ctx.options.now(),
      });
      ctx.track(tx.id, hash);
      return tx;
    } catch (error) {
      await ctx.transition(tx, { state: "failed", error: errorMessage(error) });
      throw error;
    }
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

  return { send, poll, replace };
};
