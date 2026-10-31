import { HDKey } from "@scure/bip32";
import { NETWORK, p2wpkh } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import { scripthash, scanChain } from "../src/chains/bitcoin-scan.ts";
import { esplora as esploraClient, EsploraError } from "../src/chains/bitcoin.ts";
import type { Esplora, EsploraFetch, EsploraResponse } from "../src/chains/bitcoin.ts";

const XPUB = HDKey.fromMasterSeed(new Uint8Array(64).fill(1));
const ACCOUNT = XPUB.derive("m/84'/0'/0'");
const xpub = ACCOUNT.publicExtendedKey;

const hashOf = (addr: string) => scripthash(addr, NETWORK);

const esplora = (txs: Record<string, unknown[]>): Esplora => ({
  get: async (path) => {
    const m = /^\/scripthash\/([0-9a-f]+)\/(txs|utxo)$/.exec(path);
    if (m !== null) {
      return Promise.resolve(m[2] === "txs" ? (txs[m[1] ?? ""] ?? []) : []);
    }
    return Promise.reject(new Error(`unmocked ${path}`));
  },
  post: async () => Promise.reject(new Error("unmocked")),
});

describe("gap-20 scanning", () => {
  it("stops after a fully unused 20-address gap on the receive chain", async () => {
    const txs: Record<string, unknown[]> = {};
    // /0/3 used keeps window 1 non-empty; window 2 is fully unused → scan ends at 40.
    const used3 = p2wpkh(ACCOUNT.deriveChild(0).deriveChild(3).publicKey!, NETWORK).address;
    txs[hashOf(used3)] = [{ txid: "x" }];
    const addrs = await scanChain(
      esplora(txs),
      xpub,
      "btc.bip84",
      "bip122:000000000019d6689c085ae165831e93",
      NETWORK,
      0,
    );
    expect(addrs).toHaveLength(40);
    expect(addrs[3]!.used).toBe(true);
    expect(addrs[39]!.used).toBe(false);
  });

  it("stops at 20 when the first window is entirely unused", async () => {
    const addrs = await scanChain(
      esplora({}),
      xpub,
      "btc.bip84",
      "bip122:000000000019d6689c085ae165831e93",
      NETWORK,
      0,
    );
    expect(addrs).toHaveLength(20);
    expect(addrs.every((a) => !a.used)).toBe(true);
  });

  it("extends past the gap when used addresses reach the window edge", async () => {
    const txs: Record<string, unknown[]> = {};
    const used19 = p2wpkh(ACCOUNT.deriveChild(0).deriveChild(19).publicKey!, NETWORK).address;
    txs[hashOf(used19)] = [{ txid: "x" }];
    const addrs = await scanChain(
      esplora(txs),
      xpub,
      "btc.bip84",
      "bip122:000000000019d6689c085ae165831e93",
      NETWORK,
      0,
    );
    expect(addrs).toHaveLength(40);
    expect(addrs[19]!.used).toBe(true);
  });
});

const noSleep = async (): Promise<void> => Promise.resolve();

const resp = (status: number): EsploraResponse => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => undefined },
  json: async () => Promise.resolve({}),
  text: async () => Promise.resolve(""),
});

const hang: EsploraFetch = async (_url, init) => {
  const sig = init?.signal;
  if (sig === undefined) {
    return new Promise<EsploraResponse>(() => {});
  }
  return new Promise<EsploraResponse>((_resolve, reject) => {
    sig.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  });
};

describe("esplora client timeout", () => {
  it("rejects a stalled request with a transient EsploraError", async () => {
    const es = esploraClient(["http://electrs.test"], hang, noSleep, 20);
    await expect(es.get("/blocks/tip/height")).rejects.toThrow(EsploraError);
    await expect(es.get("/blocks/tip/height")).rejects.toMatchObject({ transient: true });
  });

  it("maps a 5xx to transient and a 4xx to permanent", async () => {
    const es500 = esploraClient(
      ["http://electrs.test"],
      async () => Promise.resolve(resp(500)),
      noSleep,
    );
    await expect(es500.get("/x")).rejects.toMatchObject({ transient: true });
    const es404 = esploraClient(
      ["http://electrs.test"],
      async () => Promise.resolve(resp(404)),
      noSleep,
    );
    await expect(es404.get("/x")).rejects.toMatchObject({ transient: false });
  });
});
