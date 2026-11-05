/** EVM route: native/ERC-20 send build → fee → decode → sign → broadcast, plus status poll. */
import { isAddress, isHex, parseTransaction } from "viem";

import { EVM_NATIVE_ASSET, checksumEvmAddress, decodeEvm } from "@qntx/wallet-chains/evm";
import { chains } from "@qntx/wallet/chains";

import { EvmChainAdapter } from "../chains/evm.ts";
import type { EvmUnsignedTransaction } from "../chains/evm.ts";
import { resolveEns } from "../names/ens.ts";
import {
  collectChecks,
  exceedsNetworkCap,
  feesDiffer,
  feeReachesAmount,
  mergeEvmQuote,
} from "../requests/checks.ts";
import type { RequestCheckCode } from "../requests/checks.ts";
import { errorMessage, newId, replacementStaleReason } from "./route.ts";
import type {
  ChainApis,
  DisplayIntent,
  PrepareParams,
  PreparedRequest,
  RouteContext,
  SendParams,
  SignParams,
  SignResult,
  TrackedTransaction,
  TxState,
} from "./route.ts";

/** Consecutive polls that must see the nonce mined without our receipt before the tx is settled. */
export const DROP_CONFIRMATIONS = 3;
export const RESUBMIT_BASE_MS = 15_000;
export const RESUBMIT_MAX_MS = 600_000;
/** How long a transaction may stay unknown to the node before it is given up as dropped. */
export const UNKNOWN_DROP_MS = 1_800_000;

type Watch = {
  consumed: number;
  attempt: number;
  unknownSince: number | undefined;
  nextResubmit: number | undefined;
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
  account: { readonly from: string; readonly groupIndex: number },
  broadcast: (signed: SignResult) => Promise<{ readonly hash: string; readonly raw: string }>,
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
    const { hash, raw } = await broadcast(signed);
    tracked = await ctx.transition(tracked, {
      state: "submitted",
      hash,
      evm: { from: account.from, groupIndex: account.groupIndex, raw },
      submittedAt: ctx.options.now(),
    });
    ctx.track(tracked.id, hash);
    return tracked;
  } catch (error) {
    await ctx.transition(tracked, { state: "failed", error: errorMessage(error) });
    throw error;
  }
};

/** The unsigned transaction a persisted signed `raw` was built from. */
const rebuild = (
  old: TrackedTransaction,
  from: string,
  raw: string,
  chainId: number,
): EvmUnsignedTransaction => {
  if (!isHex(raw)) {
    throw new Error("build record is malformed");
  }
  const parsed = parseTransaction(raw);
  if (parsed.chainId !== chainId) {
    throw new Error("build record is for a different chain");
  }
  if (parsed.nonce !== old.nonce) {
    throw new Error("build record nonce does not match the transaction");
  }
  if (parsed.to === undefined || parsed.to === null || parsed.gas === undefined) {
    throw new Error("build record is incomplete");
  }
  return {
    family: "evm",
    network: old.network,
    from,
    to: checksumEvmAddress(parsed.to),
    value: parsed.value ?? 0n,
    data: parsed.data ?? "0x",
    nonce: parsed.nonce,
    gas: parsed.gas,
    ...("gasPrice" in parsed && parsed.gasPrice !== undefined ? { gasPrice: parsed.gasPrice } : {}),
    ...("maxFeePerGas" in parsed && parsed.maxFeePerGas !== undefined
      ? { maxFeePerGas: parsed.maxFeePerGas }
      : {}),
    ...("maxPriorityFeePerGas" in parsed && parsed.maxPriorityFeePerGas !== undefined
      ? { maxPriorityFeePerGas: parsed.maxPriorityFeePerGas }
      : {}),
  };
};

/** Other tracked transactions with a hash at the same (network, sender, nonce). */
const sameNonce = (ctx: RouteContext, tx: TrackedTransaction, from: string): TrackedTransaction[] =>
  Object.values(ctx.txs()).filter(
    (t) =>
      t.id !== tx.id &&
      t.family === "evm" &&
      t.network === tx.network &&
      t.nonce === tx.nonce &&
      t.hash !== undefined &&
      t.evm?.from.toLowerCase() === from.toLowerCase(),
  );

const withL1Fee = (intent: DisplayIntent, l1: bigint | undefined): DisplayIntent =>
  l1 === undefined || intent.fee === undefined
    ? intent
    : {
        ...intent,
        fee: { ...intent.fee, l1Data: { asset: EVM_NATIVE_ASSET, amount: l1.toString(10) } },
      };

