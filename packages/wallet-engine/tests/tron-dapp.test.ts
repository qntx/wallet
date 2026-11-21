import { readFileSync } from "node:fs";

import { secp256k1 } from "@noble/curves/secp256k1.js";
/**
 * DApp-built TRON transactions: the wallet validates the exact `raw_data` bytes (modeled contract,
 * own owner, permission 0, bounded expiration, on-chain reference block), quotes and simulates
 * them, has the kernel sign those bytes untouched, then only observes the dApp's broadcast — the
 * entry never carries signed bytes for the poller to send. `submitDappTron` is the one broadcast
 * path, for the bytes the dApp hands back.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeTronRawData,
  encodeTronRawData,
  tronAddressFromPublicKey,
  tronAddressToHex,
  tronRawDataFromJson,
} from "@qntx/wallet-chains/tron";

import type { TronApi } from "../src/chains/tron.ts";
import type { TronLog } from "../src/gateway/contract/index.ts";
import type { Independent } from "../src/networks/controller.ts";
import type {
  AccountRef,
  RouteContext,
  SendParams,
  TrackedTransaction,
} from "../src/transactions/route.ts";
import { pollTron, prepareDappTron, submitDappTron } from "../src/transactions/tron.ts";

const NET = "tron:728126428";
const PRIV = new Uint8Array(32).fill(0x11);
const FROM = tronAddressFromPublicKey(secp256k1.getPublicKey(PRIV, false));
const FROM_HEX = tronAddressToHex(FROM);
const TO = tronAddressFromPublicKey(secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), false));
const TO_HEX = tronAddressToHex(TO);
const OTHER = tronAddressFromPublicKey(
  secp256k1.getPublicKey(new Uint8Array(32).fill(0x33), false),
);
const OTHER_HEX = tronAddressToHex(OTHER);
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"; // mainnet USDT — in the built-in table.
const ACCOUNT: AccountRef = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "tron.bip44",
};
const VERIFY = { kind: "password", password: "pw" } as SendParams["verify"];

/** Full-node head 105; the reference block is the solid head at 100. */
const SOLID_ID = "ab".repeat(32);
const REF_BYTES = "0064";
const REF_HASH = SOLID_ID.slice(16, 32);
const EXPIRATION = 1_100_000;
const NOW = 1_000_000;

const PARAMS = {
  getTransactionFee: 1000,
  getEnergyFee: 210,
  getCreateAccountFee: 100_000,
  getCreateNewAccountFeeInSystemContract: 1_000_000,
  getMaxFeeLimit: 5_000_000_000,
  getCreateNewAccountBandwidthRate: 4,
  getMaxCreateAccountTxSize: 5000,
  getMemoFee: 1_000_000,
};
const CHAIN_PARAMETERS = {
  chainParameter: Object.entries(PARAMS).map(([key, value]) => ({ key, value })),
};
const RESOURCES = {
  freeNetLimit: 600,
  freeNetUsed: 0,
  NetLimit: 0,
  NetUsed: 0,
  EnergyLimit: 0,
  EnergyUsed: 0,
};

const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};
const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const SUNIO = JSON.parse(
  readFileSync(new URL("fixtures/tron-sunio-swap.json", import.meta.url), "utf8"),
) as {
  readonly raw_data: Record<string, unknown>;
  readonly raw_data_hex: string;
  readonly txID: string;
  readonly visible: boolean;
};
const SUNIO_OWNER = "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb";
/** The fixture's reference block 52480, its hash carried in id bytes 8–16 like a real blockID. */
const SUNIO_REF_ID = `0000cd0000000000${SUNIO.raw_data["ref_block_hash"]}${"00".repeat(16)}`;

const transferContract = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  parameter: {
    value: { amount: 1_000_000, owner_address: FROM_HEX, to_address: TO_HEX, ...over },
    type_url: "type.googleapis.com/protocol.TransferContract",
  },
  type: "TransferContract",
});

/** A USDT `transfer(to, 0xf42400)` call — the calldata layout the intent decoder models. */
const triggerContract = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  parameter: {
    value: {
      owner_address: FROM_HEX,
      contract_address: tronAddressToHex(USDT),
      data: `a9059cbb${"0".repeat(24)}${TO_HEX.slice(2)}${"0".repeat(56)}00f42400`,
      ...over,
    },
    type_url: "type.googleapis.com/protocol.TriggerSmartContract",
  },
  type: "TriggerSmartContract",
});

