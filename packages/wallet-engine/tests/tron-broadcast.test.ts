/**
 * A TRON broadcast whose answer is unclear stays `submitted` — the signed bytes and the locally
 * computed id are persisted before anything leaves — and only a node's own refusal fails the send.
 * `DUP_TRANSACTION_ERROR` is held, not success; unknown codes and transport failures keep tracking;
 * polls rebroadcast the persisted wire until the solidified head passes `expiration`, then the
 * transaction is `dropped`. Persisted rows resume tracking after a restart; a locked vault keeps
 * bytes from leaving.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import { tronAddressFromPublicKey, tronTransactionId } from "@qntx/wallet-chains/tron";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type { TrackedTransaction } from "../src/transactions/route.ts";
import { idleNetworkDeps, send } from "./send-helpers.ts";
import { manualTimers } from "./support/timers.ts";

const POLL_MS = 4000;
const HOST = "http://host.local";
const NET = "tron:3448148188";
const PRIV = new Uint8Array(32).fill(0x11);
const FROM = tronAddressFromPublicKey(secp256k1.getPublicKey(PRIV, false));
const TO = tronAddressFromPublicKey(secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), false));
const SOLID_ID = "ab".repeat(32);
const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "tron.bip44" as const,
};
const SEND = {
  account: ACCOUNT,
  network: NET,
  to: TO,
  amount: 1_000_000n,
  fee: "normal" as const,
  verify: { kind: "password" as const, password: "pw" },
};
const PARAMS = {
  getTransactionFee: 1000,
  getEnergyFee: 210,
  getCreateAccountFee: 100_000,
  getCreateNewAccountFeeInSystemContract: 1_000_000,
  getMaxFeeLimit: 5_000_000_000,
  getCreateNewAccountBandwidthRate: 4,
  getMaxCreateAccountTxSize: 5000,
};

type Backing = { collections: Map<string, Map<string, Uint8Array>> };

const world = () => {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const broadcasts: string[] = [];
  const backing: Backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const warnings: string[] = [];
  const env = {
    /** Solid head timestamp — polls compare it to raw_data.expiration. */
    solidTime: 900_000,
    /** Full-node head number, for reorg checks. */
    fullHead: 105,
    /** Gettransactioninfobyid rows by id, per node kind. */
    solidInfo: new Map<string, Record<string, unknown>>(),
    fullInfo: new Map<string, Record<string, unknown>>(),
    /** Gettransactionbyid-known ids. */
    known: new Set<string>(),
  };
  let broadcastMode:
    | { kind: "ok" }
    | { kind: "refuse"; code: string; message?: string }
    | { kind: "drop" } = { kind: "ok" };

  const answer = (path: string, body: Record<string, unknown>): unknown => {
    posts.push({ path, body });
    switch (path) {
      case "/walletsolidity/getnowblock":
        return {
          blockID: SOLID_ID,
          block_header: { raw_data: { number: 100, timestamp: env.solidTime } },
        };
      case "/wallet/getnowblock":
        return {
          blockID: "cd".repeat(32),
          block_header: { raw_data: { number: env.fullHead, timestamp: 910_000 } },
        };
      case "/wallet/getchainparameters":
        return {
          chainParameter: Object.entries(PARAMS).map(([key, value]) => ({ key, value })),
        };
      case "/wallet/getaccount":
        return body["address"] === FROM
          ? { address: FROM, balance: 100_000_000 }
          : { address: TO, balance: 0 };
      case "/wallet/getaccountresource":
        return { freeNetLimit: 600, freeNetUsed: 0 };
      case "/wallet/broadcasthex": {
        const hex = String(body["transaction"]);
        broadcasts.push(hex);
        if (broadcastMode.kind === "drop") {
          throw new TypeError("fetch failed");
        }
        if (broadcastMode.kind === "refuse") {
          return {
            result: false,
            code: broadcastMode.code,
            message: broadcastMode.message ?? broadcastMode.code,
          };
        }
        /* The node returns the txid it computed — the caller still tracks the local one. */
        return { result: true, txid: "ee".repeat(32) };
      }
      case "/wallet/gettransactionbyid":
        return env.known.has(String(body["value"])) ? { txID: String(body["value"]) } : {};
      case "/wallet/gettransactioninfobyid":
        return env.fullInfo.get(String(body["value"])) ?? {};
      case "/walletsolidity/gettransactioninfobyid":
        return env.solidInfo.get(String(body["value"])) ?? {};
      default:
        throw new Error(`unmocked ${path}`);
    }
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    await Promise.resolve();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
      string,
      unknown
    >;
    if (path === "/wallet/broadcasthex" && broadcastMode.kind === "drop") {
      throw new TypeError("fetch failed");
    }
    return Response.json(answer(path, body));
  };

  let signedRawData: Uint8Array | undefined;
  const apis = {
    account: async () => Promise.resolve({ template: "tron.bip44", network: NET, address: FROM }),
    sign: async ({ request }: { request: { kind: string; rawData?: Uint8Array } }) => {
      await Promise.resolve();
      if (request.kind !== "tron.transaction" || !(request.rawData instanceof Uint8Array)) {
        throw new Error("unexpected request kind");
      }
      signedRawData = request.rawData;
      const sig = secp256k1.sign(request.rawData, PRIV, {
        lowS: true,
        format: "recovered",
      });
      const out = new Uint8Array(65);
      out.set(sig.subarray(1), 0);
      out[64] = 27 + (sig[0] ?? 0);
      return { kind: "tron.transaction" as const, signature: out };
    },
  } as unknown as ReturnType<typeof chains>;

  let tag = 0;
  const boot = async () => {
    const timers = manualTimers();
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks: new NetworkController({
        ...idleNetworkDeps,
        fetch: fetchImpl,
        rpc: { [NET]: [HOST] },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        logger: { warn: () => {} },
      }),
      openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      setTimer: timers.setTimer,
      now: () => 1_000_000,
      logger: { warn: (msg) => warnings.push(msg) },
      pollMs: POLL_MS,
      chains: apis,
    });
    await ctl.init();
    return { ctl, timers };
  };

  const persistedTx = async (id: string): Promise<Record<string, unknown> | undefined> => {
    const raw = await createMemoryEngineStore(backing).collection("transactions").get(id);
    return raw === undefined
      ? undefined
      : (JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>);
  };

  return {
    posts,
    broadcasts,
    env,
    backing,
    warnings,
    boot,
    persistedTx,
    signedRawData: () => signedRawData,
    setBroadcastMode: (mode: typeof broadcastMode) => {
      broadcastMode = mode;
    },
  };
};

