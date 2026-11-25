/**
 * Gap-20 BIP-44/86 account scanning over Esplora — derives /0/* and /1/* from the account xpub,
 * walks each chain in windows until 20 consecutive unused addresses, persists the discovered
 * addresses/txs/UTXOs in EngineStore (rebuildable from a rescan), and exposes the next unused
 * receive/change address.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Address, OutScript } from "@scure/btc-signer";
import type { NETWORK as BTC_NETWORK } from "@scure/btc-signer";

import { ChainError } from "@qntx/wallet-chains";
import type { BitcoinAccountTemplate } from "@qntx/wallet-chains/bitcoin";
import {
  BITCOIN_GAP_LIMIT,
  BITCOIN_SCAN_LIMIT,
  bitcoinAddressFromXpub,
  changeScanReach,
} from "@qntx/wallet-chains/bitcoin";

import type { EngineLogger } from "../events.ts";
import { readJson } from "../store/json.ts";
import type { EngineStore } from "../store/port.ts";
import type { Esplora } from "./bitcoin.ts";

const COLL = "btc-scan";

export type BtcChain = 0 | 1;

export type ScanAddress = {
  readonly chain: BtcChain;
  readonly index: number;
  readonly address: string;
  readonly used: boolean;
};

export type ScannedAddress = ScanAddress & {
  /** The address's Esplora `/txs` page — mempool rows first, confirmed newest first. */
  readonly txs: ReadonlyArray<unknown>;
};

export type ScanUtxo = {
  readonly txid: string;
  readonly vout: number;
  readonly value: number;
  readonly address: string;
  readonly height: number;
};

