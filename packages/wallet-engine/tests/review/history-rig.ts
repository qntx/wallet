/**
 * Shared history rig for the R15-04/R15-05 review PoCs: the `make` rig of
 * history-controller.test.ts, with `confirmed` read off a mutable flag on every `chains.account`
 * call — what a later on-device verification changes underneath it.
 */
/* oxlint-disable typescript/require-await -- the stub signatures demand promises the rig
   resolves immediately */
import { HistoryController } from "../../src/history/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";

export const OWNER2 = "0x70A65731F328d3e24Be8abc0dBd0bDa2e46bDf8B";
export const OTHER = "0xfa5180956e87bff2d1fce8423d2e755846ac3b24";
// Same first/last four characters as OWNER2 — a lookalike of the second group's address.
export const LOOKALIKE2 = `0x70a6${"0".repeat(32)}df8b`;
export const GROUP2 = { walletId: "w", groupIndex: 1 } as const;
export const EVM = "eip155:1";

const hash = (byte: string) => `0x${byte.repeat(32)}`;

/** A first page holding one erc20 transfer from the lookalike to the second group's address. */
export const lookalikePage = {
  items: [
    {
      hash: hash("bb"),
      block: "100",
      timestamp: 5_000_000,
      transfers: [
        {
          kind: "erc20",
          from: LOOKALIKE2,
          to: OWNER2,
          contract: "0x9999999999999999999999999999999999999999",
          tokenId: null,
          amount: "700",
          decimals: 6,
          symbol: null,
          logIndex: null,
        },
      ],
    },
  ],
  cursor: null,
};

export const historyRig = (confirmed: { current: boolean }): { controller: HistoryController } => {
  const pages = [{ ...lookalikePage, items: [...lookalikePage.items] }];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stub casts past the full options type, as the make rig of history-controller.test.ts does
  const controller = new HistoryController({
    networks: {
      enabled: (family: string) => (family === "evm" ? [EVM] : []),
      client: () => ({
        transport: {
          request: async () => null,
        },
      }),
      gatewayFirst: () => true,
      independentClient: () => ({ kind: "unavailable" }),
      independentSolanaRpc: () => ({ kind: "unavailable" }),
      independentEsplora: () => ({ kind: "unavailable" }),
      solanaRpc: () => ({
        call: async () => {
          throw new Error("solana node down");
        },
      }),
      esplora: () => ({
        get: async () => {
          throw new Error("unmocked");
        },
      }),
    },
    chains: {
      account: async (params: { template: string; groupIndex: number }) =>
        params.template === "evm.bip44"
          ? {
              address: params.groupIndex === 0 ? OTHER : OWNER2,
              confirmed: confirmed.current,
            }
          : params.template === "solana.bip44-change"
            ? { address: "SolOwner111111111111111111111111111111111", confirmed: true }
            : { xpub: "xpub", changeMark: 0, confirmed: true },
    },
    spark: {
      history: async () => ({ items: [], nextOffset: undefined }),
      store: { getState: () => ({ accounts: {} }), subscribe: () => () => undefined },
    },
    sparkNetwork: "regtest",
    transactions: {
      store: {
        getState: () => ({ txs: {} }),
        setState: () => undefined,
        subscribe: () => () => undefined,
      },
    },
    addressBook: {
      store: {
        getState: () => ({ entries: {} }),
        subscribe: () => () => undefined,
      },
    },
    gateway: {
      url: "https://gateway.test",
      fetch: (async () => {
        const page = { truncated: false, ...(pages.shift() ?? { items: [], cursor: null }) };
        return Response.json(page);
      }) as typeof globalThis.fetch,
    },
    openStore: async () => createMemoryEngineStore(),
    setTimer: () => () => undefined,
    now: () => 1_700_000_000_000,
    logger: { warn: () => undefined },
  } as never);
  return { controller };
};

export const flagsOf = (controller: HistoryController, key = "w:1"): ReadonlyArray<string> =>
  controller.getState().groups[key]?.entries[0]?.flags ?? [];
