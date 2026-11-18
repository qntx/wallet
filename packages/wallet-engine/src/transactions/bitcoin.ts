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
  BtcFrozenStore,
  BtcUtxoStore,
  scanChain,
  scanUtxos,
  scriptPubKey,
} from "../chains/bitcoin-scan.ts";
import type { ScanAddress, ScanUtxo } from "../chains/bitcoin-scan.ts";
import {
  BitcoinChainAdapter,
  EsploraError,
  estimateVsize,
  feeTiers,
  selectableUtxos,
} from "../chains/bitcoin.ts";
import type { BtcUtxo, Esplora } from "../chains/bitcoin.ts";
import type { NetworkController } from "../networks/controller.ts";
import {
  collectChecks,
  exceedsNetworkCap,
  feeReachesAmount,
  mergeSatPerByte,
} from "../requests/checks.ts";
import type { RequestCheckCode } from "../requests/checks.ts";
import type { PreparedBitcoinPsbt } from "../requests/types.ts";
import type { EngineStore } from "../store/port.ts";
import { RESUBMIT_BASE_MS, RESUBMIT_MAX_MS, UNKNOWN_DROP_MS, submitSigned } from "./broadcast.ts";
import type { BroadcastVerdict, SignedBroadcast } from "./broadcast.ts";
import { failTx, newId, replacementStaleReason } from "./route.ts";
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

/**
 * What a send, replacement or child build needs beyond the persisted record — derived from the
 * account and a fresh scan every time, so nothing of it has to survive a restart in memory.
 */
type SpendContext = {
  readonly template: BitcoinAccountTemplate;
  readonly groupIndex: number;
  readonly network: string;
  readonly fp: number;
  /** The send's next change address — the group's bip84 change chain for legacy templates. */
  readonly changeAddr: string | undefined;
  /** Unused addresses of the template's own change chain — the own-scripts set and bump change. */
  readonly changeAddresses: ReadonlyArray<string>;
  /** The scan's account outputs — confirmed, or the wallet's own unconfirmed change. */
  readonly candidates: ReadonlyArray<BtcUtxo>;
  /** `candidates` minus user-frozen and inscription-protected outpoints — the automatic picks. */
  readonly spendable: ReadonlyArray<BtcUtxo>;
  readonly pathOf: (u: { readonly address: string }) => number[];
  readonly pubkeyOf: (u: { readonly address: string }) => Uint8Array;
  readonly scriptOf: (u: { readonly address: string }) => Uint8Array;
};

/** The finalized network transaction of a signed PSBT: its hex and its txid. */
const extractSigned = (result: SignResult): { readonly raw: string; readonly txid: string } => {
  if (result.kind !== "bitcoin.psbt" || !(result.signedPsbt instanceof Uint8Array)) {
    throw new Error("unexpected bitcoin sign result");
  }
  const signed = Transaction.fromPSBT(result.signedPsbt);
  signed.finalize();
  return { raw: hex.encode(signed.extract()), txid: signed.id };
};

/**
 * What a failed `POST /tx` says about the bytes: Esplora answers a node rejection
 * (`sendrawtransaction` error) with a 4xx; a 5xx, timeout or network failure says nothing.
 */
export const esploraBroadcastVerdict = (error: unknown): BroadcastVerdict =>
  error instanceof EsploraError && !error.transient ? "refused" : undefined;

const esploraBroadcast = (
  es: Esplora,
  signed: ReturnType<typeof extractSigned>,
  held: { readonly hold: () => void; readonly release: () => void },
): SignedBroadcast => ({
  id: signed.txid,
  raw: signed.raw,
  ...held,
  send: async () => String(await es.post("/tx", signed.raw)),
  verdict: esploraBroadcastVerdict,
  known: async () => esploraKnows(es, signed.txid),
});

/** True when the endpoint knows `txid`; a 4xx is "not known", anything else is rethrown. */
const esploraKnows = async (es: Esplora, txid: string): Promise<boolean> => {
  try {
    await es.get(`/tx/${txid}/status`);
    return true;
  } catch (error) {
    if (error instanceof EsploraError && !error.transient) {
      return false;
    }
    throw error;
  }
};

