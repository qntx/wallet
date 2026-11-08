import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { base64 } from "@scure/base";
import { address, getAddressEncoder } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { JupiterSwapQuote } from "../src/swaps/index.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type { AccountRef } from "../src/transactions/route.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const logger = { warn: () => undefined };

const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const PAYER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_ATA = "5N3f1tj9v1vc5TUZ8S7mCAnVmjVKrfnzXWhxLaxyZAgt";
const BLOCKHASH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const HOST = "https://rpc.example/solana";
const GW = "https://gateway.example";
const VERIFY = { kind: "none" } as never;
const ACCOUNT: AccountRef = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "solana.bip44-change",
};
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/jupiter-build.json"), "utf8"),
) as {
  build: {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    otherAmountThreshold: string;
    setupInstructions: ReadonlyArray<{
      programId: string;
      accounts: ReadonlyArray<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
      data: string;
    }>;
    swapInstruction: {
      programId: string;
      accounts: ReadonlyArray<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
      data: string;
    };
    cleanupInstruction: unknown;
    addressesByLookupTableAddress: Record<string, ReadonlyArray<string>>;
  };
  alts: Record<string, { value: { owner: string; data: [string, string]; lamports: number } }>;
};

const wireIx = (i: {
  programId: string;
  accounts: ReadonlyArray<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}) => ({
  programId: i.programId,
  accounts: i.accounts.map((a) => ({
    address: a.pubkey,
    signer: a.isSigner,
    writable: a.isWritable,
  })),
  data: Uint8Array.from(base64.decode(i.data)),
});

const solQuote = (overrides: Partial<JupiterSwapQuote> = {}): JupiterSwapQuote => ({
  provider: "jupiter",
  network: SOL_NET,
  taker: PAYER,
  sell: "lamports",
  buy: USDC,
  sellAmount: BigInt(fixture.build.inAmount),
  buyAmount: BigInt(fixture.build.outAmount),
  minBuyAmount: BigInt(fixture.build.otherAmountThreshold),
  setup: fixture.build.setupInstructions.map(wireIx),
  swap: wireIx(fixture.build.swapInstruction),
  cleanup: wireIx(fixture.build.cleanupInstruction as Parameters<typeof wireIx>[0]),
  lookupTables: Object.keys(fixture.build.addressesByLookupTableAddress),
  fetchedAt: 0,
  ...overrides,
});

/** SPL token account bytes: mint ‖ owner ‖ amount(u64le) ‖ padding — what tokenBalances parses. */
const tokenAccount = (mint: string, owner: string, amount: bigint): string => {
  const bytes = new Uint8Array(165);
  bytes.set(Uint8Array.from(addressDecoderOf(mint)), 0);
  bytes.set(Uint8Array.from(addressDecoderOf(owner)), 32);
  const dv = new DataView(bytes.buffer);
  dv.setBigUint64(64, amount, true);
  return base64.encode(bytes);
};

const addrDec = getAddressEncoder();
const addressDecoderOf = (a: string): Uint8Array => Uint8Array.from(addrDec.encode(address(a)));

type SwapWorld = {
  readonly tableOverrides?: Record<string, unknown>;
  readonly independentOverrides?: Record<string, unknown> | "fail";
  readonly units?: number;
  readonly sellDelta?: bigint;
  readonly buyDelta?: bigint;
  readonly simulation?: "success" | "reverted" | "error";
  readonly resimulation?: "success" | "violation";
};

const tableCalls = new Map<string, number>();

