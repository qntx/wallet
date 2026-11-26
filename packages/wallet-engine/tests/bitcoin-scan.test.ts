import { HDKey } from "@scure/bip32";
import { NETWORK, p2pkh, p2wpkh } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import { changeScanReach } from "@qntx/wallet-chains/bitcoin";

import { scripthash, scanChain, scanSourceWithHistory } from "../src/chains/bitcoin-scan.ts";
import { esplora as esploraClient, EsploraError } from "../src/chains/bitcoin.ts";
import type { Esplora, EsploraDeps, EsploraFetch, EsploraResponse } from "../src/chains/bitcoin.ts";
import { esploraDeps } from "./send-helpers.ts";

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
      -1,
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
      -1,
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
      -1,
    );
    expect(addrs).toHaveLength(40);
    expect(addrs[19]!.used).toBe(true);
  });

  it("fails closed after 2000 addresses when every address reports history", async () => {
    let queried = 0;
    const lying: Esplora = {
      get: async () => {
        queried += 1;
        return Promise.resolve([{ txid: "x" }]);
      },
      post: async () => Promise.reject(new Error("unmocked")),
    };
    await expect(
      scanChain(
        lying,
        xpub,
        "btc.bip84",
        "bip122:000000000019d6689c085ae165831e93",
        NETWORK,
        0,
        -1,
      ),
    ).rejects.toThrow("bitcoin address scan exceeded 2000 addresses");
    expect(queried).toBe(2000);
    // Deriving 2000 addresses from the xpub dominates; under a loaded full run it exceeds 5 s.
  }, 30_000);
});

describe("change-mark reach scanning", () => {
  const reachScan = async (txs: Record<string, unknown[]>, reach: number) =>
    scanChain(
      esplora(txs),
      xpub,
      "btc.bip84",
      "bip122:000000000019d6689c085ae165831e93",
      NETWORK,
      1,
      reach,
    );

  it("mark 0 walks the change chain to index 20 even with nothing used", async () => {
    const addrs = await reachScan({}, changeScanReach(0));
    expect(addrs).toHaveLength(21);
    expect(addrs.every((a) => a.chain === 1)).toBe(true);
    expect(addrs.every((a) => !a.used)).toBe(true);
    expect(addrs[20]!.index).toBe(20);
  });

  it("mark 100 walks the change chain to index 120 in tail windows", async () => {
    const addrs = await reachScan({}, changeScanReach(100));
    expect(addrs).toHaveLength(121);
    expect(addrs[120]!.index).toBe(120);
  });

  it("a used address in the tail resumes the gap rule from there", async () => {
    const txs: Record<string, unknown[]> = {};
    const used105 = p2wpkh(ACCOUNT.deriveChild(1).deriveChild(105).publicKey!, NETWORK).address;
    txs[hashOf(used105)] = [{ txid: "x" }];
    // Reach 120 covers index 105 in the tail — the found history then re-arms gap-20, so the
    // scan continues one full window past the reach: 120 tail rows + window [120, 140).
    const addrs = await reachScan(txs, changeScanReach(100));
    expect(addrs).toHaveLength(140);
    expect(addrs[105]!.used).toBe(true);
    expect(addrs[139]!.index).toBe(139);
  });

  it("the reach is capped at the scan limit — a huge mark walks to index 1999 only", async () => {
    const addrs = await reachScan({}, changeScanReach(5000));
    expect(addrs).toHaveLength(2000);
    expect(addrs[1999]!.index).toBe(1999);
  }, 30_000);

  it("scanSourceWithHistory walks a bip44 change chain under an unused receive chain", async () => {
    const ACCOUNT44 = XPUB.derive("m/44'/0'/0'");
    const xpub44 = ACCOUNT44.publicExtendedKey;
    const txs: Record<string, unknown[]> = {};
    // A receipt only on the bip44 change chain — the wallet's own hidden change.
    const change5 = p2pkh(ACCOUNT44.deriveChild(1).deriveChild(5).publicKey!, NETWORK).address;
    txs[hashOf(change5)] = [{ txid: "x" }];
    const scanned = await scanSourceWithHistory(
      esplora(txs),
      { kind: "xpub", template: "btc.bip44", xpub: xpub44, changeMark: 0 },
      "bip122:000000000019d6689c085ae165831e93",
      NETWORK,
    );
    const change = scanned.filter((a) => a.chain === 1);
    // The receive chain is fully unused (20 rows); the change chain is still walked — index 5
    // is found used, which re-arms gap-20 and the scan ends after one all-unused window.
    expect(scanned.filter((a) => a.chain === 0)).toHaveLength(20);
    expect(change).toHaveLength(40);
    expect(change.find((a) => a.index === 5)?.used).toBe(true);
  });
});

const realTimerDeps: EsploraDeps = {
  setTimer: (ms, fn) => {
    const id = setTimeout(fn, ms);
    return () => {
      clearTimeout(id);
    };
  },
  random: (n) => new Uint8Array(n),
};

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
    const es = esploraClient(["http://electrs.test"], hang, realTimerDeps, 20);
    await expect(es.get("/blocks/tip/height")).rejects.toThrow(EsploraError);
    await expect(es.get("/blocks/tip/height")).rejects.toMatchObject({ transient: true });
  });

  it("maps a 5xx to transient and a 4xx to permanent", async () => {
    const es500 = esploraClient(
      ["http://electrs.test"],
      async () => Promise.resolve(resp(500)),
      esploraDeps(),
    );
    await expect(es500.get("/x")).rejects.toMatchObject({ transient: true });
    const es404 = esploraClient(
      ["http://electrs.test"],
      async () => Promise.resolve(resp(404)),
      esploraDeps(),
    );
    await expect(es404.get("/x")).rejects.toMatchObject({ transient: false });
  });
});