const rawJson = (
  over: Record<string, unknown> = {},
  contract: Record<string, unknown> = transferContract(),
): Record<string, unknown> => ({
  ref_block_bytes: REF_BYTES,
  ref_block_hash: REF_HASH,
  expiration: EXPIRATION,
  timestamp: 1_040_000,
  contract: [contract],
  ...over,
});

/** The raw_data bytes a dApp would hand over — built through the strict JSON path. */
const dappRawData = (
  over: Record<string, unknown> = {},
  contract?: Record<string, unknown>,
): Uint8Array => tronRawDataFromJson(rawJson(over, contract), false);

type World = {
  accounts: Map<string, Record<string, unknown>>;
  owner: string;
  /** Full-node head — the TaPoS number is recovered against it. */
  fullHead: number;
  solidBlock: { number: number; timestamp: number };
  blockIds: Map<number, string>;
  energyUsed: number;
  logs: TronLog[];
  callOk: boolean;
  resources: Record<string, unknown>;
  solidInfo: Map<string, Record<string, unknown>>;
  fullInfo: Map<string, Record<string, unknown>>;
  broadcasts: string[];
  independent: Independent<TronApi>;
  posts: Array<{ path: string; body: unknown }>;
  signCalls: Array<{ request: { kind: string; rawData?: Uint8Array } }>;
  lastSignature: Uint8Array | undefined;
};

const world = (over: Partial<World> = {}): World & { api: TronApi } => {
  const w: World = {
    accounts: new Map([
      [FROM, { address: FROM, balance: 100_000_000 }],
      [TO, { address: TO, balance: 0 }],
      [SUNIO_OWNER, { address: SUNIO_OWNER, balance: 500_000_000 }],
    ]),
    owner: FROM,
    fullHead: 105,
    solidBlock: { number: 100, timestamp: 900_000 },
    blockIds: new Map([[100, SOLID_ID]]),
    energyUsed: 14_630,
    logs: [],
    callOk: true,
    resources: RESOURCES,
    solidInfo: new Map(),
    fullInfo: new Map(),
    broadcasts: [],
    independent: { kind: "not-needed" },
    posts: [],
    signCalls: [],
    lastSignature: undefined,
    ...over,
  };
  const api: TronApi = {
    post: async (path, body) => {
      await Promise.resolve();
      w.posts.push({ path, body });
      const b = body as Record<string, unknown>;
      switch (path) {
        case "/walletsolidity/getnowblock":
          return {
            blockID: SOLID_ID,
            block_header: { raw_data: { ...w.solidBlock } },
          };
        case "/wallet/getnowblock":
          return {
            blockID: "cd".repeat(32),
            block_header: {
              raw_data: { number: w.fullHead, timestamp: w.solidBlock.timestamp + 10_000 },
            },
          };
        case "/wallet/getblockbynum":
        case "/walletsolidity/getblockbynum": {
          const id = w.blockIds.get(Number(b["num"]));
          return id === undefined
            ? {}
            : {
                blockID: id,
                block_header: {
                  raw_data: { number: b["num"], timestamp: w.solidBlock.timestamp },
                },
              };
        }
        case "/wallet/getchainparameters":
          return CHAIN_PARAMETERS;
        case "/wallet/getaccount":
          return w.accounts.get(String(b["address"])) ?? {};
        case "/wallet/getaccountresource":
          return w.resources;
        case "/wallet/triggerconstantcontract":
          return w.callOk
            ? {
                result: { result: true },
                energy_used: w.energyUsed,
                energy_penalty: 0,
                logs: w.logs,
              }
            : { result: { code: "REVERT", message: "524556552" }, energy_used: w.energyUsed };
        case "/wallet/broadcasthex":
          w.broadcasts.push(String(b["transaction"]));
          return { result: true, txid: "ee".repeat(32) };
        case "/wallet/gettransactionbyid":
          return {};
        case "/wallet/gettransactioninfobyid":
          return w.fullInfo.get(String(b["value"])) ?? {};
        case "/walletsolidity/gettransactioninfobyid":
          return w.solidInfo.get(String(b["value"])) ?? {};
        default:
          throw new Error(`unmocked ${path}`);
      }
    },
  };
  return Object.assign(w, { api });
};