const rpcAnswer = (o: SwapWorld) => {
  const answer = (method: string, params: ReadonlyArray<unknown>): unknown => {
    const cfg = params[1] as Record<string, unknown> | undefined;
    switch (method) {
      case "getAccountInfo": {
        const table = params[0] as string;
        const alt = fixture.alts[table];
        if (alt === undefined) {
          return { value: null };
        }
        const seen = (tableCalls.get(table) ?? 0) + 1;
        tableCalls.set(table, seen);
        const override = seen === 1 ? o.tableOverrides : o.independentOverrides;
        if (override === "fail") {
          return new Error("alt read failed");
        }
        const patch = override?.[table] as Record<string, unknown> | undefined;
        if (patch !== undefined) {
          if (patch["value"] === null) {
            return { value: null };
          }
          return {
            value: {
              ...alt.value,
              ...(patch["owner"] === undefined ? {} : { owner: patch["owner"] }),
              ...(patch["data"] === undefined ? {} : { data: [patch["data"], "base64"] }),
            },
          };
        }
        return { value: alt.value };
      }
      case "getMultipleAccounts": {
        const addrs = (params[0] as ReadonlyArray<string>) ?? [];
        return {
          value: addrs.map((a) => {
            if (fixture.alts[a] !== undefined) {
              return fixture.alts[a].value;
            }
            return a === PAYER
              ? {
                  lamports: 50_000_000_000,
                  owner: "11111111111111111111111111111111",
                  data: ["", "base64"],
                }
              : null;
          }),
        };
      }
      case "getLatestBlockhash":
        return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100_000 } };
      case "simulateTransaction": {
        if (o.simulation === "error") {
          return new Error("simulation failed");
        }
        if (o.simulation === "reverted") {
          return { value: { err: { InstructionError: [0, "Custom"] }, logs: [] } };
        }
        const watch = (cfg?.["accounts"] as Record<string, unknown> | undefined)?.["addresses"] as
          | ReadonlyArray<string>
          | undefined;
        if (watch !== undefined) {
          simCount += 1;
        }
        const violation = o.resimulation === "violation" && watch !== undefined && simCount > 1;
        const accounts = watch?.map((a) => {
          if (a === PAYER) {
            return {
              lamports: 50_000_000_000 - Number(o.sellDelta ?? 100_001_000n),
              owner: "11111111111111111111111111111111",
              data: ["", "base64"],
            };
          }
          if (a === USDC_ATA) {
            return {
              lamports: 2_039_280,
              owner: TOKEN_PROGRAM,
              data: [
                tokenAccount(USDC, PAYER, violation ? 1n : (o.buyDelta ?? 8_950_000n)),
                "base64",
              ],
            };
          }
          return null;
        });
        return {
          value: {
            err: null,
            logs: [],
            unitsConsumed: o.units ?? 21_000,
            ...(watch === undefined ? {} : { accounts }),
          },
        };
      }
      case "getRecentPrioritizationFees":
        return [];
      case "sendTransaction":
        return `sig${"a".repeat(80)}`;
      case "getSignatureStatuses":
        return { value: [{ confirmationStatus: "finalized", err: null }] };
      case "getBlockHeight":
        return 1;
      default:
        return new Error(`unexpected rpc ${method}`);
    }
  };
  return answer;
};

let simCount = 0;

const world = (o: SwapWorld = {}, _independent = true) => {
  simCount = 0;
  tableCalls.clear();
  const sent: Array<{ readonly url: string; readonly method: string }> = [];
  const fetchImpl = async (
    url: string | URL | Request,
    init?: { readonly method?: string; readonly body?: string },
  ): Promise<Response> => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (target === `${GW}/v1/networks`) {
      return Response.json({ networks: [SOL_NET] });
    }
    const body = JSON.parse(init?.body ?? "{}") as {
      method?: string;
      params?: ReadonlyArray<unknown>;
    };
    const method = body.method ?? "";
    sent.push({ url: target, method });
    /* The independent client re-uses the same hosts — distinguish by call count per table. */
    const result = await rpcAnswer(o)(method, body.params ?? []);
    if (result instanceof Error) {
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32_000, message: result.message },
      });
    }
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  };
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: fetchImpl as typeof globalThis.fetch,
    rpc: { [SOL_NET]: [HOST] },
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    logger,
    gateway: { url: GW, installId: "a".repeat(32) },
  });
  const signed: SignRequest[] = [];
  const apis = {
    account: async () =>
      Promise.resolve({ template: "solana.bip44-change", network: SOL_NET, address: PAYER }),
    sign: async ({ request }: { request: SignRequest }) => {
      signed.push(request);
      return Promise.resolve({ kind: "solana.transaction", signature: new Uint8Array(64) });
    },
  } as unknown as ReturnType<typeof chains>;
  const transactions = new TransactionController({
    wallet: {} as Wallet,
    networks,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    random: (n) => new Uint8Array(n).fill(3),
    setTimer: () => () => undefined,
    now: () => 0,
    logger,
    pollMs: 1,
    chains: apis,
  });
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    ...bookDeps(),
    spark: {} as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    fetch: fetchImpl as typeof globalThis.fetch,
    random: (n) => new Uint8Array(n).fill(4),
    now: () => 0,
    setTimer: () => () => undefined,
    logger,
  });
  const start = async () => {
    await networks.init();
    await transactions.init();
    await requests.init();
  };
  return { requests, transactions, sent, signed, start };
};

