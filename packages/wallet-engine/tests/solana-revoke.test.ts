/**
 * `solana-revoke` read-before-build → program-matched Revoke instructions → decode-guard. The rpc
 * answer scripts stand in for both endpoints; the chains decoder is the second reader of the
 * compiled message — it must name exactly `delegate-revoked` for the asked accounts, nothing else.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import { PROGRAM_IDS } from "@qntx/wallet-chains/solana";

import type { SolanaRpc } from "../src/networks/controller.ts";
import { networkById } from "../src/networks/registry.ts";
import type { RouteContext } from "../src/transactions/route.ts";
import { prepareSolanaRevoke, SOLANA_REVOKE_MAX } from "../src/transactions/solana-revoke.ts";

const NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const BLOCKHASH = "11111111111111111111111111111111";
const FROM = base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(7)));
const TA1 = base58.encode(new Uint8Array(32).fill(11));
const TA2 = base58.encode(new Uint8Array(32).fill(12));
const TA3 = base58.encode(new Uint8Array(32).fill(13));
const DELEGATE = base58.encode(new Uint8Array(32).fill(14));
const ACCOUNT = {
  kind: "hd" as const,
  walletId: "0a".repeat(8),
  groupIndex: 0,
  template: "solana.bip44-change" as const,
};

const rpc = (answer: (method: string, params: unknown[]) => unknown): SolanaRpc => ({
  call: async (method, params) => {
    await Promise.resolve();
    return answer(method, params);
  },
});

const unmocked = (method: string): never => {
  throw new Error(`unmocked ${method}`);
};

/** The calls the whole prepare path makes for a revoke. */
const defaults =
  (accounts: unknown) =>
  (method: string, _params: unknown[]): unknown => {
    switch (method) {
      case "getMultipleAccounts":
        return { value: accounts };
      case "getLatestBlockhash":
        return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100_000 } };
      case "getGenesisHash":
        return GENESIS;
      case "isBlockhashValid":
        return { context: { slot: 90_000 }, value: true };
      case "getEpochInfo":
        return { absoluteSlot: 100_000, blockHeight: 90_000, epoch: 700 };
      case "getRecentPrioritizationFees":
        return [];
      case "simulateTransaction":
        return { value: { err: null, logs: [], unitsConsumed: 5000, accounts: null } };
      default:
        return unmocked(method);
    }
  };

const tokenAccount = (options: {
  readonly program?: string;
  readonly owner?: string;
  /** `null` writes no delegate field at all. */
  readonly delegate?: string | null;
}): unknown => ({
  owner: options.program ?? PROGRAM_IDS.token,
  data: {
    parsed: {
      type: "account",
      info: {
        owner: options.owner ?? FROM,
        ...(options.delegate === null ? {} : { delegate: options.delegate ?? DELEGATE }),
        mint: TA3,
        tokenAmount: { amount: "5", decimals: 6, uiAmountString: "0.000005" },
      },
      space: 165,
    },
    program: "spl-token",
  },
});

