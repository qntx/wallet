import { address, createAddressWithSeed } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { STAKE_ACCOUNT_BYTES } from "../src/chains/solana.ts";
import { NetworkController } from "../src/networks/controller.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { stakePositions, stakeValidators } from "../src/staking/index.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
const PAYER = "11111111111111111111111111111112";
const VOTE = "cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN";
const NODE = "4NDqA2GvB5iE6tB9Qc8sF9mR3pX7uL2nW8kV1dH5gJ6y";
const OTHER = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const STAKE_ACCT = "YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf";
const BLOCKHASH = "11111111111111111111111111111111";
const GW = "https://gw.test";
const HOST = "https://host.test/solana";
const ACCOUNT = {
  kind: "hd" as const,
  walletId: "0a".repeat(8),
  groupIndex: 0,
  template: "solana.bip44-change" as const,
};
const logger = { warn: () => undefined };
const U64_MAX = "18446744073709551615";

const derived = async (n: number): Promise<string> =>
  String(
    await createAddressWithSeed({
      baseAddress: address(PAYER),
      programAddress: address(STAKE_PROGRAM),
      seed: `stake:${n}`,
    }),
  );

const voteEntry = (vote = VOTE, activatedStake = 5_000_000_000_000_000, commission = 5) => ({
  votePubkey: vote,
  nodePubkey: NODE,
  activatedStake,
  epochVoteAccount: true,
  commission,
  lastVote: 100,
  epochCredits: [[1, 2, 3]],
  rootSlot: 99,
});

const stakeValue = (overrides: {
  lamports?: number;
  staker?: string;
  withdrawer?: string;
  type?: string;
  delegation?: {
    voter?: string;
    stake?: string;
    activationEpoch?: string;
    deactivationEpoch?: string;
  };
}) => ({
  lamports: overrides.lamports ?? 2_000_000_000,
  owner: STAKE_PROGRAM,
  executable: false,
  rentEpoch: U64_MAX,
  data: {
    program: "stake",
    parsed: {
      type: overrides.type ?? "delegated",
      info: {
        meta: {
          rentExemptReserve: "2282880",
          authorized: {
            staker: overrides.staker ?? PAYER,
            withdrawer: overrides.withdrawer ?? PAYER,
          },
          lockup: { unixTimestamp: 0, epoch: 0, custodian: PAYER },
        },
        ...(overrides.type === "initialized"
          ? {}
          : {
              stake: {
                delegation: {
                  voter: overrides.delegation?.voter ?? VOTE,
                  stake: "1000000000",
                  activationEpoch: overrides.delegation?.activationEpoch ?? "600",
                  deactivationEpoch: overrides.delegation?.deactivationEpoch ?? U64_MAX,
                  warmupCooldownRate: 0.25,
                },
                creditsObserved: 10,
              },
            }),
      },
    },
    space: STAKE_ACCOUNT_BYTES,
  },
});

type StakeWorld = {
  readonly minDelegation?: bigint;
  readonly votes?: ReadonlyArray<unknown>;
  readonly delinquent?: ReadonlyArray<unknown>;
  readonly independentVotes?: ReadonlyArray<unknown> | "fail";
  readonly existingSeeds?: number;
  readonly balance?: bigint;
  readonly rent?: bigint;
  readonly epoch?: bigint;
  readonly units?: number;
  readonly accountInfo?: unknown;
  readonly positions?: ReadonlyArray<unknown>;
  readonly addresses?: ReadonlyArray<string>;
};

/** Answers one Solana JSON-RPC call for the world above; `Error` becomes an RPC error. */
const rpcAnswer = (o: StakeWorld, independent: boolean, seeds: ReadonlyArray<string>) => {
  const answer = (method: string, params: ReadonlyArray<unknown>): unknown => {
    const cfg = params[1] as Record<string, unknown> | undefined;
    switch (method) {
      case "getStakeMinimumDelegation":
        return { value: Number(o.minDelegation ?? 1_000_000_000n) };
      case "getVoteAccounts":
        if (independent && o.independentVotes === "fail") {
          return new Error("vote accounts read failed");
        }
        return {
          current: (independent ? o.independentVotes : undefined) ?? o.votes ?? [voteEntry()],
          delinquent: o.delinquent ?? [],
        };
      case "getMultipleAccounts": {
        const addrs = (params[0] as ReadonlyArray<string>) ?? [];
        if (cfg?.["encoding"] === "jsonParsed") {
          /* Positions scan: one slot per requested address. */
          return { value: addrs.map((a) => o.positions?.[seeds.indexOf(a)] ?? null) };
        }
        const seedAnswers = addrs.map((a) =>
          seeds.includes(a) && seeds.indexOf(a) < (o.existingSeeds ?? 0)
            ? { lamports: 1, owner: STAKE_PROGRAM, data: ["", "base64"] }
            : null,
        );
        return {
          value: addrs.every((a) => seeds.includes(a)) ? seedAnswers : addrs.map(() => null),
        };
      }
      case "getAccountInfo":
        return { value: o.accountInfo ?? null };
      case "getBalance":
        return { value: Number(o.balance ?? 50_000_000_000n) };
      case "getLatestBlockhash":
        return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100_000 } };
      case "simulateTransaction":
        return {
          value: {
            err: null,
            logs: [],
            unitsConsumed: o.units ?? 21_000,
            accounts:
              cfg?.["accounts"] === undefined
                ? undefined
                : ((cfg["accounts"] as Record<string, unknown>)["addresses"] as unknown[]).map(
                    () => null,
                  ),
          },
        };
      case "getRecentPrioritizationFees":
        return [];
      case "getMinimumBalanceForRentExemption":
        return Number(o.rent ?? 2_282_880n);
      case "getEpochInfo":
        return { epoch: Number(o.epoch ?? 700n) };
      case "getBlockHeight":
        return 1;
      case "sendTransaction":
        return `sig${"a".repeat(80)}`;
      case "getSignatureStatuses":
        return { value: [{ confirmationStatus: "finalized", err: null }] };
      default:
        return new Error(`unexpected rpc ${method}`);
    }
  };
  return answer;
};

