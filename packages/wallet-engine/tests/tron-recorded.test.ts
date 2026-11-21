import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vite-plus/test";

import { isTronAddress, tronAddressFromHex } from "@qntx/wallet-chains/tron";

import {
  account,
  blockId,
  chainParams,
  constantCall,
  resources,
  solidHead,
  transactionInfo,
  transactionKnown,
  tronLogAddress,
} from "../src/chains/tron.ts";
import type { TronApi, TronCallOutcome } from "../src/chains/tron.ts";
import { parseTronJson } from "../src/gateway/contract/index.ts";
import type { SimulationOutcome } from "../src/requests/simulation.ts";
import type { AccountRef, RouteContext, SendParams } from "../src/transactions/route.ts";
import { prepareTron } from "../src/transactions/tron.ts";

// Recorded by apps/gateway/scripts/record-tron.ts — real node bodies, shared with the route tests.
const FIXTURES = resolve(import.meta.dirname, "../../../apps/gateway/tests/fixtures/tron");
const DIRS = [
  "mainnet-trongrid",
  "mainnet-tatum",
  "mainnet-publicnode",
  "nile-trongrid",
  "nile-nileex",
  "nile-tatum",
];

type Body = Record<string, unknown>;

const fixture = (dir: string, name: string): Body =>
  (parseTronJson(readFileSync(resolve(FIXTURES, dir, `${name}.json`), "utf8")) as { body: Body })
    .body;

const PATHS: Readonly<Record<string, string>> = {
  "/walletsolidity/getnowblock": "nowblock-solidity",
  "/wallet/getnowblock": "nowblock-full",
  "/wallet/getblockbynum": "blockbynum-full",
  "/walletsolidity/getblockbynum": "blockbynum-solidity",
  "/wallet/getchainparameters": "chainparameters",
  "/wallet/getaccountresource": "accountresource",
  "/wallet/triggerconstantcontract": "triggerconstantcontract",
  "/wallet/gettransactioninfobyid": "transactioninfobyid",
  "/walletsolidity/gettransactioninfobyid": "transactioninfobyid-solidity",
  "/wallet/gettransactionbyid": "transactionbyid",
  "/wallet/broadcasthex": "broadcasthex",
};

const apiFrom = (dir: string, constantPatch?: Body): TronApi => ({
  post: async (path) => {
    if (path === "/wallet/getaccount") {
      return Promise.resolve(fixture(dir, "account-holder"));
    }
    const name = PATHS[path];
    if (name === undefined) {
      return Promise.reject(new Error(`unmocked ${path}`));
    }
    const body = fixture(dir, name);
    return Promise.resolve(
      name === "triggerconstantcontract" && constantPatch !== undefined
        ? { ...body, ...constantPatch }
        : body,
    );
  },
});

const num = (n: unknown): number => Math.trunc(Number(n ?? 0));

const blockFields = (body: Body): { number: number; timestamp: number; id: string } => {
  const raw = (body["block_header"] as Body | undefined)?.["raw_data"] as Body | undefined;
  return {
    number: num(raw?.["number"]),
    timestamp: num(raw?.["timestamp"]),
    id: String(body["blockID"]),
  };
};

// The recorded holder of the triggerconstantcontract/account fixtures.
const HOLDER = "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb";

const expectOkCall = (call: TronCallOutcome): Extract<TronCallOutcome, { ok: true }> => {
  if (!call.ok) {
    throw new Error(`expected ok call, got ${call.message}`);
  }
  return call;
};

const validTronAddress = (a: string | undefined): boolean => a !== undefined && isTronAddress(a);

const changesOf = (sim: SimulationOutcome | undefined): ReadonlyArray<unknown> => {
  if (sim?.status !== "success") {
    throw new Error(`expected a successful simulation, got ${sim?.status ?? "absent"}`);
  }
  return sim.changes;
};

describe("readers on recorded node bodies", () => {
  it.each(DIRS)("parses %s", async (dir) => {
    const api = apiFrom(dir);

    const head = blockFields(fixture(dir, "nowblock-solidity"));
    await expect(solidHead(api)).resolves.toStrictEqual(head);

    const block = blockFields(fixture(dir, "blockbynum-full"));
    await expect(blockId(api, block.number, false)).resolves.toBe(block.id);
    const solidBlock = blockFields(fixture(dir, "blockbynum-solidity"));
    await expect(blockId(api, solidBlock.number, true)).resolves.toBe(solidBlock.id);

    const holder = await account(api, HOLDER);
    expect(holder?.balance).toBe(num(fixture(dir, "account-holder")["balance"]));

    const res = fixture(dir, "accountresource");
    await expect(resources(api, HOLDER)).resolves.toStrictEqual({
      freeNetLimit: num(res["freeNetLimit"]),
      freeNetUsed: num(res["freeNetUsed"]),
      netLimit: num(res["NetLimit"]),
      netUsed: num(res["NetUsed"]),
      energyLimit: num(res["EnergyLimit"]),
      energyUsed: num(res["EnergyUsed"]),
      tronPowerLimit: num(res["tronPowerLimit"]),
      tronPowerUsed: num(res["tronPowerUsed"]),
    });

    const entries = new Map(
      (
        fixture(dir, "chainparameters")["chainParameter"] as Array<{ key: string; value: number }>
      ).map((e) => [e.key, e.value]),
    );
    const params = await chainParams(api);
    expect(params.transactionFee).toBe(BigInt(num(entries.get("getTransactionFee"))));
    expect(params.energyFee).toBe(BigInt(num(entries.get("getEnergyFee"))));

    const trig = fixture(dir, "triggerconstantcontract");
    const call = expectOkCall(
      await constantCall(api, {
        owner: HOLDER,
        contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        data: new Uint8Array(),
      }),
    );
    expect(call.energyUsed).toBe(num(trig["energy_used"]));
    expect(call.energyPenalty).toBe(num(trig["energy_penalty"]));
    // The recorded log address is the base58check form of the 20-byte token body —
    // tronLogAddress restores the version byte (a plain isTronAddress rejects the body-only form).
    expect(tronLogAddress(call.logs[0]?.address)).toSatisfy(validTronAddress);

    const info = fixture(dir, "transactioninfobyid");
    const parsed = await transactionInfo(api, String(info["id"]), false);
    expect(parsed?.blockNumber).toBe(num(info["blockNumber"]));
    expect(parsed?.fee).toBe(num(info["fee"]));
    const solidParsed = await transactionInfo(api, String(info["id"]), true);
    expect(solidParsed?.blockNumber).toBe(num(info["blockNumber"]));

    const known = fixture(dir, "transactionbyid");
    await expect(transactionKnown(api, String(known["txID"]))).resolves.toBe(true);
    await expect(transactionKnown(api, "00".repeat(32))).resolves.toBe(false);
  });
});