const ctx = (
  primary: (method: string, params: unknown[]) => unknown,
  independent?: ((method: string, params: unknown[]) => unknown) | "down",
): RouteContext => ({
  options: {
    networks: {
      info: networkById,
      solanaRpc: () => rpc(primary),
      independentSolanaRpc: () =>
        independent === undefined
          ? { kind: "unavailable" }
          : {
              kind: "available" as const,
              source: "host" as const,
              client:
                independent === "down"
                  ? rpc((method, params) => {
                      if (method === "getMultipleAccounts") {
                        throw new Error("endpoint down");
                      }
                      return defaults([])(method, params);
                    })
                  : rpc(independent),
            },
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

const revoke = (
  tokenAccounts: ReadonlyArray<string>,
): Parameters<typeof prepareSolanaRevoke>[1] => ({
  method: "solana-revoke",
  account: ACCOUNT,
  network: NET,
  tokenAccounts,
  fee: "normal",
});

describe("solana-revoke", () => {
  it("builds one Token Revoke and decodes to exactly the delegate-revoked approvals", async () => {
    const prepared = await prepareSolanaRevoke(ctx(defaults([tokenAccount({})])), revoke([TA1]));
    expect(prepared.intent.approvals).toStrictEqual([
      { kind: "delegate-revoked", account: TA1, verified: false },
    ]);
    expect(prepared.intent.outflows).toStrictEqual([]);
    expect(prepared.intent.verifiability).toBe("full");
  });

  it("mixes Token and Token-2022 accounts — each Revoke names its own program", async () => {
    const prepared = await prepareSolanaRevoke(
      ctx(defaults([tokenAccount({}), tokenAccount({ program: PROGRAM_IDS.token2022 })])),
      revoke([TA1, TA2]),
    );
    expect(prepared.intent.approvals).toStrictEqual([
      { kind: "delegate-revoked", account: TA1, verified: false },
      { kind: "delegate-revoked", account: TA2, verified: false },
    ]);
    /* Both Revokes decoded, in order — one approval per token account. */
  });

  it("refuses a token account owned by someone else", async () => {
    await expect(
      prepareSolanaRevoke(ctx(defaults([tokenAccount({ owner: DELEGATE })])), revoke([TA1])),
    ).rejects.toThrow(/not owned by this account/);
  });

  it("refuses an account without a delegate", async () => {
    await expect(
      prepareSolanaRevoke(ctx(defaults([tokenAccount({ delegate: null })])), revoke([TA1])),
    ).rejects.toThrow(/has no delegate/);
  });

  it("refuses a non-token account", async () => {
    await expect(
      prepareSolanaRevoke(
        ctx(defaults([tokenAccount({ program: "Stake11111111111111111111111111111111111111" })])),
        revoke([TA1]),
      ),
    ).rejects.toThrow(/not a token account/);
  });

  it("refuses a missing account", async () => {
    await expect(prepareSolanaRevoke(ctx(defaults([null])), revoke([TA1]))).rejects.toThrow(
      /not a token account/,
    );
  });

  it("refuses duplicate accounts", async () => {
    await expect(prepareSolanaRevoke(ctx(defaults([])), revoke([TA1, TA1]))).rejects.toThrow(
      /duplicate token account/,
    );
  });

  it("refuses more than 10 accounts", async () => {
    const many = Array.from({ length: SOLANA_REVOKE_MAX + 1 }, (_, i) =>
      base58.encode(new Uint8Array(32).fill(30 + i)),
    );
    await expect(prepareSolanaRevoke(ctx(defaults([])), revoke(many))).rejects.toThrow(
      /takes 1\.\.\d+ token accounts/,
    );
  });

  it("refuses a malformed account string", async () => {
    await expect(prepareSolanaRevoke(ctx(defaults([])), revoke(["not-base58!"]))).rejects.toThrow(
      /not a base58 account/,
    );
  });

  it("refuses when the two endpoints disagree on the delegate", async () => {
    const independent = (method: string, params: unknown[]): unknown =>
      defaults([tokenAccount({ delegate: TA3 })])(method, params);
    await expect(
      prepareSolanaRevoke(
        ctx(defaults([tokenAccount({ delegate: DELEGATE })]), independent),
        revoke([TA1]),
      ),
    ).rejects.toThrow(/the two endpoints disagree/);
  });

  it("a down independent endpoint flags reads-unverified but still prepares", async () => {
    const prepared = await prepareSolanaRevoke(
      ctx(defaults([tokenAccount({})]), "down"),
      revoke([TA1]),
    );
    expect(prepared.checks).toContain("reads-unverified");
  });

  it("an agreeing independent endpoint leaves the read verified", async () => {
    const prepared = await prepareSolanaRevoke(
      ctx(
        defaults([tokenAccount({ delegate: DELEGATE })]),
        defaults([tokenAccount({ delegate: DELEGATE })]),
      ),
      revoke([TA1]),
    );
    expect(prepared.checks).not.toContain("reads-unverified");
  });
});