const prepare = async (w: ReturnType<typeof world>, quote: JupiterSwapQuote) =>
  w.requests.prepare({
    method: "solana-swap",
    account: ACCOUNT,
    network: SOL_NET,
    quote,
    fee: "normal",
  });

describe("solana-swap through requests.prepare", () => {
  it("happy path: builds the v0 message, decodes the swap intent, and signs it", async () => {
    const w = world();
    await w.start();
    const pending = await prepare(w, solQuote());
    const display = pending.display as { summary?: string; minimumReceived?: unknown };
    expect(display.summary).toBe("swap");
    const approved = await w.requests.approve(pending.id, "solana-swap", VERIFY);
    expect(approved.state).toBe("submitted");
    const request = w.signed[0] as Extract<SignRequest, { kind: "solana.transaction" }>;
    expect(request.lookupTables?.length).toBe(4);
  });

  it("refuses a stale quote", async () => {
    const w = world();
    await w.start();
    await expect(prepare(w, solQuote({ fetchedAt: -120_000 }))).rejects.toThrow(/stale/);
  });

  it("refuses a quote for a different taker", async () => {
    const w = world();
    await w.start();
    await expect(
      prepare(w, solQuote({ taker: "Ff4CgHQXyMBRktUtmCNPvL4YS1NBiS1d9QDrPqRMhLQ" })),
    ).rejects.toThrow(/taker/);
  });

  it("refuses a foreign-program instruction", async () => {
    const w = world();
    await w.start();
    const quote = solQuote();
    const badSetup = [{ ...quote.setup[0]!, programId: USDC }, ...quote.setup.slice(1)];
    const bad = { ...quote, setup: badSetup };
    await expect(prepare(w, bad)).rejects.toThrow(/foreign program/);
  });

  it("refuses a swap instruction not from Jupiter", async () => {
    const w = world();
    await w.start();
    const quote = solQuote();
    await expect(
      prepare(w, { ...quote, swap: { ...quote.swap, programId: USDC } }),
    ).rejects.toThrow(/foreign program|Jupiter/);
  });

  it("refuses when the endpoints disagree on a lookup table", async () => {
    const table = Object.keys(fixture.alts)[0]!;
    const other = fixture.alts[Object.keys(fixture.alts)[1]!]!;
    const w = world({ independentOverrides: { [table]: { data: other.value.data[0] } } });
    await w.start();
    await expect(prepare(w, solQuote())).rejects.toThrow(/disagree/);
  });

  it("refuses a table not owned by the lookup program", async () => {
    const table = Object.keys(fixture.alts)[0]!;
    const w = world({ tableOverrides: { [table]: { owner: USDC } } });
    await w.start();
    await expect(prepare(w, solQuote())).rejects.toThrow(/owned/);
  });

  it("refuses a missing lookup table", async () => {
    const table = Object.keys(fixture.alts)[0]!;
    const w = world({ tableOverrides: { [table]: { value: null } } });
    await w.start();
    await expect(prepare(w, solQuote())).rejects.toThrow(/not on chain/);
  });

  it("refuses a build that exceeds the wire size without tables", async () => {
    const w = world();
    await w.start();
    await expect(prepare(w, solQuote({ lookupTables: [] }))).rejects.toThrow(/size|bytes/);
  });

  it("refuses a decoded sell leg that does not match the quote", async () => {
    const w = world();
    await w.start();
    await expect(prepare(w, solQuote({ sellAmount: 1n }))).rejects.toThrow(/sell/);
  });

  it.each(["error", "reverted"] as const)("refuses a %s simulation", async (sim) => {
    const w = world({ simulation: sim });
    await w.start();
    await expect(prepare(w, solQuote())).rejects.toThrow(/simulation|unavailable/);
  });

  it("refuses when the simulation gains less than the minimum", async () => {
    const w = world({ buyDelta: 1n });
    await w.start();
    await expect(prepare(w, solQuote())).rejects.toThrow(/minimum/);
  });

  it("a resimulation that violates the quote refuses", async () => {
    const w = world({ resimulation: "violation" });
    await w.start();
    const prepared = await w.transactions.prepareSolanaSwap(
      {
        method: "solana-swap",
        account: ACCOUNT,
        network: SOL_NET,
        quote: solQuote(),
        fee: "normal",
      },
      "r1",
    );
    await expect(prepared.resimulate?.()).rejects.toThrow(/minimum/);
  });
});
