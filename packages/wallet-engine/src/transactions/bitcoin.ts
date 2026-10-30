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
import type { NetworkController } from "../networks/controller.ts";
import { errorMessage, newId } from "./route.ts";
import type { SignParams, RouteContext, SendParams, TrackedTransaction, TxState } from "./route.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

type BtcStash = {
  readonly inputs: ReadonlyArray<Parameters<BitcoinChainAdapter["buildPsbt"]>[0][number]>;
  readonly allUtxos: ReadonlyArray<{
    readonly txid: string;
    readonly vout: number;
    readonly value: number;
    readonly address: string;
    readonly height: number;
  }>;
  readonly pathOf: (u: { readonly address: string; readonly txid?: string }) => number[];
  readonly pubkeyOf: (u: { readonly address: string; readonly txid?: string }) => Uint8Array;
  readonly scriptOf: (u: { readonly address: string }) => Uint8Array;
  readonly changeAddresses: ReadonlyArray<string>;
  readonly tier: string;
  readonly tap: boolean;
  readonly network: string;
};

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

const poll = async (ctx: RouteContext, tx: TrackedTransaction): Promise<TxState | undefined> => {
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

/** Per-controller route — the UTXO store and the build stash are engine state. */
export const createBitcoinRoute = (): BitcoinRoute => {
  const bitcoin = new BitcoinChainAdapter();
  const bitcoinUtxos = new BtcUtxoStore();
  const pending = new Map<string, BtcStash>();

  const send = async (ctx: RouteContext, params: SendParams): Promise<TrackedTransaction> => {
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
    const { vsize } = txP;
    const outValues = Array.from({ length: txP.outputsLength }, (_, i) => {
      const o = txP.getOutput(i);
      return {
        address: "address" in o && typeof o.address === "string" ? o.address : "",
        value: Number(o.amount ?? 0n),
        own: false,
      };
    });
    for (const o of outValues) {
      if (ownScripts.has(hex.encode(scriptPubKey(o.address, net.params)))) {
        (o as { own: boolean }).own = true;
      }
    }
    const inTotal = selectedUtxos.reduce((a, u) => a + u.value, 0);
    const outTotal = outValues.reduce((a, o) => a + o.value, 0);
    const id0 = newId(ctx.options.random);
    pending.set(id0, {
      inputs,
      allUtxos: utxos,
      pathOf: (u) => {
        const a = byAddr.get(u.address);
        return a === undefined ? [] : [...base, a.chain, a.index];
      },
      pubkeyOf: (u) => {
        const a = byAddr.get(u.address);
        if (a === undefined) {
          throw new Error(`utxo ${String(u.txid)} on an unknown address`);
        }
        return bitcoinPubkeyFromXpub(xpub, template, network, a.chain, a.index);
      },
      scriptOf: (u) => scriptPubKey(u.address, net.params),
      changeAddresses: change.filter((a) => !a.used).map((a) => a.address),
      tier: fee === "fast" ? "fast" : fee === "slow" ? "slow" : "normal",
      tap,
      network,
    });
    let tx: TrackedTransaction = {
      id: id0,
      family: "bitcoin",
      network,
      account: account.walletId,
      hash: undefined,
      state: "draft",
      intent,
      nonce: 0,
      btc: {
        inputs: selectedUtxos.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          value: u.value,
          address: u.address,
        })),
        outputs: outValues,
        vsize,
        fee: inTotal - outTotal,
        feeRate: Math.ceil((inTotal - outTotal) / vsize),
      },
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

  const finish = async (
    ctx: RouteContext,
    stash: BtcStash,
    es: ReturnType<NetworkController["esplora"]>,
    account: SignParams["request"]["account"],
    old: TrackedTransaction,
    psbt: Uint8Array,
    record: NonNullable<TrackedTransaction["btc"]>,
    link: { readonly replaces?: string; readonly parentId?: string },
    verify: SendParams["verify"],
  ): Promise<TrackedTransaction> => {
    const apis = ctx.options.chains ?? chains(ctx.options.wallet);
    const txP = Transaction.fromPSBT(psbt);
    const request = {
      kind: "bitcoin.psbt" as const,
      network: old.network,
      account,
      psbt,
      sign: Array.from({ length: txP.inputsLength }, (_, i) => i),
    };
    const ownScripts = new Set(
      stash.changeAddresses.map((a) =>
        hex.encode(scriptPubKey(a, bitcoinNetwork(stash.network).params)),
      ),
    );
    const intent = decodeBitcoinPsbt(request, ownScripts);
    let tx: TrackedTransaction = {
      id: newId(ctx.options.random),
      family: "bitcoin",
      network: old.network,
      account: old.account,
      hash: undefined,
      state: "draft",
      intent,
      nonce: 0,
      btc: record,
      submittedAt: ctx.options.now(),
      error: undefined,
      ...link,
    };
    tx = await ctx.transition(tx, {});
    try {
      const result = await apis.sign({ request, verify });
      tx = await ctx.transition(tx, { state: "signed" });
      if (result.kind !== "bitcoin.psbt" || !(result.signedPsbt instanceof Uint8Array)) {
        throw new Error("unexpected bitcoin sign result");
      }
      bitcoinUtxos.endTx(old.id, "dropped");
      const signed = Transaction.fromPSBT(result.signedPsbt);
      signed.finalize();
      const raw = signed.extract();
      const hash = String(await es.post("/tx", hex.encode(raw)));
      bitcoinUtxos.lock(
        record.inputs.map((i) => ({ ...i, status: "confirmed" as const, height: 0 })),
        tx.id,
      );
      tx = await ctx.transition(tx, { state: "submitted", hash, submittedAt: ctx.options.now() });
      ctx.track(tx.id, hash);
      return tx;
    } catch (error) {
      const failed = tx.state === "signed" ? "failed" : "rejected";
      await ctx.transition(tx, { state: failed, error: errorMessage(error) });
      throw error;
    }
  };

  const replace = async (
    ctx: RouteContext,
    old: TrackedTransaction,
    mode: "speed-up" | "cancel",
    verify: SendParams["verify"],
  ): Promise<TrackedTransaction> => {
    const stash = pending.get(old.id);
    const { btc } = old;
    if (stash === undefined || btc === undefined) {
      throw new Error("the original build context is gone — cannot replace after restart");
    }
    const es = ctx.options.networks.esplora(old.network);
    const apis = ctx.options.chains ?? chains(ctx.options.wallet);
    const template = stash.tap ? ("btc.bip86" as const) : ("btc.bip84" as const);
    const btcAccount = await apis.account({
      walletId: old.account,
      groupIndex: 0,
      template,
      network: old.network,
    });
    if (!("xpub" in btcAccount)) {
      throw new Error("bitcoin account carries no xpub");
    }
    const account = { kind: "hd" as const, walletId: old.account, groupIndex: 0, template };
    const tiers = await feeTiers(es);
    const tierQuote = tiers.find((t) => t.tier === stash.tier) ?? tiers[1];
    const rate = tierQuote === undefined ? 1 : tierQuote.satPerByte;
    const newFee = Math.max(btc.fee + btc.vsize, Math.ceil(btc.vsize * rate));
    const [changeAddr] = stash.changeAddresses;
    if (changeAddr === undefined) {
      throw new Error("no unused change address");
    }
    const net = bitcoinNetwork(old.network);
    const inTotal = btc.inputs.reduce((a, i) => a + i.value, 0);
    const dust = 546;
    const payee = btc.outputs
      .filter((o) => !o.own)
      .map((o) => ({ address: o.address, amount: BigInt(o.value) }));
    const usedKeys = new Set(btc.inputs.map((i) => `${i.txid}:${i.vout}`));
    const spare = stash.allUtxos.filter((u) => !usedKeys.has(`${u.txid}:${u.vout}`));
    const extraInputs: ReturnType<typeof bitcoin.toInputs> = [];
    const extraUtxos: typeof spare = [];
    const feeNeeded = (o: ReadonlyArray<{ amount: bigint }>): bigint =>
      BigInt(newFee) -
      (BigInt(inTotal) +
        extraUtxos.reduce((a, u) => a + BigInt(u.value), 0n) -
        o.reduce((a, x) => a + x.amount, 0n));
    let outputs: ReadonlyArray<{ readonly address: string; readonly amount: bigint }>;
    if (mode === "cancel") {
      outputs = [{ address: changeAddr, amount: BigInt(inTotal - newFee) }];
    } else {
      const shrunk = btc.outputs.find((o) => o.own);
      const changeAfter = shrunk === undefined ? 0 : shrunk.value - (newFee - btc.fee);
      outputs =
        changeAfter >= dust
          ? [...payee, { address: changeAddr, amount: BigInt(changeAfter) }]
          : payee;
      while (feeNeeded(outputs) > 0n && spare.length > extraUtxos.length) {
        const next = spare[extraUtxos.length];
        if (next === undefined) {
          break;
        }
        extraUtxos.push(next);
        extraInputs.push(
          ...bitcoin.toInputs(
            [{ ...next, status: "confirmed" as const }],
            0,
            stash.pathOf,
            stash.pubkeyOf,
            stash.scriptOf,
            stash.tap,
          ),
        );
      }
      if (feeNeeded(outputs) > 0n) {
        const keepChange = [...outputs, { address: changeAddr, amount: BigInt(dust) }];
        while (feeNeeded(keepChange) > 0n && spare.length > extraUtxos.length) {
          const next = spare[extraUtxos.length];
          if (next === undefined) {
            break;
          }
          extraUtxos.push(next);
          extraInputs.push(
            ...bitcoin.toInputs(
              [{ ...next, status: "confirmed" as const }],
              0,
              stash.pathOf,
              stash.pubkeyOf,
              stash.scriptOf,
              stash.tap,
            ),
          );
        }
        if (feeNeeded(keepChange) > 0n) {
          throw new Error("insufficient confirmed utxo to fund the replacement fee");
        }
        const changeValue =
          inTotal +
          extraUtxos.reduce((a, u) => a + u.value, 0) -
          payee.reduce((a, o) => a + Number(o.amount), 0) -
          newFee;
        outputs = [...payee, { address: changeAddr, amount: BigInt(changeValue) }];
      } else {
        const changeValue =
          inTotal +
          extraUtxos.reduce((a, u) => a + u.value, 0) -
          payee.reduce((a, o) => a + Number(o.amount), 0) -
          newFee;
        if (changeValue >= dust) {
          outputs = [...payee, { address: changeAddr, amount: BigInt(changeValue) }];
        }
      }
    }
    const allInputs = [...stash.inputs, ...extraInputs];
    const { psbt, vsize } = bitcoin.buildExactPsbt(allInputs, outputs, net.params);
    const record = {
      inputs: [
        ...btc.inputs,
        ...extraUtxos.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          value: u.value,
          address: u.address,
        })),
      ],
      outputs: outputs.map((o) => ({
        address: o.address,
        value: Number(o.amount),
        own: o.address === changeAddr,
      })),
      vsize,
      fee: newFee,
      feeRate: Math.ceil(newFee / vsize),
    };
    return finish(ctx, stash, es, account, old, psbt, record, { replaces: old.id }, verify);
  };

  const bumpChild = async (
    ctx: RouteContext,
    old: TrackedTransaction,
    targetRate: number,
    verify: SendParams["verify"],
  ): Promise<TrackedTransaction> => {
    const stash = pending.get(old.id);
    const { btc } = old;
    if (stash === undefined || btc === undefined) {
      throw new Error("the parent build context is gone — cannot bump after restart");
    }
    const es = ctx.options.networks.esplora(old.network);
    const template = stash.tap ? ("btc.bip86" as const) : ("btc.bip84" as const);
    const account = { kind: "hd" as const, walletId: old.account, groupIndex: 0, template };
    const own = btc.outputs.filter((o) => o.own);
    if (own.length === 0) {
      throw new Error("parent has no own outputs to bump");
    }
    const childInputs = bitcoin.toInputs(
      own.map((o, i) => ({
        txid: old.hash ?? "",
        vout: i,
        value: o.value,
        address: o.address,
        status: "confirmed" as const,
        height: 0,
      })),
      0,
      stash.pathOf,
      stash.pubkeyOf,
      stash.scriptOf,
      stash.tap,
    );
    const [changeAddr] = stash.changeAddresses;
    if (changeAddr === undefined) {
      throw new Error("no unused change address");
    }
    const net = bitcoinNetwork(old.network);
    const inTotal = own.reduce((a, o) => a + o.value, 0);
    const probe = bitcoin.buildExactPsbt(
      childInputs,
      [{ address: changeAddr, amount: BigInt(inTotal) }],
      net.params,
    );
    const childFee = Math.max(
      Math.ceil(targetRate * (btc.vsize + probe.vsize)) - btc.fee,
      probe.vsize,
    );
    const { psbt, vsize } = bitcoin.buildExactPsbt(
      childInputs,
      [{ address: changeAddr, amount: BigInt(inTotal - childFee) }],
      net.params,
    );
    const record = {
      inputs: own.map((o, i) => ({
        txid: old.hash ?? "",
        vout: i,
        value: o.value,
        address: o.address,
      })),
      outputs: [{ address: changeAddr, value: inTotal - childFee, own: true }],
      vsize,
      fee: childFee,
      feeRate: Math.ceil(childFee / vsize),
    };
    return finish(ctx, stash, es, account, old, psbt, record, { parentId: old.id }, verify);
  };

  return { send, poll, replace, bumpChild };
};

export type BitcoinRoute = {
  readonly send: (ctx: RouteContext, params: SendParams) => Promise<TrackedTransaction>;
  readonly poll: (ctx: RouteContext, tx: TrackedTransaction) => Promise<TxState | undefined>;
  readonly replace: (
    ctx: RouteContext,
    old: TrackedTransaction,
    mode: "speed-up" | "cancel",
    verify: SendParams["verify"],
  ) => Promise<TrackedTransaction>;
  readonly bumpChild: (
    ctx: RouteContext,
    old: TrackedTransaction,
    targetRate: number,
    verify: SendParams["verify"],
  ) => Promise<TrackedTransaction>;
};
