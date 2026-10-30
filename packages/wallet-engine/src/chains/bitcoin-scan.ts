/**
 * Gap-20 BIP-44/86 account scanning over Esplora — derives /0/* and /1/* from the account xpub,
 * walks each chain in windows until 20 consecutive unused addresses, persists the discovered
 * addresses/txs/UTXOs in EngineStore (rebuildable from a rescan), and exposes the next unused
 * receive/change address.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Address, OutScript } from "@scure/btc-signer";
import type { NETWORK as BTC_NETWORK } from "@scure/btc-signer";

import type { BitcoinAccountTemplate } from "@qntx/wallet-chains/bitcoin";
import { bitcoinAddressFromXpub } from "@qntx/wallet-chains/bitcoin";

import type { EngineStore } from "../store/port.ts";
import type { Esplora } from "./bitcoin.ts";

const GAP = 20;
const COLL = "btc-scan";

export type BtcChain = 0 | 1;

export type ScanAddress = {
  readonly chain: BtcChain;
  readonly index: number;
  readonly address: string;
  readonly used: boolean;
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

/** The scriptPubKey bytes of a bech32/base58 address on `network`. */
export const scriptPubKey = (address: string, network: typeof BTC_NETWORK): Uint8Array =>
  OutScript.encode(Address(network).decode(address));

/** Electrum-order scripthash: sha256 of the scriptPubKey, digest reversed. */
export const scripthash = (address: string, network: typeof BTC_NETWORK): string => {
  const decoded = Address(network).decode(address);
  const script = OutScript.encode(decoded);
  const h = sha256(script);
  return [...h]
    .reverse()
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const windowUsed = async (
  es: Esplora,
  params: typeof BTC_NETWORK,
  addrs: ReadonlyArray<ScanAddress>,
): Promise<ReadonlyArray<boolean>> =>
  Promise.all(
    addrs.map(async (a) => {
      const txs = await es.get(`/scripthash/${scripthash(a.address, params)}/txs`);
      return Array.isArray(txs) && txs.length > 0;
    }),
  );

export const scanChain = async (
  es: Esplora,
  xpub: string,
  template: BitcoinAccountTemplate,
  network: string,
  params: typeof BTC_NETWORK,
  chain: BtcChain,
  start = 0,
): Promise<ReadonlyArray<ScanAddress>> => {
  const batch: ScanAddress[] = Array.from({ length: GAP }, (_, i) => {
    const index = start + i;
    return {
      chain,
      index,
      address: bitcoinAddressFromXpub(xpub, template, network, chain, index),
      used: false,
    };
  });
  const used = await windowUsed(es, params, batch);
  const marked = batch.map((a, i) => ({
    chain: a.chain,
    index: a.index,
    address: a.address,
    used: used[i] === true,
  }));
  if (!marked.some((a) => a.used)) {
    return marked;
  }
  const rest = await scanChain(es, xpub, template, network, params, chain, start + GAP);
  return [...marked, ...rest];
};

const scanAddressUtxos = async (
  es: Esplora,
  a: ScanAddress,
  params: typeof BTC_NETWORK,
): Promise<ReadonlyArray<ScanUtxo>> => {
  const utxos = await es.get(`/scripthash/${scripthash(a.address, params)}/utxo`);
  if (!Array.isArray(utxos)) {
    return [];
  }
  return utxos.flatMap((u: unknown): ScanUtxo[] => {
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
  const candidates = addresses.filter((a) => a.used || a.chain === 1 || a.index < GAP);
  return Promise.all(candidates.map(async (a) => scanAddressUtxos(es, a, params))).then((r) =>
    r.flat(),
  );
};

export class BitcoinScanStore {
  private engineStore: EngineStore | undefined;

  async unlock(store: EngineStore): Promise<ScanState | undefined> {
    this.engineStore = store;
    const raw = await store.collection(COLL).get("state");
    return raw === undefined ? undefined : (JSON.parse(new TextDecoder().decode(raw)) as ScanState);
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

/** Persistent UTXO lock/spent lifecycle — locked by an in-flight tx, released or spent at its end. */
export type LockedUtxo = ScanUtxo & {
  readonly status: "confirmed" | "locked" | "frozen";
  readonly txId?: string;
};

export class BtcUtxoStore {
  private engineStore: EngineStore | undefined;
  private utxos = new Map<string, LockedUtxo>();

  async unlock(store: EngineStore): Promise<void> {
    this.engineStore = store;
    const raw = await store.collection("btc-utxos").get("state");
    this.utxos =
      raw === undefined
        ? new Map()
        : new Map(
            Object.entries(JSON.parse(new TextDecoder().decode(raw)) as Record<string, LockedUtxo>),
          );
  }

  private async persist(): Promise<void> {
    const store = this.engineStore;
    if (store !== undefined) {
      await store
        .collection("btc-utxos")
        .put("state", new TextEncoder().encode(JSON.stringify(Object.fromEntries(this.utxos))));
    }
  }

  private static key(u: { txid: string; vout: number }): string {
    return `${u.txid}:${u.vout}`;
  }

  replace(utxos: ReadonlyArray<ScanUtxo>): void {
    const locked = [...this.utxos.entries()].filter(
      ([, u]) => u.status === "locked" || u.status === "frozen",
    );
    this.utxos = new Map(
      utxos.map((u) => [BtcUtxoStore.key(u), { ...u, status: "confirmed" as const }]),
    );
    for (const [k, u] of locked) {
      this.utxos.set(k, u);
    }
  }

  lock(utxos: ReadonlyArray<ScanUtxo>, txId: string): void {
    for (const u of utxos) {
      this.utxos.set(BtcUtxoStore.key(u), { ...u, status: "locked", txId });
    }
    void this.persist();
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
          const { txId: _t, ...rest } = u;
          this.utxos.set(k, { ...rest, status: "confirmed" });
        }
      }
    }
    void this.persist();
  }

  spendable(): ReadonlyArray<LockedUtxo> {
    return [...this.utxos.values()].filter(
      (u) => u.status === "confirmed" && !(u.value === 546 || u.value === 330),
    );
  }

  frozen(): ReadonlyArray<LockedUtxo> {
    return [...this.utxos.values()].filter(
      (u) => u.status === "frozen" || u.value === 546 || u.value === 330,
    );
  }

  all(): ReadonlyArray<LockedUtxo> {
    return [...this.utxos.values()];
  }

  lockStore(): void {
    this.engineStore = undefined;
  }
}
