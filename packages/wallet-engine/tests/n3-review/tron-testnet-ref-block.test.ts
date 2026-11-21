/**
 * A testnet send through the gateway with no host endpoint: `crossCheckTron` returns early on an
 * unavailable independent read, so the reference block bound into the signed `raw_data` is whatever
 * the single gateway endpoint answered — any block id it invents is signed verbatim, and the only
 * check the request carries is `reads-unverified`.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import { decodeTronRawData, tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import { approval } from "../approval.ts";
import { idleNetworkDeps, requestsFor } from "../send-helpers.ts";
import { manualTimers } from "../support/timers.ts";

const POLL_MS = 4000;
const GATEWAY = "https://gateway.test";
const TRON_BASE = `${GATEWAY}/v1/tron`;
const NET = "tron:3448148188";
const PRIV = new Uint8Array(32).fill(0x11);
const FROM = tronAddressFromPublicKey(secp256k1.getPublicKey(PRIV, false));
const TO = tronAddressFromPublicKey(secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), false));
/* The single endpoint's head — arbitrary values standing in for a block it never proved. */
const BLOCK_NUMBER = 87_000_123;
const BLOCK_ID = "ab".repeat(32);
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

const world = () => {
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };

  const answer = (path: string, body: Record<string, unknown>): unknown => {
    switch (path) {
      case "/walletsolidity/getnowblock":
        return {
          blockID: BLOCK_ID,
          block_header: { raw_data: { number: BLOCK_NUMBER, timestamp: 900_000 } },
        };
      case "/wallet/getnowblock":
        return {
          blockID: "cd".repeat(32),
          block_header: { raw_data: { number: 105, timestamp: 910_000 } },
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
      default:
        throw new Error(`unmocked ${path}`);
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
      return Response.json(answer(path, body));
    }
    throw new Error(`unrouted ${url}`);
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
      rpc: {},
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
    return { ctl };
  };

  return { boot, signedRawData: () => signedRawData };
};

describe("a testnet send with only the gateway behind it", () => {
  it("signs the endpoint's unverified reference block — no second read proves it", async () => {
    const w = world();
    const { ctl } = await w.boot();
    const requests = await requestsFor(ctl);
    const { verify, ...rest } = SEND;
    const request = await requests.prepare({ method: "send", ...rest });

    // The independent endpoint does not exist, so nothing cross-checked the reference block.
    expect(request.checks).toStrictEqual(["reads-unverified"]);

    await requests.approve(request.id, "send", approval(request, verify));
    const rawData = w.signedRawData();
    expect(rawData).toBeDefined();
    const raw = decodeTronRawData(rawData!);

    // ref_block_bytes is the block number's low two bytes; ref_block_hash is id bytes 8..16 —
    // bound to whatever the single endpoint answered.
    const numberBytes = new Uint8Array(8);
    new DataView(numberBytes.buffer).setUint32(4, BLOCK_NUMBER);
    expect([...raw.refBlockBytes]).toStrictEqual([...numberBytes.subarray(6, 8)]);
    const idBytes = new Uint8Array(16).fill(0xab);
    expect([...raw.refBlockHash]).toStrictEqual([...idBytes.subarray(8, 16)]);
  });
});
