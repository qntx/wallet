import { readFileSync } from "node:fs";

import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, test, vi } from "vite-plus/test";

import { TronBroadcastError } from "../src/chains/tron.ts";
import {
  ConnectionController,
  TRON_METHODS,
  TRON_NOTIFICATIONS,
} from "../src/connect/controller.ts";
import type { ConnectionSession } from "../src/connect/controller.ts";
import { ProviderError } from "../src/connect/errors.ts";
import { installTron } from "../src/connect/inject/tron.ts";
import type { TronInstallContext } from "../src/connect/inject/tron.ts";
import type { TronProviderState } from "../src/connect/tron.ts";
import { TronWalletHandler } from "../src/connect/tron.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { BroadcastRefusedError } from "../src/transactions/broadcast.ts";

const ORIGIN = "https://sun.io";
const TRON_NET = "tron:728126428";
const TRON_NILE = "tron:3448148188";
const TRON_CHAIN_ID = "0x2b6653dc";
const WALLET = { walletId: "wallet-1", groupIndex: 0 };
const TRON_ADDR = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_ADDR_HEX = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";
const GENESIS = "00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc";

const SUNIO = JSON.parse(
  readFileSync(new URL("fixtures/tron-sunio-swap.json", import.meta.url), "utf8"),
) as {
  raw_data: Record<string, unknown>;
  raw_data_hex: string;
  txID: string;
  visible: boolean;
};

const tronSession = (network: string = TRON_NET): ConnectionSession => ({
  id: "session-1",
  origin: { kind: "browser", origin: ORIGIN },
  scopes: {
    [TRON_NET]: {
      accounts: [`${TRON_NET}:${TRON_ADDR}`],
      methods: TRON_METHODS,
      notifications: TRON_NOTIFICATIONS,
    },
    [TRON_NILE]: {
      accounts: [`${TRON_NILE}:${TRON_ADDR}`],
      methods: TRON_METHODS,
      notifications: TRON_NOTIFICATIONS,
    },
  },
  currentNetwork: network,
  tronNetwork: network,
  group: WALLET,
  createdAt: 1,
  lastUsedAt: 1,
});

const fakeConnections = (session: ConnectionSession | undefined) => {
  const sessions: Record<string, ConnectionSession> =
    session === undefined ? {} : { [session.id]: session };
  const storeListeners = new Set<
    (state: { sessions: typeof sessions; pending: Record<string, never> }) => void
  >();
  const calls = { setTronNetwork: [] as string[], requested: [] as unknown[] };
  const state = { sessions, pending: {} as Record<string, never> };
  return {
    calls,
    storeListeners,
    notify: (next: Record<string, ConnectionSession>) => {
      state.sessions = next;
      for (const listener of storeListeners) {
        listener(state);
      }
    },
    connections: {
      checkOrigin: (origin: string) => ({ kind: "browser" as const, origin }),
      session: (origin: string) =>
        Object.values(state.sessions).find((s) => s.origin.origin === origin),
      authorize: (origin: string, network: string, method: string) => {
        const s = Object.values(state.sessions).find((x) => x.origin.origin === origin);
        const scope = s?.scopes[network];
        if (s === undefined || scope === undefined || !scope.methods.includes(method)) {
          throw new ProviderError(4100, "not authorized");
        }
        return s;
      },
      sessionAccounts: (origin: string, network: string) => {
        const s = Object.values(state.sessions).find((x) => x.origin.origin === origin);
        const scope = s?.scopes[network];
        if (s?.group === undefined || scope === undefined || scope.accounts.length === 0) {
          return undefined;
        }
        return {
          group: s.group,
          addresses: scope.accounts.map((a) => a.slice(a.lastIndexOf(":") + 1)),
        };
      },
      setTronNetwork: async (origin: string, network: string) => {
        const s = Object.values(state.sessions).find((x) => x.origin.origin === origin);
        if (s === undefined || s.scopes[network] === undefined) {
          throw new ProviderError(4100, "not authorized");
        }
        calls.setTronNetwork.push(network);
        await Promise.resolve();
      },
      request: async (_origin: string, req: unknown) => {
        calls.requested.push(req);
        await Promise.resolve();
        return session!;
      },
      touch: async () => Promise.resolve(),
      revoke: async () => Promise.resolve(),
      getState: () => state,
      store: {
        subscribe: (listener: (s: typeof state) => void) => {
          storeListeners.add(listener);
          return () => {
            storeListeners.delete(listener);
          };
        },
      },
    } as unknown as ConstructorParameters<typeof TronWalletHandler>[0]["connections"],
  };
};

