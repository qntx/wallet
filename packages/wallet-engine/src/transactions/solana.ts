/** Solana route: SOL/SPL send → sign → broadcast, plus status poll with rebroadcast/drop. */
import { chains } from "@qntx/wallet/chains";

import { SolanaChainAdapter } from "../chains/solana.ts";
import { errorMessage, newId } from "./route.ts";
import type { RouteContext, SendParams, TrackedTransaction, TxState } from "./route.ts";

const solana = new SolanaChainAdapter();

/** Signed wire transactions kept for re-broadcast until the tx confirms or drops. */
const wires = new Map<string, Uint8Array>();

export const sendSolana = async (
  ctx: RouteContext,
  params: SendParams,
): Promise<TrackedTransaction> => {
  const { account, network, to, amount, fee, verify } = params;
  if (account.kind !== "hd") {
    throw new Error("imported accounts are not yet supported");
  }
  const rpc = ctx.options.networks.solanaRpc(network);
  const apis = ctx.options.chains ?? chains(ctx.options.wallet);
  const solAccount = await apis.account({
    walletId: account.walletId,
    groupIndex: account.groupIndex,
    template: "solana.bip44-change",
    network,
  });
  const from = "address" in solAccount ? solAccount.address : "";
  const unsigned = await solana.build(
    rpc,
    network,
    from,
    params.token === undefined
      ? { kind: "sol", to, lamports: amount }
      : { kind: "spl", mint: params.token, to, amount, decimals: params.decimals ?? 0 },
  );
  const quotes = await solana.estimateFee(rpc, unsigned.writable);
  const quote = quotes.find((q) => q.tier === fee) ?? quotes[1];
  if (quote === undefined) {
    throw new Error("no fee quote");
  }
  const messageBytes = solana.applyFee(unsigned, quote);
  const request = {
    kind: "solana.transaction" as const,
    network,
    account,
    message: messageBytes,
  };
  const id = newId(ctx.options.random);
  let tx: TrackedTransaction = {
    id,
    family: "solana",
    network,
    account: account.walletId,
    hash: undefined,
    state: "draft",
    intent: undefined,
    nonce: 0,
    lastValidBlockHeight: Number(unsigned.lastValidBlockHeight),
    submittedAt: ctx.options.now(),
    error: undefined,
  };
  tx = await ctx.transition(tx, {});
  try {
    const result = await apis.sign({ request, verify });
    tx = await ctx.transition(tx, { state: "signed" });
    if (result.kind !== "solana.transaction" || !(result.signature instanceof Uint8Array)) {
      throw new Error("unexpected solana sign result");
    }
    const wire = solana.finalize(messageBytes, [result.signature]);
    const hash = await solana.broadcast(rpc, wire);
    wires.set(id, wire);
    tx = await ctx.transition(tx, {
      state: "submitted",
      hash,
      submittedAt: ctx.options.now(),
    });
    ctx.track(tx.id, hash);
    return tx;
  } catch (error) {
    const failed = tx.state === "signed" ? "failed" : "rejected";
    await ctx.transition(tx, { state: failed, error: errorMessage(error) });
    throw error;
  }
};

/** Returns the terminal state, `dropped` on blockhash expiry, or `undefined` to keep polling. */
export const pollSolana = async (
  ctx: RouteContext,
  tx: TrackedTransaction,
): Promise<TxState | undefined> => {
  if (tx.hash === undefined) {
    return "failed";
  }
  const rpc = ctx.options.networks.solanaRpc(tx.network);
  const state = await solana.status(rpc, tx.hash);
  if (state !== "pending") {
    wires.delete(tx.id);
    return state === "finalized" ? "confirmed" : state;
  }
  if (
    tx.lastValidBlockHeight !== undefined &&
    (await solana.blockHeight(rpc)) > BigInt(tx.lastValidBlockHeight)
  ) {
    wires.delete(tx.id);
    return "dropped";
  }
  const wire = wires.get(tx.id);
  if (wire !== undefined) {
    await solana.broadcast(rpc, wire).catch(() => "");
  }
  return undefined;
};
