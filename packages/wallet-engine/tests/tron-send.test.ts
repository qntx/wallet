import { secp256k1 } from "@noble/curves/secp256k1.js";
/**
 * TRON send preparation: every decisive read is served by a fake `TronApi` (and, when it matters,
 * an independent second one), the kernel's signature is real — the route verifies it — and the
 * transaction is built, decoded and broadcast from local bytes only; a node's `transaction` field
 * is never consulted.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { createBase58check } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import { ChainError } from "@qntx/wallet-chains";
import {
  tronAddressFromPublicKey,
  tronAddressToBytes,
  tronAddressToHex,
} from "@qntx/wallet-chains/tron";

import type { TronApi } from "../src/chains/tron.ts";
import type { TronLog } from "../src/gateway/contract/index.ts";
import type { Independent } from "../src/networks/controller.ts";
import type {
  AccountRef,
  PrepareParams,
  RouteContext,
  SendParams,
  TrackedTransaction,
} from "../src/transactions/route.ts";
import { prepareTron } from "../src/transactions/tron.ts";

const NET = "tron:3448148188";
const PRIV = new Uint8Array(32).fill(0x11);
const FROM = tronAddressFromPublicKey(secp256k1.getPublicKey(PRIV, false));
const TO = tronAddressFromPublicKey(secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), false));
const TOKEN = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"; // Nile USDT — in the built-in table.
const UNKNOWN_TOKEN = tronAddressFromPublicKey(
  secp256k1.getPublicKey(new Uint8Array(32).fill(0x44), false),
);
const TRC10 = "1002000";
const SOLID_ID = "ab".repeat(32);
const ACCOUNT: AccountRef = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "tron.bip44",
};
const VERIFY = { kind: "password", password: "pw" } as SendParams["verify"];

const PARAMS = {
  getTransactionFee: 1000,
  getEnergyFee: 210,
  getCreateAccountFee: 100_000,
  getCreateNewAccountFeeInSystemContract: 1_000_000,
  getMaxFeeLimit: 5_000_000_000,
  getCreateNewAccountBandwidthRate: 4,
  getMaxCreateAccountTxSize: 5000,
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
const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicOf = (address: string): string => `${"0".repeat(22)}${tronAddressToHex(address)}`;
const u256 = (n: bigint): string => n.toString(16).padStart(64, "0");
// `triggerconstantcontract` with visible:true emits the 20-byte body base58check-encoded — not
// the `41…` form `raw_data` fields carry.
const base58check = createBase58check(sha256);
const logAddress = (address: string): string =>
  base58check.encode(tronAddressToBytes(address).subarray(1));

const transferLog = (from: string, to: string, amount: bigint): TronLog => ({
  address: logAddress(TOKEN),
  topics: [TRANSFER_TOPIC, topicOf(from), topicOf(to)],
  data: u256(amount),
});
const holderOf = (data: string): string | undefined =>
  [FROM, TO].find(
    (a) => `0x${tronAddressToHex(a).slice(2).toLowerCase()}` === `0x${data.slice(-40)}`,
  );

type World = {
  accounts: Map<string, Record<string, unknown>>;
  balances: Map<string, bigint>;
  energyUsed: number;
  energyPenalty: number;
  logs: TronLog[];
  callOk: boolean;
  callMessage: string | undefined;
  broadcastBody: Record<string, unknown>;
  broadcastThrow: unknown;
  known: Set<string>;
  solidInfo: Map<string, Record<string, unknown>>;
  fullInfo: Map<string, Record<string, unknown>>;
  blockIds: Map<number, string>;
  independent: Independent<TronApi>;
  posts: Array<{ path: string; body: unknown }>;
  signCalls: Array<{ request: { kind: string; rawData?: Uint8Array } }>;
};

const world = (over: Partial<World> = {}): World & { api: TronApi } => {
  const w: World = {
    accounts: new Map([
      [FROM, { address: FROM, balance: 100_000_000, assetV2: [{ key: TRC10, value: 50_000 }] }],
      [TO, { address: TO, balance: 0 }],
    ]),
    balances: new Map([[FROM, 100_000_000n]]),
    energyUsed: 14_630,
    energyPenalty: 0,
    logs: [transferLog(FROM, TO, 42_000_000n)],
    callOk: true,
    callMessage: undefined,
    broadcastBody: { result: true },
    broadcastThrow: undefined,
    known: new Set(),
    solidInfo: new Map(),
    fullInfo: new Map(),
    blockIds: new Map([[100, SOLID_ID]]),
    independent: { kind: "not-needed" },
    posts: [],
    signCalls: [],
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
            block_header: { raw_data: { number: 100, timestamp: 900_000 } },
          };
        case "/wallet/getnowblock":
          return {
            blockID: "cd".repeat(32),
            block_header: { raw_data: { number: 105, timestamp: 910_000 } },
          };
        case "/wallet/getblockbynum":
        case "/walletsolidity/getblockbynum": {
          const id = w.blockIds.get(Number(b["num"]));
          return id === undefined
            ? {}
            : { blockID: id, block_header: { raw_data: { number: b["num"], timestamp: 900_000 } } };
        }
        case "/wallet/getchainparameters":
          return CHAIN_PARAMETERS;
        case "/wallet/getaccount":
          return w.accounts.get(String(b["address"])) ?? {};
        case "/wallet/getaccountresource":
          return RESOURCES;
        case "/wallet/triggerconstantcontract": {
          if (!w.callOk) {
            const message =
              w.callMessage === undefined
                ? undefined
                : [...new TextEncoder().encode(w.callMessage)]
                    .map((x) => x.toString(16).padStart(2, "0"))
                    .join("");
            return {
              result: { code: "REVERT", ...(message === undefined ? {} : { message }) },
              transaction: { ignored: "node field" },
            };
          }
          const data = String(b["data"] ?? "");
          if (data.startsWith("70a08231")) {
            const holder = holderOf(data);
            return {
              result: { result: true },
              energy_used: 0,
              constant_result: [u256(w.balances.get(holder ?? "") ?? 0n)],
            };
          }
          return {
            result: { result: true },
            energy_used: w.energyUsed,
            energy_penalty: w.energyPenalty,
            logs: w.logs,
            transaction: { malicious: "node-provided transaction — must be ignored" },
          };
        }
        case "/wallet/broadcasthex":
          if (w.broadcastThrow !== undefined) {
            throw w.broadcastThrow;
          }
          return { txid: "ee".repeat(32), ...w.broadcastBody };

        case "/wallet/gettransactionbyid":
          return w.known.has(String(b["value"])) ? { txID: String(b["value"]) } : {};
        case "/wallet/gettransactioninfobyid":
          return w.fullInfo.get(String(b["value"])) ?? {};
        case "/walletsolidity/gettransactioninfobyid":
          return w.solidInfo.get(String(b["value"])) ?? {};
        default:
          throw new Error(`unmocked ${path}`);
      }
    },
  };
  return { ...w, api };
};

const ctx = (
  w: World & { api: TronApi },
  now: () => number = () => 1_000_000,
  wallet: RouteContext["options"]["wallet"] = {} as never,
): { ctx: RouteContext; transitions: TrackedTransaction[] } => {
  const transitions: TrackedTransaction[] = [];
  return {
    ctx: {
      options: {
        networks: {
          tronApi: () => w.api,
          independentTronApi: () => w.independent,
        } as never,
        wallet,
        openStore: async () => Promise.resolve({} as never),
        random: (n: number) => new Uint8Array(n).fill(0x55),
        setTimer: () => () => {},
        now,
        logger: { warn: () => {} },
        chains: {
          account: async () =>
            Promise.resolve({ template: "tron.bip44", network: NET, address: FROM }),
          sign: async (p: { request: { kind: string; rawData?: Uint8Array } }) => {
            await Promise.resolve();
            w.signCalls.push(p);
            const { request } = p;
            if (request.kind !== "tron.transaction" || !(request.rawData instanceof Uint8Array)) {
              throw new Error("wrong kind");
            }
            // noble hashes the message with sha256 itself — TRON signs sha256(raw_data).
            const sig = secp256k1.sign(request.rawData, PRIV, {
              lowS: true,
              format: "recovered",
            });
            const out = new Uint8Array(65);
            out.set(sig.subarray(1), 0); // noble emits recovery‖r‖s
            out[64] = 27 + (sig[0] ?? 0);
            return { kind: "tron.transaction" as const, signature: out };
          },
        } as never,
      },
      transition: async (tx, next) => {
        const merged = { ...tx, ...next };
        transitions.push(merged);
        return Promise.resolve(merged);
      },
      track: () => {},
      txs: () => ({}),
      newId: () => "tx-test",
    },
    transitions,
  };
};

const params = (
  over: {
    readonly token?: string | undefined;
    readonly to?: string | undefined;
    readonly amount?: bigint | undefined;
    readonly account?: AccountRef | undefined;
  } = {},
): PrepareParams => ({
  account: over.account ?? ACCOUNT,
  network: NET,
  to: over.to ?? TO,
  amount: over.amount ?? 1_000_000n,
  fee: "normal",
  ...(over.token === undefined ? {} : { token: over.token }),
});

const submit = async (w: World & { api: TronApi }, p = params()): Promise<TrackedTransaction> => {
  const prepared = await prepareTron(ctx(w).ctx, p);
  return prepared.submit(VERIFY, () => undefined);
};

/** The raw_data bytes the kernel was asked to sign. */
const signedRawData = (w: World & { api: TronApi }): Uint8Array => {
  const [call] = w.signCalls;
  if (call?.request.rawData === undefined) {
    throw new Error("nothing was signed");
  }
  return call.request.rawData;
};

