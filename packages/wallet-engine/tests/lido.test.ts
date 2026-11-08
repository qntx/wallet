import { readFileSync } from "node:fs";

import { encodeAbiParameters, getAddress } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import { EVM_DELEGATOR } from "@qntx/wallet-chains/evm";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const N1 = "eip155:1";
const GW = "https://gw.test";
const HOST = "https://host.test/evm";
const ADDR = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "evm.bip44" as const,
};
const DEL_CODE = readFileSync(
  new URL("fixtures/eip7702-stateless-delegator-1.3.0.hex", import.meta.url).pathname,
  "utf8",
).trim();
const designator = (a: string) => `0xef0100${a.slice(2)}`;

const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const statusTuple = (o: {
  readonly amount?: bigint;
  readonly owner?: string;
  readonly timestamp?: bigint;
  readonly finalized?: boolean;
  readonly claimed?: boolean;
}) =>
  encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "amountOfStETH", type: "uint256" },
          { name: "amountOfShares", type: "uint256" },
          { name: "owner", type: "address" },
          { name: "timestamp", type: "uint256" },
          { name: "isFinalized", type: "bool" },
          { name: "isClaimed", type: "bool" },
        ],
      },
    ],
    [
      [
        {
          amountOfStETH: o.amount ?? 1_000_000_000_000_000_000n,
          amountOfShares: 1_000_000_000_000_000_000n,
          owner: getAddress(o.owner ?? ADDR),
          timestamp: o.timestamp ?? 1000n,
          isFinalized: o.finalized ?? true,
          isClaimed: o.claimed ?? false,
        },
      ],
    ],
  );

const u256s = (ns: ReadonlyArray<bigint>) => encodeAbiParameters([{ type: "uint256[]" }], [ns]);

type LidoWorld = {
  readonly address?: string;
  readonly code?: Record<string, string>;
  readonly paused?: boolean;
  readonly queuePaused?: boolean;
  readonly limit?: bigint;
  readonly allowance?: bigint;
  readonly stEth?: bigint;
  readonly ids?: ReadonlyArray<bigint>;
  readonly statuses?: string;
  readonly hints?: ReadonlyArray<bigint>;
  readonly lastCheckpoint?: bigint;
  readonly failIndependent?: boolean;
  readonly independentPaused?: boolean;
  readonly extraNetworks?: ReadonlyArray<string>;
};

