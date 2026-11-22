/**
 * The recent blockhash is the chain binding of a Solana transaction: when the gateway serves the
 * network a host endpoint must still accept it (`isBlockhashValid` at processed), and both
 * endpoints must report the configured cluster's genesis. A gateway-only build is refused, a host
 * read failure or "invalid" answer is refused, and an endpoint on another cluster is refused before
 * anything is signed. A host-only primary is trusted configuration and builds without a genesis
 * read.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import type { Independent, SolanaRpc } from "../src/networks/controller.ts";
import type {
  AccountRef,
  ChainRequestInput,
  RouteContext,
  SendParams,
  TrackedTransaction,
  PrepareParams,
} from "../src/transactions/route.ts";
import { prepareSolana, prepareSolanaStake } from "../src/transactions/solana.ts";

const NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** Solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp mainnet's genesis — what another cluster answers. */
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const FROM = base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(0x11)));
const TO = base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(0x22)));
const VOTE = base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(0x33)));
const STAKE_ACCOUNT = base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(0x44)));
const BLOCKHASH = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const ACCOUNT: AccountRef = {
  kind: "hd",
  walletId: "w",
  groupIndex: 0,
  template: "solana.bip44-change",
};
const VERIFY = { kind: "password", password: "pw" } as SendParams["verify"];

const params = (over: Partial<PrepareParams> = {}): PrepareParams => ({
  account: ACCOUNT,
  network: NET,
  to: TO,
  amount: 1_000_000n,
  fee: "normal",
  ...over,
});

type World = {
  /** The primary endpoint's cluster; the host's lives on the independent client. */
  genesis: string;
  hostGenesis: string;
  /** Whether the host's `isBlockhashValid` answers true. */
  hostBlockhashValid: boolean;
  /** Methods the host endpoint fails on. */
  hostFailing: Set<string>;
  independent: Independent<SolanaRpc>;
  /** Every method the primary saw, in order. */
  calls: string[];
  /** Every method the host saw, in order. */
  hostCalls: string[];
  signCalls: number;
};

const answerRpc = (w: World, host: boolean) => {
  const methods = host ? w.hostCalls : w.calls;
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    await Promise.resolve();
    methods.push(method);
    if (host && w.hostFailing.has(method)) {
      throw new TypeError("fetch failed");
    }
    switch (method) {
      case "getLatestBlockhash":
        return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100_000 } };
      case "getGenesisHash":
        return host ? w.hostGenesis : w.genesis;
      case "isBlockhashValid":
        return { context: { slot: 5000 }, value: w.hostBlockhashValid };
      case "getRecentPrioritizationFees":
        return [];
      case "getAccountInfo":
        return params[0] === STAKE_ACCOUNT
          ? {
              value: {
                lamports: 2_000_000_000,
                data: {
                  program: "stake",
                  parsed: {
                    type: "delegated",
                    info: {
                      meta: { authorized: { staker: FROM, withdrawer: FROM } },
                      stake: {
                        delegation: {
                          voter: VOTE,
                          activationEpoch: "100",
                          deactivationEpoch: "18446744073709551615",
                        },
                      },
                    },
                  },
                },
              },
            }
          : { value: null };
      case "getMultipleAccounts": {
        const watch = Array.isArray(params[0]) ? params[0] : [];
        return { value: watch.map(() => null) };
      }
      case "simulateTransaction": {
        const cfg = params[1] as Record<string, unknown> | undefined;
        const watch = (cfg?.["accounts"] as Record<string, unknown> | undefined)?.["addresses"];
        return {
          value: {
            err: null,
            logs: [],
            unitsConsumed: 6000,
            accounts: Array.isArray(watch) ? watch.map(() => null) : undefined,
          },
        };
      }
      case "getBlockHeight":
        return 99_000;
      case "getEpochInfo":
        return { absoluteSlot: 5000, blockHeight: 99_000 };
      case "sendTransaction": {
        const wire = String(params[0]);
        return base58.encode(base64.decode(wire).slice(1, 65));
      }
      default:
        throw new Error(`unmocked ${method}`);
    }
  };
  return call;
};

const world = (over: Partial<World> = {}): World & { api: SolanaRpc; hostApi: SolanaRpc } => {
  const w: World = {
    genesis: GENESIS,
    hostGenesis: GENESIS,
    hostBlockhashValid: true,
    hostFailing: new Set(),
    independent: { kind: "not-needed" },
    calls: [],
    hostCalls: [],
    signCalls: 0,
    ...over,
  };
  return {
    ...w,
    api: { call: answerRpc(w, false) },
    hostApi: { call: answerRpc(w, true) },
  };
};

const withHost = (w: World & { hostApi: SolanaRpc }): void => {
  w.independent = { kind: "available", client: w.hostApi };
};