const ctx = (
  w: World & { api: TronApi },
  now: () => number = () => NOW,
): { ctx: RouteContext; txs: Record<string, TrackedTransaction> } => {
  const txs: Record<string, TrackedTransaction> = {};
  return {
    txs,
    ctx: {
      options: {
        networks: {
          tronApi: () => w.api,
          independentTronApi: () => w.independent,
        } as never,
        wallet: {} as never,
        openStore: async () => Promise.resolve({} as never),
        random: (n: number) => new Uint8Array(n).fill(0x55),
        setTimer: () => () => {},
        now,
        logger: { warn: () => {} },
        chains: {
          account: async () =>
            Promise.resolve({ template: "tron.bip44", network: NET, address: w.owner }),
          sign: async (p: { request: { kind: string; rawData?: Uint8Array } }) => {
            await Promise.resolve();
            w.signCalls.push(p);
            const { request } = p;
            if (request.kind !== "tron.transaction" || !(request.rawData instanceof Uint8Array)) {
              throw new Error("wrong kind");
            }
            const sig = secp256k1.sign(request.rawData, PRIV, {
              lowS: true,
              format: "recovered",
            });
            const out = new Uint8Array(65);
            out.set(sig.subarray(1), 0);
            out[64] = 27 + (sig[0] ?? 0);
            w.lastSignature = out;
            return { kind: "tron.transaction" as const, signature: out };
          },
        } as never,
      },
      transition: async (tx, next) => {
        const merged = { ...tx, ...next };
        txs[merged.id] = merged;
        return Promise.resolve(merged);
      },
      track: () => {},
      txs: () => txs,
      newId: () => "tx-test",
    },
  };
};

/** A 65-byte signature over `raw` by `priv`, in the kernel's r‖s‖v form. */
const signBytes = (raw: Uint8Array, priv: Uint8Array): Uint8Array => {
  const sig = secp256k1.sign(raw, priv, { lowS: true, format: "recovered" });
  const out = new Uint8Array(65);
  out.set(sig.subarray(1), 0);
  out[64] = 27 + (sig[0] ?? 0);
  return out;
};

/** The signature the world's kernel stub produced — throws when nothing was signed. */
const lastSignature = (w: World): Uint8Array => {
  const { lastSignature: sig } = w;
  if (sig === undefined) {
    throw new Error("nothing was signed");
  }
  return sig;
};

