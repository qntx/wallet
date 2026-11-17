/**
 * PoC (audit lane parity-multichain, PM-04). `AssetsController.refreshBitcoin` hard-codes
 * `template = "btc.bip84"` (assets/controller.ts:453) and treats its argument as an xpub. So (a) a
 * `btc.bip86` (Taproot / "ordinals") account's balance is read from P2WPKH addresses derived from
 * the Taproot xpub — funds on the real P2TR addresses are not counted; (b) a Bitcoin watch account
 * — stored as a plain address (accounts/watch.ts:55) and refreshed by `engine.watch.assets` through
 * `assets.refresh(account.address, network)` (engine.ts:786) — throws.
 */
import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vite-plus/test";

import { bitcoinAddressFromXpub, bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";

import { AssetsController } from "../../src/assets/controller.ts";
import { scanChain, scanUtxos, scripthash } from "../../src/chains/bitcoin-scan.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";

const NETWORK = "bip122:000000000019d6689c085ae165831e93";
const params = bitcoinNetwork(NETWORK).params;
const XPUB86 = HDKey.fromMasterSeed(new Uint8Array(64).fill(3)).derive("m/86'/0'/0'").publicExtendedKey;
const P2TR_0 = bitcoinAddressFromXpub(XPUB86, "btc.bip86", NETWORK, 0, 0);

/** An Esplora that knows one funded P2TR address (100,000 sat, confirmed). */
const esplora = {
  get: async (path: string): Promise<unknown> => {
    const funded = path.includes(scripthash(P2TR_0, params));
    if (path.endsWith("/txs")) {
      return funded ? [{ txid: "aa".repeat(32) }] : [];
    }
    if (path.endsWith("/utxo")) {
      return funded
        ? [{ txid: "aa".repeat(32), vout: 0, value: 100_000, status: { block_height: 800_000 } }]
        : [];
    }
    throw new Error(`unmocked ${path}`);
  },
  post: async () => Promise.reject(new Error("unused")),
};

const controller = () =>
  new AssetsController({
    networks: { info: () => ({ family: "bitcoin" }), esplora: () => esplora } as never,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    setTimer: () => () => {},
    logger: { warn: () => {} },
  });

describe("PM-04 bitcoin balances only work for bip84 xpubs", () => {
  it("a funded Taproot (bip86) account reads as 0", async () => {
    const ctl = controller();
    await ctl.init();
    const balances = await ctl.refresh(XPUB86, NETWORK);
    expect(P2TR_0.startsWith("bc1p")).toBe(true);
    expect(balances.native).toBe("0");
    // Control: the same Esplora, scanned with the account's real template, holds 100,000 sat.
    const addrs = [
      ...(await scanChain(esplora, XPUB86, "btc.bip86", NETWORK, params, 0)),
      ...(await scanChain(esplora, XPUB86, "btc.bip86", NETWORK, params, 1)),
    ];
    const utxos = await scanUtxos(esplora, addrs, params);
    expect(utxos.reduce((a, u) => a + u.value, 0)).toBe(100_000);
  });

  it("a Bitcoin watch account (plain address) cannot be refreshed at all", async () => {
    const ctl = controller();
    await ctl.init();
    await expect(ctl.refresh(P2TR_0, NETWORK)).rejects.toThrow();
  });
});