const rig = (session: ConnectionSession | null = tronSession()) => {
  const fake = fakeConnections(session ?? undefined);
  const prepared: unknown[] = [];
  const submitted: Array<{ network: string; rawData: Uint8Array; signature: Uint8Array }> = [];
  let outcome: unknown = { family: "tron", tron: { dappSignature: "ab".repeat(65) } };
  let submitError: unknown;
  const handler = new TronWalletHandler({
    connections: fake.connections,
    requests: {
      prepare: async (input: unknown) => {
        prepared.push(input);
        await Promise.resolve();
        return { id: "req-1" };
      },
      outcome: async () => {
        await Promise.resolve();
        return outcome;
      },
    } as unknown as ConstructorParameters<typeof TronWalletHandler>[0]["requests"],
    transactions: {
      submitDappTron: async (network: string, rawData: Uint8Array, signature: Uint8Array) => {
        submitted.push({ network, rawData, signature });
        await Promise.resolve();
        if (submitError !== undefined) {
          throw submitError;
        }
        return { id: "tx-1" };
      },
    } as unknown as ConstructorParameters<typeof TronWalletHandler>[0]["transactions"],
    tronNetworks: () => [TRON_NET, TRON_NILE],
    tronNetwork: () => TRON_NET,
    isTracked: (network, address) => network === TRON_NET && address === TRON_ADDR,
  });
  return {
    handler,
    fake,
    prepared,
    submitted,
    setOutcome: (value: unknown) => {
      outcome = value;
    },
    setSubmitError: (error: unknown) => {
      submitError = error;
    },
  };
};

const providerError = async (p: Promise<unknown>): Promise<{ code: number; message: string }> => {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return { code: (error as ProviderError).code, message: (error as ProviderError).message };
  }
  throw new Error("expected the call to reject");
};

