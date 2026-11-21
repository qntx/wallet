import { secp256k1 } from "@noble/curves/secp256k1.js";
import { expect, it } from "vite-plus/test";

import { tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";

import type { TronApi } from "../src/chains/tron.ts";
import type { Independent } from "../src/networks/controller.ts";
import type {
  AccountRef,
  ChainRequestInput,
  RouteContext,
  TrackedTransaction,
} from "../src/transactions/route.ts";
import { prepareTronApprove } from "../src/transactions/tron.ts";

/**
 * TRON TRC-20 approvals: `approve` calldata is built locally, estimated by replaying the exact
 * call, decode-asserted, and tracked like every other TRON operation. Amount 0 revokes; a
 * max-uint256 approval is flagged `unlimited` by the decoder for `chainRisk`.
 */
const NET = "tron:3448148188";
const PRIV = new Uint8Array(32).fill(0x11);
const FROM = tronAddressFromPublicKey(secp256k1.getPublicKey(PRIV, false));
const SPENDER = tronAddressFromPublicKey(
  secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), false),
);
const TOKEN = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"; // Nile USDT — in the built-in table.
const SOLID_ID = "ab".repeat(32);
const ACCOUNT: AccountRef = { kind: "hd", walletId: "w", groupIndex: 0, template: "tron.bip44" };
const VERIFY = { kind: "password", password: "pw" } as never;
const U256_MAX = 2n ** 256n - 1n;

const CHAIN_PARAMETERS = {
  chainParameter: [
    { key: "getTransactionFee", value: 1000 },
    { key: "getEnergyFee", value: 210 },
    { key: "getCreateAccountFee", value: 100_000 },
    { key: "getCreateNewAccountFeeInSystemContract", value: 1_000_000 },
    { key: "getMaxFeeLimit", value: 5_000_000_000 },
    { key: "getCreateNewAccountBandwidthRate", value: 4 },
    { key: "getMaxCreateAccountTxSize", value: 5000 },
    { key: "getMemoFee", value: 1_000_000 },
  ],
};

type World = {
  energyUsed: number;
  energyPenalty: number;
  callOk: boolean;
  callMessage: string | undefined;
  independent: Independent<TronApi>;
  broadcastBody: Record<string, unknown>;
  signCalls: Uint8Array[];
};

const world = (over: Partial<World> = {}): World & { api: TronApi } => {
  const w: World = {
    energyUsed: 22_130,
    energyPenalty: 0,
    callOk: true,
    callMessage: undefined,
    independent: { kind: "not-needed" },
    broadcastBody: { result: true },
    signCalls: [],
    ...over,
  };
  const api: TronApi = {
    post: async (path, _body) => {
      await Promise.resolve();
      switch (path) {
        case "/walletsolidity/getnowblock":
          return {
            blockID: SOLID_ID,
            block_header: { raw_data: { number: 100, timestamp: 900_000 } },
          };
        case "/wallet/getblockbynum":
        case "/walletsolidity/getblockbynum":
          return {
            blockID: SOLID_ID,
            block_header: { raw_data: { number: 100, timestamp: 900_000 } },
          };
        case "/wallet/getchainparameters":
          return CHAIN_PARAMETERS;
        case "/wallet/getaccount":
          return { address: FROM, balance: 200_000_000 };
        case "/wallet/getaccountresource":
          return { freeNetLimit: 600 };
        case "/wallet/triggerconstantcontract":
          if (!w.callOk) {
            const message =
              w.callMessage === undefined
                ? undefined
                : [...new TextEncoder().encode(w.callMessage)]
                    .map((x) => x.toString(16).padStart(2, "0"))
                    .join("");
            return { result: { code: "REVERT", ...(message === undefined ? {} : { message }) } };
          }
          return {
            result: { result: true },
            energy_used: w.energyUsed,
            energy_penalty: w.energyPenalty,
            constant_result: [],
          };

        case "/wallet/broadcasthex":
          return { txid: "ee".repeat(32), ...w.broadcastBody };
        default:
          throw new Error(`unmocked ${path}`);
      }
    },
  };
  return { ...w, api };
};