const onlyTx = (ctl: TransactionController): TrackedTransaction => {
  const [id] = Object.keys(ctl.getState().txs);
  const tx = id === undefined ? undefined : ctl.getState().txs[id];
  if (tx === undefined) {
    throw new Error("no tracked transaction");
  }
  return tx;
};

const idHex = (rawData: Uint8Array | undefined): string =>
  rawData === undefined
    ? ""
    : [...tronTransactionId(rawData)].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("a TRON broadcast", () => {
  it("reports the locally computed id — the node's txid answer is display-only", async () => {
    const w = world();
    const { ctl } = await w.boot();
    const tx = await send(ctl, SEND);
    // The tracked id is sha256(raw_data) — not the 'ee…' the endpoint returned.
    const rawData = w.signedRawData();
    expect(rawData).toBeDefined();
    expect(tx.hash).toBe(idHex(rawData));
    const persisted = await w.persistedTx(tx.id);
    expect(persisted?.["tron"]).toMatchObject({ from: FROM });
    expect(persisted?.["raw"]).toBeTypeOf("string");
    expect(tx.state).toBe("submitted");
  });

  it("a refused code fails the send — nothing stays tracked", async () => {
    const w = world();
    const { ctl } = await w.boot();
    w.setBroadcastMode({ kind: "refuse", code: "CONTRACT_VALIDATE_ERROR", message: "bad sig" });
    await expect(send(ctl, SEND)).rejects.toThrow(/bad sig|CONTRACT_VALIDATE_ERROR/);
    const tx = onlyTx(ctl);
    expect(tx.state).toBe("failed");
    expect(tx.hash).toBeUndefined();
    expect(tx.raw).toBeUndefined();
    expect(tx.error).toMatch(/bad sig|CONTRACT_VALIDATE_ERROR/);
  });

  it("DUP_TRANSACTION_ERROR is held — the send tracks the id as submitted", async () => {
    const w = world();
    const { ctl } = await w.boot();
    w.setBroadcastMode({ kind: "refuse", code: "DUP_TRANSACTION_ERROR" });
    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    expect(tx.hash).toBeDefined();
  });

  it.each([
    "SERVER_BUSY",
    "NO_CONNECTION",
    "BLOCK_UNSOLIDIFIED",
    "NOT_ENOUGH_EFFECTIVE_CONNECTION",
    "OTHER_ERROR",
    "BRAND_NEW_CODE",
  ])("an unknown code (%s) keeps the send submitted", async (code) => {
    const w = world();
    const { ctl } = await w.boot();
    w.setBroadcastMode({ kind: "refuse", code });
    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    expect(tx.hash).toBeDefined();
  });

  it.each([
    "SIGERROR",
    "CONTRACT_EXE_ERROR",
    "BANDWITH_ERROR",
    "TAPOS_ERROR",
    "TOO_BIG_TRANSACTION_ERROR",
    "TRANSACTION_EXPIRATION_ERROR",
  ])("a refused code (%s) fails the send", async (code) => {
    const w = world();
    const { ctl } = await w.boot();
    w.setBroadcastMode({ kind: "refuse", code });
    await expect(send(ctl, SEND)).rejects.toThrow(code);
    const tx = onlyTx(ctl);
    expect(tx.state).toBe("failed");
  });

  it("a transport failure keeps the send submitted; polls rebroadcast the same wire", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    w.setBroadcastMode({ kind: "drop" });
    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    expect(w.broadcasts).toHaveLength(0); // nothing reached the node

    w.setBroadcastMode({ kind: "ok" });
    await timers.fire(POLL_MS);
    expect(w.broadcasts).toStrictEqual([tx.raw]); // byte-identical rebroadcast
  });

  it("rebroadcast stops once the solidified head passes expiration", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    w.setBroadcastMode({ kind: "drop" });
    const tx = await send(ctl, SEND);
    w.setBroadcastMode({ kind: "ok" });
    w.env.solidTime = 1_060_001; // expiration was now+60_000
    await timers.fire(POLL_MS);
    expect(ctl.getState().txs[tx.id]?.state).toBe("dropped");
    expect(w.broadcasts).toHaveLength(0); // a dropped transaction is never rebroadcast
  });

  it("a persisted signed row resumes tracking after a restart", async () => {
    const w = world();
    const first = await w.boot();
    w.setBroadcastMode({ kind: "drop" });
    const tx = await send(first.ctl, SEND);
    const persisted = await w.persistedTx(tx.id);
    expect(persisted?.["state"]).toBe("submitted");
    expect(persisted?.["tron"]).toMatchObject({ expiration: 1_060_000, from: FROM });

    first.ctl.lock();
    const second = await w.boot();
    const reloaded = second.ctl.getState().txs[tx.id];
    expect(reloaded?.state).toBe("submitted");
    expect(reloaded?.tron).toMatchObject({ expiration: 1_060_000, from: FROM });

    w.setBroadcastMode({ kind: "ok" });
    await second.timers.fire(POLL_MS);
    expect(w.broadcasts).toStrictEqual([tx.raw]); // the wire rebroadcasts after restart
  });

  it("a locked vault keeps signed bytes from leaving", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    w.setBroadcastMode({ kind: "drop" });
    const tx = await send(ctl, SEND);
    ctl.lock();
    await timers.fire(POLL_MS);
    expect(w.broadcasts).toHaveLength(0);
    void tx;
  });
});
