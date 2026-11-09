/** Bitcoin route: scan → coin-select → PSBT → sign → broadcast, plus esplora status poll. */
import { hex } from "@scure/base";
import { Address, OutScript, Transaction } from "@scure/btc-signer";

import { ChainError } from "@qntx/wallet-chains";
import {
  decodeBitcoinPsbt,
  bitcoinNetwork,
  bitcoinPubkeyFromXpub,
} from "@qntx/wallet-chains/bitcoin";
import type { BitcoinAccountTemplate } from "@qntx/wallet-chains/bitcoin";
import { chains } from "@qntx/wallet/chains";

import {
  BitcoinScanStore,
  BtcUtxoStore,
  scanChain,
  scanUtxos,
  scriptPubKey,
} from "../chains/bitcoin-scan.ts";
import type { ScanAddress, ScanUtxo } from "../chains/bitcoin-scan.ts";
import { BitcoinChainAdapter, feeTiers } from "../chains/bitcoin.ts";
import type { NetworkController } from "../networks/controller.ts";
import {
  collectChecks,
  exceedsNetworkCap,
  feeReachesAmount,
  mergeSatPerByte,
} from "../requests/checks.ts";
import type { RequestCheckCode } from "../requests/checks.ts";
import type { EngineStore } from "../store/port.ts";
import { failTx, newId, replacementStaleReason, submitTx } from "./route.ts";
import type {
  PrepareParams,
  PreparedRequest,
  RouteContext,
  SendParams,
  AccountRef,
  SignResult,
  SparkDepositTag,
  TrackedTransaction,
  TxState,
} from "./route.ts";

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
  readonly template: BitcoinAccountTemplate;
  readonly network: string;
  readonly fp: number;
};

export const broadcastPsbt = async (
  es: { post: (path: string, body: string) => Promise<unknown> },
  result: SignResult,
): Promise<string> => {
  if (result.kind !== "bitcoin.psbt" || !(result.signedPsbt instanceof Uint8Array)) {
    throw new Error("unexpected bitcoin sign result");
  }
  const signed = Transaction.fromPSBT(result.signedPsbt);
  signed.finalize();
  const raw = signed.extract();
  return String(await es.post("/tx", hex.encode(raw)));
};

const fetchRawTxes = async (
  es: { readonly get: (path: string) => Promise<unknown> },
  utxos: ReadonlyArray<{ readonly txid: string }>,
): Promise<Map<string, Uint8Array>> => {
  const out = new Map<string, Uint8Array>();
  await Promise.all(
    utxos.map(async (u) => {
      const raw = await es.get(`/tx/${u.txid}/hex`);
      if (typeof raw !== "string") {
        throw new TypeError(`esplora /tx/${u.txid}/hex: not a string`);
      }
      const bytes = hex.decode(raw);
      if (Transaction.fromRaw(bytes, { allowUnknownInputs: true }).id !== u.txid) {
        throw new Error(`esplora /tx/${u.txid}/hex: txid mismatch`);
      }
      out.set(u.txid, bytes);
    }),
  );
  return out;
};

/** The account-relative full path `purpose'/coin'/group'/change/index` for a PSBT entry. */
export const accountPath = (accountPath: string): ReadonlyArray<number> =>
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

const nextReceiveAddress = async (
  ctx: RouteContext,
  walletId: string,
  groupIndex: number,
  network: string,
): Promise<string> => {
  const apis = ctx.options.chains ?? chains(ctx.options.wallet);
  const account = await apis.account({ walletId, groupIndex, template: "btc.bip84", network });
  if (!("xpub" in account) || account.xpub === undefined) {
    throw new Error("bitcoin account carries no xpub");
  }
  const receive = await scanChain(
    ctx.options.networks.esplora(network),
    account.xpub,
    "btc.bip84",
    network,
    bitcoinNetwork(network).params,
    0,
  );
  const next = new BitcoinScanStore().nextUnused(
    { addresses: receive, utxos: [], scannedAt: ctx.options.now() },
    0,
  );
  if (next === undefined) {
    throw new Error("no unused receive address");
  }
  return next.address;
};

