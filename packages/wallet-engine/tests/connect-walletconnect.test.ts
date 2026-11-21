/**
 * WalletConnect peers as dApp origins: `establishWalletConnect` binds the negotiated scopes to the
 * selected group inside the session write queue and persists the session under the peer's session
 * key, `checkOrigin` accepts a peer only through that session, and the `ready` flag tracks the
 * session store.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import {
  BITCOIN_METHODS,
  ConnectionController,
  SESSION_METHODS,
  SOLANA_METHODS,
} from "../src/connect/controller.ts";
import type {
  AccountGroup,
  ConnectionControllerOptions,
  ConnectionScope,
} from "../src/connect/controller.ts";
import { ProviderError } from "../src/connect/errors.ts";
import { PHISHING_BLOCKED_MESSAGE } from "../src/phishing/status.ts";
import type { PhishingStatus } from "../src/phishing/status.ts";
import { walletConnectKey } from "../src/requests/types.ts";
import type { WalletConnectOrigin } from "../src/requests/types.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const MAINNET = "eip155:1";
const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BTC_NET = "bip122:000000000019d6689c085ae165831e93";
const OTHER_TOPIC = "b".repeat(64);
const PEER_URL = "https://peer.example";
const GROUP: AccountGroup = { walletId: "w", groupIndex: 0 };
const OTHER_GROUP: AccountGroup = { walletId: "w", groupIndex: 1 };
const TOPIC = "a".repeat(64);

const peer = (over: Partial<WalletConnectOrigin> = {}): WalletConnectOrigin => ({
  kind: "walletconnect",
  origin: walletConnectKey(over.topic ?? TOPIC),
  topic: over.topic ?? TOPIC,
  url: PEER_URL,
  name: "Peer Dapp",
  verify: { validation: "VALID", isScam: false },
  ...over,
});

const settle =
  (
    origin: WalletConnectOrigin,
    bound?: { scopes?: Readonly<Record<string, ConnectionScope>> },
    during?: () => Promise<void>,
  ) =>
  async (scopes: Readonly<Record<string, ConnectionScope>>): Promise<WalletConnectOrigin> => {
    if (bound !== undefined) {
      bound.scopes = scopes;
    }
    await during?.();
    return origin;
  };

const SCOPE = { methods: SESSION_METHODS, notifications: [] };

const codeOf = async (run: Promise<unknown>): Promise<number | string> =>
  run.then(
    () => "resolved",
    (error: unknown) => (error instanceof ProviderError ? error.code : String(error)),
  );

const idOf = (entry: { readonly id: string } | undefined): string => entry?.id ?? "";

const syncCode = (run: () => unknown): number | string => {
  try {
    run();
    return "resolved";
  } catch (error) {
    return error instanceof ProviderError ? error.code : String(error);
  }
};

function rig(options: { noGroup?: boolean; failEvm?: boolean } = {}) {
  let selected: AccountGroup | undefined = options.noGroup === true ? undefined : GROUP;
  const selectionListeners = new Set<() => void>();
  const blocked = new Set<string>();
  const invalidated: string[] = [];
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  let counter = 0;
  const random = (n: number): Uint8Array => {
    counter += 1;
    return new Uint8Array(n).fill(counter % 251);
  };
  const connectionOptions: ConnectionControllerOptions = {
    phishing: { check: (url): PhishingStatus => (blocked.has(url) ? "blocked" : "clear") },
    setTimer: () => () => undefined,
    openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
    random,
    now: () => 1000,
    logger: { warn: () => undefined },
    allowLocalhost: false,
    selectedGroup: () => selected,
    onSelectedGroup: (listener) => {
      selectionListeners.add(listener);
      return () => {
        selectionListeners.delete(listener);
      };
    },
    invalidateAll: () => undefined,
    evmAddress: async (group) => {
      if (options.failEvm === true) {
        throw new Error("derivation failed");
      }
      await Promise.resolve();
      return `0xEVM${String(group.groupIndex)}`;
    },
    enabledNetworks: () => [MAINNET, SOL_NET, BTC_NET],
    bitcoinAddress: async (group, _network, purpose) =>
      Promise.resolve(`btc-${String(group.groupIndex)}-${purpose}`),
    solanaAddress: async (group) => Promise.resolve(`sol-${String(group.groupIndex)}`),
    nostrPubkey: async () => Promise.resolve("a".repeat(64)),
    invalidate: (origin) => {
      invalidated.push(origin);
    },
  };
  const connections = new ConnectionController(connectionOptions);
  return {
    connections,
    connectionOptions,
    blocked,
    invalidated,
    select: (group: AccountGroup | undefined): void => {
      selected = group;
      for (const listener of selectionListeners) {
        listener();
      }
    },
  };
}

describe("checkOrigin with a WalletConnect peer", () => {
  it("refuses a walletconnect:<topic> string like any other non-URL origin", async () => {
    const r = rig();
    await r.connections.init();
    expect(syncCode(() => r.connections.checkOrigin(`walletconnect:${TOPIC}`))).toBe(4100);
  });

  it("refuses a peer object without an established session", async () => {
    const r = rig();
    await r.connections.init();
    expect(syncCode(() => r.connections.checkOrigin(peer()))).toBe(4100);
  });

  it("returns the very peer object passed once its session exists, Verify verdict included", async () => {
    const r = rig();
    await r.connections.init();
    const origin = peer({ verify: { validation: "UNKNOWN", isScam: true } });
    await r.connections.establishWalletConnect({ [MAINNET]: SCOPE }, settle(origin));
    expect(r.connections.checkOrigin(origin)).toBe(origin);
  });

  it("refuses the same session key under a different topic", async () => {
    const r = rig();
    await r.connections.init();
    const origin = peer();
    await r.connections.establishWalletConnect({ [MAINNET]: SCOPE }, settle(origin));
    expect(syncCode(() => r.connections.checkOrigin({ ...origin, topic: OTHER_TOPIC }))).toBe(4100);
  });

  it("refuses a peer whose unverified url is on the phishing list", async () => {
    const r = rig();
    await r.connections.init();
    const origin = peer();
    await r.connections.establishWalletConnect({ [MAINNET]: SCOPE }, settle(origin));
    r.blocked.add(PEER_URL);
    expect(() => r.connections.checkOrigin(origin)).toThrow(ProviderError);
    expect(() => r.connections.checkOrigin(origin)).toThrow(PHISHING_BLOCKED_MESSAGE);
  });
});

describe("establishWalletConnect", () => {
  it("binds each network's scope to the selected group and persists the session under the peer key", async () => {
    const r = rig();
    await r.connections.init();
    const origin = peer();
    const settled: { scopes?: Readonly<Record<string, ConnectionScope>> } = {};
    const session = await r.connections.establishWalletConnect(
      {
        [MAINNET]: SCOPE,
        [SOL_NET]: { methods: SOLANA_METHODS, notifications: [] },
        [BTC_NET]: { methods: BITCOIN_METHODS, notifications: ["change"] },
      },
      settle(origin, settled),
    );
    // evmAddress returns mixed case; the bound account is lowercased.
    expect(settled.scopes?.[MAINNET]?.accounts).toStrictEqual([`${MAINNET}:0xevm0`]);
    expect(settled.scopes?.[SOL_NET]?.accounts).toStrictEqual([`${SOL_NET}:sol-0`]);
    expect(settled.scopes?.[BTC_NET]?.accounts).toStrictEqual([
      `${BTC_NET}:btc-0-payment`,
      `${BTC_NET}:btc-0-ordinals`,
    ]);
    expect(settled.scopes?.[MAINNET]?.methods).toStrictEqual(SESSION_METHODS);
    expect(session).toMatchObject({
      origin,
      group: GROUP,
      currentNetwork: MAINNET,
      scopes: settled.scopes,
    });
    expect(session.origin).toBe(origin);
    expect(r.connections.session(origin.origin)).toStrictEqual(session);
  });

  it("currentNetwork is the first scope key when no eip155 network is granted", async () => {
    const r = rig();
    await r.connections.init();
    const session = await r.connections.establishWalletConnect(
      { [SOL_NET]: { methods: SOLANA_METHODS, notifications: [] } },
      settle(peer()),
    );
    expect(session.currentNetwork).toBe(SOL_NET);
  });

  it("persists the session across lock and unlock", async () => {
    const r = rig();
    await r.connections.init();
    const origin = peer();
    const session = await r.connections.establishWalletConnect(
      { [MAINNET]: SCOPE },
      settle(origin),
    );
    r.connections.lock();
    const reopened = new ConnectionController(r.connectionOptions);
    await reopened.init();
    expect(reopened.session(origin.origin)).toStrictEqual(session);
    expect(reopened.checkOrigin(origin)).toBe(origin);
  });

  it("drops a persisted session whose walletconnect origin key does not match its topic", async () => {
    const r = rig();
    await r.connections.init();
    const session = await r.connections.establishWalletConnect(
      { [MAINNET]: SCOPE },
      settle(peer()),
    );
    const store = await r.connectionOptions.openStore();
    const corrupted = {
      ...session,
      origin: { ...session.origin, origin: walletConnectKey(OTHER_TOPIC) },
    };
    await store
      .collection("connections")
      .put(session.id, new TextEncoder().encode(JSON.stringify(corrupted)));
    const reopened = new ConnectionController(r.connectionOptions);
    await reopened.init();
    expect(reopened.getState().sessions).toStrictEqual({});
  });

  it("persists nothing when settle throws, and the error propagates", async () => {
    const r = rig();
    await r.connections.init();
    await expect(
      codeOf(
        r.connections.establishWalletConnect({ [MAINNET]: SCOPE }, async () => {
          await Promise.resolve();
          throw new Error("relay refused");
        }),
      ),
    ).resolves.toBe("Error: relay refused");
    expect(r.connections.getState().sessions).toStrictEqual({});
  });

  it("is a user rejection when locked or when no account group is selected", async () => {
    const locked = rig();
    await locked.connections.init();
    locked.connections.lock();
    await expect(
      codeOf(locked.connections.establishWalletConnect({ [MAINNET]: SCOPE }, settle(peer()))),
    ).resolves.toBe(4001);

    const noGroup = rig({ noGroup: true });
    await noGroup.connections.init();
    await expect(
      codeOf(noGroup.connections.establishWalletConnect({ [MAINNET]: SCOPE }, settle(peer()))),
    ).resolves.toBe(4001);
  });

  it("rejects empty scopes, a namespace that is not a chain network and a disabled network", async () => {
    const r = rig();
    await r.connections.init();
    await expect(codeOf(r.connections.establishWalletConnect({}, settle(peer())))).resolves.toBe(
      -32602,
    );
    await expect(
      codeOf(
        r.connections.establishWalletConnect(
          { nostr: { methods: ["signEvent"], notifications: [] } },
          settle(peer()),
        ),
      ),
    ).resolves.toBe(-32602);
    await expect(
      codeOf(r.connections.establishWalletConnect({ "eip155:999": SCOPE }, settle(peer()))),
    ).resolves.toBe(-32602);
  });

  it("is an internal error when an account cannot be derived", async () => {
    const r = rig({ failEvm: true });
    await r.connections.init();
    await expect(
      codeOf(r.connections.establishWalletConnect({ [MAINNET]: SCOPE }, settle(peer()))),
    ).resolves.toBe(-32603);
  });

  it("a group switch while settle is pending is applied after the persist", async () => {
    const r = rig();
    await r.connections.init();
    const origin = peer();
    let release = (): void => undefined;
    let mark = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      mark = resolve;
    });
    const establishing = r.connections.establishWalletConnect(
      { [MAINNET]: SCOPE },
      settle(origin, undefined, async () => {
        mark();
        r.select(OTHER_GROUP);
        await gate;
      }),
    );
    await entered;
    release();
    const session = await establishing;
    // The persisted session holds the accounts settle saw; the queued re-point then updates them.
    expect(session.scopes[MAINNET]?.accounts).toStrictEqual([`${MAINNET}:0xevm0`]);
    await vi.waitFor(() => {
      expect(r.connections.session(origin.origin)?.scopes[MAINNET]?.accounts).toStrictEqual([
        `${MAINNET}:0xevm1`,
      ]);
    });
    expect(r.invalidated).toContain(origin.origin);
  });
});

describe("session store readiness and re-pointing", () => {
  it("ready is false before init, true once loaded, false after lock", async () => {
    const r = rig();
    expect(r.connections.getState().ready).toBe(false);
    await r.connections.init();
    expect(r.connections.getState().ready).toBe(true);
    r.connections.lock();
    expect(r.connections.getState().ready).toBe(false);
  });

  it("a group switch keeps a bip122 scope's restricted methods", async () => {
    const r = rig();
    await r.connections.init();
    const origin = peer();
    const restricted = ["bitcoin:signMessage"];
    await r.connections.establishWalletConnect(
      { [BTC_NET]: { methods: restricted, notifications: [] } },
      settle(origin),
    );
    r.select(OTHER_GROUP);
    await vi.waitFor(() => {
      expect(r.invalidated).toContain(origin.origin);
    });
    const scope = r.connections.session(origin.origin)?.scopes[BTC_NET];
    expect(scope?.methods).toStrictEqual(restricted);
    expect(scope?.accounts).toStrictEqual([
      `${BTC_NET}:btc-1-payment`,
      `${BTC_NET}:btc-1-ordinals`,
    ]);
  });

  it("a network request on a WalletConnect session key names the peer's origin", async () => {
    const r = rig();
    await r.connections.init();
    const origin = peer();
    await r.connections.establishWalletConnect({ [MAINNET]: SCOPE }, settle(origin));
    const waiting = r.connections.request(origin.origin, {
      kind: "network",
      namespace: "eip155",
      network: "eip155:11155111",
    });
    const [entry] = r.connections.pending();
    expect(entry?.origin).toStrictEqual(origin);
    r.connections.rejectConnection(idOf(entry));
    await expect(waiting).rejects.toMatchObject({ code: 4001 });
  });
});

describe("previewAccounts", () => {
  it("returns the group's bound addresses for each chain family and persists nothing", async () => {
    const r = rig();
    await r.connections.init();
    const evm = await r.connections.previewAccounts(MAINNET);
    expect(evm).toStrictEqual({ group: GROUP, addresses: ["0xevm0"] });
    const sol = await r.connections.previewAccounts(SOL_NET);
    expect(sol?.addresses).toStrictEqual(["sol-0"]);
    const btc = await r.connections.previewAccounts(BTC_NET);
    expect(btc?.addresses).toStrictEqual(["btc-0-payment", "btc-0-ordinals"]);
    expect(r.connections.getState().sessions).toStrictEqual({});
  });

  it("is undefined when no group is selected or derivation fails", async () => {
    const r = rig({ noGroup: true });
    await r.connections.init();
    await expect(r.connections.previewAccounts(MAINNET)).resolves.toBeUndefined();
    const f = rig({ failEvm: true });
    await f.connections.init();
    await expect(f.connections.previewAccounts(MAINNET)).resolves.toBeUndefined();
  });
});
