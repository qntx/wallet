/**
 * `pollTron` drops a not-yet-included transaction once the solidified head it read passes
 * `expiration` — and it decides from the primary endpoint alone. A load-balanced backend that is
 * still behind (its info reads both answer empty) makes the poll end `dropped` while the
 * independent endpoint — never consulted — already sees the transaction in a block.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import { tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import { idleNetworkDeps, send } from "../send-helpers.ts";
import { manualTimers } from "../support/timers.ts";

const POLL_MS = 4000;
const GATEWAY = "https://gateway.test";
const TRON_BASE = `${GATEWAY}/v1/tron`;
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

const INFO = {
  blockNumber: 90,
  blockTimeStamp: 880_000,
  fee: 200_000,
  receipt: { result: "SUCCESS" },
};

const world = () => {
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  /** Every POST the host (independent) endpoint was asked, by path. */
  const independentPosts: string[] = [];
  const env = {
    /** Primary solid head timestamp — crossing expiration proves the drop. */
    solidTime: 900_000,
    /** Primary full-node head number — send-time reads only. */
    fullHead: 105,
    /** Primary gettransactioninfobyid rows by id — empty means "not seen yet". */
    solidInfo: new Map<string, Record<string, unknown>>(),
    fullInfo: new Map<string, Record<string, unknown>>(),
    /** The independent endpoint sees the transaction from the start. */
    independentInfo: new Map<string, Record<string, unknown>>(),
  };

  const primary = (path: string, body: Record<string, unknown>): unknown => {
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
      case "/wallet/broadcasthex":
        return { result: true, txid: "ee".repeat(32) };
      case "/wallet/gettransactionbyid":
        return { txID: String(body["value"]) };
      case "/wallet/gettransactioninfobyid":
        return env.fullInfo.get(String(body["value"])) ?? {};
      case "/walletsolidity/gettransactioninfobyid":
        return env.solidInfo.get(String(body["value"])) ?? {};
      default:
        throw new Error(`unmocked primary ${path}`);
    }
  };

  const independent = (path: string, body: Record<string, unknown>): unknown => {
    switch (path) {
      case "/wallet/getblockbynum":
        return { blockID: SOLID_ID };
      case "/wallet/getchainparameters":
        return {
          chainParameter: Object.entries(PARAMS).map(([key, value]) => ({ key, value })),
        };
      case "/wallet/getaccount":
        return { address: TO, balance: 0 };
      case "/wallet/gettransactioninfobyid":
      case "/walletsolidity/gettransactioninfobyid":
        return env.independentInfo.get(String(body["value"])) ?? {};
      default:
        throw new Error(`unmocked independent ${path}`);
    }
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    await Promise.resolve();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GATEWAY}/v1/networks`) {
      return Response.json({ networks: [NET] });
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
      string,
      unknown
    >;
    if (url.startsWith(`${TRON_BASE}/${NET}/`)) {
      const path = url.slice(TRON_BASE.length + NET.length + 1);
      return Response.json(primary(path, body));
    }
    if (url.startsWith(HOST)) {
      const path = new URL(url).pathname;
      independentPosts.push(path);
      return Response.json(independent(path, body));
    }
    throw new Error(`unrouted ${url}`);
  };

  const apis = {
    account: async () => Promise.resolve({ template: "tron.bip44", network: NET, address: FROM }),
    sign: async ({ request }: { request: { kind: string; rawData?: Uint8Array } }) => {
      await Promise.resolve();
      if (request.kind !== "tron.transaction" || !(request.rawData instanceof Uint8Array)) {
        throw new Error("unexpected request kind");
      }
      const sig = secp256k1.sign(request.rawData, PRIV, { lowS: true, format: "recovered" });
      const out = new Uint8Array(65);
      out.set(sig.subarray(1), 0);
      out[64] = 27 + (sig[0] ?? 0);
      return { kind: "tron.transaction" as const, signature: out };
    },
  } as unknown as ReturnType<typeof chains>;

  let tag = 0;
  const boot = async () => {
    const timers = manualTimers();
    const networks = new NetworkController({
      ...idleNetworkDeps,
      fetch: fetchImpl,
      rpc: { [NET]: [HOST] },
      gateway: {
        url: GATEWAY,
        clientIds: {
          evm: "a".repeat(32),
          solana: "a".repeat(32),
          bitcoin: "a".repeat(32),
          tron: "a".repeat(32),
          service: "a".repeat(32),
        },
      },
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      logger: { warn: () => {} },
    });
    await networks.init();
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks,
      openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      setTimer: timers.setTimer,
      now: () => 1_000_000,
      logger: { warn: () => {} },
      pollMs: POLL_MS,
      chains: apis,
    });
    await ctl.init();
    return { ctl, timers };
  };

  return { env, independentPosts, boot };
};

const polls = async (timers: Awaited<ReturnType<ReturnType<typeof world>["boot"]>>["timers"], n = 1) => {
  for (let i = 0; i < n; i += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each poll re-arms the next
    await timers.fire(POLL_MS);
  }
};

describe("a TRON poll whose primary endpoint lags behind", () => {
  it("drops the transaction on the primary's empty reads alone — the knowing independent is never asked", async () => {
    const w = world();
    const { ctl, timers } = await w.boot();
    const tx = await send(ctl, SEND);
    expect(tx.state).toBe("submitted");
    const { hash } = tx;

    // The send's cross-check asked the host about the ref block, params and recipient — the
    // poll must not ask it anything.
    w.independentPosts.length = 0;

    // A backend behind the block: the solid head moved past expiration but neither info read
    // shows the transaction — while the independent endpoint already has it in block 90.
    w.env.solidTime = 1_060_001;
    w.env.independentInfo.set(hash ?? "", INFO);
    await polls(timers);
    expect(ctl.getState().txs[tx.id]?.state).toBe("dropped");
    expect(
      w.independentPosts.filter((p) => p.includes("gettransactioninfobyid")),
    ).toHaveLength(0);

    // The transaction was in a block all along — the primary catches up — but an ended row is
    // untracked: it stays dropped and nothing polls it again.
    w.env.fullInfo.set(hash ?? "", INFO);
    w.env.solidInfo.set(hash ?? "", INFO);
    expect(timers.armed(POLL_MS)).toBe(0);
    await polls(timers, 2);
    expect(ctl.getState().txs[tx.id]?.state).toBe("dropped");
  });
});
