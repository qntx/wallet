/**
 * Bitcoin balance read: one path for every source kind — an account template's xpub (its
 * gap-scanned receive and change chains) or one watched address. Totals are display-only;
 * `unconfirmed` holds the account's own unconfirmed change, `protected` the protected UTXOs — every
 * taproot output and anything at or below ord's MAX_POSTAGE, which may carry an inscription — and
 * other unconfirmed outputs count nowhere. User freezes (`transactions.frozenUtxos`) are a separate
 * coin-control list and are not reflected here.
 */
import type { NETWORK as BTC_NETWORK } from "@scure/btc-signer";

import { bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import type { BitcoinAccountTemplate } from "@qntx/wallet-chains/bitcoin";

import { scanSource, scanUtxos } from "../chains/bitcoin-scan.ts";
import type { BitcoinSource } from "../chains/bitcoin-scan.ts";
import { isTaprootAddress, mayCarryInscription } from "../chains/bitcoin.ts";
import type { Esplora } from "../chains/bitcoin.ts";

export type BitcoinSourceKey = BitcoinAccountTemplate | "address";

export type BitcoinTotals = {
  readonly native: string;
  readonly unconfirmed: string;
  readonly protected: string;
};

export type BitcoinUtxoView = {
  readonly txid: string;
  readonly vout: number;
  readonly value: number;
  readonly address: string;
  readonly height: number;
  readonly source: BitcoinSourceKey;
  readonly protected: boolean;
};

const sourceKey = (source: BitcoinSource): BitcoinSourceKey =>
  source.kind === "xpub" ? source.template : "address";

const readSource = async (
  es: Esplora,
  source: BitcoinSource,
  network: string,
  params: typeof BTC_NETWORK,
): Promise<{ readonly totals: BitcoinTotals; readonly utxos: ReadonlyArray<BitcoinUtxoView> }> => {
  const addresses = await scanSource(es, source, network, params);
  const byAddress = new Map(addresses.map((a) => [a.address, a]));
  const scanned = await scanUtxos(es, addresses, params);
  const key = sourceKey(source);
  let native = 0n;
  let unconfirmed = 0n;
  let protectedSats = 0n;
  const utxos = scanned.map((u): BitcoinUtxoView => {
    const value = BigInt(u.value);
    const protect = mayCarryInscription(isTaprootAddress(u.address, params), u.value);
    if (protect) {
      protectedSats += value;
    } else if (u.height > 0) {
      native += value;
    } else if (byAddress.get(u.address)?.chain === 1) {
      unconfirmed += value;
    }
    return {
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      address: u.address,
      height: u.height,
      source: key,
      protected: protect,
    };
  });
  return {
    totals: {
      native: native.toString(),
      unconfirmed: unconfirmed.toString(),
      protected: protectedSats.toString(),
    },
    utxos,
  };
};

export type BitcoinRead = {
  readonly totals: BitcoinTotals;
  readonly bySource: Partial<Record<BitcoinSourceKey, BitcoinTotals>>;
  readonly utxos: ReadonlyArray<BitcoinUtxoView>;
};

export const readBitcoin = async (
  es: Esplora,
  network: string,
  sources: ReadonlyArray<BitcoinSource>,
): Promise<BitcoinRead> => {
  const { params } = bitcoinNetwork(network);
  const reads = await Promise.all(
    sources.map(async (source) => ({ source, ...(await readSource(es, source, network, params)) })),
  );
  let native = 0n;
  let unconfirmed = 0n;
  let protectedSats = 0n;
  const bySource: Partial<Record<BitcoinSourceKey, BitcoinTotals>> = {};
  const utxos: BitcoinUtxoView[] = [];
  for (const read of reads) {
    native += BigInt(read.totals.native);
    unconfirmed += BigInt(read.totals.unconfirmed);
    protectedSats += BigInt(read.totals.protected);
    bySource[sourceKey(read.source)] = read.totals;
    utxos.push(...read.utxos);
  }
  return {
    totals: {
      native: native.toString(),
      unconfirmed: unconfirmed.toString(),
      protected: protectedSats.toString(),
    },
    bySource,
    utxos,
  };
};

/** The `AccountBalances` shape every bitcoin read produces — tokens never appear on bitcoin. */
export const bitcoinBalances = (
  read: BitcoinRead,
): {
  readonly native: string;
  readonly tokens: ReadonlyArray<never>;
  readonly unconfirmed: string;
  readonly protected: string;
  readonly sources: Readonly<Partial<Record<BitcoinSourceKey, BitcoinTotals>>>;
  readonly utxos: ReadonlyArray<BitcoinUtxoView>;
} => ({
  native: read.totals.native,
  tokens: [],
  unconfirmed: read.totals.unconfirmed,
  protected: read.totals.protected,
  sources: read.bySource,
  utxos: read.utxos,
});
