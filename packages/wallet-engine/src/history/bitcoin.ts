import * as z from "zod/mini";

import { bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import type { BitcoinAccountTemplate } from "@qntx/wallet-chains/bitcoin";

import { BITCOIN_TEMPLATES, scanSource, scripthash } from "../chains/bitcoin-scan.ts";
import type { BitcoinSource } from "../chains/bitcoin-scan.ts";
import type { Esplora } from "../chains/bitcoin.ts";
import type { Stream } from "./merge.ts";
import type { HistoryEntry } from "./types.ts";

const PAGE = 25;
const CHAIN_PAGES_MAX = 20;

const esploraTx = z.looseObject({
  txid: z.string(),
  fee: z.number(),
  vin: z.array(
    z.looseObject({
      prevout: z.union([
        z.looseObject({
          scriptpubkey_address: z.optional(z.string()),
          value: z.number(),
        }),
        z.null(),
      ]),
    }),
  ),
  vout: z.array(
    z.looseObject({
      scriptpubkey_address: z.optional(z.string()),
      value: z.number(),
    }),
  ),
  status: z.looseObject({
    confirmed: z.boolean(),
    block_height: z.optional(z.number()),
    block_time: z.optional(z.number()),
  }),
});

export type EsploraTx = z.output<typeof esploraTx>;

const fetchPage = async (es: Esplora, hash: string, after?: string): Promise<EsploraTx[]> => {
  const path =
    after === undefined ? `/scripthash/${hash}/txs` : `/scripthash/${hash}/txs/chain/${after}`;
  const result = z.safeParse(z.array(esploraTx), await es.get(path));
  if (!result.success) {
    throw new Error(`${path}: malformed response`);
  }
  return result.data;
};

/**
 * The group's view of one Esplora transaction — `verified` only when the read went to a host
 * indexer (`trusted`); a gateway-routed Esplora feed stays unverified. Netting the wallet's own
 * inputs and outputs decides direction; a send is only "out" when the net outflow exceeds the fee
 * the wallet provably paid (every input its own).
 *
 * "Own" is not one set: every confirmed template's addresses share the first party, each
 * unconfirmed template's addresses form their own. The transaction is computed from the first party
 * it touches — confirmed first, then unconfirmed templates in template order — so a flow between a
 * confirmed and an unconfirmed account, or between two unconfirmed ones, is never labelled "self":
 * the other parties' addresses are counterparties.
 */
export const bitcoinEntry = (
  network: string,
  parties: ReadonlyArray<ReadonlySet<string>>,
  tx: EsploraTx,
  trusted: boolean,
): HistoryEntry => {
  const touched = (party: ReadonlySet<string>): boolean =>
    tx.vin.some(
      (vin) =>
        vin.prevout !== null &&
        vin.prevout.scriptpubkey_address !== undefined &&
        party.has(vin.prevout.scriptpubkey_address),
    ) ||
    tx.vout.some(
      (vout) => vout.scriptpubkey_address !== undefined && party.has(vout.scriptpubkey_address),
    );
  const own = parties.find(touched) ?? new Set<string>();
  let ownIn = 0n;
  for (const vin of tx.vin) {
    if (
      vin.prevout !== null &&
      vin.prevout.scriptpubkey_address !== undefined &&
      own.has(vin.prevout.scriptpubkey_address)
    ) {
      ownIn += BigInt(vin.prevout.value);
    }
  }
  let ownOut = 0n;
  for (const vout of tx.vout) {
    if (vout.scriptpubkey_address !== undefined && own.has(vout.scriptpubkey_address)) {
      ownOut += BigInt(vout.value);
    }
  }
  const net = ownOut - ownIn;
  const allInputsOwn =
    tx.vin.length > 0 &&
    tx.vin.every(
      (vin) =>
        vin.prevout !== null &&
        vin.prevout.scriptpubkey_address !== undefined &&
        own.has(vin.prevout.scriptpubkey_address),
    );
  const fee = allInputsOwn ? BigInt(tx.fee) : undefined;
  const sent = -net - (fee ?? 0n);
  let direction: HistoryEntry["direction"];
  let counterparties: ReadonlyArray<string>;
  if (net > 0n) {
    direction = "in";
    counterparties = tx.vin
      .map((vin) => vin.prevout?.scriptpubkey_address)
      .filter((a): a is string => a !== undefined && !own.has(a));
  } else if (ownIn > 0n && sent > 0n) {
    direction = "out";
    counterparties = tx.vout
      .map((vout) => vout.scriptpubkey_address)
      .filter((a): a is string => a !== undefined && !own.has(a));
  } else {
    direction = "self";
    counterparties = [];
  }
  const amount = direction === "in" ? net : direction === "out" ? sent : 0n;
  return {
    id: `${network}:${tx.txid}`,
    family: "bitcoin",
    network,
    hash: tx.txid,
    direction,
    counterparties: [...new Set(counterparties)].slice(0, 100),
    changes:
      amount === 0n
        ? []
        : [
            {
              direction: direction === "in" ? "in" : "out",
              asset: "sats",
              amount: amount.toString(10),
              decimals: 8,
              symbol: "BTC",
              listed: true,
            },
          ],
    ...(fee === undefined ? {} : { fee: fee.toString(10) }),
    status: tx.status.confirmed ? "confirmed" : "pending",
    ...(tx.status.block_time === undefined ? {} : { timestamp: tx.status.block_time * 1000 }),
    ...(tx.status.block_height === undefined ? {} : { block: tx.status.block_height }),
    verified: trusted,
    origin: "chain",
    flags: [],
  };
};

/**
 * `trusted` is false when the only reachable indexer is the gateway — scanned entries then stay
 * unverified.
 */
export type BitcoinHistoryDeps = {
  readonly esplora: (network: string) => Esplora;
  readonly account: (params: {
    readonly walletId: string;
    readonly groupIndex: number;
    readonly template: BitcoinAccountTemplate;
    readonly network: string;
  }) => Promise<
    | { readonly address: string }
    | { readonly xpub: string; readonly changeMark: number; readonly confirmed: boolean }
  >;
  readonly trusted: boolean;
};

export type BitcoinHistoryScan = {
  /**
   * The own-address parties — the confirmed templates' first, then one per unconfirmed template in
   * template order — the local-send membership sets.
   */
  readonly parties: ReadonlyArray<ReadonlySet<string>>;
  readonly entries: ReadonlyArray<HistoryEntry>;
};

/**
 * Own addresses (every template's scanned receive and change chains) and the history of all of
 * them: the first `/txs` page then `/txs/chain` pages while the confirmed part stays full, txids
 * deduped across addresses and templates.
 */
export const bitcoinHistoryScan = async (
  options: BitcoinHistoryDeps,
  network: string,
  group: { readonly walletId: string; readonly groupIndex: number },
): Promise<BitcoinHistoryScan> => {
  const es = options.esplora(network);
  const { params } = bitcoinNetwork(network);
  const accounts = await Promise.all(
    BITCOIN_TEMPLATES.map(async (template: BitcoinAccountTemplate) => {
      const account = await options.account({ ...group, template, network });
      if (!("xpub" in account)) {
        throw new TypeError(`bitcoin account ${template} on ${network} has no xpub`);
      }
      const source: BitcoinSource = {
        kind: "xpub",
        template,
        xpub: account.xpub,
        changeMark: account.changeMark,
      };
      return { source, confirmed: account.confirmed };
    }),
  );
  const scanned = await Promise.all(
    accounts.map(async ({ source }) => scanSource(es, source, network, params)),
  );
  /* The local-send membership sets are the entry's parties: confirmed templates' scanned
     addresses share the first; each unconfirmed template's form their own party so a send to a
     key the device never confirmed is never read as self. An unused scanned address can still
     be a local send's change output, so every scanned address belongs to a party. */
  const confirmed = new Set<string>();
  const parties: Array<Set<string>> = [confirmed];
  for (const [i, addresses] of scanned.entries()) {
    const account = accounts[i];
    if (account === undefined) {
      continue;
    }
    const party = account.confirmed ? confirmed : new Set<string>();
    for (const a of addresses) {
      party.add(a.address);
    }
    if (!account.confirmed) {
      parties.push(party);
    }
  }
  const used = scanned.flat().filter((a) => a.used);
  const seen = new Set<string>();
  const txs: EsploraTx[] = [];
  for (const { address } of used) {
    const hash = scripthash(address, params);
    // oxlint-disable-next-line eslint/no-await-in-loop -- address pages are serialized to bound in-flight requests.
    let page = await fetchPage(es, hash);
    let chainPages = 0;
    for (;;) {
      for (const tx of page) {
        if (!seen.has(tx.txid)) {
          seen.add(tx.txid);
          txs.push(tx);
        }
      }
      const confirmed = page.filter((tx) => tx.status.confirmed);
      if (confirmed.length < PAGE || chainPages >= CHAIN_PAGES_MAX) {
        break;
      }
      const last = confirmed.at(-1);
      if (last === undefined) {
        break;
      }
      // Esplora chain pages continue after the last confirmed txid of the previous page.
      // oxlint-disable-next-line eslint/no-await-in-loop -- each chain page needs the previous one's tail.
      page = await fetchPage(es, hash, last.txid);
      chainPages += 1;
    }
  }
  const entries = txs.map((tx) => bitcoinEntry(network, parties, tx, options.trusted));
  entries.sort(
    (a, b) => (b.timestamp ?? Number.MAX_SAFE_INTEGER) - (a.timestamp ?? Number.MAX_SAFE_INTEGER),
  );
  return { parties, entries };
};

/**
 * One history stream for an enabled Bitcoin network: the whole scan runs on the first (and only)
 * `next()` — own addresses are needed before any entry is safe to emit — returning everything.
 */
export const bitcoinHistoryStream = (
  options: BitcoinHistoryDeps,
  network: string,
  group: { readonly walletId: string; readonly groupIndex: number },
  onOwn: (parties: ReadonlyArray<ReadonlySet<string>>) => void,
): Stream<HistoryEntry> => {
  let scan: Promise<BitcoinHistoryScan> | undefined;
  let done = false;
  return {
    id: network,
    next: async () => {
      if (done) {
        return { items: [], done: true };
      }
      scan ??= bitcoinHistoryScan(options, network, group);
      const { parties, entries } = await scan;
      onOwn(parties);
      done = true;
      return { items: entries, done: true };
    },
  };
};