const deriveSeeds = async (n: number): Promise<ReadonlyArray<string>> => {
  const out = await Promise.all(Array.from({ length: n }, (_v, i) => i).map(derived));
  return out;
};

const world = (o: StakeWorld = {}) => {
  const sent: Array<{ readonly url: string; readonly method: string }> = [];
  const seeds = deriveSeeds(40);
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
    const result = await rpcAnswer(o, target === HOST, await seeds)(method, body.params ?? []);
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
  return { requests, transactions, sent, signed, start, seeds };
};

const prepare = async (
  w: ReturnType<typeof world>,
  action: Extract<
    Parameters<RequestController["prepare"]>[0],
    { method: "solana-stake" }
  >["action"],
) =>
  w.requests.prepare({
    method: "solana-stake",
    account: ACCOUNT,
    network: SOL_NET,
    action,
    fee: "normal",
  });

const delegate = (lamports = 2_000_000_000n) => ({
  kind: "delegate" as const,
  lamports,
  vote: VOTE,
});

describe("solana-stake delegate", () => {
  it("builds create+initialize+delegate, decodes stake/full, and submits", async () => {
    const w = world();
    await w.start();
    const pending = await prepare(w, delegate());
    const display = pending.display as {
      summary: string;
      verifiability: string;
      staking?: ReadonlyArray<{ kind: string; account?: string }>;
      outflows: ReadonlyArray<{ to: string; amount: { amount: string } }>;
    };
    expect(display.summary).toBe("stake");
    expect(display.verifiability).toBe("full");
    expect(display.staking?.map((a) => a.kind)).toStrictEqual(["create", "delegate"]);
    const stakeAccount = await derived(0);
    expect(display.staking?.[1]?.account).toBe(stakeAccount);
    expect(display.outflows).toStrictEqual([
      {
        to: stakeAccount,
        amount: { asset: "lamports", amount: "2002282880", decimals: 9, symbol: "SOL" },
        verified: true,
      },
    ]);
    const tx = await w.requests.approve(pending.id, "solana-stake", {
      kind: "password",
      password: "pw",
    });
    expect(tx.state).not.toBe("failed");
    expect(w.signed).toHaveLength(1);
  });

  it("skips seeds whose derived accounts already exist", async () => {
    const w = world({ existingSeeds: 2 });
    await w.start();
    const pending = await prepare(w, delegate());
    const display = pending.display as { staking?: ReadonlyArray<{ account?: string }> };
    expect(display.staking?.[0]?.account).toBe(await derived(2));
  });

  it("refuses a delegation below the minimum", async () => {
    const w = world();
    await w.start();
    await expect(prepare(w, delegate(500_000_000n))).rejects.toThrow(/at least/);
  });

  it("refuses a vote account that is not current, or delinquent", async () => {
    const w = world({ votes: [] });
    await w.start();
    await expect(prepare(w, delegate())).rejects.toThrow(/not a current vote account/);
    const d = world({ votes: [], delinquent: [voteEntry()] });
    await d.start();
    await expect(prepare(d, delegate())).rejects.toThrow(/not a current vote account/);
  });

  it("refuses when the endpoints disagree, flags a failed independent read", async () => {
    const w = world({ independentVotes: [] });
    await w.start();
    await expect(prepare(w, delegate())).rejects.toThrow(/independent endpoint/);
    const failed = world({ independentVotes: "fail" });
    await failed.start();
    const pending = await prepare(failed, delegate());
    expect(pending.checks).toContain("reads-unverified");
  });

  it("refuses when the balance cannot cover delegation, rent and fees", async () => {
    const w = world({ balance: 1_500_000_000n });
    await w.start();
    await expect(prepare(w, delegate())).rejects.toThrow(/does not cover/);
  });
});