describe("prepareDappTron", () => {
  const prepare = async (w: World & { api: TronApi }, raw: Uint8Array, now = () => NOW) =>
    prepareDappTron(ctx(w, now).ctx, ACCOUNT, NET, raw);

  it("prepares a dApp transfer: intent, quote and the exact bytes signed", async () => {
    const w = world();
    const raw = dappRawData();
    const prepared = await prepare(w, raw);
    expect(prepared.intent.tron?.contractType).toBe("TransferContract");
    expect(prepared.intent.outflows[0]?.amount.amount).toBe("1000000");
    expect(prepared.tronFee).toBeDefined();
    const tx = await prepared.submit(VERIFY, () => undefined);
    const [call] = w.signCalls;
    expect(call?.request.rawData).toStrictEqual(raw); // the kernel signs the dApp's bytes verbatim
    expect(tx.state).toBe("submitted");
    expect(tx.hash).toBe(bytesToHex(sha256(raw)));
    expect(tx.raw).toBeUndefined(); // an observed entry never carries signed bytes
    expect(tx.tron?.expiration).toBe(EXPIRATION);
    expect(tx.tron?.dappSignature).toBe(bytesToHex(lastSignature(w)));
    expect(w.broadcasts).toHaveLength(0); // the wallet only observes — the dApp broadcasts
  });

  it("refuses a transaction owned by another account", async () => {
    const w = world();
    await expect(
      prepare(w, dappRawData({}, transferContract({ owner_address: OTHER_HEX }))),
    ).rejects.toThrow("owner is not the signing account");
  });

  it("refuses a non-zero Permission_id", async () => {
    const w = world();
    const contract = { ...transferContract(), Permission_id: 2 };
    await expect(prepare(w, dappRawData({}, contract))).rejects.toThrow("Permission_id must be 0");
  });

  it("refuses a contract type the wallet does not model", async () => {
    const w = world();
    const raw = decodeTronRawData(dappRawData());
    const unmodeled = encodeTronRawData({
      ...raw,
      contract: { ...raw.contract, typeId: 999, typeUrl: "type.googleapis.com/protocol.X" },
    });
    await expect(prepare(w, unmodeled)).rejects.toThrow("not modeled");
  });

  it("refuses an expired transaction", async () => {
    const w = world();
    await expect(prepare(w, dappRawData({ expiration: NOW - 1 }))).rejects.toThrow(
      "already expired",
    );
  });

  it("refuses an expiration more than 24 hours ahead", async () => {
    const w = world();
    await expect(
      prepare(w, dappRawData({ expiration: NOW + 25 * 60 * 60 * 1000 })),
    ).rejects.toThrow("more than 24 hours ahead");
  });

  it("refuses a transaction with under 20 seconds of validity left", async () => {
    const w = world();
    await expect(prepare(w, dappRawData({ expiration: NOW + 19_000 }))).rejects.toThrow(
      "the transaction expires in less than 20 s — the dApp must build it again",
    );
  });

  it("refuses a transaction whose reference block is not on this chain", async () => {
    const w = world();
    w.blockIds.set(100, "dd".repeat(32));
    await expect(prepare(w, dappRawData())).rejects.toThrow(
      "references a block that is not on this chain",
    );
  });

  it("refuses when the balance does not cover the outflow plus fees", async () => {
    const w = world({
      accounts: new Map([
        [FROM, { address: FROM, balance: 1_000_000 }],
        [TO, { address: TO, balance: 0 }],
      ]),
      // No free bandwidth — the flat byte fee lands on top of the 1 TRX outflow.
      resources: { freeNetLimit: 600, freeNetUsed: 600 },
    });
    await expect(prepare(w, dappRawData())).rejects.toThrow("does not cover");
  });

  it("warns when the dApp's fee_limit is below the energy estimate", async () => {
    const w = world(); // 14_630 energy at 210 sun — the estimate costs ~3× the 1_000_000 cap
    const raw = dappRawData({ fee_limit: 1_000_000 }, triggerContract());
    const prepared = await prepare(w, raw);
    expect(prepared.tronFee?.warnings).toContain("fee-limit-below-estimate");
    expect(prepared.risk).toContainEqual({ code: "fee-limit-below-estimate", level: "warning" });
  });

  it("reports stale once under 20 seconds remain or the reference block moved", async () => {
    const w = world();
    const clock = { now: NOW };
    const prepared = await prepare(w, dappRawData(), () => clock.now);
    await expect(prepared.staleReason()).resolves.toBeUndefined();
    clock.now = EXPIRATION - 19_000;
    await expect(prepared.staleReason()).resolves.toBe(
      "the transaction expires in less than 20 s — the dApp must build it again",
    );
    const moved = world();
    const prepared2 = await prepare(moved, dappRawData());
    moved.blockIds.set(100, "dd".repeat(32));
    await expect(prepared2.staleReason()).resolves.toBe(
      "the transaction's reference block left the chain",
    );
  });
});

describe("prepareDappTron with the SUN.io fixture", () => {
  const SUNIO_NOW = 1_795_269_375_000; // 60 s before the fixture's expiration

  const sunioWorld = (): World & { api: TronApi } =>
    world({
      owner: SUNIO_OWNER,
      fullHead: 65_636,
      blockIds: new Map([
        [52_480, SUNIO_REF_ID],
        [100, SOLID_ID],
      ]),
      energyUsed: 300_000,
      logs: [
        {
          address: tronAddressToHex(USDT).slice(2),
          topics: [
            "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            `0000000000000000000000${tronAddressToHex(SUNIO_OWNER)}`,
            `0000000000000000000000${tronAddressToHex(TO)}`,
          ],
          data: `${"0".repeat(56)}00f42400`,
        },
      ],
    });

  it("accepts a real SUN.io swap transaction and simulates its TRC-20 flow", async () => {
    const w = sunioWorld();
    const raw = hexToBytes(SUNIO.raw_data_hex);
    const prepared = await prepareDappTron(ctx(w, () => SUNIO_NOW).ctx, ACCOUNT, NET, raw);
    expect(prepared.intent.tron?.contractType).toBe("TriggerSmartContract");
    expect(prepared.tronFee).toBeDefined();
    expect(prepared.simulation).toMatchObject({
      status: "success",
      changes: [{ asset: USDT, amount: "-16000000", verified: true }],
    });
    // bytes 8–16 of the reference block's id are its ref_block_hash — proven against the node
    // (block 52480 sits above the solid head, so the full node answers it)
    const refPost = w.posts.filter((p) => p.path === "/wallet/getblockbynum");
    expect(refPost.map((p) => (p.body as { num?: number }).num)).toContain(52_480);
  });
});

