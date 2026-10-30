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

const windowUsed = async (
  es: Esplora,
  params: typeof BTC_NETWORK,
  addrs: ReadonlyArray<ScanAddress>,
): Promise<ReadonlyArray<boolean>> =>
  addrs.reduce<Promise<ReadonlyArray<boolean>>>(
    async (p, a) =>
      p.then(async (acc) => {
        await new Promise((r) => setTimeout(r, 150));
        const txs = await es.get(`/scripthash/${scripthash(a.address, params)}/txs`);
        return [...acc, Array.isArray(txs) && txs.length > 0];
      }),
    Promise.resolve([]),
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
    const parsed: unknown =
      raw === undefined ? undefined : JSON.parse(new TextDecoder().decode(raw));
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
  if (status !== "confirmed" && status !== "locked" && status !== "frozen") {
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
        ? new Map<string, LockedUtxo>()
        : new Map<string, LockedUtxo>(
            Object.entries(
              ((): Record<string, LockedUtxo> => {
                const rawParsed: unknown = JSON.parse(new TextDecoder().decode(raw));
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
