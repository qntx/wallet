/**
 * RPC answers that omit or corrupt fields the spec guarantees must fail the read, never read as a
 * zero/default: a missing `lastValidBlockHeight` would make drop proofs fire immediately (a resent
 * transaction double-pays), a missing epoch-tip weakens the bank floor, and a missing balance or
 * rent produces a wrong refusal. Protocol-defined omissions (proto3 zero fields, a fee sample list,
 * simulate's `unitsConsumed`) keep their conservative meanings.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import { EvmChainAdapter } from "../src/chains/evm.ts";
import { SolanaChainAdapter } from "../src/chains/solana.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";
import type { SimulationOutcome } from "../src/requests/simulation.ts";
import type { RouteContext } from "../src/transactions/route.ts";
import { prepareSolana, prepareSolanaStake } from "../src/transactions/solana.ts";

const NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const FROM = base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(7)));
const TO = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const VOTE = base58.encode(new Uint8Array(32).fill(3));
const MINT = base58.encode(new Uint8Array(32).fill(9));
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const unmocked = (method: string): never => {
  throw new Error(`unmocked ${method}`);
};

const rpc = (answer: (method: string, params: unknown[]) => unknown): SolanaRpc => ({
  call: async (method, params) => {
    await Promise.resolve();
    return answer(method, params);
  },
});

/** A `SolanaRpc` that returns the recorded answer per method and throws on anything else. */
const answers =
  (over: Record<string, unknown>) =>
  (method: string): unknown =>
    method in over ? over[method] : unmocked(method);

/** The error text of an `unavailable` outcome. */
const errorOf = (o: SimulationOutcome): string => (o.status === "unavailable" ? o.error : "");

/** `getMultipleAccounts` answers whose entries carry no `lamports` field. */
const noLamports = (method: string, params: unknown[]): unknown =>
  method === "getMultipleAccounts"
    ? {
        value: (params[0] as unknown[]).map(() => ({
          owner: "11111111111111111111111111111111",
          data: ["", "base64"],
        })),
      }
    : method === "simulateTransaction"
      ? { value: { err: null, logs: [], unitsConsumed: 5000, accounts: [] } }
      : unmocked(method);

const solana = new SolanaChainAdapter();

describe("solana RPC numeric fields", () => {
  it("tip rejects a missing absoluteSlot or blockHeight instead of reading them as 0", async () => {
    const epochInfo = (over: Record<string, unknown>) => ({
      absoluteSlot: 500,
      blockHeight: 600,
      epoch: 700,
      ...over,
    });
    await expect(solana.tip(rpc(() => epochInfo({ absoluteSlot: undefined })))).rejects.toThrow(
      /absoluteSlot/,
    );
    await expect(solana.tip(rpc(() => epochInfo({ blockHeight: undefined })))).rejects.toThrow(
      /blockHeight/,
    );
    await expect(solana.tip(rpc(() => epochInfo({})))).resolves.toStrictEqual({
      slot: 500n,
      height: 600n,
    });
  });

  it("build rejects a missing blockhash or lastValidBlockHeight instead of reading 0", async () => {
    const lamports = 1000n;
    await expect(
      solana.build(rpc(answers({ getLatestBlockhash: { value: {} } })), NET, FROM, {
        kind: "sol",
        to: TO,
        lamports,
      }),
    ).rejects.toThrow(/blockhash/);
    await expect(
      solana.build(
        rpc(
          answers({
            getLatestBlockhash: {
              value: { blockhash: "11111111111111111111111111111111" },
            },
          }),
        ),
        NET,
        FROM,
        { kind: "sol", to: TO, lamports },
      ),
    ).rejects.toThrow(/lastValidBlockHeight/);
  });

  it("rent-exemption rejects a missing value instead of building with 0 rent", async () => {
    await expect(
      solana.build(rpc(answers({ getMinimumBalanceForRentExemption: {} })), NET, FROM, {
        kind: "stake-delegate",
        seed: "stake:0",
        stakeAccount: TO,
        lamports: 1n,
        vote: VOTE,
      }),
    ).rejects.toThrow(/getMinimumBalanceForRentExemption/);
  });

  it("a simulation account missing lamports is unavailable, never a silent zero", async () => {
    const unsigned = await solana.build(
      rpc(
        answers({
          getLatestBlockhash: {
            value: {
              blockhash: "11111111111111111111111111111111",
              lastValidBlockHeight: 100_000,
            },
          },
          simulateTransaction: { value: { err: null, logs: [], unitsConsumed: 5000 } },
        }),
      ),
      NET,
      FROM,
      { kind: "sol", to: TO, lamports: 1000n },
    );
    const message = solana.applyFee(unsigned, { tier: "normal", microLamportsPerCu: 0n });
    const outcome = await solana.simulate(rpc(noLamports), NET, FROM, message, () => () => {});
    expect(outcome.status).toBe("unavailable");
    expect(errorOf(outcome)).toMatch(/lamports/);
  });

  it("a simulate answer without unitsConsumed still budgets the maximum", async () => {
    const unsigned = await solana.build(
      rpc(
        answers({
          getLatestBlockhash: {
            value: {
              blockhash: "11111111111111111111111111111111",
              lastValidBlockHeight: 100_000,
            },
          },
          simulateTransaction: { value: { err: null, logs: [] } },
        }),
      ),
      NET,
      FROM,
      { kind: "sol", to: TO, lamports: 1000n },
    );
    expect(unsigned.unitsConsumed).toBe(1_400_000);
    const stringUnits = await solana.build(
      rpc(
        answers({
          getLatestBlockhash: {
            value: {
              blockhash: "11111111111111111111111111111111",
              lastValidBlockHeight: 100_000,
            },
          },
          simulateTransaction: { value: { err: null, logs: [], unitsConsumed: "5000" } },
        }),
      ),
      NET,
      FROM,
      { kind: "sol", to: TO, lamports: 1000n },
    );
    expect(stringUnits.unitsConsumed).toBe(1_400_000);
  });

  it("a malformed prioritization-fee sample is dropped, never NaN", async () => {
    const quotes = await solana.estimateFee(
      rpc(() => [
        { prioritizationFee: "not-a-number" },
        { prioritizationFee: "junk" },
        { prioritizationFee: 7 },
      ]),
      [FROM],
    );
    for (const quote of quotes) {
      expect(quote.microLamportsPerCu).toBe(7n);
    }
  });
});

const ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "solana.bip44-change" as const,
};

const ctx = (call: (method: string, params: unknown[]) => unknown): RouteContext => ({
  options: {
    networks: {
      solanaRpc: () => rpc(call),
      independentSolanaRpc: () => ({ kind: "unavailable" }),
    } as never,
    chains: { account: async () => Promise.resolve({ address: FROM }) } as never,
    wallet: {} as never,
    openStore: async () => Promise.resolve({} as never),
    random: (n: number) => new Uint8Array(n),
    setTimer: () => () => {},
    now: () => 0,
    logger: { warn: () => {} },
  },
  transition: async (tx, next) => Promise.resolve({ ...tx, ...next }),
  track: () => {},
  txs: () => ({}),
  newId: () => "tx-1",
});

/** The valid answer for every call the stake paths make. */
const stakeDefault = (method: string, params: unknown[]): unknown => {
  switch (method) {
    case "getStakeMinimumDelegation":
      return { value: 1 };
    case "getVoteAccounts":
      return { current: [{ votePubkey: VOTE }], delinquent: [] };
    case "getMultipleAccounts":
      return { value: (params[0] as unknown[]).map(() => null) };
    case "getMinimumBalanceForRentExemption":
      return 2_282_880;
    case "getBalance":
      return { value: 50_000_000_000 };
    case "getLatestBlockhash":
      return {
        value: {
          blockhash: "11111111111111111111111111111111",
          lastValidBlockHeight: 100_000,
        },
      };
    case "getEpochInfo":
      return { epoch: 700 };
    case "getRecentPrioritizationFees":
      return [];
    case "simulateTransaction":
      return { value: { err: null, logs: [], unitsConsumed: 5000 } };
    default:
      return unmocked(method);
  }
};

const stakeAnswers =
  (over: Record<string, unknown> = {}) =>
  (method: string, params: unknown[]): unknown =>
    method in over ? over[method] : stakeDefault(method, params);

const DELEGATE = {
  method: "solana-stake" as const,
  account: ACCOUNT,
  network: NET,
  action: { kind: "delegate" as const, lamports: 1_000_000_000n, vote: VOTE },
  fee: "normal" as const,
};

const stakeAccount = (lamports: number | undefined): unknown => ({
  ...(lamports === undefined ? {} : { lamports }),
  owner: "Stake11111111111111111111111111111111111111",
  data: {
    program: "stake",
    parsed: {
      type: "delegated",
      info: {
        meta: { authorized: { staker: FROM, withdrawer: FROM } },
        stake: {
          delegation: {
            voter: VOTE,
            activationEpoch: 1,
            deactivationEpoch: 650,
          },
        },
      },
    },
  },
});