export type ScanState = {
  readonly addresses: ReadonlyArray<ScanAddress>;
  readonly utxos: ReadonlyArray<ScanUtxo>;
  readonly scannedAt: number;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isUnknownArray = (v: unknown): v is ReadonlyArray<unknown> => Array.isArray(v);
const asArray = (v: unknown): ReadonlyArray<unknown> => (isUnknownArray(v) ? v : []);

/** The scriptPubKey bytes of a bech32/base58 address on `network`. */
export const scriptPubKey = (address: string, network: typeof BTC_NETWORK): Uint8Array =>
  OutScript.encode(Address(network).decode(address));

/** Esplora scripthash: sha256 of the scriptPubKey, digest hex as-is (verified vs electrs REST). */
export const scripthash = (address: string, network: typeof BTC_NETWORK): string =>
  [...sha256(OutScript.encode(Address(network).decode(address)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export const hexOf = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const windowTxs = async (
  es: Esplora,
  params: typeof BTC_NETWORK,
  addrs: ReadonlyArray<ScanAddress>,
): Promise<ReadonlyArray<ReadonlyArray<unknown>>> =>
  Promise.all(
    addrs.map(async (a) => {
      const txs: unknown = await es.get(`/scripthash/${scripthash(a.address, params)}/txs`);
      return isUnknownArray(txs) ? txs : [];
    }),
  );

/**
 * Gap-limited chain scan covering at least `[0, reach]`: windows of `BITCOIN_GAP_LIMIT` stop after
 * the first all-unused window — unless the sealed mark's reach is not yet covered, in which case
 * tail windows (the last one truncated at `reach`) keep walking; a used address in the tail resumes
 * the gap rule from there. The `BITCOIN_SCAN_LIMIT` bound caps the total work.
 */
const scanChainWithHistory = async (
  es: Esplora,
  xpub: string,
  template: BitcoinAccountTemplate,
  network: string,
  params: typeof BTC_NETWORK,
  chain: BtcChain,
  reach: number,
): Promise<ReadonlyArray<ScannedAddress>> => {
  const scanned: ScannedAddress[] = [];
  let tail = false;
  for (let start = 0; ;) {
    const end = tail ? Math.min(start + BITCOIN_GAP_LIMIT, reach + 1) : start + BITCOIN_GAP_LIMIT;
    if (end <= start) {
      return scanned;
    }
    if (end > BITCOIN_SCAN_LIMIT) {
      throw new Error(`bitcoin address scan exceeded ${BITCOIN_SCAN_LIMIT} addresses`);
    }
    const batch: ScanAddress[] = Array.from({ length: end - start }, (_, i) => {
      const index = start + i;
      return {
        chain,
        index,
        address: bitcoinAddressFromXpub(xpub, template, network, chain, index),
        used: false,
      };
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- whether to scan the next window depends on this one.
    const pages = await windowTxs(es, params, batch);
    const marked = batch.map((a, i): ScannedAddress => ({
      chain: a.chain,
      index: a.index,
      address: a.address,
      used: (pages[i]?.length ?? 0) > 0,
      txs: pages[i] ?? [],
    }));
    scanned.push(...marked);
    if (marked.some((a) => a.used)) {
      tail = false;
    } else {
      if (end > reach) {
        return scanned;
      }
      tail = true;
    }
    start = end;
  }
};

export const scanChain = async (
  es: Esplora,
  xpub: string,
  template: BitcoinAccountTemplate,
  network: string,
  params: typeof BTC_NETWORK,
  chain: BtcChain,
  reach = -1,
): Promise<ReadonlyArray<ScanAddress>> => {
  const scanned = await scanChainWithHistory(es, xpub, template, network, params, chain, reach);
  return scanned.map(({ chain, index, address, used }) => ({ chain, index, address, used }));
};

const scanAddressUtxos = async (
  es: Esplora,
  a: ScanAddress,
  params: typeof BTC_NETWORK,
): Promise<ReadonlyArray<ScanUtxo>> => {
  const utxos: unknown = await es.get(`/scripthash/${scripthash(a.address, params)}/utxo`);
  return asArray(utxos).flatMap((u): ScanUtxo[] => {
    const o = isObject(u) ? u : {};
    const status = isObject(o["status"]) ? o["status"] : {};
    const txid = typeof o["txid"] === "string" ? o["txid"] : "";
    if (txid === "") {
      return [];
    }
    return [
      {
        txid,
        vout: typeof o["vout"] === "number" ? o["vout"] : 0,
        value: typeof o["value"] === "number" ? o["value"] : 0,
        address: a.address,
        height: typeof status["block_height"] === "number" ? status["block_height"] : 0,
      },
    ];
  });
};

export const scanUtxos = async (
  es: Esplora,
  addresses: ReadonlyArray<ScanAddress>,
  params: typeof BTC_NETWORK,
): Promise<ReadonlyArray<ScanUtxo>> => {
  const candidates = addresses.filter(
    (a) => a.used || a.chain === 1 || a.index < BITCOIN_GAP_LIMIT,
  );
  return Promise.all(candidates.map(async (a) => scanAddressUtxos(es, a, params))).then((r) =>
    r.flat(),
  );
};

/** Esplora truncates `/txs` at 50 mempool + 25 confirmed rows — a full page may hide history. */
const TX_PAGE_MEMPOOL = 50;
const TX_PAGE_CONFIRMED = 25;
const HEX = /^[0-9a-f]+$/;

type HistoryVin = { readonly txid: string; readonly vout: number };
type HistoryTx = {
  readonly txid: string;
  readonly vin: ReadonlyArray<HistoryVin>;
  readonly vout: ReadonlyArray<{ readonly scriptpubkey: string; readonly value: number }>;
  readonly confirmed: boolean;
  readonly blockHeight: number | undefined;
};

const historyTx = (v: unknown): HistoryTx | undefined => {
  if (
    !isObject(v) ||
    typeof v["txid"] !== "string" ||
    !Array.isArray(v["vin"]) ||
    !Array.isArray(v["vout"]) ||
    !isObject(v["status"])
  ) {
    return undefined;
  }
  const vins: HistoryVin[] = [];
  for (const vin of v["vin"]) {
    if (!isObject(vin)) {
      return undefined;
    }
    if (vin["is_coinbase"] === true) {
      continue;
    }
    if (typeof vin["txid"] !== "string" || typeof vin["vout"] !== "number") {
      return undefined;
    }
    vins.push({ txid: vin["txid"], vout: vin["vout"] });
  }
  const vouts: Array<{ scriptpubkey: string; value: number }> = [];
  for (const out of v["vout"]) {
    if (!isObject(out)) {
      return undefined;
    }
    const spk = out["scriptpubkey"];
    if (typeof spk !== "string" || !HEX.test(spk) || typeof out["value"] !== "number") {
      return undefined;
    }
    vouts.push({ scriptpubkey: spk, value: out["value"] });
  }
  const { status } = v;
  return {
    txid: v["txid"],
    vin: vins,
    vout: vouts,
    confirmed: status["confirmed"] === true,
    blockHeight: typeof status["block_height"] === "number" ? status["block_height"] : undefined,
  };
};

/**
 * The page is derivable only when Esplora could not have truncated it AND every row is well-formed:
 * a txid string, `vin` rows carrying txid/vout (coinbase rows exempt), `vout` rows carrying a hex
 * scriptpubkey and a numeric value, and a `status` object. A duplicated txid or a tx spending one
 * outpoint twice marks the page unsafe — Esplora never serves either.
 */
const safeHistory = (txs: ReadonlyArray<unknown>): ReadonlyArray<HistoryTx> | undefined => {
  const parsed: HistoryTx[] = [];
  const seenTxids = new Set<string>();
  let confirmed = 0;
  let mempool = 0;
  for (const t of txs) {
    const tx = historyTx(t);
    if (tx === undefined || seenTxids.has(tx.txid)) {
      return undefined;
    }
    seenTxids.add(tx.txid);
    if (tx.confirmed) {
      confirmed += 1;
    } else {
      mempool += 1;
    }
    const spentHere = new Set<string>();
    for (const v of tx.vin) {
      const key = `${v.txid}:${String(v.vout)}`;
      if (spentHere.has(key)) {
        return undefined;
      }
      spentHere.add(key);
    }
    parsed.push(tx);
  }
  if (confirmed >= TX_PAGE_CONFIRMED || mempool >= TX_PAGE_MEMPOOL) {
    return undefined;
  }
  return parsed;
};

/**
 * Derives each candidate's UTXO set from the `/txs` pages the scan already fetched — the same
 * candidate filter as {@link scanUtxos}. An empty history means no UTXOs and no call. A complete,
 * well-formed page derives: outputs paying the address's scriptPubKey that no vin in the page
 * spends; height is `status.block_height` for confirmed rows, 0 otherwise. Anything else —
 * truncated, malformed, duplicated — falls back to `/scripthash/:h/utxo` parsed like scanUtxos.
 */
export const utxosFromHistory = async (
  es: Esplora,
  scanned: ReadonlyArray<ScannedAddress>,
  params: typeof BTC_NETWORK,
): Promise<ReadonlyArray<ScanUtxo>> => {
  const candidates = scanned.filter((a) => a.used || a.chain === 1 || a.index < BITCOIN_GAP_LIMIT);
  return Promise.all(
    candidates.map(async (a): Promise<ReadonlyArray<ScanUtxo>> => {
      if (a.txs.length === 0) {
        return [];
      }
      const history = safeHistory(a.txs);
      if (history === undefined) {
        return scanAddressUtxos(es, a, params);
      }
      const script = hexOf(scriptPubKey(a.address, params));
      const spent = new Set(
        history.flatMap((tx) => tx.vin.map((v) => `${v.txid}:${String(v.vout)}`)),
      );
      return history.flatMap((tx) =>
        tx.vout.flatMap((o, vout): ScanUtxo[] =>
          o.scriptpubkey === script && !spent.has(`${tx.txid}:${String(vout)}`)
            ? [
                {
                  txid: tx.txid,
                  vout,
                  value: o.value,
                  address: a.address,
                  height: tx.confirmed ? (tx.blockHeight ?? 0) : 0,
                },
              ]
            : [],
        ),
      );
    }),
  ).then((r) => r.flat());
};

export const BITCOIN_TEMPLATES = ["btc.bip44", "btc.bip49", "btc.bip84", "btc.bip86"] as const;

/**
 * What a Bitcoin balance is read from: one account template's xpub, or one watched address.
 * `changeMark` is the sealed mark the change chain must reach past — a watch-only xpub has none
 * (0).
 */
export type BitcoinSource =
  | {
      readonly kind: "xpub";
      readonly template: BitcoinAccountTemplate;
      readonly xpub: string;
      readonly changeMark: number;
    }
  | { readonly kind: "address"; readonly address: string };

/**
 * The scanned addresses plus each address's `/txs` page — the read path derives UTXOs from this
 * history without asking `/utxo` again. Both chains are always walked: a used change output can sit
 * under a fully-unused receive chain, and the change chain is walked to `changeScanReach(mark)` so
 * every change output the kernel could have hidden is covered.
 */
export const scanSourceWithHistory = async (
  es: Esplora,
  source: BitcoinSource,
  network: string,
  params: typeof BTC_NETWORK,
): Promise<ReadonlyArray<ScannedAddress>> => {
  if (source.kind === "address") {
    try {
      Address(params).decode(source.address);
    } catch {
      throw new TypeError(`${source.address} is not a bitcoin address on ${network}`);
    }
    const txs: unknown = await es.get(`/scripthash/${scripthash(source.address, params)}/txs`);
    return [
      {
        chain: 0,
        index: 0,
        address: source.address,
        used: true,
        txs: isUnknownArray(txs) ? txs : [],
      },
    ];
  }
  const receive = await scanChainWithHistory(
    es,
    source.xpub,
    source.template,
    network,
    params,
    0,
    -1,
  );
  const change = await scanChainWithHistory(
    es,
    source.xpub,
    source.template,
    network,
    params,
    1,
    changeScanReach(source.changeMark),
  );
  return [...receive, ...change];
};

/** The addresses to read: the xpub's gap-scanned receive and change chains, or the address itself. */
export const scanSource = async (
  es: Esplora,
  source: BitcoinSource,
  network: string,
  params: typeof BTC_NETWORK,
): Promise<ReadonlyArray<ScanAddress>> => {
  if (source.kind === "address") {
    try {
      Address(params).decode(source.address);
    } catch {
      throw new TypeError(`${source.address} is not a bitcoin address on ${network}`);
    }
    return [{ chain: 0, index: 0, address: source.address, used: true }];
  }
  const scanned = await scanSourceWithHistory(es, source, network, params);
  return scanned.map(({ chain, index, address, used }) => ({ chain, index, address, used }));
};

export class BitcoinScanStore {
  private engineStore: EngineStore | undefined;

  async unlock(store: EngineStore): Promise<ScanState | undefined> {
    this.engineStore = store;
    const raw = await store.collection(COLL).get("state");
    const parsed: unknown = raw === undefined ? undefined : readJson(raw);
    if (
      !isObject(parsed) ||
      !Array.isArray(parsed["addresses"]) ||
      !Array.isArray(parsed["utxos"])
    ) {
      return undefined;
    }
    const state: ScanState = {
      addresses: asArray(parsed["addresses"]).flatMap((a) => toScanAddress(a)),
      utxos: asArray(parsed["utxos"]).flatMap((u) => toScanUtxo(u)),
      scannedAt: typeof parsed["scannedAt"] === "number" ? parsed["scannedAt"] : 0,
    };
    return state;
  }

  async persist(state: ScanState): Promise<void> {
    const store = this.engineStore;
    if (store !== undefined) {
      await store.collection(COLL).put("state", new TextEncoder().encode(JSON.stringify(state)));
    }
  }

  nextUnused(state: ScanState, chain: BtcChain): ScanAddress | undefined {
    return state.addresses.find((a) => a.chain === chain && !a.used);
  }

  lock(): void {
    this.engineStore = undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

const toScanAddress = (v: unknown): ScanAddress[] => {
  if (!isObject(v)) {
    return [];
  }
  const chain = num(v["chain"]);
  const index = num(v["index"]);
  const address = str(v["address"]);
  const used = v["used"] === true;
  return chain !== undefined &&
    index !== undefined &&
    address !== undefined &&
    (chain === 0 || chain === 1)
    ? [{ chain: chain === 0 ? (0 as const) : (1 as const), index, address, used }]
    : [];
};

const toScanUtxo = (v: unknown): ScanUtxo[] => {
  if (!isObject(v)) {
    return [];
  }
  const txid = str(v["txid"]);
  const vout = num(v["vout"]);
  const value = num(v["value"]);
  const address = str(v["address"]);
  const height = num(v["height"]);
  return txid !== undefined && vout !== undefined && value !== undefined && address !== undefined
    ? [{ txid, vout, value, address, height: height ?? 0 }]
    : [];
};

const toLockedUtxo = (v: unknown): LockedUtxo | undefined => {
  const [base] = toScanUtxo(v);
  if (base === undefined || !isObject(v)) {
    return undefined;
  }
  const status = str(v["status"]);
  const txId = str(v["txId"]);
  if (status !== "confirmed" && status !== "locked") {
    return undefined;
  }
  const locked: LockedUtxo =
    txId === undefined
      ? {
          txid: base.txid,
          vout: base.vout,
          value: base.value,
          address: base.address,
          height: base.height,
          status,
        }
      : {
          txid: base.txid,
          vout: base.vout,
          value: base.value,
          address: base.address,
          height: base.height,
          status,
          txId,
        };
  return locked;
};

/** Persistent UTXO lock/spent lifecycle — locked by an in-flight tx, released or spent at its end. */
export type LockedUtxo = ScanUtxo & {
  readonly status: "confirmed" | "locked";
  readonly txId?: string;
};

export class BtcUtxoStore {
  private engineStore: EngineStore | undefined;
  private logger: EngineLogger | undefined;
  private utxos = new Map<string, LockedUtxo>();
  private readonly queue: Uint8Array[] = [];
  private draining = false;

  async unlock(store: EngineStore, logger: EngineLogger): Promise<void> {
    this.engineStore = store;
    this.logger = logger;
    const raw = await store.collection("btc-utxos").get("state");
    this.utxos =
      raw === undefined
        ? new Map<string, LockedUtxo>()
        : new Map<string, LockedUtxo>(
            Object.entries(
              ((): Record<string, LockedUtxo> => {
                const rawParsed = readJson(raw);
                const parsed = isObject(rawParsed) ? rawParsed : {};
                const pairs: ReadonlyArray<readonly [string, LockedUtxo]> = Object.entries(
                  parsed,
                ).flatMap(([k, v]) => {
                  const u = toLockedUtxo(v);
                  return u === undefined ? [] : [[k, u] as const];
                });
                return Object.fromEntries(pairs);
              })(),
            ),
          );
  }

  /**
   * Snapshot writes are serialized through a FIFO drain in issue order — a slow earlier write can
   * never land after a newer snapshot. Each write carries the full snapshot taken at call time, so
   * a failed write (logged, never thrown) is repaired by the next successful one; in-memory state
   * is authoritative for the session either way.
   */
  private persist(): void {
    this.queue.push(new TextEncoder().encode(JSON.stringify(Object.fromEntries(this.utxos))));
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    for (;;) {
      const payload = this.queue.shift();
      if (payload === undefined) {
        break;
      }
      const store = this.engineStore;
      if (store === undefined) {
        continue;
      }
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- writes must land in issue order
        await store.collection("btc-utxos").put("state", payload);
      } catch (error) {
        this.logger?.warn("btc-utxos snapshot write failed", error);
      }
    }
    this.draining = false;
  }

  private static key(u: { txid: string; vout: number }): string {
    return `${u.txid}:${u.vout}`;
  }

  replace(utxos: ReadonlyArray<ScanUtxo>): void {
    const locked = [...this.utxos.entries()].filter(([, u]) => u.status === "locked");
    this.utxos = new Map(
      utxos.map((u) => [
        BtcUtxoStore.key(u),
        {
          txid: u.txid,
          vout: u.vout,
          value: u.value,
          address: u.address,
          height: u.height,
          status: "confirmed" as const,
        },
      ]),
    );
    for (const [k, u] of locked) {
      this.utxos.set(k, u);
    }
  }

  lock(utxos: ReadonlyArray<ScanUtxo>, txId: string): void {
    for (const u of utxos) {
      this.utxos.set(BtcUtxoStore.key(u), {
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        address: u.address,
        height: u.height,
        status: "locked",
        txId,
      });
    }
    this.persist();
  }

  /**
   * Re-locks a live transaction's inputs on restart — the durable `btc.inputs` record outlives a
   * lost snapshot write, so its spend must stay unselectable. Gap-fill only: an input already
   * locked under any tx id keeps its owner.
   */
  restoreLocks(txId: string, inputs: ReadonlyArray<ScanUtxo>): void {
    let changed = false;
    for (const u of inputs) {
      const key = BtcUtxoStore.key(u);
      if (this.utxos.get(key)?.status === "locked") {
        continue;
      }
      this.utxos.set(key, {
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        address: u.address,
        height: u.height,
        status: "locked",
        txId,
      });
      changed = true;
    }
    if (changed) {
      this.persist();
    }
  }

  /** True while a pending request or an unconfirmed transaction holds this output. */
  isLocked(u: { txid: string; vout: number }): boolean {
    return this.utxos.get(BtcUtxoStore.key(u))?.status === "locked";
  }

  /** Released on failed/rejected/dropped; spent-removed on confirmed. */
  endTx(txId: string, final: "confirmed" | "failed" | "rejected" | "dropped"): void {
    if (final === "confirmed") {
      for (const [k, u] of this.utxos) {
        if (u.txId === txId) {
          this.utxos.delete(k);
        }
      }
    } else {
      for (const [k, u] of this.utxos) {
        if (u.txId === txId && u.status === "locked") {
          this.utxos.set(k, {
            txid: u.txid,
            vout: u.vout,
            value: u.value,
            address: u.address,
            height: u.height,
            status: "confirmed",
          });
        }
      }
    }
    this.persist();
  }

  all(): ReadonlyArray<LockedUtxo> {
    return [...this.utxos.values()];
  }

  lockStore(): void {
    this.engineStore = undefined;
  }
}

const OUTPOINT = /^[0-9a-f]{64}:\d+$/;

/** A `txid:vout` string — the txid is 64 lowercase hex digits, the vout a safe integer. */
export const isOutpoint = (v: string): boolean =>
  OUTPOINT.test(v) && Number.isSafeInteger(Number(v.slice(65)));

/**
 * The outpoints the user froze, per account key `walletId:groupIndex:network` — one record per key
 * in the "btc-frozen" collection holding a JSON array. A freeze is intent, not utxo state: the
 * outpoint need not exist and a frozen coin that disappears simply never matches. Freezing is
 * separate from the derived inscription protection — unfreezing never unprotects.
 */
export class BtcFrozenStore {
  private engineStore: EngineStore | undefined;
  private frozen = new Map<string, Set<string>>();

  async unlock(store: EngineStore): Promise<void> {
    this.engineStore = store;
    const col = store.collection("btc-frozen");
    const next = new Map<string, Set<string>>();
    // A malformed record reads as an empty set — the next write replaces it.
    const keys = await col.list();
    const raws = await Promise.all(keys.map(async (key) => [key, await col.get(key)] as const));
    for (const [key, raw] of raws) {
      const parsed = raw === undefined ? undefined : readJson(raw);
      const list = Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string" && isOutpoint(v))
        : [];
      next.set(key, new Set(list));
    }
    this.frozen = next;
  }

  private async persist(accountKey: string): Promise<void> {
    const store = this.engineStore;
    if (store !== undefined) {
      await store
        .collection("btc-frozen")
        .put(
          accountKey,
          new TextEncoder().encode(JSON.stringify([...(this.frozen.get(accountKey) ?? [])])),
        );
    }
  }

  /** The outpoints the account froze. */
  frozenOf(accountKey: string): ReadonlyArray<string> {
    return [...(this.frozen.get(accountKey) ?? [])];
  }

  isFrozen(accountKey: string, outpoint: string): boolean {
    return this.frozen.get(accountKey)?.has(outpoint) ?? false;
  }

  async setFrozen(
    accountKey: string,
    outpoints: ReadonlyArray<string>,
    frozen: boolean,
  ): Promise<void> {
    for (const outpoint of outpoints) {
      if (!isOutpoint(outpoint)) {
        throw new ChainError("invalid-request", `${outpoint} is not a valid outpoint`);
      }
    }
    const set = new Set(this.frozen.get(accountKey));
    for (const outpoint of outpoints) {
      if (frozen) {
        set.add(outpoint);
      } else {
        set.delete(outpoint);
      }
    }
    this.frozen.set(accountKey, set);
    await this.persist(accountKey);
  }

  lockStore(): void {
    this.engineStore = undefined;
    this.frozen = new Map();
  }
}