/** Per-controller route — the UTXO store and the build stash are engine state. */
export const createBitcoinRoute = (): BitcoinRoute => {
  const bitcoin = new BitcoinChainAdapter();
  const bitcoinUtxos = new BtcUtxoStore();
  const pending = new Map<string, BtcStash>();
  /**
   * Outputs held by a request that has not been broadcast yet ("txid:vout" → request id). Memory
   * only: the request queue is not persisted, so a crash must not leave anything locked. The
   * persistent lock (keyed by tx id) is written only once a broadcast succeeds.
   */
  const reserved = new Map<string, string>();
  const isHeld = (key: string): boolean => {
    const [txid = "", vout = "0"] = key.split(":");
    return reserved.has(key) || bitcoinUtxos.isLocked({ txid, vout: Number(vout) });
  };
  const releaseReservation = (requestId: string): void => {
    for (const [key, holder] of reserved) {
      if (holder === requestId) {
        reserved.delete(key);
      }
    }
  };

  const prepare = async (
    ctx: RouteContext,
    params: PrepareParams,
    requestId: string,
    sparkDeposit?: SparkDepositTag,
  ): Promise<PreparedRequest> => {
    const { account, network, to, amount, fee } = params;
    if (account.kind !== "hd") {
      throw new ChainError("unsupported", "imported keys cannot sign bitcoin transactions");
    }
    const es = ctx.options.networks.esplora(network);
    const independent = ctx.options.networks.independentEsplora(network);
    const apis = ctx.options.chains ?? chains(ctx.options.wallet);
    const template =
      (["btc.bip44", "btc.bip49", "btc.bip84", "btc.bip86"] as const).find(
        (x) => x === account.template,
      ) ?? "btc.bip84";
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
    const rawTxOf = (u: { readonly txid: string }): Uint8Array | undefined => rawTxes.get(u.txid);

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
    const rawTxes =
      template === "btc.bip44" ? await fetchRawTxes(es, utxos) : new Map<string, Uint8Array>();
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
      template,
      template === "btc.bip44" ? rawTxOf : undefined,
    );
    // bip49/bip44 are spend-only — their change goes on the group's bip84 chain.
    let changeAddr = change.find((a) => !a.used)?.address;
    if (template === "btc.bip49" || template === "btc.bip44") {
      const acct84 = await apis.account({
        walletId: account.walletId,
        groupIndex: account.groupIndex,
        template: "btc.bip84",
        network,
      });
      const xpub84 = "xpub" in acct84 ? acct84.xpub : undefined;
      if (xpub84 === undefined) {
        throw new Error("no bip84 account for the legacy-template change chain");
      }
      const change84 = await scanChain(es, xpub84, "btc.bip84", network, net.params, 1);
      changeAddr = change84.find((a) => !a.used)?.address;
    }
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
    const flags: Array<RequestCheckCode | undefined> = [
      independent.kind === "unavailable" ? "reads-unverified" : undefined,
    ];
    let rate = quote.satPerByte;
    let independentRate: number | undefined;
    if (independent.kind === "available") {
      try {
        const others = await feeTiers(independent.client);
        independentRate = others.find((q) => q.tier === quote.tier)?.satPerByte;
        if (independentRate === undefined) {
          flags.push("reads-unverified");
        } else {
          const merged = mergeSatPerByte(quote.satPerByte, independentRate);
          ({ rate } = merged);
          flags.push(merged.mismatch ? "fee-mismatch" : undefined);
        }
      } catch {
        flags.push("reads-unverified");
      }
    }
    // Selection and reservation run with no await between them, so concurrent prepares cannot
    // pick the same output.
    const free = inputs.filter((i) => !isHeld(`${String(i.txid ?? "")}:${String(i.index ?? 0)}`));
    const { psbt, inputs: selected } = bitcoin.buildPsbt(
      free,
      to,
      amount,
      BigInt(rate),
      changeAddr,
      net.params,
    );
    const selectedKeys = new Set(
      selected.map((i) => `${String(i.txid ?? "")}:${String(i.index ?? 0)}`),
    );
    const selectedUtxos = utxos.filter((u) => selectedKeys.has(`${u.txid}:${u.vout}`));
    for (const key of selectedKeys) {
      reserved.set(key, requestId);
    }
    const txP = Transaction.fromPSBT(psbt);
    const ownScripts = new Set(
      change.filter((a) => !a.used).map((a) => hex.encode(scriptPubKey(a.address, net.params))),
    );
    const request = {
      kind: "bitcoin.psbt" as const,
      network,
      account: {
        kind: "hd" as const,
        walletId: account.walletId,
        groupIndex: account.groupIndex,
      },
      psbt,
      sign: Array.from({ length: txP.inputsLength }, (_, i) => ({ index: i, template })),
    };
    const intent = decodeBitcoinPsbt(request, ownScripts);
    const vsize = Math.ceil(
      10.5 + txP.inputsLength * (tap ? 57.5 : 68) + txP.outputsLength * (tap ? 43 : 31),
    );
    const outValues = Array.from({ length: txP.outputsLength }, (_, i) => {
      const o = txP.getOutput(i);
      const scriptHex =
        "script" in o && o.script instanceof Uint8Array ? o.script : new Uint8Array();
      const address =
        scriptHex.length > 0 ? Address(net.params).encode(OutScript.decode(scriptHex)) : "";
      return { address, value: Number(o.amount ?? 0n), own: false };
    });
    for (const o of outValues) {
      if (o.address !== "" && ownScripts.has(hex.encode(scriptPubKey(o.address, net.params)))) {
        (o as { own: boolean }).own = true;
      }
    }
    const inTotal = selectedUtxos.reduce((a, u) => a + u.value, 0);
    const outTotal = outValues.reduce((a, o) => a + o.value, 0);
    const id0 = newId(ctx.options.random);
    const stash: BtcStash = {
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
      fp,
      tier: fee === "fast" ? "fast" : fee === "slow" ? "slow" : "normal",
      template,
      network,
    };
    const record = {
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
    };
    if (independentRate !== undefined) {
      flags.push(
        exceedsNetworkCap(BigInt(record.feeRate), BigInt(Math.ceil(independentRate)))
          ? "fee-above-network"
          : undefined,
      );
    }
    flags.push(feeReachesAmount(BigInt(record.fee), amount) ? "fee-exceeds-amount" : undefined);

    const submit = async (verify: SendParams["verify"]): Promise<TrackedTransaction> => {
      pending.set(id0, stash);
      let tx: TrackedTransaction = {
        id: id0,
        family: "bitcoin",
        network,
        account: account.walletId,
        hash: undefined,
        state: "draft",
        intent,
        nonce: 0,
        btc: record,
        ...(sparkDeposit === undefined ? {} : { sparkDeposit }),
        submittedAt: ctx.options.now(),
        error: undefined,
      };
      tx = await ctx.transition(tx, {});
      try {
        const result = await apis.sign({ request, verify });
        tx = await ctx.transition(tx, { state: "signed" });
        const hash = await broadcastPsbt(es, result);
        bitcoinUtxos.lock(selectedUtxos, tx.id);
        releaseReservation(requestId);
        return await submitTx(ctx, tx, hash);
      } catch (error) {
        await failTx(ctx, tx, error);
        throw error;
      }
    };

    return {
      txId: id0,
      account,
      network,
      intent,
      checks: collectChecks(flags),
      staleReason: () => undefined,
      submit,
      release: () => {
        releaseReservation(requestId);
      },
    };
  };

  /** Esplora `/tx/:txid/status` → terminal state or `undefined` to keep polling. */

  /**
   * Builds the approval-ready request for a replacement or CPFP child. `held` are the extra outputs
   * it spends beyond the original's own inputs; they are reserved in memory here and only locked
   * persistently, under the new transaction id, once the broadcast succeeds.
   */
  const prepareFinish = (
    ctx: RouteContext,
    stash: BtcStash,
    es: ReturnType<NetworkController["esplora"]>,
    account: AccountRef,
    old: TrackedTransaction,
    psbt: Uint8Array,
    record: NonNullable<TrackedTransaction["btc"]>,
    link: { readonly replaces?: string; readonly parentId?: string },
    requestId: string,
    held: ReadonlyArray<string>,
    flags: ReadonlyArray<RequestCheckCode | undefined>,
  ): PreparedRequest => {
    const apis = ctx.options.chains ?? chains(ctx.options.wallet);
    const txP = Transaction.fromPSBT(psbt);
    if (account.kind !== "hd") {
      throw new ChainError("unsupported", "imported keys cannot sign bitcoin transactions");
    }
    const request = {
      kind: "bitcoin.psbt" as const,
      network: old.network,
      account: { kind: "hd" as const, walletId: account.walletId, groupIndex: account.groupIndex },
      psbt,
      sign: Array.from({ length: txP.inputsLength }, (_, i) => ({
        index: i,
        template: stash.template,
      })),
    };
    const ownScripts = new Set(
      stash.changeAddresses.map((a) =>
        hex.encode(scriptPubKey(a, bitcoinNetwork(stash.network).params)),
      ),
    );
    const intent = decodeBitcoinPsbt(request, ownScripts);
    const txId = newId(ctx.options.random);
    for (const key of held) {
      reserved.set(key, requestId);
    }

    const submit = async (verify: SendParams["verify"]): Promise<TrackedTransaction> => {
      let tx: TrackedTransaction = {
        id: txId,
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
        const hash = await broadcastPsbt(es, result);
        if (link.replaces !== undefined) {
          bitcoinUtxos.endTx(old.id, "dropped");
        }
        bitcoinUtxos.lock(
          record.inputs.map((i) => ({ ...i, status: "confirmed" as const, height: 0 })),
          tx.id,
        );
        releaseReservation(requestId);
        return await submitTx(ctx, tx, hash);
      } catch (error) {
        await failTx(ctx, tx, error);
        throw error;
      }
    };

    return {
      txId,
      account,
      network: old.network,
      target: old.id,
      intent,
      checks: collectChecks(flags),
      staleReason: () =>
        link.replaces === undefined ? undefined : replacementStaleReason(ctx, old.id),
      submit,
      release: () => {
        releaseReservation(requestId);
      },
    };
  };

  const prepareReplace = async (
    ctx: RouteContext,
    old: TrackedTransaction,
    mode: "speed-up" | "cancel",
    requestId: string,
  ): Promise<PreparedRequest> => {
    const stash = pending.get(old.id);
    const { btc } = old;
    if (stash === undefined || btc === undefined) {
      throw new Error("the original build context is gone — cannot replace after restart");
    }
    const es = ctx.options.networks.esplora(old.network);
    const independent = ctx.options.networks.independentEsplora(old.network);
    const apis = ctx.options.chains ?? chains(ctx.options.wallet);
    const { template } = stash;
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
    let rate = tierQuote === undefined ? 1 : tierQuote.satPerByte;
    const flags: Array<RequestCheckCode | undefined> = [
      independent.kind === "unavailable" ? "reads-unverified" : undefined,
    ];
    let independentRate: number | undefined;
    if (independent.kind === "available") {
      try {
        const others = await feeTiers(independent.client);
        independentRate = others.find((q) => q.tier === tierQuote?.tier)?.satPerByte;
        if (independentRate === undefined) {
          flags.push("reads-unverified");
        } else {
          const merged = mergeSatPerByte(rate, independentRate);
          ({ rate } = merged);
          flags.push(merged.mismatch ? "fee-mismatch" : undefined);
        }
      } catch {
        flags.push("reads-unverified");
      }
    }
    // The BIP-125 floor (rule 4: pay for the replacement's own relay) applies after the merge, so
    // a low quote cannot push the replacement under it.
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
    const spare = stash.allUtxos.filter(
      (u) => !usedKeys.has(`${u.txid}:${u.vout}`) && !isHeld(`${u.txid}:${u.vout}`),
    );
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
            stash.fp,
            stash.pathOf,
            stash.pubkeyOf,
            stash.scriptOf,
            stash.template,
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
              stash.template,
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
    if (independentRate !== undefined) {
      flags.push(
        exceedsNetworkCap(BigInt(record.feeRate), BigInt(Math.ceil(independentRate)))
          ? "fee-above-network"
          : undefined,
      );
    }
    return prepareFinish(
      ctx,
      stash,
      es,
      account,
      old,
      psbt,
      record,
      { replaces: old.id },
      requestId,
      extraUtxos.map((u) => `${u.txid}:${u.vout}`),
      flags,
    );
  };

  const prepareCpfp = async (
    ctx: RouteContext,
    old: TrackedTransaction,
    targetRate: number,
    requestId: string,
  ): Promise<PreparedRequest> => {
    const stash = pending.get(old.id);
    const { btc } = old;
    if (stash === undefined || btc === undefined) {
      throw new Error("the parent build context is gone — cannot bump after restart");
    }
    const es = ctx.options.networks.esplora(old.network);
    const independent = ctx.options.networks.independentEsplora(old.network);
    const { template } = stash;
    const account = { kind: "hd" as const, walletId: old.account, groupIndex: 0, template };
    const own = btc.outputs.flatMap((o, vout) => (o.own ? [{ ...o, vout }] : []));
    if (own.length === 0) {
      throw new Error("parent has no own outputs to bump");
    }
    const parentKeys = own.map((o) => `${old.hash ?? ""}:${o.vout}`);
    if (parentKeys.some((key) => isHeld(key))) {
      throw new Error("the parent's outputs are already reserved by another request");
    }
    const flags: Array<RequestCheckCode | undefined> = [
      independent.kind === "unavailable" ? "reads-unverified" : undefined,
    ];
    if (independent.kind === "available") {
      try {
        const others = await feeTiers(independent.client);
        const fastest = others.find((q) => q.tier === "fast");
        flags.push(
          fastest === undefined
            ? "reads-unverified"
            : exceedsNetworkCap(
                  BigInt(Math.ceil(targetRate)),
                  BigInt(Math.ceil(fastest.satPerByte)),
                )
              ? "fee-above-network"
              : undefined,
        );
      } catch {
        flags.push("reads-unverified");
      }
    }
    const childInputs = bitcoin.toInputs(
      own.map((o) => ({
        txid: old.hash ?? "",
        vout: o.vout,
        value: o.value,
        address: o.address,
        status: "confirmed" as const,
        height: 0,
      })),
      stash.fp,
      stash.pathOf,
      stash.pubkeyOf,
      stash.scriptOf,
      stash.template,
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
      inputs: own.map((o) => ({
        txid: old.hash ?? "",
        vout: o.vout,
        value: o.value,
        address: o.address,
      })),
      outputs: [{ address: changeAddr, value: inTotal - childFee, own: true }],
      vsize,
      fee: childFee,
      feeRate: Math.ceil(childFee / vsize),
    };
    return prepareFinish(
      ctx,
      stash,
      es,
      account,
      old,
      psbt,
      record,
      { parentId: old.id },
      requestId,
      parentKeys,
      flags,
    );
  };

  const pollAndRelease = async (
    ctx: RouteContext,
    tx: TrackedTransaction,
  ): Promise<TxState | undefined> => {
    const state = await poll(ctx, tx);
    if (state === "confirmed") {
      bitcoinUtxos.endTx(tx.id, "confirmed");
    }
    return state;
  };

  return {
    prepare,
    nextReceiveAddress,
    poll: pollAndRelease,
    prepareReplace,
    prepareCpfp,
    unlock: async (store) => bitcoinUtxos.unlock(store),
    lock: () => {
      reserved.clear();
      bitcoinUtxos.lockStore();
    },
  };
};

export type BitcoinRoute = {
  readonly prepare: (
    ctx: RouteContext,
    params: PrepareParams,
    requestId: string,
    sparkDeposit?: SparkDepositTag,
  ) => Promise<PreparedRequest>;
  /** The group's next unused `btc.bip84` receive address. */
  readonly nextReceiveAddress: (
    ctx: RouteContext,
    walletId: string,
    groupIndex: number,
    network: string,
  ) => Promise<string>;
  readonly poll: (ctx: RouteContext, tx: TrackedTransaction) => Promise<TxState | undefined>;
  readonly prepareReplace: (
    ctx: RouteContext,
    old: TrackedTransaction,
    mode: "speed-up" | "cancel",
    requestId: string,
  ) => Promise<PreparedRequest>;
  readonly unlock: (store: EngineStore) => Promise<void>;
  readonly lock: () => void;
  readonly prepareCpfp: (
    ctx: RouteContext,
    old: TrackedTransaction,
    targetRate: number,
    requestId: string,
  ) => Promise<PreparedRequest>;
};