// A TRC-20 prepare driven entirely by recorded mainnet bodies. The recorder never captured a
// balanceOf call, so constant_result for the 70a08231 selector is the only shim.
const NET = "tron:728126428";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
// The log topic-2 recipient of the recorded transfer.
const TO = tronAddressFromHex(`4131c56137ff5ed70721fd412ed3a7600ecb3f137c`);
const ACCOUNT: AccountRef = { kind: "hd", walletId: "w", groupIndex: 0, template: "tron.bip44" };
const VERIFY = { kind: "password", password: "pw" } as SendParams["verify"];

const recordedApi = (constantPatch?: Body): TronApi => {
  const base = apiFrom("mainnet-trongrid", constantPatch);
  return {
    post: async (path, body) => {
      const data = String((body as Body)["data"] ?? "");
      if (path === "/wallet/triggerconstantcontract" && data.startsWith("70a08231")) {
        const recorded = fixture("mainnet-trongrid", "triggerconstantcontract");
        return {
          ...recorded,
          energy_used: 0,
          energy_penalty: 0,
          logs: [],
          constant_result: ["00000000000000000000000000000000000000000000000de0b6b3a7640000"],
          ...constantPatch,
        };
      }
      return base.post(path, body);
    },
  };
};

const ctxOf = (api: TronApi, signCalls: Uint8Array[]): RouteContext => ({
  options: {
    networks: {
      tronApi: () => api,
      independentTronApi: () => ({ kind: "not-needed" }),
    } as never,
    wallet: {} as never,
    openStore: async () => Promise.resolve({} as never),
    random: (n: number) => new Uint8Array(n).fill(0x55),
    setTimer: () => () => {},
    now: () => 1_800_000_000_000,
    logger: { warn: () => {} },
    chains: {
      account: async () =>
        Promise.resolve({ template: "tron.bip44", network: NET, address: HOLDER }),
      sign: async (p: { request: { rawData?: Uint8Array } }) => {
        await Promise.resolve();
        const raw = p.request.rawData;
        if (!(raw instanceof Uint8Array)) {
          throw new TypeError("no rawData");
        }
        signCalls.push(raw);
        const sig = secp256k1.sign(raw, new Uint8Array(32).fill(0x11), {
          lowS: true,
          format: "recovered",
        });
        const signature = new Uint8Array(65);
        signature.set(sig.subarray(1), 0); // noble emits recovery‖r‖s
        signature[64] = 27 + (sig[0] ?? 0);
        return { kind: "tron.transaction" as const, signature } as never;
      },
    } as never,
  },
  transition: async (tx, next) => Promise.resolve({ ...tx, ...next }),
  track: () => {},
  txs: () => ({}),
  newId: () => "tx-test",
});

const PARAMS_SEND = {
  account: ACCOUNT,
  network: NET,
  to: TO,
  amount: 1_000_000n,
  token: USDT,
} as SendParams & Parameters<typeof prepareTron>[1];

const signedRaw = async (
  api: TronApi,
): Promise<{ raw: Uint8Array; prepared: Awaited<ReturnType<typeof prepareTron>> }> => {
  const signCalls: Uint8Array[] = [];
  const prepared = await prepareTron(ctxOf(api, signCalls), PARAMS_SEND);
  try {
    await prepared.submit(VERIFY, () => undefined);
  } catch {
    /* the recorded broadcasthex body is a refusal — the sign call already ran */
  }
  const [raw] = signCalls;
  if (raw === undefined) {
    throw new Error("no sign call");
  }
  return { raw, prepared };
};

it("prepares a TRC-20 send whose reads all come from recorded bodies", async () => {
  const { prepared } = await signedRaw(recordedApi());
  expect(prepared.intent.summary).toBe("transfer");
  expect(prepared.tronFee?.energy).toMatchObject({ used: 130_285, penalty: 100_635 });
  // The recorded log must produce the owner's −1_000_000 change — regression for the
  // `visible:true` base58 log-address form.
  expect(changesOf(prepared.simulation)).toContainEqual(
    expect.objectContaining({ asset: USDT, amount: "-1000000" }),
  );
});

it("ignores a poisoned transaction field in the constant call", async () => {
  const clean = await signedRaw(recordedApi());
  const poisoned = await signedRaw(
    recordedApi({ transaction: { raw_data_hex: "ff".repeat(512) } }),
  );
  expect(poisoned.raw).toStrictEqual(clean.raw);
});
