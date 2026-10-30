import { base64 } from "@scure/base";

import { parseMintExtensions, PROGRAM_IDS } from "@qntx/wallet-chains/solana";
/** Solana route: SOL/SPL send → sign → broadcast, plus status poll with rebroadcast/drop. */
import { chains } from "@qntx/wallet/chains";

import { SolanaChainAdapter } from "../chains/solana.ts";
import { errorMessage, newId } from "./route.ts";
import type { RouteContext, SendParams, TrackedTransaction, TxState } from "./route.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const obj = (v: unknown): Record<string, unknown> | undefined => (isObject(v) ? v : undefined);
const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);

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
  // For an SPL transfer, resolve the mint's owner (Token vs Token-2022) and reject the
  // extension combinations the wallet cannot carry before any signing or broadcast.
  let tokenProgram: string | undefined;
  if (params.token !== undefined) {
    const mintInfo = await rpc.call("getAccountInfo", [
      params.token,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    const owner = obj(mintInfo)?.["value"];
    if (obj(owner)?.["owner"] === PROGRAM_IDS.token2022) {
      tokenProgram = PROGRAM_IDS.token2022;
      const mintBytes = arr(obj(owner)?.["data"])?.[0];
      const raw = typeof mintBytes === "string" ? base64.decode(mintBytes) : undefined;
      if (raw !== undefined && raw.length > 83) {
        const epoch = obj(await rpc.call("getEpochInfo", []))?.["epoch"];
        const ext = parseMintExtensions(
          raw.subarray(83),
          BigInt(typeof epoch === "number" ? epoch : 0),
        );
        if (ext.nonTransferable === true) {
          throw new Error("token is non-transferable");
        }
        if (ext.confidential === true) {
          throw new Error("confidential transfer extensions are not supported");
        }
        // A hook or delegate extension leaves the intent partial — the decoded intent
        // marks unknown-mint token calls verified:false, which is what the UI surfaces.
        void ext.transferHook;
        void ext.permanentDelegate;
      }
    }
  }
  const unsigned = await solana.build(
    rpc,
    network,
    from,
    params.token === undefined
      ? { kind: "sol", to, lamports: amount }
      : {
          kind: "spl",
          mint: params.token,
          to,
          amount,
          decimals: params.decimals ?? 0,
          ...(tokenProgram === undefined ? {} : { tokenProgram }),
        },
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