describe("TronWalletHandler", () => {
  test("tron_getProviderState is disconnected without a session", async () => {
    const { handler } = rig(null);
    const state = (await handler.handle(ORIGIN, {
      method: "tron_getProviderState",
    })) as TronProviderState;
    expect(state.address).toBe(false);
    expect(state.chainId).toBe(TRON_CHAIN_ID);
    expect(state.genesis).toBe(GENESIS);
  });

  test("tron_getProviderState reports the session address and network", async () => {
    const { handler } = rig();
    const state = (await handler.handle(ORIGIN, {
      method: "tron_getProviderState",
    })) as TronProviderState;
    expect(state.address).toStrictEqual({ base58: TRON_ADDR, hex: TRON_ADDR_HEX });
    expect(state.chainId).toBe(TRON_CHAIN_ID);
  });

  test("eth_requestAccounts returns the bound address when connected", async () => {
    const { handler, fake } = rig();
    await expect(handler.handle(ORIGIN, { method: "eth_requestAccounts" })).resolves.toStrictEqual([
      TRON_ADDR,
    ]);
    expect(fake.calls.requested).toHaveLength(0);
  });

  test("eth_requestAccounts connects when there is no session", async () => {
    const { fake } = rig(null);
    fake.calls.requested.length = 0;
    // After request() resolves the session still does not exist in the fake: simulate the grant.
    const sessionless = fakeConnections(undefined);
    const r2 = rig(null);
    // request resolves but no session appears -> 4100 like Solana
    await expect(
      providerError(
        new TronWalletHandler({
          connections: sessionless.connections,
          requests: r2.handler.options.requests,
          transactions: r2.handler.options.transactions,
          tronNetworks: () => [TRON_NET],
          tronNetwork: () => TRON_NET,
          isTracked: () => false,
        }).handle(ORIGIN, { method: "eth_requestAccounts" }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: 4100 }));
    expect(sessionless.calls.requested).toStrictEqual([{ kind: "connect", namespace: "tron" }]);
  });

  test("tron_requestAccounts resolves the legacy codes", async () => {
    const connected = rig();
    await expect(
      connected.handler.handle(ORIGIN, { method: "tron_requestAccounts" }),
    ).resolves.toStrictEqual(expect.objectContaining({ code: 200 }));

    const rejected = fakeConnections(undefined);
    rejected.connections.request = async () => {
      await Promise.resolve();
      throw new ProviderError(4001, "user rejected the request");
    };
    const r = rig();
    const legacy = new TronWalletHandler({
      connections: rejected.connections,
      requests: r.handler.options.requests,
      transactions: r.handler.options.transactions,
      tronNetworks: () => [TRON_NET],
      tronNetwork: () => TRON_NET,
      isTracked: () => false,
    });
    await expect(legacy.handle(ORIGIN, { method: "tron_requestAccounts" })).resolves.toStrictEqual(
      expect.objectContaining({ code: 4001 }),
    );

    rejected.connections.request = async () => {
      await Promise.resolve();
      throw new ProviderError(-32002, "a connection request is already pending");
    };
    await expect(legacy.handle(ORIGIN, { method: "tron_requestAccounts" })).resolves.toStrictEqual(
      expect.objectContaining({ code: 4000 }),
    );

    rejected.connections.request = async () => {
      await Promise.resolve();
      throw new Error("boom");
    };
    await expect(legacy.handle(ORIGIN, { method: "tron_requestAccounts" })).resolves.toStrictEqual(
      expect.objectContaining({ code: 4000 }),
    );
  });

  test("wallet_switchEthereumChain validates the chain and switches", async () => {
    const { handler, fake } = rig();
    await expect(
      providerError(handler.handle(ORIGIN, { method: "wallet_switchEthereumChain", params: [] })),
    ).resolves.toStrictEqual(expect.objectContaining({ code: -32602 }));
    await expect(
      providerError(
        handler.handle(ORIGIN, {
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0xdeadbeef" }],
        }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: 4902 }));
    await expect(
      handler.handle(ORIGIN, {
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0xCD8690DC" }],
      }),
    ).resolves.toBeNull();
    expect(fake.calls.setTronNetwork).toStrictEqual([TRON_NILE]);
  });

  test("wallet_switchEthereumChain without a session is 4100", async () => {
    const { handler } = rig(null);
    await expect(
      providerError(
        handler.handle(ORIGIN, {
          method: "wallet_switchEthereumChain",
          params: [{ chainId: TRON_CHAIN_ID }],
        }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: 4100 }));
  });

  test("wallet_watchAsset accepts trc20 only", async () => {
    const { handler, prepared } = rig();
    await expect(
      providerError(
        handler.handle(ORIGIN, { method: "wallet_watchAsset", params: { type: "trc10" } }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: 4200 }));
    await expect(
      providerError(
        handler.handle(ORIGIN, { method: "wallet_watchAsset", params: { type: "trc721" } }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: 4200 }));
    await expect(
      providerError(handler.handle(ORIGIN, { method: "wallet_watchAsset", params: {} })),
    ).resolves.toStrictEqual(expect.objectContaining({ code: -32602 }));
    await expect(
      handler.handle(ORIGIN, {
        method: "wallet_watchAsset",
        params: { type: "trc20", options: { address: TRON_ADDR } },
      }),
    ).resolves.toBeUndefined();
    // already tracked — no request was prepared
    expect(prepared).toHaveLength(0);
    await expect(
      handler.handle(ORIGIN, {
        method: "wallet_watchAsset",
        params: { type: "trc20", options: { address: "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs" } },
      }),
    ).resolves.toBeUndefined();
    expect(prepared).toHaveLength(1);
    expect((prepared[0] as { method: string }).method).toBe("watch-asset");
  });

  test("tron_signTransaction returns the transaction plus the dapp signature", async () => {
    const { handler, prepared } = rig();
    const transaction = { ...SUNIO };
    const signed = (await handler.handle(ORIGIN, {
      method: "tron_signTransaction",
      params: { transaction },
    })) as { signature: string[]; txID: string };
    expect(signed.signature).toStrictEqual(["ab".repeat(65)]);
    expect(signed.txID).toBe(SUNIO.txID);
    const input = prepared[0] as { method: string; request: { kind: string; rawData: Uint8Array } };
    expect(input.method).toBe("tron-sign");
    expect(input.request.kind).toBe("tron.transaction");
    expect(bytesToHex(input.request.rawData)).toBe(SUNIO.raw_data_hex);
  });

  test("tron_signTransaction refusals", async () => {
    const { handler } = rig();
    const base = { ...SUNIO };
    await expect(
      providerError(handler.handle(ORIGIN, { method: "tron_signTransaction", params: {} })),
    ).resolves.toStrictEqual(expect.objectContaining({ code: -32602 }));
    await expect(
      providerError(
        handler.handle(ORIGIN, {
          method: "tron_signTransaction",
          params: { transaction: { ...base, signature: ["00"] } },
        }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: -32602 }));
    await expect(
      providerError(
        handler.handle(ORIGIN, {
          method: "tron_signTransaction",
          params: { transaction: { ...base, raw_data_hex: "xyz" } },
        }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: -32602 }));
    await expect(
      providerError(
        handler.handle(ORIGIN, {
          method: "tron_signTransaction",
          params: { transaction: { ...base, txID: "00ff" } },
        }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: -32602 }));
    await expect(
      providerError(
        handler.handle(ORIGIN, {
          method: "tron_signTransaction",
          params: { transaction: { ...base, txID: "ff".repeat(32) } },
        }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: -32602 }));
    await expect(
      providerError(
        handler.handle(ORIGIN, {
          method: "tron_signTransaction",
          params: { transaction: { ...base, visible: "false" } },
        }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: -32602 }));
    await expect(
      providerError(
        handler.handle(ORIGIN, {
          method: "tron_signTransaction",
          params: {
            transaction: { ...base, raw_data: { ...base.raw_data, expiration: 1 } },
          },
        }),
      ),
    ).resolves.toStrictEqual(
      expect.objectContaining({ code: -32602, message: "raw_data does not match raw_data_hex" }),
    );
  });

  test("tron_sendRawTransaction submits the wallet-signed transaction", async () => {
    const { handler, submitted } = rig();
    const signature = "cd".repeat(65);
    const transaction = { ...SUNIO, signature: [signature] };
    await expect(
      handler.handle(ORIGIN, {
        method: "tron_sendRawTransaction",
        params: { transaction },
      }),
    ).resolves.toStrictEqual({ result: true, txid: SUNIO.txID, transaction });
    expect(submitted).toHaveLength(1);
    expect(bytesToHex(submitted[0]!.signature)).toBe(signature);
  });

  test("tron_sendRawTransaction refusals", async () => {
    const { handler } = rig();
    const signature = "cd".repeat(65);
    await expect(
      providerError(
        handler.handle(ORIGIN, {
          method: "tron_sendRawTransaction",
          params: { transaction: { ...SUNIO } },
        }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: -32602 }));
    await expect(
      providerError(
        handler.handle(ORIGIN, {
          method: "tron_sendRawTransaction",
          params: { transaction: { ...SUNIO, signature: [signature, signature] } },
        }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: -32602 }));
    await expect(
      providerError(
        handler.handle(ORIGIN, {
          method: "tron_sendRawTransaction",
          params: { transaction: { ...SUNIO, signature: ["00"] } },
        }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: -32602 }));
  });

  test("tron_sendRawTransaction maps a broadcast refusal to result:false with the node code", async () => {
    const { handler, setSubmitError } = rig();
    setSubmitError(new BroadcastRefusedError(new TronBroadcastError("SIGERROR", "bad sig")));
    const transaction = { ...SUNIO, signature: ["cd".repeat(65)] };
    await expect(
      handler.handle(ORIGIN, {
        method: "tron_sendRawTransaction",
        params: { transaction },
      }),
    ).resolves.toStrictEqual({
      result: false,
      code: "SIGERROR",
      message: "bad sig",
      txid: SUNIO.txID,
      transaction,
    });
  });

  test("tron_sendRawTransaction maps 'not signed by this wallet' to invalidParams", async () => {
    const { handler, setSubmitError } = rig();
    const { ChainError } = await import("@qntx/wallet-chains");
    setSubmitError(
      new ChainError("invalid-request", "this transaction was not signed by this wallet"),
    );
    await expect(
      providerError(
        handler.handle(ORIGIN, {
          method: "tron_sendRawTransaction",
          params: { transaction: { ...SUNIO, signature: ["cd".repeat(65)] } },
        }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: -32602 }));
  });

  test("tron_signMessageV2 signs bytes and returns 0x-hex", async () => {
    const { handler, prepared, setOutcome } = rig();
    setOutcome({ kind: "tron.message", signature: new Uint8Array(65).fill(7) });
    const signature = await handler.handle(ORIGIN, {
      method: "tron_signMessageV2",
      params: { message: new Uint8Array([104, 105]) },
    });
    expect(signature).toBe(`0x${"07".repeat(65)}`);
    const input = prepared[0] as { request: { kind: string; message: Uint8Array } };
    expect(input.request.kind).toBe("tron.message");
    expect(bytesToHex(input.request.message)).toBe("6869");
  });

  test("tron_signMessageV2 rejects a non-bytes message", async () => {
    const { handler } = rig();
    await expect(
      providerError(
        handler.handle(ORIGIN, { method: "tron_signMessageV2", params: { message: 42 } }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: -32602 }));
  });

  test("tron_signTypedData signs a valid document", async () => {
    const { handler, setOutcome } = rig();
    setOutcome({ kind: "tron.typed-data", signature: new Uint8Array(65).fill(9) });
    const signature = await handler.handle(ORIGIN, {
      method: "tron_signTypedData",
      params: {
        domain: { name: "D" },
        types: { Mail: [{ name: "text", type: "string" }] },
        message: { text: "hello" },
      },
    });
    expect(signature).toBe(`0x${"09".repeat(65)}`);
  });

  test("tron_signTypedData maps a malformed document to invalidParams", async () => {
    const { handler } = rig();
    await expect(
      providerError(
        handler.handle(ORIGIN, {
          method: "tron_signTypedData",
          params: { domain: { name: "D" }, types: {}, message: {} },
        }),
      ),
    ).resolves.toStrictEqual(expect.objectContaining({ code: -32602 }));
  });

  test("unknown methods are 4200", async () => {
    const { handler } = rig();
    await expect(
      providerError(handler.handle(ORIGIN, { method: "tron_universal" })),
    ).resolves.toStrictEqual(expect.objectContaining({ code: 4200 }));
  });

  test("a tronNetwork change emits tronStateChanged with the new state", () => {
    const { handler, fake } = rig();
    const events: TronProviderState[] = [];
    handler.subscribe((event) => {
      events.push(event.state);
    });
    const switched = tronSession(TRON_NILE);
    fake.notify({ [switched.id]: switched });
    expect(events).toHaveLength(1);
    expect(events[0]?.chainId).toBe(`0x${(3448148188).toString(16)}`);
  });
});