type IndependentFixture = {
  readonly calls?: string[];
  readonly blockId?: string;
  readonly params?: unknown;
  readonly account?: unknown;
  readonly trigger?: unknown;
};

/** The independent endpoint's standard answers; `over` swaps one at a time per test. */
const independentApi = (over: IndependentFixture = {}): TronApi => ({
  post: async (path, body) => {
    over.calls?.push(path);
    const num = (body as { readonly num?: number }).num ?? 100;
    switch (path) {
      case "/wallet/getblockbynum":
        return Promise.resolve({
          blockID: over.blockId ?? SOLID_ID,
          block_header: { raw_data: { number: num, timestamp: 900_000 } },
        });
      case "/wallet/getchainparameters":
        return Promise.resolve(over.params ?? CHAIN_PARAMETERS);
      case "/wallet/getaccount":
        return Promise.resolve(over.account ?? { address: TO });
      case "/wallet/triggerconstantcontract":
        return Promise.resolve(
          over.trigger ?? { result: { result: true }, energy_used: 14_630, energy_penalty: 0 },
        );
      default:
        return Promise.reject(new Error(`unexpected ${path}`));
    }
  },
});

/** A TronApi that answers `value` for one path and delegates everything else to `base`. */
const overrideApi = (base: TronApi, path: string, value: unknown): TronApi => ({
  post: async (p, body) => (p === path ? Promise.resolve(value) : base.post(p, body)),
});

