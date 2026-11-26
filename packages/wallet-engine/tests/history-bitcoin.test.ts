/**
 * Bitcoin history: bitcoinEntry direction/amount semantics against the recorded Esplora fixture,
 * chain-page pagination over `/txs/chain/<txid>`, the group-level xpub scan, and the Esplora
 * allow-list's chain-page pattern.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { HDKey } from "@scure/bip32";
import { NETWORK, p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import type { BitcoinAccountTemplate } from "@qntx/wallet-chains/bitcoin";
import type { ChainsApi } from "@qntx/wallet/chains";

import { scripthash } from "../src/chains/bitcoin-scan.ts";
import type { Esplora } from "../src/chains/bitcoin.ts";
import { esploraPathAllowed } from "../src/gateway/contract/esplora.ts";
import { bitcoinEntry, bitcoinHistoryScan } from "../src/history/bitcoin.ts";
import type { EsploraTx } from "../src/history/bitcoin.ts";

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/history/esplora.json"), "utf8"),
) as {
  readonly firstPage: EsploraTx[];
  readonly chainPage: EsploraTx[];
  readonly source: {
    readonly address: string;
    readonly scripthash: string;
    readonly chainPageUrl: string;
  };
};

const BTC_NET = "bip122:000000000019d6689c085ae165831e93";
const GROUP = { walletId: "w", groupIndex: 0 } as const;

/** `131576aeb4…`: own input 402225494 spent, own output 6104 back — send when only funded as sender. */
const TX = fixture.firstPage.find((tx) => tx.txid.startsWith("131576aeb4"));
if (TX === undefined) {
  throw new Error("fixture missing 131576aeb4");
}
const OWN_IN = "bc1q8pmuc2v0cku2ty0rfxp2jyvrhv6lpsjzq9y6s8";
const OWN_OUT = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";

describe("bitcoinEntry", () => {
  it("reads the fixture tx as incoming when only the receiving address is ours", () => {
    const e = bitcoinEntry(BTC_NET, [new Set([OWN_OUT])], TX, true);
    expect(e.direction).toBe("in");
    expect(e.counterparties).toStrictEqual([OWN_IN]);
    expect(e.fee).toBeUndefined();
    expect(e.changes).toStrictEqual([
      {
        direction: "in",
        asset: "sats",
        amount: "6104",
        decimals: 8,
        symbol: "BTC",
        listed: true,
      },
    ]);
    expect(e.status).toBe("confirmed");
    expect(e.block).toBe(976381);
    expect(e.verified).toBe(true);
    expect(e.origin).toBe("chain");
  });

  it("reads the fixture tx as outgoing when only the input address is ours", () => {
    const e = bitcoinEntry(BTC_NET, [new Set([OWN_IN])], TX, true);
    expect(e.direction).toBe("out");
    expect(e.fee).toBe("1272");
    expect(e.changes[0]?.amount).toBe("120876469");
    expect(e.counterparties).not.toContain(OWN_IN);
    expect(e.counterparties).toContain(OWN_OUT);
  });

  it("nets both own sides when the input and a change output are ours", () => {
    const e = bitcoinEntry(BTC_NET, [new Set([OWN_IN, OWN_OUT])], TX, true);
    expect(e.direction).toBe("out");
    expect(e.changes[0]?.amount).toBe("120870365");
  });

  it("leaves the entry unverified when the indexer read went to the gateway", () => {
    const e = bitcoinEntry(BTC_NET, [new Set([OWN_OUT])], TX, false);
    expect(e.direction).toBe("in");
    expect(e.verified).toBe(false);
  });
});

const ROOT = HDKey.fromMasterSeed(new Uint8Array(64).fill(3));
const ACCOUNTS: Record<BitcoinAccountTemplate, HDKey> = {
  "btc.bip44": ROOT.derive("m/44'/0'/0'"),
  "btc.bip49": ROOT.derive("m/49'/0'/0'"),
  "btc.bip84": ROOT.derive("m/84'/0'/0'"),
  "btc.bip86": ROOT.derive("m/86'/0'/0'"),
};

const addressOf = (template: BitcoinAccountTemplate, chain: 0 | 1, index: number): string => {
  const pub = ACCOUNTS[template].derive(`m/${chain}/${index}`).publicKey;
  if (pub === null) {
    throw new Error("no public key");
  }
  const address =
    template === "btc.bip44"
      ? p2pkh(pub, NETWORK).address
      : template === "btc.bip49"
        ? p2sh(p2wpkh(pub, NETWORK), NETWORK).address
        : template === "btc.bip84"
          ? p2wpkh(pub, NETWORK).address
          : p2tr(pub.subarray(1), undefined, NETWORK).address;
  if (address === undefined) {
    throw new Error("could not encode the derived address");
  }
  return address;
};