const WITHDRAW = {
  method: "solana-stake" as const,
  account: ACCOUNT,
  network: NET,
  action: { kind: "withdraw" as const, stakeAccount: TO, lamports: 10n },
  fee: "normal" as const,
};

describe("solana route RPC fields", () => {
  it("a missing rent value is malformed, not a zero-rent delegation", async () => {
    await expect(
      prepareSolanaStake(ctx(stakeAnswers({ getMinimumBalanceForRentExemption: {} })), DELEGATE),
    ).rejects.toThrow(/getMinimumBalanceForRentExemption: malformed/);
  });

  it("a missing balance value is malformed, not a zero balance", async () => {
    await expect(
      prepareSolanaStake(ctx(stakeAnswers({ getBalance: {} })), DELEGATE),
    ).rejects.toThrow(/getBalance: malformed/);
  });

  it("a short getMultipleAccounts answer is malformed, not free seeds", async () => {
    await expect(
      prepareSolanaStake(ctx(stakeAnswers({ getMultipleAccounts: { value: [] } })), DELEGATE),
    ).rejects.toThrow(/getMultipleAccounts: malformed/);
  });

  it("a stake account without a lamports field is malformed", async () => {
    await expect(
      prepareSolanaStake(
        ctx(stakeAnswers({ getAccountInfo: { value: stakeAccount(undefined) } })),
        WITHDRAW,
      ),
    ).rejects.toThrow(/getAccountInfo: malformed lamports/);
  });

  it("a missing epoch is malformed, not epoch 0 (which would refuse a live cooldown)", async () => {
    await expect(
      prepareSolanaStake(
        ctx(
          stakeAnswers({
            getAccountInfo: { value: stakeAccount(50_000_000_000) },
            getEpochInfo: {},
          }),
        ),
        WITHDRAW,
      ),
    ).rejects.toThrow(/getEpochInfo: malformed epoch/);
  });

  it("a missing epoch gates Token-2022 extension parsing the same way", async () => {
    await expect(
      prepareSolana(
        ctx(
          answers({
            getAccountInfo: {
              value: {
                owner: TOKEN_2022,
                data: [base64.encode(new Uint8Array(200)), "base64"],
              },
            },
            getEpochInfo: {},
          }),
        ),
        {
          account: ACCOUNT,
          network: NET,
          to: TO,
          amount: 1n,
          fee: "normal",
          token: MINT,
          decimals: 6,
        },
      ),
    ).rejects.toThrow(/getEpochInfo: malformed epoch/);
  });
});

describe("evm RPC quantity fields", () => {
  const evm = new EvmChainAdapter();
  const evmAddr = "0x1111111111111111111111111111111111111111";
  const client = (answers: Record<string, unknown>) =>
    ({
      transport: {
        request: async ({ method }: { method: string; params: unknown[] }) => {
          await Promise.resolve();
          return method in answers ? answers[method] : unmocked(method);
        },
      },
    }) as never;

  it("transaction counts reject a non-quantity answer instead of NaN", async () => {
    const c = client({ eth_getTransactionCount: "not-a-quantity" });
    await expect(evm.pendingCount(c, evmAddr)).rejects.toThrow(/eth_getTransactionCount/);
    await expect(evm.confirmedCount(c, evmAddr)).rejects.toThrow(/eth_getTransactionCount/);
    await expect(
      evm.pendingCount(client({ eth_getTransactionCount: "0x5" }), evmAddr),
    ).resolves.toBe(5);
  });

  it("estimateGas rejects a non-quantity answer instead of an untyped BigInt throw", async () => {
    const c = client({ eth_estimateGas: "junk" });
    await expect(
      evm.build(c, "eip155:1", evmAddr, { kind: "native", to: evmAddr, value: 1n }, 0),
    ).rejects.toThrow(/eth_estimateGas: malformed/);
  });

  it("a malformed feeHistory falls back to gasPrice instead of quoting 0", async () => {
    const c = client({
      eth_feeHistory: { baseFeePerGas: [], reward: [] },
      eth_gasPrice: "0x100",
    });
    const quotes = await evm.estimateFee(c, "eip1559");
    for (const quote of quotes) {
      expect(quote.maxFeePerGas).toBe(256n);
    }
  });

  it("a receipt without a status is malformed, not a success", async () => {
    const c = client({
      eth_getTransactionReceipt: {
        blockHash: `0x${"ab".repeat(32)}`,
        blockNumber: "0x10",
      },
    });
    await expect(evm.receipt(c, `0x${"cd".repeat(32)}`)).rejects.toThrow(/status/);
  });
});