const ctx = (w: World & { api: SolanaRpc }): RouteContext => ({
  options: {
    networks: {
      solanaRpc: () => w.api,
      independentSolanaRpc: () => w.independent,
      info: () => ({ genesisHash: GENESIS }),
    } as never,
    wallet: {} as never,
    openStore: async () => Promise.resolve({} as never),
    random: (n: number) => new Uint8Array(n).fill(0x55),
    setTimer: () => () => {},
    now: () => 1_000_000,
    logger: { warn: () => {} },
    chains: {
      account: async () =>
        Promise.resolve({ template: "solana.bip44-change", network: NET, address: FROM }),
      sign: async (p: { request: { kind: string } }) => {
        await Promise.resolve();
        w.signCalls += 1;
        if (p.request.kind !== "solana.transaction") {
          throw new Error("unexpected request");
        }
        return { kind: "solana.transaction" as const, signature: new Uint8Array(64).fill(7) };
      },
    } as never,
  },
  transition: async (tx: TrackedTransaction, next: Partial<TrackedTransaction>) => {
    const updated = { ...tx, ...next };
    return Promise.resolve(updated);
  },
  track: () => {},
  txs: () => ({}),
  newId: () => "tx-test",
});

const genesisReads = (w: World): number => w.calls.filter((m) => m === "getGenesisHash").length;

const deactivate = (): Extract<ChainRequestInput, { method: "solana-stake" }> => ({
  method: "solana-stake",
  account: ACCOUNT,
  network: NET,
  action: { kind: "deactivate", stakeAccount: STAKE_ACCOUNT },
  fee: "normal",
});

describe("the recent blockhash must be confirmed by a host endpoint", () => {
  it("refuses a gateway-only send before anything is signed", async () => {
    const w = world({ independent: { kind: "unavailable" } });
    await expect(prepareSolana(ctx(w), params())).rejects.toThrow(
      /only the gateway vouches for the recent blockhash on solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/,
    );
    expect(w.signCalls).toBe(0);
  });

  it("refuses a gateway-only stake prepare the same way", async () => {
    const w = world({ independent: { kind: "unavailable" } });
    await expect(prepareSolanaStake(ctx(w), deactivate())).rejects.toThrow(
      /only the gateway vouches for the recent blockhash/,
    );
    expect(w.signCalls).toBe(0);
  });

  it("builds when the host endpoint confirms the blockhash", async () => {
    const w = world();
    withHost(w);
    const prepared = await prepareSolana(ctx(w), params());
    expect(prepared.checks).toStrictEqual([]);
    expect(genesisReads(w)).toBe(1); // the answering endpoint's own genesis was read
    expect(w.hostCalls).toContain("getGenesisHash");
    expect(w.hostCalls).toContain("isBlockhashValid");
    const tx = await prepared.submit(VERIFY, () => undefined);
    expect(tx.state).toBe("submitted");
    expect(w.signCalls).toBe(1);
  });

  it("builds a stake prepare the host confirms", async () => {
    const w = world();
    withHost(w);
    const prepared = await prepareSolanaStake(ctx(w), deactivate());
    expect(prepared.checks).toStrictEqual([]);
    expect(w.hostCalls).toContain("isBlockhashValid");
  });

  it("refuses when the host's blockhash read fails", async () => {
    const w = world();
    w.hostFailing.add("isBlockhashValid");
    withHost(w);
    await expect(prepareSolana(ctx(w), params())).rejects.toThrow(
      /could not confirm the recent blockhash/,
    );
    expect(w.signCalls).toBe(0);
  });

  it("refuses when the host does not know the blockhash", async () => {
    const w = world({ hostBlockhashValid: false });
    withHost(w);
    await expect(prepareSolana(ctx(w), params())).rejects.toThrow(
      /does not know the recent blockhash/,
    );
    expect(w.signCalls).toBe(0);
  });
});

describe("the answering node must report the configured cluster", () => {
  it("refuses a primary on another cluster's genesis", async () => {
    const w = world({ genesis: MAINNET_GENESIS });
    withHost(w);
    await expect(prepareSolana(ctx(w), params())).rejects.toThrow(
      /serves another chain than solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/,
    );
    expect(w.signCalls).toBe(0);
  });

  it("refuses a host endpoint on another cluster's genesis", async () => {
    const w = world({ hostGenesis: MAINNET_GENESIS });
    withHost(w);
    await expect(prepareSolana(ctx(w), params())).rejects.toThrow(/serves another chain/);
    expect(w.signCalls).toBe(0);
  });

  it("refuses when the host's genesis read fails", async () => {
    const w = world();
    w.hostFailing.add("getGenesisHash");
    withHost(w);
    await expect(prepareSolana(ctx(w), params())).rejects.toThrow(
      /could not confirm the recent blockhash/,
    );
  });

  it("a host-only primary builds without a genesis read", async () => {
    const w = world(); // independent stays not-needed — trusted host configuration
    const prepared = await prepareSolana(ctx(w), params());
    expect(prepared.checks).toStrictEqual([]);
    expect(genesisReads(w)).toBe(0);
    const tx = await prepared.submit(VERIFY, () => undefined);
    expect(tx.state).toBe("submitted");
  });
});