const accountFor =
  (confirmed: (template: BitcoinAccountTemplate) => boolean): ChainsApi["account"] =>
  (params) => {
    const t = params.template;
    if (t === "btc.bip44" || t === "btc.bip49" || t === "btc.bip84" || t === "btc.bip86") {
      return Promise.resolve({
        template: t,
        network: params.network,
        xpub: ACCOUNTS[t].publicExtendedKey,
        fingerprint: "deadbeef",
        path: "m",
        changeMark: 0,
        confirmed: confirmed(t),
      });
    }
    return Promise.reject(new Error(`unexpected template ${t}`));
  };

const chains: Pick<ChainsApi, "account"> = { account: accountFor(() => true) };

type Pages = { readonly txs: ReadonlyArray<unknown>; readonly chain?: ReadonlyArray<unknown> };

/**
 * Esplora fake: every derived address scans empty except `funded` scripthashes, which answer the
 * given `/txs` page and an optional `/txs/chain` continuation. Records every GET.
 */
const esplora = (funded: ReadonlyMap<string, Pages>, paths: string[]): Esplora => ({
  get: async (path) => {
    paths.push(path);
    const chain = /^\/scripthash\/([0-9a-f]+)\/txs\/chain\/([0-9a-f]+)$/.exec(path);
    if (chain !== null) {
      const page = funded.get(chain[1] ?? "");
      if (page?.chain === undefined) {
        return Promise.reject(new Error(`unmocked ${path}`));
      }
      return Promise.resolve(page.chain);
    }
    const txs = /^\/scripthash\/([0-9a-f]+)\/txs$/.exec(path);
    if (txs !== null) {
      return Promise.resolve(funded.get(txs[1] ?? "")?.txs ?? []);
    }
    const utxo = /^\/scripthash\/([0-9a-f]+)\/utxo$/.exec(path);
    if (utxo !== null) {
      return Promise.resolve([]);
    }
    return Promise.reject(new Error(`unmocked ${path}`));
  },
  post: async () => Promise.reject(new Error("unmocked")),
});

const scanWith = async (account: ChainsApi["account"], es: Esplora) =>
  bitcoinHistoryScan({ esplora: () => es, account, trusted: true }, BTC_NET, GROUP);

const scan = async (es: Esplora) => scanWith(chains.account, es);

describe("bitcoinHistoryScan", () => {
  it("pages a used address through /txs then /txs/chain/<last-confirmed-txid>", async () => {
    const funded = addressOf("btc.bip86", 0, 0);
    const paths: string[] = [];
    const es = esplora(
      new Map([
        [scripthash(funded, NETWORK), { txs: fixture.firstPage, chain: fixture.chainPage }],
      ]),
      paths,
    );
    const { entries, parties } = await scan(es);
    const tail = fixture.firstPage.at(-1)?.txid;
    expect(paths).toContain(`/scripthash/${scripthash(funded, NETWORK)}/txs/chain/${tail}`);
    const txids = new Set(entries.map((e) => e.hash));
    expect(entries).toHaveLength(txids.size);
    expect(entries).toHaveLength(fixture.firstPage.length + fixture.chainPage.length);
    expect(parties.some((party) => party.has(funded))).toBe(true);
  });

  it("classifies an incoming payment to a derived taproot address", async () => {
    const mine = addressOf("btc.bip86", 0, 0);
    const pay: EsploraTx = {
      txid: "aa".repeat(32),
      fee: 1000,
      vin: [
        {
          prevout: {
            scriptpubkey_address: "bc1qexternal000000000000000000000000000",
            value: 100000,
          },
        },
      ],
      vout: [{ scriptpubkey_address: mine, value: 50000 }],
      status: { confirmed: true, block_height: 900000, block_time: 1700000000 },
    };
    const { entries } = await scan(
      esplora(new Map([[scripthash(mine, NETWORK), { txs: [pay] }]]), []),
    );
    const e = entries.find((x) => x.hash === pay.txid);
    expect(e?.direction).toBe("in");
    expect(e?.changes[0]?.amount).toBe("50000");
    expect(e?.counterparties).toStrictEqual(["bc1qexternal000000000000000000000000000"]);
  });

  it("classifies a consolidation between own addresses as self", async () => {
    const a = addressOf("btc.bip86", 0, 0);
    const b = addressOf("btc.bip86", 0, 1);
    const move: EsploraTx = {
      txid: "bb".repeat(32),
      fee: 500,
      vin: [{ prevout: { scriptpubkey_address: a, value: 60000 } }],
      vout: [{ scriptpubkey_address: b, value: 59500 }],
      status: { confirmed: true, block_height: 900001, block_time: 1700000100 },
    };
    const { entries } = await scan(
      esplora(new Map([[scripthash(a, NETWORK), { txs: [move] }]]), []),
    );
    const e = entries.find((x) => x.hash === move.txid);
    expect(e?.direction).toBe("self");
    expect(e?.changes).toStrictEqual([]);
    expect(e?.fee).toBe("500");
  });
});