/**
 * Whether somebody else's transaction spent one of `tx`'s inputs, told by the prevouts'
 * `/outspends`: a confirmed foreign spend settles the tracker as `replaced`; an unconfirmed one
 * means the bytes can never land — pointless to rebroadcast, but the drop clock keeps running.
 * Unreadable answers are a missed check, not a poll failure.
 */
const foreignSpend = async (
  es: Esplora,
  tx: TrackedTransaction,
): Promise<"confirmed" | "unconfirmed" | undefined> => {
  if (tx.raw === undefined || tx.hash === undefined) {
    return undefined;
  }
  let inputs: ReadonlyArray<{ txid?: Uint8Array; index?: number }>;
  try {
    const parsed = Transaction.fromRaw(hex.decode(tx.raw), { allowUnknownInputs: true });
    inputs = Array.from({ length: parsed.inputsLength }, (_, i) => parsed.getInput(i));
  } catch {
    return undefined;
  }
  const prevs = [
    ...new Set(inputs.flatMap((i) => (i.txid instanceof Uint8Array ? [hex.encode(i.txid)] : []))),
  ];
  const outspends = new Map<string, ReadonlyArray<unknown>>();
  await Promise.all(
    prevs.map(async (txid) => {
      try {
        const answer: unknown = await es.get(`/tx/${txid}/outspends`);
        if (Array.isArray(answer)) {
          outspends.set(txid, answer);
        }
      } catch {
        // tolerated — the drop/rebroadcast rules below still apply
      }
    }),
  );
  let unconfirmed = false;
  for (const input of inputs) {
    if (!(input.txid instanceof Uint8Array) || input.index === undefined) {
      continue;
    }
    const entry = outspends.get(hex.encode(input.txid))?.[input.index];
    if (!isObject(entry) || entry["spent"] !== true || entry["txid"] === tx.hash) {
      continue;
    }
    const { status } = entry;
    if (isObject(status) && status["confirmed"] === true) {
      return "confirmed";
    }
    unconfirmed = true;
  }
  return unconfirmed ? "unconfirmed" : undefined;
};

export const fetchRawTxes = async (
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

/**
 * The account context every build shares: derivation data, both chains scanned, a fresh UTXO scan
 * filtered to spendable outpoints, and the change addresses. Called at send, replacement and CPFP
 * prepare alike, so a restart costs a rescan, never a capability.
 */
const accountContext = async (
  ctx: RouteContext,
  account: { walletId: string; groupIndex: number; template: BitcoinAccountTemplate },
  network: string,
  frozen: ReadonlySet<string>,
): Promise<SpendContext> => {
  const apis = ctx.options.chains ?? chains(ctx.options.wallet);
  const es = ctx.options.networks.esplora(network);
  const net = bitcoinNetwork(network);
  const { template } = account;
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
  const receive = await scanChain(es, xpub, template, network, net.params, 0);
  const change = await scanChain(es, xpub, template, network, net.params, 1);
  const addresses: ScanAddress[] = [...receive, ...change];
  const scannedUtxos: ReadonlyArray<ScanUtxo> = await scanUtxos(es, addresses, net.params);
  // A height-0 output pays through an unconfirmed transaction its sender can still revoke or
  // replace — spendable only when this wallet built that transaction (own unconfirmed change).
  const ownTxids = new Set(
    Object.values(ctx.txs()).flatMap((t) =>
      t.family === "bitcoin" &&
      t.btc !== undefined &&
      t.hash !== undefined &&
      (t.state === "submitted" || t.state === "pending" || t.state === "confirmed")
        ? [t.hash]
        : [],
    ),
  );
  const utxos = scannedUtxos.flatMap((u): BtcUtxo[] =>
    u.height > 0 || ownTxids.has(u.txid)
      ? [
          {
            txid: u.txid,
            vout: u.vout,
            value: u.value,
            address: u.address,
            status: u.height > 0 ? "confirmed" : "unconfirmed",
            height: u.height,
          },
        ]
      : [],
  );
  const byAddr = new Map(addresses.map((a) => [a.address, a]));
  const base = accountPath(path);
  // bip49/bip44 are spend-only — a send's change goes on the group's bip84 chain.
  let changeChain = change;
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
    changeChain = await scanChain(es, xpub84, "btc.bip84", network, net.params, 1);
  }
  return {
    template,
    groupIndex: account.groupIndex,
    network,
    fp,
    changeAddr: changeChain.find((a) => !a.used)?.address,
    changeAddresses: changeChain.filter((a) => !a.used).map((a) => a.address),
    candidates: utxos,
    spendable: selectableUtxos(utxos, net.params, frozen),
    pathOf: (u) => {
      const a = byAddr.get(u.address);
      return a === undefined ? [] : [...base, a.chain, a.index];
    },
    pubkeyOf: (u) => {
      const a = byAddr.get(u.address);
      if (a === undefined) {
        throw new Error(`utxo on an unknown address ${u.address}`);
      }
      return bitcoinPubkeyFromXpub(xpub, template, network, a.chain, a.index);
    },
    scriptOf: (u) => scriptPubKey(u.address, net.params),
  };
};