const broadcastBody = (w: {
  posts: Array<{ path: string; body: unknown }>;
}): Record<string, unknown> => {
  const sent = w.posts.find((post) => post.path === "/wallet/broadcasthex");
  if (sent === undefined) {
    throw new Error("no broadcast was posted");
  }
  return sent.body as Record<string, unknown>;
};

const successChanges = (prepared: { simulation?: unknown }): unknown =>
  (prepared.simulation as { status: string; changes?: unknown } | undefined)?.status === "success"
    ? (prepared.simulation as { changes: unknown }).changes
    : undefined;

describe("prepareTron", () => {
  it("a TRX send builds, decodes, signs and broadcasts local bytes", async () => {
    const w = world();
    const prepared = await prepareTron(ctx(w).ctx, params());
    expect(prepared.intent.summary).toBe("transfer");
    const [flow] = prepared.intent.outflows;
    expect(flow?.to).toBe(TO);
    expect(flow?.amount).toMatchObject({ asset: "sun", amount: "1000000" });
    expect(prepared.intent.tron?.contractType).toBe("TransferContract");
    expect(prepared.checks).toStrictEqual([]);
    expect(prepared.simulation).toBeUndefined();

    const tx = await prepared.submit(VERIFY, () => undefined);
    expect(tx.state).toBe("submitted");
    expect(tx.tron).toStrictEqual({ expiration: 1_060_000, from: FROM });
    // The broadcast carried exactly the persisted raw hex; the tracked id is sha256(raw_data).
    expect(broadcastBody(w)["transaction"]).toBe(tx.raw);
    const rawData = signedRawData(w);
    expect(tx.hash).toBe([...sha256(rawData)].map((b) => b.toString(16).padStart(2, "0")).join(""));
  });

  it("binds the reference block to the SOLIDIFIED head, not the full-node head", async () => {
    const w = world();
    await submit(w);
    const raw = signedRawData(w);
    // raw_data field 1 (ref_block_bytes) tag 0x0a, len 2, value = number 100 BE (0x0064);
    // ref_block_hash is field 4 (tag 0x22), len 8, value = SOLID_ID bytes 8..16.
    const hex = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex.startsWith(`0a0200642208${"ab".repeat(8)}`)).toBe(true);
  });

  it("refuses a self TRX transfer", async () => {
    const w = world();
    await expect(prepareTron(ctx(w).ctx, params({ to: FROM }))).rejects.toBeInstanceOf(ChainError);
  });

  it("refuses an unactivated sender", async () => {
    const w = world({ accounts: new Map([[TO, { address: TO }]]) });
    await expect(prepareTron(ctx(w).ctx, params())).rejects.toThrow(/not activated/);
  });

  it("refuses a send the balance cannot cover — before signing", async () => {
    const w = world({ accounts: new Map([[FROM, { address: FROM, balance: 500_000 }]]) });
    await expect(prepareTron(ctx(w).ctx, params())).rejects.toThrow(/does not cover/);
    expect(w.signCalls).toHaveLength(0);
  });

  it("quotes account activation for a TRX send to an absent account", async () => {
    const w = world({ accounts: new Map([[FROM, { address: FROM, balance: 100_000_000 }]]) });
    const prepared = await prepareTron(ctx(w).ctx, params());
    expect(prepared.tronFee?.activation).toBe(
      PARAMS.getCreateNewAccountFeeInSystemContract.toString(),
    );
    expect(prepared.tronFee?.bandwidth.source).toBe("activation-fee");
  });

  it("uses staked activation bandwidth when it covers the transaction", async () => {
    const w = world({
      accounts: new Map([[FROM, { address: FROM, balance: 100_000_000 }]]),
    });
    // NetLimit of 2000 staked bandwidth at rate 4 covers 334 bytes × 4 = 1336.
    const staked = {
      ...RESOURCES,
      NetLimit: 2000,
    };
    const w2 = { ...w, api: overrideApi(w.api, "/wallet/getaccountresource", staked) };
    const prepared = await prepareTron(ctx(w2).ctx, params());
    expect(prepared.tronFee?.bandwidth.source).toBe("activation-staked");
  });

  it("a TRC-10 send checks assetV2 and decodes the trc10: asset", async () => {
    const w = world();
    const prepared = await prepareTron(ctx(w).ctx, params({ token: TRC10, amount: 1000n }));
    const [flow] = prepared.intent.outflows;
    expect(flow?.amount.asset).toBe(`trc10:${TRC10}`);
    expect(prepared.intent.tron?.contractType).toBe("TransferAssetContract");
  });

  it("fractional node balances are malformed, never truncated", async () => {
    const w = world();
    w.accounts.set(FROM, {
      address: FROM,
      balance: 100_000_000.9,
      assetV2: [{ key: TRC10, value: 50_000.9 }],
    });
    await expect(prepareTron(ctx(w).ctx, params({ token: TRC10, amount: 1000n }))).rejects.toThrow(
      /malformed/,
    );
  });

  it("refuses a TRC-10 send over the assetV2 balance", async () => {
    const w = world();
    await expect(
      prepareTron(ctx(w).ctx, params({ token: TRC10, amount: 60_000n })),
    ).rejects.toThrow(/does not hold/);
  });

  it("a TRC-20 send estimates energy, sets fee_limit and simulates the Transfer log", async () => {
    const w = world();
    const prepared = await prepareTron(ctx(w).ctx, params({ token: TOKEN, amount: 42_000_000n }));
    const [flow] = prepared.intent.outflows;
    expect(flow?.amount.asset).toBe(TOKEN);
    expect(prepared.intent.tron?.contractType).toBe("TriggerSmartContract");
    const base = BigInt(14_630) * BigInt(PARAMS.getEnergyFee);
    expect(prepared.tronFee?.energy?.feeLimit).toBe(((base * 3n + 1n) / 2n).toString());
    expect(successChanges(prepared)).toContainEqual({
      asset: TOKEN,
      amount: "-42000000",
      verified: true,
    });

    const w2 = world({ logs: [] });
    const p2 = await prepareTron(ctx(w2).ctx, params({ token: UNKNOWN_TOKEN, amount: 5n }));
    expect(p2.simulation).toMatchObject({ status: "success", changes: [] });
  });

  it("warns on an empty token balance at the recipient", async () => {
    const w = world();
    const prepared = await prepareTron(ctx(w).ctx, params({ token: TOKEN, amount: 100n }));
    expect(prepared.tronFee?.warnings).toContain("token-recipient-empty");
    expect(prepared.risk).toContainEqual({ code: "token-recipient-empty", level: "warning" });
  });

  it("flags the token contract itself as recipient", async () => {
    const w = world();
    const prepared = await prepareTron(
      ctx(w).ctx,
      params({ token: TOKEN, to: TOKEN, amount: 100n }),
    );
    expect(prepared.risk).toContainEqual({ code: "token-contract-recipient", level: "danger" });
  });

  it("warns when a TRX send targets a contract account", async () => {
    const w = world({
      accounts: new Map([
        [FROM, { address: FROM, balance: 100_000_000 }],
        [TO, { address: TO, type: "Contract" }],
      ]),
    });
    const prepared = await prepareTron(ctx(w).ctx, params());
    expect(prepared.risk).toContainEqual({ code: "contract-recipient", level: "warning" });
  });

  it("refuses a reverting TRC-20 transfer estimate with the node's message", async () => {
    const w = world({ callOk: false, callMessage: "REVERT: insufficient balance" });
    await expect(prepareTron(ctx(w).ctx, params({ token: TOKEN, amount: 100n }))).rejects.toThrow(
      /REVERT/,
    );
  });

  it("refuses a TRC-20 send the token balance does not cover", async () => {
    const w = world({ balances: new Map([[FROM, 10n]]) });
    await expect(prepareTron(ctx(w).ctx, params({ token: TOKEN, amount: 100n }))).rejects.toThrow(
      /token balance/,
    );
  });

  it("refuses an energy estimate above maxFeeLimit", async () => {
    const w = world({ energyUsed: 30_000_000 });
    await expect(prepareTron(ctx(w).ctx, params({ token: TOKEN, amount: 100n }))).rejects.toThrow(
      /maximum fee limit/,
    );
  });

  it("cross-checks the reference block and chain parameters on the independent endpoint", async () => {
    const calls: string[] = [];
    const w = world({
      independent: { kind: "available", client: independentApi({ calls }) },
      accounts: new Map([
        [FROM, { address: FROM, balance: 100_000_000 }],
        [TO, { address: TO, balance: 0 }],
      ]),
    });
    const prepared = await prepareTron(ctx(w).ctx, params());
    expect(prepared.checks).toStrictEqual([]);
    expect(calls).toContain("/wallet/getblockbynum");
    expect(calls).toContain("/wallet/getchainparameters");
  });

  it("refuses on a reference-block mismatch", async () => {
    const w = world({
      independent: {
        kind: "available",
        client: independentApi({ blockId: "ff".repeat(32), account: {} }),
      },
    });
    await expect(prepareTron(ctx(w).ctx, params())).rejects.toThrow(/reference block/);
  });

  it("refuses on a chain-parameter mismatch", async () => {
    const w = world({
      independent: {
        kind: "available",
        client: independentApi({
          account: {},
          params: {
            chainParameter: Object.entries({ ...PARAMS, getEnergyFee: 999 }).map(
              ([key, value]) => ({
                key,
                value,
              }),
            ),
          },
        }),
      },
    });
    await expect(prepareTron(ctx(w).ctx, params())).rejects.toThrow(/chain parameters/);
  });

  it("flags reads-unverified when the independent endpoint throws", async () => {
    const w = world({
      independent: {
        kind: "available",
        client: { post: async () => Promise.reject(new TypeError("fetch failed")) },
      },
    });
    const prepared = await prepareTron(ctx(w).ctx, params());
    expect(prepared.checks).toContain("reads-unverified");
  });

  it("flags reads-unverified when no independent endpoint exists", async () => {
    const w = world({ independent: { kind: "unavailable" } });
    const prepared = await prepareTron(ctx(w).ctx, params());
    expect(prepared.checks).toContain("reads-unverified");
  });

  it("flags fee-mismatch on a >25% energy-estimate gap and keeps the larger estimate", async () => {
    const w = world({
      independent: {
        kind: "available",
        client: independentApi({
          trigger: { result: { result: true }, energy_used: 20_000, energy_penalty: 0 },
        }),
      },
    });
    const prepared = await prepareTron(ctx(w).ctx, params({ token: TOKEN, amount: 100n }));
    expect(prepared.checks).toContain("fee-mismatch");
    expect(prepared.tronFee?.energy?.used).toBe(20_000);
  });

  it("flags fee-exceeds-amount when the max fee tops a tiny TRX send", async () => {
    const w = world();
    const prepared = await prepareTron(ctx(w).ctx, params({ amount: 1n }));
    expect(prepared.checks).toContain("fee-exceeds-amount");
  });

  it("treats the recipient as unactivated when the independent endpoint says absent", async () => {
    const w = world({
      independent: { kind: "available", client: independentApi({ account: {} }) },
    });
    const prepared = await prepareTron(ctx(w).ctx, params({ amount: 3_000_000n }));
    expect(prepared.tronFee?.activation).toBeDefined();
    expect(prepared.tronFee?.bandwidth.source).toBe("activation-fee");
  });

  it("staleReason fires at expiration minus five seconds", async () => {
    const w = world();
    const clock = { now: 1_000_000 };
    const prepared = await prepareTron(ctx(w, () => clock.now).ctx, params());
    await expect(prepared.staleReason()).resolves.toBeUndefined();
    clock.now = 1_055_000; // expiration was 1_060_000 — within the last five seconds
    await expect(prepared.staleReason()).resolves.toBe("transaction expired — start over");
  });

  it("resimulate re-runs the constant call", async () => {
    const w = world();
    const prepared = await prepareTron(ctx(w).ctx, params({ token: TOKEN, amount: 100n }));
    const before = w.posts.filter((p) => p.path === "/wallet/triggerconstantcontract").length;
    const out = await prepared.resimulate?.();
    expect(out?.status).toBe("success");
    expect(
      w.posts.filter((p) => p.path === "/wallet/triggerconstantcontract").length,
    ).toBeGreaterThan(before);
  });

  it("a bad kernel signature fails before any broadcast", async () => {
    const w = world();
    const base = ctx(w);
    const bad: RouteContext = {
      ...base.ctx,
      options: {
        ...base.ctx.options,
        chains: {
          account: async () =>
            Promise.resolve({ template: "tron.bip44", network: NET, address: FROM }),
          sign: async () =>
            Promise.resolve({
              kind: "tron.transaction" as const,
              signature: new Uint8Array(65),
            }),
        } as never,
      },
    };
    const prepared = await prepareTron(bad, params());
    await expect(prepared.submit(VERIFY, () => undefined)).rejects.toThrow(/does not verify/);
    expect(w.posts.some((p) => p.path === "/wallet/broadcasthex")).toBe(false);
  });

  it("an imported tron key ref resolves its stored address through keys.list", async () => {
    const w = world();
    const keyId = "dd".repeat(8);
    const wallet = {
      keys: {
        list: async () => Promise.resolve([{ keyId, family: "tron", address: FROM, createdAt: 1 }]),
      },
    } as never;
    const prepared = await prepareTron(
      ctx(w, undefined, wallet).ctx,
      params({ account: { kind: "imported", keyId, family: "tron" } }),
    );
    const tx = await prepared.submit(VERIFY, () => undefined);
    expect(tx.tron?.from).toBe(FROM);
    expect(w.signCalls.map((c) => (c.request as { account?: unknown }).account)).toStrictEqual([
      { kind: "imported", keyId, family: "tron" },
    ]);
  });
});