/* A pinned entry the device never confirmed is not own: its scanned addresses form their own
   party, so a flow to or from a confirmed account is never labelled "self". */
describe("an unconfirmed template's addresses form their own party", () => {
  const account = accountFor((t) => t !== "btc.bip44");
  const OWN84 = addressOf("btc.bip84", 0, 0);
  const CHANGE84 = addressOf("btc.bip84", 1, 0);
  const FOREIGN44 = addressOf("btc.bip44", 1, 0);
  const EXTERNAL = "bc1qexternal000000000000000000000000000";

  const move = (
    txid: string,
    vin: ReadonlyArray<{ readonly address: string; readonly value: number }>,
    vout: ReadonlyArray<{ readonly address: string; readonly value: number }>,
  ): EsploraTx => ({
    txid,
    fee: 500,
    vin: vin.map((v) => ({
      prevout: { scriptpubkey_address: v.address, value: v.value },
    })),
    vout: vout.map((v) => ({ scriptpubkey_address: v.address, value: v.value })),
    status: { confirmed: true, block_height: 900001, block_time: 1700000100 },
  });

  it("a confirmed → unconfirmed transfer is out, the foreign-key address the counterparty", async () => {
    const tx = move(
      "cc".repeat(32),
      [{ address: OWN84, value: 60_000 }],
      [
        { address: FOREIGN44, value: 50_000 },
        { address: CHANGE84, value: 9_500 },
      ],
    );
    const { entries, parties } = await scanWith(
      account,
      esplora(new Map([[scripthash(OWN84, NETWORK), { txs: [tx] }]]), []),
    );
    const e = entries.find((x) => x.hash === tx.txid);
    expect(e?.direction).toBe("out");
    expect(e?.counterparties).toStrictEqual([FOREIGN44]);
    expect(parties).toHaveLength(2);
    expect(parties[0]?.has(OWN84)).toBe(true);
    expect(parties[1]?.has(FOREIGN44)).toBe(true);
  });

  it("an inflow to the unconfirmed account reads from its own party", async () => {
    const tx = move(
      "dd".repeat(32),
      [{ address: EXTERNAL, value: 70_000 }],
      [{ address: FOREIGN44, value: 69_500 }],
    );
    const { entries } = await scanWith(
      account,
      esplora(new Map([[scripthash(FOREIGN44, NETWORK), { txs: [tx] }]]), []),
    );
    const e = entries.find((x) => x.hash === tx.txid);
    expect(e?.direction).toBe("in");
    expect(e?.counterparties).toStrictEqual([EXTERNAL]);
    expect(e?.changes[0]?.amount).toBe("69500");
  });

  it("a self-transfer inside the confirmed party stays self", async () => {
    const tx = move(
      "ee".repeat(32),
      [{ address: OWN84, value: 60_000 }],
      [{ address: CHANGE84, value: 59_500 }],
    );
    const { entries } = await scanWith(
      account,
      esplora(new Map([[scripthash(OWN84, NETWORK), { txs: [tx] }]]), []),
    );
    const e = entries.find((x) => x.hash === tx.txid);
    expect(e?.direction).toBe("self");
    expect(e?.counterparties).toStrictEqual([]);
  });
});

describe("esplora contract", () => {
  it("allows the chain-page pattern and rejects a non-hex cursor", () => {
    const h = "ab".repeat(32);
    expect(esploraPathAllowed("GET", `/scripthash/${h}/txs/chain/${h}`)).toBe(true);
    expect(esploraPathAllowed("GET", `/scripthash/${h}/txs`)).toBe(true);
    expect(esploraPathAllowed("GET", `/scripthash/${h}/txs/chain/xyz`)).toBe(false);
    expect(esploraPathAllowed("GET", `/scripthash/${h}/txs/chain/${h}/extra`)).toBe(false);
  });
});