function world(o: LidoWorld = {}) {
  const calls: Array<{ url: string; method: string; params?: unknown }> = [];
  const signed: SignRequest[] = [];
  const code = {
    [EVM_DELEGATOR.address.toLowerCase()]: DEL_CODE,
    [(o.address ?? ADDR).toLowerCase()]: designator(EVM_DELEGATOR.address),
    ...o.code,
  };
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    await Promise.resolve();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GW}/v1/networks`) {
      return Response.json({ networks: [N1] });
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method: string;
      params?: unknown[];
    };
    calls.push({ url, method: body.method, params: body.params });
    const independent = url === HOST;
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
    const fail = (msg: string) =>
      Response.json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: msg } });
    if (body.method === "eth_getCode") {
      const p = (body.params?.[0] as string | undefined)?.toLowerCase() ?? "";
      return reply(code[p] ?? "0x");
    }
    if (body.method === "eth_call") {
      const sel = ((body.params?.[0] as { data?: string } | undefined)?.data ?? "").slice(0, 10);
      const failFlag = independent && o.failIndependent === true;
      if (sel === "0x1ea7ca89") {
        if (failFlag) {
          return fail("x");
        }
        return reply(word((independent ? (o.independentPaused ?? o.paused) : o.paused) ? 1n : 0n));
      }
      if (sel === "0x609c4c6c") {
        if (failFlag) {
          return fail("x");
        }
        return reply(word(o.limit ?? 2n ** 128n));
      }
      if (sel === "0xb187bd26") {
        if (failFlag) {
          return fail("x");
        }
        return reply(
          word((independent ? (o.independentPaused ?? o.queuePaused) : o.queuePaused) ? 1n : 0n),
        );
      }
      if (sel === "0xdd62ed3e") {
        if (failFlag) {
          return fail("x");
        }
        return reply(word(o.allowance ?? 0n));
      }
      if (sel === "0x70a08231") {
        return reply(word(o.stEth ?? 0n));
      }
      if (sel === "0x7d031b65") {
        return reply(u256s(o.ids ?? []));
      }
      if (sel === "0xb8c4b85a") {
        if (failFlag) {
          return fail("x");
        }
        return reply(
          o.statuses ??
            encodeAbiParameters(
              [
                {
                  type: "tuple[]",
                  components: [
                    { name: "amountOfStETH", type: "uint256" },
                    { name: "amountOfShares", type: "uint256" },
                    { name: "owner", type: "address" },
                    { name: "timestamp", type: "uint256" },
                    { name: "isFinalized", type: "bool" },
                    { name: "isClaimed", type: "bool" },
                  ],
                },
              ],
              [[]],
            ),
        );
      }
      if (sel === "0x526eae3e") {
        return reply(word(o.lastCheckpoint ?? 42n));
      }
      if (sel === "0x62abe3fa") {
        return reply(u256s(o.hints ?? [1n]));
      }
      if (sel === "0xc97912d8") {
        return reply(u256s((o.ids ?? []).map(() => 5000n)));
      }
      return reply(word(0n));
    }
    if (body.method === "eth_simulateV1") {
      const blocks =
        (body.params as [{ blockStateCalls?: Array<{ calls?: unknown[] }> }] | undefined)?.[0]
          ?.blockStateCalls ?? [];
      return reply(
        blocks.map((_, i) => ({
          number: `0x${(i + 1).toString(16)}`,
          hash: `0x${"00".repeat(32)}`,
          calls: [{ status: "0x1", returnData: "0x", gasUsed: "0x0", logs: [] }],
        })),
      );
    }
    const base: Record<string, unknown> = {
      eth_chainId: "0x1",
      eth_blockNumber: "0x1",
      eth_getTransactionCount: "0x0",
      eth_estimateGas: "0x5208",
      eth_feeHistory: { baseFeePerGas: ["0x64", "0x64"], reward: [["0x1", "0x2", "0x3"]] },
      eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
      eth_getBlockByNumber: { number: "0x2" },
    };
    return body.method in base ? reply(base[body.method]) : fail(`unexpected ${body.method}`);
  };
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: fetchImpl,
    rpc: { [N1]: [HOST], ...Object.fromEntries((o.extraNetworks ?? []).map((n) => [n, [HOST]])) },
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    logger: { warn: () => {} },
    gateway: { url: GW, installId: "a".repeat(32) },
  });
  const apis = {
    account: async () =>
      Promise.resolve({ template: "evm.bip44", network: N1, address: o.address ?? ADDR }),
    sign: async ({ request }: { request: SignRequest }) => {
      signed.push(request);
      return Promise.resolve({ kind: "evm.transaction", signedTransaction: new Uint8Array(1) });
    },
  } as unknown as ReturnType<typeof chains>;
  const transactions = new TransactionController({
    wallet: {} as Wallet,
    networks,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    random: (n) => new Uint8Array(n).fill(3),
    setTimer: () => () => undefined,
    now: () => 0,
    logger: { warn: () => {} },
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
    fetch: fetchImpl,
    random: (n) => new Uint8Array(n).fill(4),
    now: () => 0,
    setTimer: () => () => undefined,
    logger: { warn: () => {} },
  });
  const start = async () => {
    await networks.init();
    await transactions.init();
    await requests.init();
  };
  return { requests, transactions, calls, signed, start };
}

const display = (pending: { display: unknown }) =>
  pending.display as {
    summary?: string;
    staking?: ReadonlyArray<{ kind: string; amount?: { amount: string } }>;
    approvals?: ReadonlyArray<unknown>;
  };

const prepare = async (
  w: ReturnType<typeof world>,
  action:
    | { kind: "stake"; amount: bigint }
    | { kind: "request"; amount: bigint }
    | { kind: "claim"; requestIds: ReadonlyArray<bigint> },
  network = N1,
) =>
  w.requests.prepare({
    method: "evm-lido",
    account: ACCOUNT,
    network,
    action,
    fee: "normal",
  });

describe("evm-lido stake", () => {
  it("builds submit(zero) with the staked value and decodes to lido-submit", async () => {
    const w = world();
    await w.start();
    const pending = await prepare(w, { kind: "stake", amount: 1_000_000_000_000_000_000n });
    expect(display(pending).summary).toBe("stake");
    expect(display(pending).staking?.[0]?.kind).toBe("lido-submit");
  });

  it("refuses a paused staking contract", async () => {
    const w = world({ paused: true });
    await w.start();
    await expect(prepare(w, { kind: "stake", amount: 1n })).rejects.toThrow(/paused/);
  });

  it("refuses an amount over the stake limit", async () => {
    const w = world({ limit: 10n });
    await w.start();
    await expect(prepare(w, { kind: "stake", amount: 11n })).rejects.toThrow(/limit/);
  });

  it("refuses on the wrong network", async () => {
    const w = world({ extraNetworks: ["eip155:8453"] });
    await w.start();
    await expect(prepare(w, { kind: "stake", amount: 1n }, "eip155:8453")).rejects.toThrow(
      /mainnet/,
    );
  });
});

describe("evm-lido request", () => {
  it("sends a single requestWithdrawals when the allowance covers it", async () => {
    const w = world({ allowance: 2n * 10n ** 18n });
    await w.start();
    const pending = await prepare(w, { kind: "request", amount: 1_000_000_000_000_000_000n });
    expect(display(pending).summary).toBe("stake");
    expect(display(pending).staking?.[0]?.kind).toBe("lido-request");
  });

  it("chunks amounts above 1000 ETH and keeps every chunk ≥ 100 wei", async () => {
    const w = world({ allowance: 3n * 10n ** 21n });
    await w.start();
    const amount = 2_500_000_000_000_000_000_050n;
    const pending = await prepare(w, { kind: "request", amount });
    const request = display(pending).staking?.[0];
    expect(request?.kind).toBe("lido-request");
    expect(request).toMatchObject({
      kind: "lido-request",
      amount: { amount: amount.toString() },
    });
  });

  it("refuses a request below the 100 wei minimum", async () => {
    const w = world({ allowance: 1000n });
    await w.start();
    await expect(prepare(w, { kind: "request", amount: 50n })).rejects.toThrow(/100/);
  });

  it("refuses a paused queue", async () => {
    const w = world({ queuePaused: true });
    await w.start();
    await expect(prepare(w, { kind: "request", amount: 1000n })).rejects.toThrow(/queue is paused/);
  });

  it("refuses without allowance when the account is not ours", async () => {
    const w = world({ address: OTHER, code: { [OTHER.toLowerCase()]: "0x" } });
    await w.start();
    await expect(
      prepare(w, { kind: "request", amount: 1_000_000_000_000_000_000n }),
    ).rejects.toThrow(/approve the withdrawal queue/);
  });

  it("batches reset+approve+request when the account is ours", async () => {
    const w = world({ allowance: 5n });
    await w.start();
    const pending = await prepare(w, { kind: "request", amount: 1_000_000_000_000_000_000n });
    expect(display(pending).summary).toBe("batch");
    expect(display(pending).staking?.[0]?.kind).toBe("lido-request");
    expect(display(pending).approvals).toHaveLength(2);
  });
});

describe("evm-lido claim", () => {
  it("builds claimWithdrawals with sorted unique ids and hints", async () => {
    const w = world({ ids: [1n], hints: [1n] });
    await w.start();
    const pending = await prepare(w, { kind: "claim", requestIds: [3n, 1n, 3n, 2n] });
    expect(display(pending).summary).toBe("stake");
    expect(display(pending).staking?.[0]?.kind).toBe("lido-claim");
  });

  it("refuses an unfinalized request", async () => {
    const w = world({ statuses: statusTuple({ finalized: false }) });
    await w.start();
    await expect(prepare(w, { kind: "claim", requestIds: [1n] })).rejects.toThrow(/finalised/);
  });

  it("refuses a claimed request", async () => {
    const w = world({ statuses: statusTuple({ claimed: true }) });
    await w.start();
    await expect(prepare(w, { kind: "claim", requestIds: [1n] })).rejects.toThrow(/claimed/);
  });

  it("refuses a request owned by someone else", async () => {
    const w = world({ statuses: statusTuple({ owner: OTHER }) });
    await w.start();
    await expect(prepare(w, { kind: "claim", requestIds: [1n] })).rejects.toThrow(/belong/);
  });
});

describe("evm-lido independent endpoint", () => {
  it("a disagreeing pause read refuses", async () => {
    const w = world({ paused: false, independentPaused: true });
    await w.start();
    await expect(prepare(w, { kind: "stake", amount: 1n })).rejects.toThrow(/differs/);
  });
});