describe("submitDappTron", () => {
  const signed = async (
    w: World & { api: TronApi },
  ): Promise<{ ctx: RouteContext; raw: Uint8Array; tx: TrackedTransaction }> => {
    const { ctx: route } = ctx(w);
    const raw = dappRawData();
    const prepared = await prepareDappTron(route, ACCOUNT, NET, raw);
    const tx = await prepared.submit(VERIFY, () => undefined);
    return { ctx: route, raw, tx };
  };

  it("broadcasts once for the entry the wallet observed, then returns it unchanged", async () => {
    const w = world();
    const { ctx: c, raw } = await signed(w);
    const signature = lastSignature(w);
    const first = await submitDappTron(c, { network: NET, rawData: raw, signature });
    expect(first.raw).toBeDefined();
    expect(w.broadcasts).toHaveLength(1);
    const again = await submitDappTron(c, { network: NET, rawData: raw, signature });
    expect(again.id).toBe(first.id);
    expect(w.broadcasts).toHaveLength(1);
  });

  it("refuses a signature the wallet did not produce", async () => {
    const w = world();
    const { ctx: c, raw } = await signed(w);
    const signature = signBytes(raw, new Uint8Array(32).fill(0x44));
    await expect(submitDappTron(c, { network: NET, rawData: raw, signature })).rejects.toThrow(
      "this transaction was not signed by this wallet",
    );
  });

  it("refuses a stored entry whose signature no longer verifies against its sender", async () => {
    const w = world();
    const { ctx: c, txs } = ctx(w);
    const raw = dappRawData();
    const signature = signBytes(raw, new Uint8Array(32).fill(0x44)); // parses, wrong key
    txs["tx-craft"] = {
      id: "tx-craft",
      family: "tron",
      network: NET,
      account: "w",
      hash: bytesToHex(sha256(raw)),
      state: "submitted",
      intent: undefined,
      nonce: 0,
      tron: { expiration: EXPIRATION, from: FROM, dappSignature: bytesToHex(signature) },
      submittedAt: NOW,
      error: undefined,
    };
    await expect(submitDappTron(c, { network: NET, rawData: raw, signature })).rejects.toThrow(
      "this transaction was not signed by this wallet",
    );
  });

  it("refuses a transaction id it never signed", async () => {
    const w = world();
    const { ctx: c, raw } = await signed(w);
    const other = dappRawData({ timestamp: 1_040_001 });
    const signature = lastSignature(w);
    await expect(submitDappTron(c, { network: NET, rawData: other, signature })).rejects.toThrow(
      "this transaction was not signed by this wallet",
    );
    // and on the wrong network the observed entry does not match either
    await expect(
      submitDappTron(c, { network: "tron:3448148188", rawData: raw, signature }),
    ).rejects.toThrow("this transaction was not signed by this wallet");
  });

  it("an observed entry resolves through the poll lifecycle without ever broadcasting", async () => {
    const w = world();
    const { ctx: c, tx } = await signed(w);
    expect(tx.raw).toBeUndefined();
    // still submitted: neither node knows the hash yet — and nothing is broadcast
    await expect(pollTron(c, tx)).resolves.toBeUndefined();
    expect(w.broadcasts).toHaveLength(0);
    // the solid node proves inclusion → confirmed and final in one step
    const info = {
      id: tx.hash,
      blockNumber: 90,
      blockTimeStamp: 800_000,
      receipt: { result: "SUCCESS" },
    };
    w.solidInfo.set(String(tx.hash), info);
    const poll = await pollTron(c, tx);
    expect(poll).toMatchObject({ kind: "included", state: "confirmed", final: true });
    expect(w.broadcasts).toHaveLength(0);
    // a second entry never included and past expiration on the solidified head → dropped
    const { tx: tx2 } = await signed(w);
    w.solidInfo.clear();
    w.solidBlock = { number: 200, timestamp: EXPIRATION + 1 };
    await expect(pollTron(c, tx2)).resolves.toMatchObject({ kind: "ended", state: "dropped" });
    expect(w.broadcasts).toHaveLength(0);
  });
});
