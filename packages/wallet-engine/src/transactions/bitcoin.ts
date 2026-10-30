/** Bitcoin route: scan → coin-select → PSBT → sign → broadcast, plus esplora status poll. */
import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";

import {
  decodeBitcoinPsbt,
  bitcoinNetwork,
  bitcoinPubkeyFromXpub,
} from "@qntx/wallet-chains/bitcoin";
import { chains } from "@qntx/wallet/chains";

import { BtcUtxoStore, scanChain, scanUtxos, scriptPubKey } from "../chains/bitcoin-scan.ts";
import type { ScanAddress, ScanUtxo } from "../chains/bitcoin-scan.ts";
import { BitcoinChainAdapter, feeTiers } from "../chains/bitcoin.ts";
import { errorMessage, newId } from "./route.ts";
import type { RouteContext, SendParams, TrackedTransaction, TxState } from "./route.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const bitcoin = new BitcoinChainAdapter();
const bitcoinUtxos = new BtcUtxoStore();

/** The account-relative full path `purpose'/coin'/group'/change/index` for a PSBT entry. */
const accountPath = (accountPath: string): ReadonlyArray<number> =>
  accountPath
    .replace(/^m\//, "")
    .split("/")
    .map((p) => {
      const hardened = p.endsWith("'");
      const n = Number(hardened ? p.slice(0, -1) : p);
      return hardened ? n + 0x80000000 : n;
    });

export const sendBitcoin = async (
  ctx: RouteContext,
  params: SendParams,
): Promise<TrackedTransaction> => {
  const { account, network, to, amount, fee, verify } = params;
  if (account.kind !== "hd") {
    throw new Error("imported accounts are not yet supported");
  }
  const es = ctx.options.networks.esplora(network);
  const apis = ctx.options.chains ?? chains(ctx.options.wallet);
  const template = account.template === "btc.bip86" ? "btc.bip86" : "btc.bip84";
  const btcAccount = await apis.account({
    walletId: account.walletId,
    groupIndex: account.groupIndex,
    template,
    network,
  });
  if (!("xpub" in btcAccount) || btcAccount.xpub === undefined) {
    throw new Error("bitcoin account carries no xpub");
  }
  const { xpub, fingerprint, path } = btcAccount as {
    xpub: string;
    fingerprint: string;
    path: string;
  };
  const fp = Number.parseInt(fingerprint, 16);
  const net = bitcoinNetwork(network);
  const tap = template === "btc.bip86";

  const receive = await scanChain(es, xpub, template, network, net.params, 0);
  const change = await scanChain(es, xpub, template, network, net.params, 1);
  const addresses: ScanAddress[] = [...receive, ...change];
  const scannedUtxos: ReadonlyArray<ScanUtxo> = await scanUtxos(es, addresses, net.params);
  const utxos = scannedUtxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: u.value,
    address: u.address,
    status: "confirmed" as const,
    height: u.height,
  }));
  const byAddr = new Map(addresses.map((a) => [a.address, a]));
  const base = accountPath(path);
  const inputs = bitcoin.toInputs(
    utxos,
    fp,
    (u) => {
      const a = byAddr.get(u.address);
      return a === undefined ? [] : [...base, a.chain, a.index];
    },
    (u) => {
      const a = byAddr.get(u.address);
      if (a === undefined) {
        throw new Error(`utxo ${u.txid} on an unknown address`);
      }
      return bitcoinPubkeyFromXpub(xpub, template, network, a.chain, a.index);
    },
    (u) => scriptPubKey(u.address, net.params),
    tap,
  );
  const changeAddr = change.find((a) => !a.used)?.address;
  if (changeAddr === undefined) {
    throw new Error("no unused change address");
  }
  const quotes = await feeTiers(es);
  const quote =
    quotes.find(
      (q: { tier: string }) =>
        q.tier === (fee === "fast" ? "fast" : fee === "slow" ? "slow" : "normal"),
    ) ?? quotes[1];
  if (quote === undefined) {
    throw new Error("no fee quote");
  }
  const { psbt, inputs: selected } = bitcoin.buildPsbt(
    inputs,
    to,
    amount,
    BigInt(quote.satPerByte),
    changeAddr,
    net.params,
  );
  const selectedKeys = new Set(
    selected.map((i) => `${String(i.txid ?? "")}:${String(i.index ?? 0)}`),
  );
  const selectedUtxos = utxos.filter((u) => selectedKeys.has(`${u.txid}:${u.vout}`));
  const txP = Transaction.fromPSBT(psbt);
  const ownScripts = new Set(
    change.filter((a) => !a.used).map((a) => hex.encode(scriptPubKey(a.address, net.params))),
  );
  const request = {
    kind: "bitcoin.psbt" as const,
    network,
    account,
    psbt,
    sign: Array.from({ length: txP.inputsLength }, (_, i) => i),
  };
  const intent = decodeBitcoinPsbt(request, ownScripts);
  let tx: TrackedTransaction = {
    id: newId(ctx.options.random),
    family: "bitcoin",
    network,
    account: account.walletId,
    hash: undefined,
    state: "draft",
    intent,
    nonce: 0,
    submittedAt: ctx.options.now(),
    error: undefined,
  };
  tx = await ctx.transition(tx, {});
  try {
    const result = await apis.sign({ request, verify });
    tx = await ctx.transition(tx, { state: "signed" });
    if (result.kind !== "bitcoin.psbt" || !(result.signedPsbt instanceof Uint8Array)) {
      throw new Error("unexpected bitcoin sign result");
    }
    bitcoinUtxos.lock(selectedUtxos, tx.id);
    const signed = Transaction.fromPSBT(result.signedPsbt);
    signed.finalize();
    const raw = signed.extract();
    const hash = String(await es.post("/tx", hex.encode(raw)));
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

/** Esplora `/tx/:txid/status` → terminal state or `undefined` to keep polling. */
export const pollBitcoin = async (
  ctx: RouteContext,
  tx: TrackedTransaction,
): Promise<TxState | undefined> => {
  if (tx.hash === undefined) {
    return "failed";
  }
  const es = ctx.options.networks.esplora(tx.network);
  const status: unknown = await es.get(`/tx/${tx.hash}/status`);
  const confirmed = isObject(status) && status["confirmed"] === true;
  if (!confirmed) {
    return undefined;
  }
  return "confirmed";
};