describe("ConnectionController tron namespace", () => {
  const connectionRig = async () => {
    const invalidated: string[] = [];
    const selectionListeners = new Set<() => void>();
    let selected: { walletId: string; groupIndex: number } | undefined = WALLET;
    const connections = new ConnectionController({
      phishing: { check: () => "clear" as const },
      setTimer: () => () => undefined,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      random: (n: number) => new Uint8Array(n).fill(5),
      now: () => 1000,
      logger: { warn: () => undefined },
      allowLocalhost: false,
      selectedGroup: () => selected,
      onSelectedGroup: (listener: () => void) => {
        selectionListeners.add(listener);
        return () => {
          selectionListeners.delete(listener);
        };
      },
      invalidateAll: () => undefined,
      evmAddress: async () => Promise.resolve("0x0000000000000000000000000000000000000001"),
      solanaAddress: async () => Promise.resolve("SoLaNaUnused"),
      tronAddress: async (group) =>
        Promise.resolve(group === WALLET ? TRON_ADDR : "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs"),
      bitcoinAddress: async () => Promise.resolve("bc1qunused"),
      enabledNetworks: () => [TRON_NET, TRON_NILE],
      nostrPubkey: async () => Promise.resolve("ab".repeat(32)),
      invalidate: (origin: string) => {
        invalidated.push(origin);
      },
    });
    await connections.init();
    const grant = async (): Promise<ConnectionSession> => {
      const pending = connections.request(ORIGIN, { kind: "connect", namespace: "tron" });
      const [entry] = connections.pending();
      const session = await connections.approveConnection(entry!.id, {
        accounts: [],
        network: TRON_NET,
      });
      await pending;
      return session;
    };
    return {
      connections,
      invalidated,
      grant,
      repoint: (group: { walletId: string; groupIndex: number } | undefined) => {
        selected = group;
        for (const listener of selectionListeners) {
          listener();
        }
      },
    };
  };

  test("a tron grant covers every enabled TRON network and sets tronNetwork", async () => {
    const { grant } = await connectionRig();
    const session = await grant();
    expect(session.tronNetwork).toBe(TRON_NET);
    expect(Object.keys(session.scopes).toSorted()).toStrictEqual([TRON_NILE, TRON_NET].toSorted());
    expect(session.scopes[TRON_NET]?.methods).toStrictEqual(TRON_METHODS);
    expect(session.scopes[TRON_NET]?.accounts).toStrictEqual([`${TRON_NET}:${TRON_ADDR}`]);
  });

  test("a tron grant on a non-TRON network is invalidParams", async () => {
    const { connections } = await connectionRig();
    void connections.request(ORIGIN, { kind: "connect", namespace: "tron" });
    const [entry] = connections.pending();
    await expect(
      connections.approveConnection(entry!.id, { accounts: [], network: "eip155:1" }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  test("setTronNetwork voids the origin's unfinished work", async () => {
    const { connections, invalidated, grant } = await connectionRig();
    await grant();
    invalidated.length = 0;
    await connections.setTronNetwork(ORIGIN, TRON_NILE);
    expect(invalidated).toStrictEqual([ORIGIN]);
  });

  test("a group switch re-points the tron scopes to the new group's address", async () => {
    const { connections, grant, repoint } = await connectionRig();
    await grant();
    repoint({ walletId: "wallet-2", groupIndex: 0 });
    await vi.waitFor(() => {
      expect(connections.session(ORIGIN)?.group?.walletId).toBe("wallet-2");
    });
    expect(connections.session(ORIGIN)?.scopes[TRON_NET]?.accounts).toStrictEqual([
      `${TRON_NET}:TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs`,
    ]);
  });

  test("isSession rejects a non-string tronNetwork", async () => {
    const { isSession } = await import("../src/connect/controller.ts");
    const session = { ...tronSession(), tronNetwork: 5 } as unknown;
    expect(isSession(session)).toBe(false);
    expect(isSession({ ...tronSession(), tronNetwork: undefined })).toBe(true);
  });

  test("setTronNetwork requires the scope and persists", async () => {
    const { connections, grant } = await connectionRig();
    await grant();
    await expect(connections.setTronNetwork(ORIGIN, "eip155:1")).rejects.toMatchObject({
      code: 4100,
    });
    await connections.setTronNetwork(ORIGIN, TRON_NILE);
    expect(connections.session(ORIGIN)?.tronNetwork).toBe(TRON_NILE);
  });
});

describe("inject tron surface", () => {
  const injectRig = () => {
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const sent: Array<{ name: string; payload: unknown }> = [];
    const requests: Array<{ provider: string; args: { method: string; params?: unknown } }> = [];
    const announced: unknown[] = [];
    const ctx: TronInstallContext = {
      request: async (provider, args) => {
        requests.push({ provider, args });
        await Promise.resolve();
        if (args.method === "tron_getProviderState") {
          return {
            address: { base58: TRON_ADDR, hex: TRON_ADDR_HEX },
            chainId: TRON_CHAIN_ID,
            genesis: GENESIS,
          };
        }
        return { ok: true };
      },
      on: (name, listener) => {
        const set = listeners.get(name) ?? new Set();
        set.add(listener);
        listeners.set(name, set);
      },
      removeListener: (name, listener) => {
        listeners.get(name)?.delete(listener);
      },
      emit: (name, payload) => {
        sent.push({ name, payload });
      },
      doc: "doc-uuid",
      info: { name: "Qntx", icon: "data:image/png;base64,AA==", rdns: "com.qntx" },
      global: {
        dispatchEvent: (event) => {
          announced.push(event);
          return true;
        },
        addEventListener: () => undefined,
        CustomEvent: class {
          readonly type: string;
          readonly detail: unknown;
          constructor(type: string, init: { detail: unknown }) {
            this.type = type;
            this.detail = init.detail;
          }
        } as unknown as new (name: string, init: { detail: unknown }) => Event,
      },
    };
    installTron(ctx);
    return { ctx, listeners, sent, requests, announced };
  };

  test("implements the surface and refuses everything else with 4200", () => {
    const { ctx } = injectRig();
    const { tronWeb } = ctx.global as unknown as { tronWeb: Record<string, unknown> };
    const trx = tronWeb["trx"] as Record<string, unknown>;
    expect(trx["sign"]).toBeTypeOf("function");
    expect(trx["signMessageV2"]).toBeTypeOf("function");
    expect(trx["sendRawTransaction"]).toBeTypeOf("function");
    expect(trx["getBlockByNumber"]).toBeTypeOf("function");
    expect(tronWeb["request"]).toBeTypeOf("function");
    // implemented members shadow the 4200 stub
    expect(trx["signMessageV2"]).toBeDefined();
    // unimplemented members refuse recursively
    const builder = tronWeb["transactionBuilder"] as Record<string, unknown>;
    expect(() => (builder["sendTrx"] as () => void)()).toThrow(/not supported/);
    let sendTrxError: unknown;
    try {
      (builder["sendTrx"] as () => void)();
    } catch (error) {
      sendTrxError = error;
    }
    expect((sendTrxError as { code?: number }).code).toBe(4200);
    // thenables, JSON and is* flags stay inert
    expect((trx as Record<string | symbol, unknown>)["then"]).toBeUndefined();
    expect((trx as Record<string | symbol, unknown>)["toJSON"]).toBeUndefined();
    expect(tronWeb["isTronLink"]).toBeUndefined();
  });

  test("state applies to defaultAddress, ready and events", async () => {
    const { ctx, sent } = injectRig();
    await Promise.resolve();
    await Promise.resolve();
    const { tronWeb } = ctx.global as unknown as {
      tronWeb: { defaultAddress: unknown; ready: boolean };
    };
    expect(tronWeb.defaultAddress).toStrictEqual({ base58: TRON_ADDR, hex: TRON_ADDR_HEX });
    const tronGlobal = (ctx.global as unknown as { tron: { tronWeb: unknown } }).tron;
    expect(tronGlobal.tronWeb).not.toBe(false);
    expect(sent.map((e) => e.name)).toContain("connect");
  });
});