/** Per-controller route — the adapter's nonce queue and the per-tx poll state are engine state. */
export const createEvmRoute = (): EvmRoute => {
  const evm = new EvmChainAdapter();
  const watching = new Map<string, Watch>();

  type BuildIntent = Parameters<EvmChainAdapter["build"]>[3];
  type PrepareSpec = {
    readonly account: PrepareParams["account"];
    readonly network: string;
    readonly intent: BuildIntent;
    readonly fee: PrepareParams["fee"];
    /** Native value moved; the worst-case fee reaching it is flagged. */
    readonly nativeValue: bigint | undefined;
  };

  /**
   * OP Stack L1 data fee plus operator fee for `tx`, the larger of the primary and independent
   * reads (the chain charges it either way; the figure only drives display and checks). Unknown
   * when the primary read fails.
   */
  const opStackFee = async (
    ctx: RouteContext,
    network: string,
    tx: EvmUnsignedTransaction,
    flags: Array<RequestCheckCode | undefined>,
  ): Promise<bigint | undefined> => {
    const { networks } = ctx.options;
    let fee: bigint;
    try {
      fee = await evm.opStackFee(networks.client(network), tx);
    } catch {
      flags.push("reads-unverified");
      return undefined;
    }
    const independent = networks.independentClient(network);
    if (independent.kind === "available") {
      try {
        const other = await evm.opStackFee(independent.client, tx);
        flags.push(feesDiffer(fee, other) ? "fee-mismatch" : undefined);
        fee = other > fee ? other : fee;
      } catch {
        flags.push("reads-unverified");
      }
    }
    return fee;
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
    const l1 = info.opStack === true ? await opStackFee(ctx, network, feed, flags) : undefined;
    if (
      spec.nativeValue !== undefined &&
      feeReachesAmount(
        feed.gas * (feed.maxFeePerGas ?? feed.gasPrice ?? 0n) + (l1 ?? 0n),
        spec.nativeValue,
      )
    ) {
      flags.push("fee-exceeds-amount");
    }
    const request = evm.toSignRequest(feed, account, info.chainId);
    const intent = withL1Fee(decodeEvm(request), l1);
    const txId = newId(ctx.options.random);
    const simulated = { to: feed.to, value: feed.value, data: feed.data };
    const simulation = await evm.simulate(
      client,
      info.chainId,
      from,
      simulated,
      ctx.options.setTimer,
    );

    const submit = async (verify: SendParams["verify"]): Promise<TrackedTransaction> => {
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
      return signSubmit(
        ctx,
        tx,
        apis,
        request,
        verify,
        { from, groupIndex: account.groupIndex },
        async (signed) => {
          const raw = evm.finalize(feed, signed);
          const hash = await evm.broadcast(client, raw);
          evm.commitNonce(network, from, unsigned.nonce);
          return { hash, raw };
        },
      );
    };

    return {
      txId,
      account,
      network,
      intent,
      checks: collectChecks(flags),
      simulation,
      resimulate: async () =>
        evm.simulate(client, info.chainId, from, simulated, ctx.options.setTimer),
      staleReason: () =>
        evm.nonceConsumed(network, from, unsigned.nonce)
          ? "nonce already used by a newer transaction — start over"
          : undefined,
      submit,
      release: () => undefined,
    };
  };

  const prepare = async (ctx: RouteContext, params: PrepareParams): Promise<PreparedRequest> => {
    let { to } = params;
    let name: string | undefined;
    let nameChecks: ReadonlyArray<RequestCheckCode> = [];
    if (!isAddress(to) && to.includes(".")) {
      const resolved = await resolveEns(ctx.options.networks, to, params.network);
      ({ address: to, name, checks: nameChecks } = resolved);
    }
    const prepared = await prepareSpec(ctx, {
      account: params.account,
      network: params.network,
      fee: params.fee,
      intent:
        params.token === undefined
          ? { kind: "native", to, value: params.amount }
          : { kind: "erc20", token: params.token, to, value: params.amount },
      nativeValue: params.token === undefined ? params.amount : undefined,
    });
    if (name === undefined) {
      return prepared;
    }
    return {
      ...prepared,
      intent: {
        ...prepared.intent,
        outflows: prepared.intent.outflows.map((flow) =>
          flow.to.toLowerCase() === to.toLowerCase() ? { ...flow, name } : flow,
        ),
      },
      checks: [...new Set([...nameChecks, ...prepared.checks])],
    };
  };

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
    const { evm: record } = old;
    if (record === undefined) {
      throw new Error("transaction has no build record — cannot replace");
    }
    const { networks } = ctx.options;
    const client = networks.client(old.network);
    const independent = networks.independentClient(old.network);
    const apis = ctx.options.chains ?? chains(ctx.options.wallet);
    const { chainId } = networks.info(old.network);
    const original = rebuild(old, record.from, record.raw, chainId);
    const account = {
      kind: "hd" as const,
      walletId: old.account,
      groupIndex: record.groupIndex,
      template: "evm.bip44" as const,
    };
    const estimates = await evm.estimateFee(client);
    let estimate = estimates.find((q) => q.tier === "fast") ?? estimates[1];
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
    const oldFee = original;
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
            ...original,
            to: original.from,
            value: 0n,
            data: "0x" as const,
            gas: 21000n,
            ...feeFields,
          }
        : { ...original, ...feeFields };
    const request = evm.toSignRequest(unsigned, account, chainId);
    const l1 =
      networks.info(old.network).opStack === true
        ? await opStackFee(ctx, old.network, unsigned, flags)
        : undefined;
    const intent = withL1Fee(decodeEvm(request), l1);
    const txId = newId(ctx.options.random);

    const submit = async (verify: SendParams["verify"]): Promise<TrackedTransaction> => {
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
      return signSubmit(
        ctx,
        tx,
        apis,
        request,
        verify,
        { from: record.from, groupIndex: record.groupIndex },
        async (signed) => {
          const raw = evm.finalize(unsigned, signed);
          return { hash: await evm.broadcast(client, raw), raw };
        },
      );
    };

    return {
      txId,
      account,
      network: old.network,
      target: old.id,
      intent,
      checks: collectChecks(flags),
      staleReason: () => replacementStaleReason(ctx, old.id),
      submit,
      release: () => undefined,
    };
  };

  const receiptState = async (
    client: ReturnType<RouteContext["options"]["networks"]["client"]>,
    hash: string,
  ): Promise<TxState | undefined> => {
    const state = await evm.status(client, hash);
    if (state === "pending") {
      return undefined;
    }
    return state === "finalized" ? "confirmed" : state;
  };

  const anyMined = async (
    ctx: RouteContext,
    tx: TrackedTransaction,
    siblings: TrackedTransaction[],
  ): Promise<boolean> => {
    const client = ctx.options.networks.client(tx.network);
    const states = await Promise.all(
      siblings.map(async (t) => (t.hash === undefined ? undefined : receiptState(client, t.hash))),
    );
    return states.some((state) => state !== undefined);
  };

  /**
   * Returns the terminal state once the receipt lands, `dropped` or `replaced` once the nonce is
   * settled without our receipt, or `undefined` to keep polling. While the node does not know the
   * transaction it is rebroadcast with exponential backoff.
   */
  const poll = async (ctx: RouteContext, tx: TrackedTransaction): Promise<TxState | undefined> => {
    if (tx.hash === undefined) {
      return "failed";
    }
    const { hash } = tx;
    const client = ctx.options.networks.client(tx.network);
    const settled = await receiptState(client, hash);
    if (settled !== undefined) {
      watching.delete(tx.id);
      return settled;
    }
    const record = tx.evm;
    if (record === undefined) {
      return undefined;
    }
    const watch: Watch = watching.get(tx.id) ?? {
      consumed: 0,
      attempt: 0,
      unknownSince: undefined,
      nextResubmit: undefined,
    };
    watching.set(tx.id, watch);

    if ((await evm.confirmedCount(client, record.from)) > tx.nonce) {
      const late = await receiptState(client, hash);
      if (late !== undefined) {
        watching.delete(tx.id);
        return late;
      }
      watch.consumed += 1;
      if (watch.consumed < DROP_CONFIRMATIONS) {
        return undefined;
      }
      watching.delete(tx.id);
      return (await anyMined(ctx, tx, sameNonce(ctx, tx, record.from))) ? "replaced" : "dropped";
    }
    watch.consumed = 0;

    const replacerLive = sameNonce(ctx, tx, record.from).some(
      (t) => t.replaces === tx.id && (t.state === "submitted" || t.state === "pending"),
    );
    if (replacerLive) {
      watch.unknownSince = undefined;
      watch.nextResubmit = undefined;
      watch.attempt = 0;
      return undefined;
    }

    if (await evm.known(client, hash)) {
      watch.unknownSince = undefined;
      watch.nextResubmit = undefined;
      watch.attempt = 0;
      return undefined;
    }
    const now = ctx.options.now();
    watch.unknownSince ??= now;
    if (now - watch.unknownSince >= UNKNOWN_DROP_MS) {
      const independent = ctx.options.networks.independentClient(tx.network);
      const elsewhere =
        independent.kind === "available" &&
        (await evm.known(independent.client, hash).catch(() => true));
      if (!elsewhere) {
        evm.releaseNonce(tx.network, record.from, tx.nonce);
        watching.delete(tx.id);
        return "dropped";
      }
    }
    if (watch.nextResubmit === undefined || now >= watch.nextResubmit) {
      await evm.broadcast(client, record.raw).catch(() => "");
      watch.nextResubmit = now + Math.min(RESUBMIT_BASE_MS * 2 ** watch.attempt, RESUBMIT_MAX_MS);
      watch.attempt += 1;
    }
    return undefined;
  };

  return { prepare, prepareCall, poll, prepareReplace };
};