/** Per-controller route — the UTXO store is engine state. */
export const createBitcoinRoute = (): BitcoinRoute => {
  const bitcoin = new BitcoinChainAdapter();
  const bitcoinUtxos = new BtcUtxoStore();
  const bitcoinFrozen = new BtcFrozenStore();
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
  /** Transactions the primary endpoint does not know: since when, and the next rebroadcast. */
  const unseen = new Map<string, { since: number; attempt: number; next: number }>();

  /**
   * Esplora `/tx/:txid/status` → `confirmed`, or `undefined` to keep polling. While the endpoint
   * does not know the transaction (and no live replacement explains why) its persisted bytes are
   * rebroadcast with backoff; once neither endpoint has known it for {@link UNKNOWN_DROP_MS} it is
   * `dropped`.
   */
  const poll = async (ctx: RouteContext, tx: TrackedTransaction): Promise<TxState | undefined> => {
    if (tx.hash === undefined) {
      return "failed";
    }
    const { networks } = ctx.options;
    const es = networks.esplora(tx.network);
    let status: unknown;
    try {
      status = await es.get(`/tx/${tx.hash}/status`);
    } catch (error) {
      if (!(error instanceof EsploraError) || error.transient) {
        throw error;
      }
      return pollUnseen(ctx, tx, tx.hash, es);
    }
    unseen.delete(tx.id);
    return isObject(status) && status["confirmed"] === true ? "confirmed" : undefined;
  };

  const pollUnseen = async (
    ctx: RouteContext,
    tx: TrackedTransaction,
    txid: string,
    es: Esplora,
  ): Promise<TxState | undefined> => {
    // A live replacement evicts the original from the pool: it is expected to be unknown then.
    const replaced = Object.values(ctx.txs()).some(
      (t) => t.replaces === tx.id && (t.state === "submitted" || t.state === "pending"),
    );
    if (replaced) {
      unseen.delete(tx.id);
      return undefined;
    }
    // A foreign spend of any input explains the disappearance better than eviction does: mined
    // it settles the tracker; unconfirmed it only proves the bytes can never land.
    const conflict = await foreignSpend(es, tx);
    if (conflict === "confirmed") {
      unseen.delete(tx.id);
      return "replaced";
    }
    const now = ctx.options.now();
    const watch = unseen.get(tx.id) ?? { since: now, attempt: 0, next: now };
    unseen.set(tx.id, watch);
    if (now - watch.since >= UNKNOWN_DROP_MS) {
      const independent = ctx.options.networks.independentEsplora(tx.network);
      const elsewhere =
        independent.kind === "available" &&
        (await esploraKnows(independent.client, txid).catch(() => true));
      if (!elsewhere) {
        unseen.delete(tx.id);
        return "dropped";
      }
    }
    if (tx.raw !== undefined && now >= watch.next && conflict !== "unconfirmed") {
      await es.post("/tx", tx.raw).catch(() => undefined);
      watch.next = now + Math.min(RESUBMIT_BASE_MS * 2 ** watch.attempt, RESUBMIT_MAX_MS);
      watch.attempt += 1;
    }
    return undefined;
  };

  const prepare = async (
    ctx: RouteContext,
    params: PrepareParams,
    requestId: string,
    sparkDeposit?: SparkDepositTag,
  ): Promise<PreparedRequest> => {
    const { account, network, to, amount, fee, inputs: named } = params;
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
    const accountKey = `${account.walletId}:${String(account.groupIndex)}:${network}`;
    const frozen = new Set(bitcoinFrozen.frozenOf(accountKey));
    const built = await accountContext(
      ctx,
      { walletId: account.walletId, groupIndex: account.groupIndex, template },
      network,
      frozen,
    );
    // Named inputs are the exact coins this send spends — each must be an account candidate,
    // unfrozen and unheld. Naming an inscription-protected coin is the explicit opt-in that
    // automatic selection never grants.
    const source =
      named === undefined
        ? built.spendable
        : [...new Set(named)].map((outpoint) => {
            const utxo = built.candidates.find((u) => `${u.txid}:${String(u.vout)}` === outpoint);
            if (utxo === undefined) {
              throw new Error(`${outpoint} is not a spendable output of this account`);
            }
            if (frozen.has(outpoint)) {
              throw new Error(`${outpoint} is frozen`);
            }
            if (isHeld(outpoint)) {
              throw new Error(`${outpoint} is held by another transaction`);
            }
            return utxo;
          });
    const net = bitcoinNetwork(network);
    const rawTxes =
      template === "btc.bip44" ? await fetchRawTxes(es, source) : new Map<string, Uint8Array>();
    const rawTxOf = (u: { readonly txid: string }): Uint8Array | undefined => rawTxes.get(u.txid);
    const inputs = bitcoin.toInputs(
      source,
      built.fp,
      built.pathOf,
      built.pubkeyOf,
      built.scriptOf,
      template,
      template === "btc.bip44" ? rawTxOf : undefined,
    );
    const { changeAddr } = built;
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
    const { psbt: unsigned, inputs: selected } = bitcoin.buildPsbt(
      free,
      to,
      amount,
      BigInt(rate),
      changeAddr,
      net.params,
      named === undefined ? "default" : "all",
    );
    const selectedKeys = new Set(
      selected.map((i) => `${String(i.txid ?? "")}:${String(i.index ?? 0)}`),
    );
    const selectedUtxos = source.filter((u) => selectedKeys.has(`${u.txid}:${u.vout}`));
    // Reserve before the first post-selection await: a concurrent prepare must not see them.
    for (const key of selectedKeys) {
      reserved.set(key, requestId);
    }
    // Segwit v0 inputs prove their amounts through the full previous transaction (bip44 carried
    // it already for selection). Fetch it only for the inputs actually spent and attach it.
    let psbt = unsigned;
    if (template === "btc.bip49" || template === "btc.bip84") {
      try {
        const prevTxs = await fetchRawTxes(es, selectedUtxos);
        const parsed = Transaction.fromPSBT(unsigned);
        for (let i = 0; i < parsed.inputsLength; i++) {
          const { txid } = parsed.getInput(i);
          const raw = txid === undefined ? undefined : prevTxs.get(hex.encode(txid));
          if (raw === undefined) {
            throw new Error(`no raw transaction for input ${String(i)}`);
          }
          parsed.updateInput(i, { nonWitnessUtxo: raw });
          const chosen = selected[i];
          if (chosen !== undefined) {
            chosen.nonWitnessUtxo = raw;
          }
        }
        psbt = parsed.toPSBT(0);
      } catch (error) {
        for (const key of selectedKeys) {
          reserved.delete(key);
        }
        throw error;
      }
    }
    const txP = Transaction.fromPSBT(psbt);
    const ownScripts = new Set(
      built.changeAddresses.map((a) => hex.encode(scriptPubKey(a, net.params))),
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
    const vsize = estimateVsize(
      Array.from({ length: txP.inputsLength }, () => template),
      outValues.map((o) => o.address),
      net.params,
    );
    const inTotal = selectedUtxos.reduce((a, u) => a + u.value, 0);
    const outTotal = outValues.reduce((a, o) => a + o.value, 0);
    const id0 = newId(ctx.options.random);
    const tier: "fast" | "normal" | "slow" =
      fee === "fast" ? "fast" : fee === "slow" ? "slow" : "normal";
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
      template,
      groupIndex: account.groupIndex,
      tier,
    };
    if (independentRate !== undefined) {
      flags.push(
        exceedsNetworkCap(BigInt(record.feeRate), BigInt(Math.ceil(independentRate)))
          ? "fee-above-network"
          : undefined,
      );
    }
    flags.push(feeReachesAmount(BigInt(record.fee), amount) ? "fee-exceeds-amount" : undefined);

    const submit = async (
      verify: SendParams["verify"],
      commit: () => void,
    ): Promise<TrackedTransaction> => {
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
      let signed: ReturnType<typeof extractSigned>;
      try {
        const result = await apis.sign({ request, verify });
        tx = await ctx.transition(tx, { state: "signed" });
        signed = extractSigned(result);
        commit();
      } catch (error) {
        await failTx(ctx, tx, error);
        throw error;
      }
      return submitSigned(
        ctx,
        tx,
        esploraBroadcast(es, signed, {
          hold: () => {
            bitcoinUtxos.lock(selectedUtxos, id0);
            releaseReservation(requestId);
          },
          release: () => {
            bitcoinUtxos.endTx(id0, "failed");
          },
        }),
      );
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
    built: SpendContext,
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
        template: built.template,
      })),
    };
    const ownScripts = new Set(
      built.changeAddresses.map((a) =>
        hex.encode(scriptPubKey(a, bitcoinNetwork(built.network).params)),
      ),
    );
    const intent = decodeBitcoinPsbt(request, ownScripts);
    const txId = newId(ctx.options.random);
    for (const key of held) {
      reserved.set(key, requestId);
    }

    const submit = async (
      verify: SendParams["verify"],
      commit: () => void,
    ): Promise<TrackedTransaction> => {
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
      let signed: ReturnType<typeof extractSigned>;
      try {
        const result = await apis.sign({ request, verify });
        tx = await ctx.transition(tx, { state: "signed" });
        signed = extractSigned(result);
        commit();
      } catch (error) {
        await failTx(ctx, tx, error);
        throw error;
      }
      const asLocked = (inputs: ReadonlyArray<(typeof record.inputs)[number]>) =>
        inputs.map((i) => ({ ...i, status: "confirmed" as const, height: 0 }));
      return submitSigned(
        ctx,
        tx,
        esploraBroadcast(es, signed, {
          // A replacement spends every input of the original, so its lock moves them all over.
          hold: () => {
            bitcoinUtxos.lock(asLocked(record.inputs), txId);
            releaseReservation(requestId);
          },
          // Refused: the original still spends its inputs and keeps them.
          release: () => {
            bitcoinUtxos.endTx(txId, "failed");
            if (link.replaces !== undefined && old.btc !== undefined) {
              bitcoinUtxos.lock(asLocked(old.btc.inputs), old.id);
            }
          },
        }),
      );
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
    const { btc } = old;
    if (btc === undefined) {
      throw new Error("this transaction carries no build record");
    }
    const es = ctx.options.networks.esplora(old.network);
    const independent = ctx.options.networks.independentEsplora(old.network);
    const account = {
      kind: "hd" as const,
      walletId: old.account,
      groupIndex: btc.groupIndex,
      template: btc.template,
    };
    const frozen = new Set(
      bitcoinFrozen.frozenOf(`${old.account}:${String(btc.groupIndex)}:${old.network}`),
    );
    const built = await accountContext(ctx, account, old.network, frozen);
    const tiers = await feeTiers(es);
    const tierQuote = tiers.find((t) => t.tier === btc.tier) ?? tiers[1];
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
    const net = bitcoinNetwork(old.network);
    // BIP-125 rule 4 prices the replacement's own estimated size — every extra input raises the
    // floor — applied after the quote merge so a low quote cannot push the replacement under it.
    const feeFor = (
      numInputs: number,
      outs: ReadonlyArray<{ readonly address: string }>,
    ): number => {
      const vsize = estimateVsize(
        Array.from({ length: numInputs }, () => btc.template),
        outs.map((o) => o.address),
        net.params,
      );
      return Math.max(btc.fee + vsize, Math.ceil(vsize * rate));
    };
    // The bump's change goes where the original's went, when it had an own output.
    const changeAddr = btc.outputs.find((o) => o.own)?.address ?? built.changeAddresses[0];
    if (changeAddr === undefined) {
      throw new Error("no unused change address");
    }
    const inTotal = btc.inputs.reduce((a, i) => a + i.value, 0);
    const dust = 546;
    const payee = btc.outputs
      .filter((o) => !o.own)
      .map((o) => ({ address: o.address, amount: BigInt(o.value) }));
    const payeeSum = payee.reduce((a, o) => a + Number(o.amount), 0);
    const usedKeys = new Set(btc.inputs.map((i) => `${i.txid}:${i.vout}`));
    // Confirmed extras only: BIP-125 rule 2 forbids a replacement adding new unconfirmed inputs.
    // Freezes on the original's own inputs are ignored — they are already spent by it — and
    // `spendable` already excludes the account's frozen outpoints.
    const spare = built.spendable.filter(
      (u) => u.height > 0 && !usedKeys.has(`${u.txid}:${u.vout}`) && !isHeld(`${u.txid}:${u.vout}`),
    );
    const extraInputs: ReturnType<typeof bitcoin.toInputs> = [];
    const extraUtxos: typeof spare = [];
    let outputs: ReadonlyArray<{ readonly address: string; readonly amount: bigint }>;
    let newFee: number;
    if (mode === "cancel") {
      newFee = feeFor(btc.inputs.length, [{ address: changeAddr }]);
      // A cancel sweeps the inputs back to us; refuse rather than emit a negative or
      // sub-dust change output.
      if (inTotal - newFee < dust) {
        throw new Error("the inputs cannot pay the cancel fee");
      }
      outputs = [{ address: changeAddr, amount: BigInt(inTotal - newFee) }];
    } else {
      for (;;) {
        const numInputs = btc.inputs.length + extraUtxos.length;
        const inSum = inTotal + extraUtxos.reduce((a, u) => a + u.value, 0);
        // Prefer the shape with a change output; a sub-dust remainder folds into the fee.
        const leftover = inSum - payeeSum - feeFor(numInputs, [...payee, { address: changeAddr }]);
        if (leftover >= dust) {
          outputs = [...payee, { address: changeAddr, amount: BigInt(leftover) }];
          newFee = inSum - payeeSum - leftover;
          break;
        }
        const noChangeFee = feeFor(numInputs, payee);
        if (inSum - payeeSum - noChangeFee >= 0) {
          outputs = payee;
          newFee = inSum - payeeSum;
          break;
        }
        const next = spare[extraUtxos.length];
        if (next === undefined) {
          throw new Error("insufficient confirmed utxo to fund the replacement fee");
        }
        const key = `${next.txid}:${next.vout}`;
        extraUtxos.push(next);
        reserved.set(key, requestId);
        try {
          const raws =
            btc.template === "btc.bip86"
              ? new Map<string, Uint8Array>()
              : // oxlint-disable-next-line eslint/no-await-in-loop -- extras join one at a time.
                await fetchRawTxes(es, [next]);
          extraInputs.push(
            ...bitcoin.toInputs(
              [{ ...next, status: "confirmed" as const }],
              built.fp,
              built.pathOf,
              built.pubkeyOf,
              built.scriptOf,
              btc.template,
              (u) => raws.get(u.txid),
            ),
          );
        } catch (error) {
          extraUtxos.pop();
          reserved.delete(key);
          throw error;
        }
      }
    }
    // The replacement spends exactly the original's inputs plus any extras. The scan does not
    // list them — the unconfirmed original spends them already — so they are rebuilt from the
    // record, with their previous transactions attached for segwit v0.
    const prevRaws =
      btc.template === "btc.bip86"
        ? new Map<string, Uint8Array>()
        : await fetchRawTxes(es, btc.inputs);
    const oldInputs = bitcoin.toInputs(
      btc.inputs.map((i) => ({ ...i, status: "confirmed" as const, height: 1 })),
      built.fp,
      built.pathOf,
      built.pubkeyOf,
      built.scriptOf,
      btc.template,
      (u) => prevRaws.get(u.txid),
    );
    const allInputs = [...oldInputs, ...extraInputs];
    const { psbt, vsize } = bitcoin.buildExactPsbt(allInputs, outputs, net.params, btc.template);
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
      template: btc.template,
      groupIndex: btc.groupIndex,
      tier: btc.tier,
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
      built,
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
    const { btc } = old;
    if (btc === undefined) {
      throw new Error("this transaction carries no build record");
    }
    const es = ctx.options.networks.esplora(old.network);
    const independent = ctx.options.networks.independentEsplora(old.network);
    // A legacy parent's own outputs sit on the group's bip84 change chain, so the child is a
    // bip84 transaction — derived, signed and sized under that template.
    const childTemplate =
      btc.template === "btc.bip44" || btc.template === "btc.bip49" ? "btc.bip84" : btc.template;
    const account = {
      kind: "hd" as const,
      walletId: old.account,
      groupIndex: btc.groupIndex,
      template: childTemplate,
    };
    const frozen = new Set(
      bitcoinFrozen.frozenOf(`${old.account}:${String(btc.groupIndex)}:${old.network}`),
    );
    const built = await accountContext(ctx, account, old.network, frozen);
    const own = btc.outputs.flatMap((o, vout) => (o.own ? [{ ...o, vout }] : []));
    if (own.length === 0) {
      throw new Error("parent has no own outputs to bump");
    }
    const bumpable = own.filter((o) => !frozen.has(`${old.hash ?? ""}:${String(o.vout)}`));
    if (bumpable.length === 0) {
      throw new Error("the parent's own outputs are frozen");
    }
    const parentKeys = bumpable.map((o) => `${old.hash ?? ""}:${o.vout}`);
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
    if (old.hash === undefined) {
      throw new Error("the parent transaction has no broadcast hash");
    }
    const parentTxid = old.hash;
    const parentRaws =
      childTemplate === "btc.bip86"
        ? new Map<string, Uint8Array>()
        : await fetchRawTxes(es, [{ txid: parentTxid }]);
    // The child spends the parent's own unconfirmed outputs — that is what CPFP is for.
    const childInputs = bitcoin.toInputs(
      bumpable.map((o) => ({
        txid: parentTxid,
        vout: o.vout,
        value: o.value,
        address: o.address,
        status: "unconfirmed" as const,
        height: 0,
      })),
      built.fp,
      built.pathOf,
      built.pubkeyOf,
      built.scriptOf,
      childTemplate,
      (u) => parentRaws.get(u.txid),
    );
    const [changeAddr] = built.changeAddresses;
    if (changeAddr === undefined) {
      throw new Error("no unused change address");
    }
    const net = bitcoinNetwork(old.network);
    const inTotal = bumpable.reduce((a, o) => a + o.value, 0);
    const probe = bitcoin.buildExactPsbt(
      childInputs,
      [{ address: changeAddr, amount: BigInt(inTotal) }],
      net.params,
      childTemplate,
    );
    const childFee = Math.max(
      Math.ceil(targetRate * (btc.vsize + probe.vsize)) - btc.fee,
      probe.vsize,
    );
    const { psbt, vsize } = bitcoin.buildExactPsbt(
      childInputs,
      [{ address: changeAddr, amount: BigInt(inTotal - childFee) }],
      net.params,
      childTemplate,
    );
    const record = {
      inputs: bumpable.map((o) => ({
        txid: old.hash ?? "",
        vout: o.vout,
        value: o.value,
        address: o.address,
      })),
      outputs: [{ address: changeAddr, value: inTotal - childFee, own: true }],
      vsize,
      fee: childFee,
      feeRate: Math.ceil(childFee / vsize),
      template: childTemplate,
      groupIndex: btc.groupIndex,
      tier: btc.tier,
    };
    return prepareFinish(
      ctx,
      built,
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

  /**
   * A dApp-signed PSBT joins tracking like a wallet send: its signed bytes and locally computed
   * txid are persisted before anything leaves, its signed inputs are held under the tracked id, and
   * a definite node refusal fails it and frees them. It carries no `btc` record — it was not
   * wallet-built — so speed-up/CPFP refuse it and its outputs are nobody's own change.
   */
  const submitDapp = async (
    ctx: RouteContext,
    params: {
      readonly network: string;
      readonly walletId: string;
      readonly prepared: PreparedBitcoinPsbt;
      readonly result: SignResult;
    },
  ): Promise<string> => {
    const { network, walletId, prepared, result } = params;
    const es = ctx.options.networks.esplora(network);
    const signed = extractSigned(result);
    const net = bitcoinNetwork(network);
    const txP = Transaction.fromPSBT(prepared.request.psbt);
    const inputs = prepared.inputs.map(({ index }) => {
      const input = txP.getInput(index);
      const prev = input.witnessUtxo;
      if (input.txid === undefined || input.index === undefined || prev === undefined) {
        throw new Error(`signed input ${String(index)} carries no prevout`);
      }
      return {
        txid: hex.encode(input.txid),
        vout: input.index,
        value: Number(prev.amount),
        address: Address(net.params).encode(OutScript.decode(prev.script)),
        status: "confirmed" as const,
        height: 0,
      };
    });
    let tx: TrackedTransaction = {
      id: ctx.newId(),
      family: "bitcoin",
      network,
      account: walletId,
      hash: undefined,
      state: "signed",
      intent: decodeBitcoinPsbt(prepared.request, prepared.ownScripts),
      nonce: 0,
      submittedAt: ctx.options.now(),
      error: undefined,
    };
    tx = await ctx.transition(tx, {});
    await submitSigned(
      ctx,
      tx,
      esploraBroadcast(es, signed, {
        hold: () => {
          bitcoinUtxos.lock(inputs, tx.id);
        },
        release: () => {
          bitcoinUtxos.endTx(tx.id, "failed");
        },
      }),
    );
    return signed.txid;
  };

  return {
    prepare,
    nextReceiveAddress,
    poll,
    settle: (id, state) => {
      bitcoinUtxos.endTx(id, state === "confirmed" ? "confirmed" : "dropped");
    },
    prepareReplace,
    prepareCpfp,
    submitDapp,
    setUtxosFrozen: async (accountKey, outpoints, frozen) =>
      bitcoinFrozen.setFrozen(accountKey, outpoints, frozen),
    frozenUtxos: (accountKey) => bitcoinFrozen.frozenOf(accountKey),
    unlock: async (store) => {
      await bitcoinUtxos.unlock(store);
      await bitcoinFrozen.unlock(store);
    },
    lock: () => {
      reserved.clear();
      bitcoinUtxos.lockStore();
      bitcoinFrozen.lockStore();
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
  /**
   * A transaction that reached a terminal state frees the outputs it locked; a confirmed one's
   * inputs are spent and leave the lock table.
   */
  readonly settle: (id: string, state: TxState) => void;
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
  /** Tracks and broadcasts a dApp-signed PSBT like a wallet send; resolves its local txid. */
  readonly submitDapp: (
    ctx: RouteContext,
    params: {
      readonly network: string;
      readonly walletId: string;
      readonly prepared: PreparedBitcoinPsbt;
      readonly result: SignResult;
    },
  ) => Promise<string>;
  /**
   * Freeze or unfreeze outpoints (`txid:vout`) for the account key `walletId:groupIndex:network`. A
   * freeze is intent, not utxo state — the outpoint need not exist — and it never lifts the derived
   * inscription protection.
   */
  readonly setUtxosFrozen: (
    accountKey: string,
    outpoints: ReadonlyArray<string>,
    frozen: boolean,
  ) => Promise<void>;
  /** The outpoints the account froze. */
  readonly frozenUtxos: (accountKey: string) => ReadonlyArray<string>;
};
