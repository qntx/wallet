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
 */
export const bitcoinEntry = (
  network: string,
  own: ReadonlySet<string>,
  tx: EsploraTx,
  trusted: boolean,
): HistoryEntry => {
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
  }) => Promise<{ readonly address?: string; readonly xpub?: string }>;
  readonly trusted: boolean;
};

export type BitcoinHistoryScan = {
  /** Every scanned own address on this network — the local-send membership set. */
  readonly own: ReadonlySet<string>;
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
  const sources = await Promise.all(
    BITCOIN_TEMPLATES.map(async (template: BitcoinAccountTemplate): Promise<BitcoinSource> => {
      const account = await options.account({ ...group, template, network });
      if (account.xpub === undefined) {
        throw new TypeError(`bitcoin account ${template} on ${network} has no xpub`);
      }
      return { kind: "xpub", template, xpub: account.xpub };
    }),
  );
  const scanned = await Promise.all(
    sources.map(async (source) => scanSource(es, source, network, params)),
  );
  // `own` is every scanned address — an unused one can still be a local send's change output.
  const own = new Set(scanned.flat().map((a) => a.address));
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
  const entries = txs.map((tx) => bitcoinEntry(network, own, tx, options.trusted));
  entries.sort(
    (a, b) => (b.timestamp ?? Number.MAX_SAFE_INTEGER) - (a.timestamp ?? Number.MAX_SAFE_INTEGER),
  );
  return { own, entries };
};

/**
 * One history stream for an enabled Bitcoin network: the whole scan runs on the first (and only)
 * `next()` — own addresses are needed before any entry is safe to emit — returning everything.
 */
export const bitcoinHistoryStream = (
  options: BitcoinHistoryDeps,
  network: string,
  group: { readonly walletId: string; readonly groupIndex: number },
  onOwn: (own: ReadonlySet<string>) => void,
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
      const { own, entries } = await scan;
      onOwn(own);
      done = true;
      return { items: entries, done: true };
    },
  };
};