describe("solana-stake deactivate", () => {
  const act = { kind: "deactivate" as const, stakeAccount: STAKE_ACCT };

  it("builds deactivate against an owned, delegated, not-deactivating account", async () => {
    const w = world({ accountInfo: stakeValue({}) });
    await w.start();
    const pending = await prepare(w, act);
    const display = pending.display as {
      summary: string;
      verifiability: string;
      staking?: ReadonlyArray<{ kind: string; account?: string }>;
    };
    expect(display.summary).toBe("stake");
    expect(display.staking).toStrictEqual([{ kind: "deactivate", account: STAKE_ACCT }]);
  });

  it("refuses a foreign staker, an already-deactivating and a non-delegated account", async () => {
    const foreign = world({ accountInfo: stakeValue({ staker: OTHER }) });
    await foreign.start();
    await expect(prepare(foreign, act)).rejects.toThrow(/staker authority/);
    const deactivating = world({
      accountInfo: stakeValue({ delegation: { deactivationEpoch: "701" } }),
    });
    await deactivating.start();
    await expect(prepare(deactivating, act)).rejects.toThrow(/already deactivating/);
    const initialized = world({ accountInfo: stakeValue({ type: "initialized" }) });
    await initialized.start();
    await expect(prepare(initialized, act)).rejects.toThrow(/not delegated/);
  });
});

describe("solana-stake withdraw", () => {
  const act = { kind: "withdraw" as const, stakeAccount: STAKE_ACCT, lamports: 1_500_000_000n };

  it("withdraws from an inactive account to the owner", async () => {
    const w = world({
      accountInfo: stakeValue({ delegation: { deactivationEpoch: "699" } }),
    });
    await w.start();
    const pending = await prepare(w, act);
    const display = pending.display as {
      summary: string;
      staking?: ReadonlyArray<unknown>;
      outflows: ReadonlyArray<unknown>;
    };
    expect(display.summary).toBe("stake");
    expect(display.staking).toStrictEqual([
      { kind: "withdraw", account: STAKE_ACCT, to: PAYER, lamports: "1500000000" },
    ]);
    expect(display.outflows).toStrictEqual([]);
  });

  it("refuses a foreign withdrawer, an active account and an overdraw", async () => {
    const foreign = world({ accountInfo: stakeValue({ withdrawer: OTHER }) });
    await foreign.start();
    await expect(prepare(foreign, act)).rejects.toThrow(/withdrawer authority/);
    const active = world({ accountInfo: stakeValue({}) });
    await active.start();
    await expect(prepare(active, act)).rejects.toThrow(/still delegated or cooling down/);
    const overdraw = world({
      accountInfo: stakeValue({
        lamports: 1_000_000_000,
        delegation: { deactivationEpoch: "699" },
      }),
    });
    await overdraw.start();
    await expect(prepare(overdraw, act)).rejects.toThrow(/exceeds/);
  });
});

describe("staking reads", () => {
  const stub = (o: StakeWorld, seeds: ReadonlyArray<string>): SolanaRpc => ({
    call: async (method, params) => {
      const result = await rpcAnswer(o, false, seeds)(method, params);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  });

  it("derives each position state and stops after five missing seeds", async () => {
    const seeds = await deriveSeeds(40);
    const positions = [
      stakeValue({ type: "initialized" }),
      stakeValue({ delegation: { activationEpoch: "700" } }),
      stakeValue({ delegation: { activationEpoch: "600" } }),
      stakeValue({ delegation: { deactivationEpoch: "700" } }),
      stakeValue({ delegation: { deactivationEpoch: "699" } }),
      null,
      null,
      null,
      null,
      null,
      stakeValue({}),
    ];
    const result = await stakePositions(stub({ positions }, seeds), PAYER);
    expect(result.map((p) => p.state)).toStrictEqual([
      "initialized",
      "activating",
      "active",
      "deactivating",
      "inactive",
    ]);
    expect(result[1]?.validator).toBe(VOTE);
    expect(result).toHaveLength(5);
  });

  it("lists current validators by activated stake, delinquents excluded", async () => {
    const votes = [
      voteEntry("v-small", 1_000_000_000, 10),
      voteEntry("v-big", 9_000_000_000, 0),
      voteEntry(VOTE, 5_000_000_000, 5),
    ];
    const validators = await stakeValidators(
      stub({ votes, delinquent: [voteEntry("v-delinquent")] }, []),
    );
    expect(validators.map((v) => v.vote)).toStrictEqual(["v-big", VOTE, "v-small"]);
    expect(validators[0]?.commission).toBe(0);
  });
});
