/**
 * Bitcoin balance reads: a group refresh scans all four account templates' xpubs into one entry
 * keyed `${network}:${walletId}:${groupIndex}`, and a watched plain address reads itself under
 * `${network}:${address}`. Unconfirmed own change and dust-value UTXOs keep their own buckets.
 *
 * The address oracle is independent: addresses are derived from the seed's HD keys with the
 * btc-signer payment encoders, never through the read path under test.
 */
import { HDKey } from "@scure/bip32";
import { NETWORK, p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import type { BitcoinAccountTemplate } from "@qntx/wallet-chains/bitcoin";
import type { ChainsApi } from "@qntx/wallet/chains";

import { AssetsController } from "../src/assets/controller.ts";
import { scripthash } from "../src/chains/bitcoin-scan.ts";
import type { Esplora } from "../src/chains/bitcoin.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const logger = { warn: () => {} };
const BTC_NET = "bip122:000000000019d6689c085ae165831e93";
const GROUP = { walletId: "w", groupIndex: 0 } as const;

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

type AccountParams = Parameters<ChainsApi["account"]>[0];

/** The kernel's `wallet.accounts`: each template's account xpub from the same seed. */
const chains = (calls?: AccountParams[]): Pick<ChainsApi, "account"> => ({
  account: async (params) => {
    calls?.push(params);
    const t = params.template;
    if (t === "btc.bip44" || t === "btc.bip49" || t === "btc.bip84" || t === "btc.bip86") {
      return Promise.resolve({
        template: t,
        network: params.network,
        xpub: ACCOUNTS[t].publicExtendedKey,
        fingerprint: "deadbeef",
        path: "m",
      });
    }
    return Promise.reject(new Error(`unexpected template ${t}`));
  },
});

type Funded = Record<string, { readonly txs: unknown[]; readonly utxo: unknown[] }>;

/** Esplora fake: per-scripthash txs and utxos; records every scripthash it is asked about. */
const esplora = (funded: Funded, asked: string[]): Esplora => ({
  get: async (path) => {
    const m = /^\/scripthash\/([0-9a-f]+)\/(txs|utxo)$/.exec(path);
    if (m === null) {
      return Promise.reject(new Error(`unmocked ${path}`));
    }
    asked.push(m[1] ?? "");
    const entry = funded[m[1] ?? ""];
    return Promise.resolve(m[2] === "txs" ? (entry?.txs ?? []) : (entry?.utxo ?? []));
  },
  post: async () => Promise.reject(new Error("unmocked")),
});

const utxo = (txid: string, value: number, height: number): unknown => ({
  txid,
  vout: 0,
  value,
  status: { block_height: height },
});

const fund = (funded: Funded, address: string, utxos: ReadonlyArray<unknown>): void => {
  funded[scripthash(address, NETWORK)] = { txs: [{ txid: "ff".repeat(32) }], utxo: [...utxos] };
};

const btcNetworks = (es: Esplora) =>
  ({
    info: (n: string) => (n === BTC_NET ? { family: "bitcoin" } : { family: "evm", chainId: 1 }),
    esplora: () => es,
  }) as never;

const make = (
  es: Esplora,
  chainCalls?: AccountParams[],
  timers?: Array<() => unknown>,
  chainsApi?: Pick<ChainsApi, "account">,
): AssetsController =>
  new AssetsController({
    networks: btcNetworks(es),
    chains: chainsApi ?? chains(chainCalls),
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    setTimer: (_ms, fn) => {
      timers?.push(fn);
      return () => {};
    },
    logger,
  });

/** Per-template totals: taproot outputs are protected under the ord-postage rule → frozen. */
const sourceTotals = (template: BitcoinAccountTemplate, value: number) =>
  template === "btc.bip86"
    ? { native: "0", unconfirmed: "0", frozen: String(value) }
    : { native: String(value), unconfirmed: "0", frozen: "0" };

describe("AssetsController bitcoin group", () => {
  it("sums every account template's xpub into one entry, each source reported apart", async () => {
    const values: ReadonlyArray<readonly [BitcoinAccountTemplate, number, string]> = [
      ["btc.bip44", 100_000, "aa".repeat(32)],
      ["btc.bip49", 200_000, "bb".repeat(32)],
      ["btc.bip84", 300_000, "cc".repeat(32)],
      ["btc.bip86", 400_000, "dd".repeat(32)],
    ];
    const funded: Funded = {};
    for (const [template, value, txid] of values) {
      fund(funded, addressOf(template, 0, 0), [utxo(txid, value, 900_000)]);
    }
    const calls: AccountParams[] = [];
    const assets = make(esplora(funded, []), calls);
    await assets.init();
    const balances = await assets.refreshBitcoinGroup(GROUP, BTC_NET);
    expect(calls.map((c) => c.template)).toStrictEqual([
      "btc.bip44",
      "btc.bip49",
      "btc.bip84",
      "btc.bip86",
    ]);
    for (const [template, value] of values) {
      expect(balances.sources?.[template]).toStrictEqual(sourceTotals(template, value));
    }
    expect(balances.native).toBe("600000");
    expect(balances.unconfirmed).toBe("0");
    expect(balances.frozen).toBe("400000");
    expect(balances.utxos?.map((u) => u.source)).toStrictEqual([
      "btc.bip44",
      "btc.bip49",
      "btc.bip84",
      "btc.bip86",
    ]);
    expect(assets.getState().balances[`${BTC_NET}:w:0`]).toStrictEqual(balances);
  });

  it("counts own unconfirmed change under unconfirmed; other unconfirmed outputs count nowhere", async () => {
    const funded: Funded = {};
    fund(funded, addressOf("btc.bip84", 0, 0), [utxo("aa".repeat(32), 70_000, 800_000)]);
    fund(funded, addressOf("btc.bip84", 1, 0), [utxo("bb".repeat(32), 50_000, 0)]);
    // An unconfirmed incoming payment on a receive address is not spendable yet.
    fund(funded, addressOf("btc.bip84", 0, 1), [utxo("cc".repeat(32), 60_000, 0)]);
    const assets = make(esplora(funded, []));
    await assets.init();
    const balances = await assets.refreshBitcoinGroup(GROUP, BTC_NET);
    expect(balances.sources?.["btc.bip84"]).toStrictEqual({
      native: "70000",
      unconfirmed: "50000",
      frozen: "0",
    });
    expect(balances.native).toBe("70000");
    expect(balances.unconfirmed).toBe("50000");
  });

  it("shows a protected UTXO under frozen and marks it protected, out of native", async () => {
    const funded: Funded = {};
    fund(funded, addressOf("btc.bip84", 0, 0), [
      utxo("aa".repeat(32), 90_000, 800_000),
      { txid: "bb".repeat(32), vout: 1, value: 546, status: { block_height: 800_000 } },
    ]);
    const assets = make(esplora(funded, []));
    await assets.init();
    const balances = await assets.refreshBitcoinGroup(GROUP, BTC_NET);
    expect(balances.native).toBe("90000");
    expect(balances.frozen).toBe("546");
    const dust = balances.utxos?.find((u) => u.value === 546);
    expect(dust?.protected).toBe(true);
    expect(dust?.source).toBe("btc.bip84");
    const spendable = balances.utxos?.find((u) => u.value === 90_000);
    expect(spendable?.protected).toBe(false);
  });

  it("the ord-postage boundary: 20_000 sat is protected, 20_001 is spendable", async () => {
    const funded: Funded = {};
    fund(funded, addressOf("btc.bip84", 0, 0), [
      utxo("aa".repeat(32), 20_000, 800_000),
      { txid: "bb".repeat(32), vout: 1, value: 20_001, status: { block_height: 800_000 } },
    ]);
    const assets = make(esplora(funded, []));
    await assets.init();
    const balances = await assets.refreshBitcoinGroup(GROUP, BTC_NET);
    expect(balances.native).toBe("20001");
    expect(balances.frozen).toBe("20000");
    expect(balances.utxos?.find((u) => u.value === 20_000)?.protected).toBe(true);
    expect(balances.utxos?.find((u) => u.value === 20_001)?.protected).toBe(false);
  });

  it("a taproot output of any value is protected — inscription postage is not a dust floor", async () => {
    const funded: Funded = {};
    fund(funded, addressOf("btc.bip86", 0, 0), [
      utxo("aa".repeat(32), 1_000_000, 800_000),
      { txid: "bb".repeat(32), vout: 1, value: 45_000, status: { block_height: 800_000 } },
    ]);
    const assets = make(esplora(funded, []));
    await assets.init();
    const balances = await assets.refreshBitcoinGroup(GROUP, BTC_NET);
    expect(balances.native).toBe("0");
    expect(balances.frozen).toBe("1045000");
    expect(balances.sources?.["btc.bip86"]).toStrictEqual({
      native: "0",
      unconfirmed: "0",
      frozen: "1045000",
    });
    expect(balances.utxos?.every((u) => u.protected)).toBe(true);
  });

  it("rejects when the kernel answers a bitcoin template with no xpub", async () => {
    const noXpub: Pick<ChainsApi, "account"> = {
      account: async () =>
        Promise.resolve({ template: "evm.bip44", network: "eip155:1", address: "0x0" }),
    };
    const assets = make(esplora({}, []), undefined, undefined, noXpub);
    await assets.init();
    await expect(assets.refreshBitcoinGroup(GROUP, BTC_NET)).rejects.toThrow(/no xpub/);
  });

  it("refuses a non-bitcoin network", async () => {
    const assets = make(esplora({}, []));
    await assets.init();
    await expect(assets.refreshBitcoinGroup(GROUP, "eip155:1")).rejects.toThrow(TypeError);
  });

  it("a poll re-reads the tracked group entry", async () => {
    const receive = addressOf("btc.bip84", 0, 0);
    const funded: Funded = {};
    fund(funded, receive, [utxo("aa".repeat(32), 80_000, 900_000)]);
    const asked: string[] = [];
    const timers: Array<() => unknown> = [];
    const assets = make(esplora(funded, asked), undefined, timers);
    await assets.init();
    assets.setVisible(true);
    await assets.refreshBitcoinGroup(GROUP, BTC_NET);
    const before = asked.length;
    void timers[0]?.();
    await new Promise((resolve) => setTimeout(resolve));
    expect(asked.slice(before)).toContain(scripthash(receive, NETWORK));
  });
});

describe("AssetsController watched bitcoin address", () => {
  it("reads the address itself — a bip86 (taproot) receive address included", async () => {
    const address = addressOf("btc.bip86", 0, 0);
    const funded: Funded = {};
    fund(funded, address, [utxo("aa".repeat(32), 125_000, 900_000)]);
    const asked: string[] = [];
    const assets = make(esplora(funded, asked));
    await assets.init();
    const balances = await assets.refresh(address, BTC_NET);
    expect(asked).toStrictEqual([scripthash(address, NETWORK)]);
    // A taproot address's funds are protected under the ord-postage rule: visible, not
    // spendable by default.
    expect(balances.native).toBe("0");
    expect(balances.unconfirmed).toBe("0");
    expect(balances.frozen).toBe("125000");
    expect(balances.sources).toStrictEqual({
      address: { native: "0", unconfirmed: "0", frozen: "125000" },
    });
    expect(balances.utxos?.map((u) => u.source)).toStrictEqual(["address"]);
    expect(assets.getState().balances[`${BTC_NET}:${address}`]).toStrictEqual(balances);
  });

  it("rejects a non-address (an xpub) as not a bitcoin address", async () => {
    const assets = make(esplora({}, []));
    await assets.init();
    await expect(assets.refresh(ACCOUNTS["btc.bip84"].publicExtendedKey, BTC_NET)).rejects.toThrow(
      /not a bitcoin address/,
    );
  });
});
