/** EVM route: native/ERC-20 send build → fee → decode → sign → broadcast, plus status poll. */
import { decodeEvm } from "@qntx/wallet-chains/evm";
import { chains } from "@qntx/wallet/chains";

import { EvmChainAdapter } from "../chains/evm.ts";
import { errorMessage, newId } from "./route.ts";
import type { RouteContext, SendParams, TrackedTransaction, TxState } from "./route.ts";

const evm = new EvmChainAdapter();

export const sendEvm = async (
  ctx: RouteContext,
  params: SendParams,
): Promise<TrackedTransaction> => {
  const { account, network, to, amount, fee, verify } = params;
  if (account.kind !== "hd") {
    throw new Error("imported accounts are not yet supported");
  }
  const { networks } = ctx.options;
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
  const request = evm.toSignRequest(evm.applyFee(unsigned, quote), account, info.chainId);
  const intent = decodeEvm(request);
  let tx: TrackedTransaction = {
    id: newId(ctx.options.random),
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
export const pollEvm = async (
  ctx: RouteContext,
  tx: TrackedTransaction,
): Promise<TxState | undefined> => {
  if (tx.hash === undefined) {
    return "failed";
  }
  const state = await evm.status(ctx.options.networks.client(tx.network), tx.hash);
  if (state === "pending") {
    return undefined;
  }
  return state === "finalized" ? "confirmed" : state;
};