const ctx = (
  w: World & { api: TronApi },
): { ctx: RouteContext; transitions: TrackedTransaction[] } => {
  const transitions: TrackedTransaction[] = [];
  return {
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
        now: () => 1_000_000,
        logger: { warn: () => {} },
        chains: {
          account: async () =>
            Promise.resolve({ template: "tron.bip44", network: NET, address: FROM }),
          sign: async (p: { request: { kind: string; rawData?: Uint8Array } }) => {
            await Promise.resolve();
            const { request } = p;
            if (request.kind !== "tron.transaction" || !(request.rawData instanceof Uint8Array)) {
              throw new Error("wrong kind");
            }
            w.signCalls.push(request.rawData);
            const sig = secp256k1.sign(request.rawData, PRIV, {
              lowS: true,
              format: "recovered",
            });
            const out = new Uint8Array(65);
            out.set(sig.subarray(1), 0);
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
      newId: () => "tx-approve",
    },
    transitions,
  };
};

const input = (amount: bigint, token = TOKEN, spender = SPENDER) =>
  ({
    method: "tron-approve",
    account: ACCOUNT,
    network: NET,
    token,
    spender,
    amount,
  }) as Extract<ChainRequestInput, { method: "tron-approve" }>;

it("builds and decode-asserts an approve", async () => {
  const w = world();
  const prepared = await prepareTronApprove(ctx(w).ctx, input(1_000_000n));
  const [approval] = prepared.intent.approvals;
  expect(approval).toStrictEqual(expect.objectContaining({ kind: "allowance", spender: SPENDER }));
  expect(prepared.tronFee?.energy).toMatchObject({ used: 22_130 });
  const tx = await prepared.submit(VERIFY, () => undefined);
  expect(tx.state).toBe("submitted");
  expect(w.signCalls).toHaveLength(1);
});

it("revokes with amount 0", async () => {
  const prepared = await prepareTronApprove(ctx(world()).ctx, input(0n));
  const [approval] = prepared.intent.approvals;
  expect(approval).toStrictEqual(
    expect.objectContaining({
      kind: "allowance",
      amount: expect.objectContaining({ amount: "0" }),
    }),
  );
});

it("marks a max-uint256 approval unlimited for chainRisk", async () => {
  const prepared = await prepareTronApprove(ctx(world()).ctx, input(U256_MAX));
  const [approval] = prepared.intent.approvals;
  expect(approval).toStrictEqual(expect.objectContaining({ kind: "allowance", unlimited: true }));
});

it.each([
  ["T1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxz", SPENDER, 1n, /not a TRON address/],
  [TOKEN, "T1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxz", 1n, /not a TRON address/],
])("refuses bad token/spender %s", async (token, spender, amount, pattern) => {
  await expect(prepareTronApprove(ctx(world()).ctx, input(amount, token, spender))).rejects.toThrow(
    pattern,
  );
});

it("refuses when the approve call reverts", async () => {
  await expect(
    prepareTronApprove(
      ctx(world({ callOk: false, callMessage: "approve disabled" })).ctx,
      input(1n),
    ),
  ).rejects.toThrow(/approve disabled/);
});

const otherEstimate = (w: World & { api: TronApi }, used: number): TronApi => ({
  post: async (path, body) => {
    if (path === "/wallet/triggerconstantcontract") {
      return {
        result: { result: true },
        energy_used: used,
        energy_penalty: 0,
        constant_result: [],
      };
    }
    await Promise.resolve();
    return w.api.post(path, body);
  },
});

it("cross-checks the energy estimate against the independent endpoint", async () => {
  const w = world();
  w.independent = { kind: "available", client: otherEstimate(w, 40_000) };
  const prepared = await prepareTronApprove(ctx(w).ctx, input(1_000_000n));
  // The larger estimate wins and the >25% difference is flagged.
  expect(prepared.tronFee?.energy).toMatchObject({ used: 40_000 });
  expect(prepared.checks).toContain("fee-mismatch");
});
