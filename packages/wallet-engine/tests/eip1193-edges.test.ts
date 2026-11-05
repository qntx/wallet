import { describe, expect, it, vi } from "vite-plus/test";

import { WalletError } from "@qntx/wallet";
import { ChainError } from "@qntx/wallet-chains";

import { Eip1193Handler } from "../src/connect/eip1193.ts";
import { ProviderError } from "../src/connect/errors.ts";
import {
  BlindSigningDisabledError,
  OriginBusyError,
  RequestEndedError,
} from "../src/requests/controller.ts";

const SITE = "https://app.example";
const MAINNET = "eip155:1";
const SEPOLIA = "eip155:11155111";
const ADDR = "0x1111111111111111111111111111111111111111";

type Session = {
  origin: { kind: "browser"; origin: string };
  currentNetwork: string;
  scopes: Record<string, { accounts: string[]; methods: string[] }>;
};

const session = (network = MAINNET, accounts = [ADDR], origin = SITE): Session => ({
  origin: { kind: "browser", origin },
  currentNetwork: network,
  scopes: { [network]: { accounts: accounts.map((a) => `${network}:${a}`), methods: [] } },
});

type Sessions = Record<string, Session>;

function rig(
  options: {
    session?: Session | undefined;
    group?: { walletId: string; groupIndex: number } | undefined;
    outcome?: () => Promise<unknown>;
    prepare?: () => Promise<unknown>;
  } = {},
) {
  let state: { sessions: Sessions; pending: object } = {
    sessions:
      options.session === undefined ? {} : { [options.session.origin.origin]: options.session },
    pending: {},
  };
  const subscribers = new Set<(s: typeof state) => void>();
  const prepared: unknown[] = [];
  const calls = { request: [] as unknown[], switched: [] as string[], touch: 0, revoked: 0 };
  const transport = vi.fn(async () => Promise.resolve("0x10"));
  const connections = {
    checkOrigin: () => ({ kind: "browser", origin: SITE }),
    accounts: (origin: string) =>
      Object.values(state.sessions)
        .filter((s) => s.origin.origin === origin)
        .flatMap((s) => s.scopes[s.currentNetwork]?.accounts ?? [])
        .map((a) => a.slice(a.lastIndexOf(":") + 1)),
    session: (origin: string) =>
      Object.values(state.sessions).find((s) => s.origin.origin === origin),
    request: async (_origin: string, request: unknown) => {
      await Promise.resolve();
      calls.request.push(request);
      return {} as never;
    },
    touch: async () => {
      await Promise.resolve();
      calls.touch += 1;
    },
    revoke: async () => {
      await Promise.resolve();
      calls.revoked += 1;
    },
    isEnabled: (network: string) => network === MAINNET || network === SEPOLIA,
    setCurrentNetwork: async (_origin: string, network: string) => {
      await Promise.resolve();
      calls.switched.push(network);
    },
    authorize: (_origin: string, network: string) => {
      const [s] = Object.values(state.sessions);
      if (s === undefined || s.scopes[network] === undefined) {
        throw new ProviderError(4100, "not authorized");
      }
      return s;
    },
    activeGroup: () => options.group,
    getState: () => state,
    store: {
      subscribe: (listener: (s: typeof state) => void) => {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      },
    },
  };
  const handler = new Eip1193Handler({
    connections: connections as never,
    requests: {
      prepare: async (input: unknown) => {
        prepared.push(input);
        return options.prepare === undefined ? { id: "req" } : options.prepare();
      },
      outcome: options.outcome ?? (async () => Promise.resolve({ hash: "0xabc" })),
    } as never,
    networks: { client: () => ({ transport: { request: transport } }) } as never,
    defaultNetwork: () => MAINNET,
    isTracked: () => false,
  });
  const set = (sessions: Sessions): void => {
    state = { ...state, sessions };
    for (const s of subscribers) {
      s(state);
    }
  };
  return { handler, calls, prepared, transport, set };
}

const GROUP = { walletId: "w", groupIndex: 0 };
const run = async (r: ReturnType<typeof rig>, method: string, params?: unknown): Promise<unknown> =>
  r.handler.handle(SITE, { method, params });
const codeOf = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => "resolved",
    (error: unknown) => (error instanceof ProviderError ? error.code : String(error)),
  );

describe("Eip1193Handler params and quantities", () => {
  it("rejects non-array params with -32602", async () => {
    await expect(codeOf(run(rig(), "eth_accounts", "x"))).resolves.toBe(-32_602);
  });

  it("answers eth_requestAccounts without asking when already connected, and wallet_requestPermissions", async () => {
    const r = rig({ session: session() });
    await expect(run(r, "eth_requestAccounts")).resolves.toStrictEqual([ADDR]);
    expect(r.calls.request).toHaveLength(0);
    await expect(
      run(r, "wallet_requestPermissions", [{ eth_accounts: {} }]),
    ).resolves.toMatchObject([{ parentCapability: "eth_accounts", invoker: SITE }]);
    const empty = rig();
    await expect(run(empty, "wallet_getPermissions")).resolves.toStrictEqual([]);
    await run(empty, "eth_requestAccounts");
    expect(empty.calls.request).toStrictEqual([{ kind: "connect" }]);
  });

  it("revokes through wallet_revokePermissions", async () => {
    const r = rig({ session: session() });
    await expect(run(r, "wallet_revokePermissions", [{ eth_accounts: {} }])).resolves.toBeNull();
    expect(r.calls.revoked).toBe(1);
  });
});

describe("Eip1193Handler personal_sign and typed data", () => {
  it("rejects a non-string message and maps a blind-signing refusal to 4200", async () => {
    const r = rig({ session: session(), group: GROUP });
    await expect(codeOf(run(r, "personal_sign", [5, ADDR]))).resolves.toBe(-32_602);
    const refused = rig({
      session: session(),
      group: GROUP,
      prepare: async () => Promise.reject(new BlindSigningDisabledError()),
    });
    await expect(codeOf(run(refused, "personal_sign", ["0xff", ADDR]))).resolves.toBe(4200);
  });

  it("signs hex or plain text for the default or a named account, and refuses another", async () => {
    const r = rig({
      session: session(),
      group: GROUP,
      outcome: async () => Promise.resolve({ signature: new Uint8Array([1, 2]) }),
    });
    await expect(run(r, "personal_sign", ["0x68656c6c6f"])).resolves.toBe("0x0102");
    await expect(
      run(r, "personal_sign", ["hello", ADDR.toUpperCase().replace("0X", "0x")]),
    ).resolves.toBe("0x0102");
    await expect(codeOf(run(r, "personal_sign", ["hello", `0x${"22".repeat(20)}`]))).resolves.toBe(
      4100,
    );
  });

  it("stringifies object typed data and keeps string typed data", async () => {
    const r = rig({
      session: session(),
      group: GROUP,
      outcome: async () => Promise.resolve({ signature: new Uint8Array([3]) }),
    });
    await run(r, "eth_signTypedData_v4", [ADDR, { a: 1 }]);
    await run(r, "eth_signTypedData_v4", [ADDR, '{"b":2}']);
    const kinds = r.prepared.map(
      (p) => (p as { request: { typedData: string } }).request.typedData,
    );
    expect(kinds).toStrictEqual(['{"a":1}', '{"b":2}']);
  });

  it("fails without an active group", async () => {
    const r = rig({ session: session() });
    await expect(codeOf(run(r, "personal_sign", ["hi", ADDR]))).resolves.toBe(-32_603);
  });
});

describe("Eip1193Handler eth_sendTransaction", () => {
  const tx = (extra: Record<string, unknown> = {}) => [{ from: ADDR, to: ADDR, ...extra }];

  it("validates the transaction object", async () => {
    const r = rig({ session: session(), group: GROUP });
    await expect(codeOf(run(r, "eth_sendTransaction", ["x"]))).resolves.toBe(-32_602);
    await expect(codeOf(run(r, "eth_sendTransaction", tx({ chainId: 5 })))).resolves.toBe(-32_602);
    await expect(codeOf(run(r, "eth_sendTransaction", tx({ data: 5 })))).resolves.toBe(-32_602);
    await expect(codeOf(run(r, "eth_sendTransaction", tx({ to: 5 })))).resolves.toBe(-32_602);
    await expect(codeOf(run(r, "eth_sendTransaction", tx({ value: "12" })))).resolves.toBe(-32_602);
  });

  it("accepts input as data, no recipient, and returns the hash", async () => {
    const r = rig({ session: session(), group: GROUP });
    await expect(
      run(r, "eth_sendTransaction", [{ from: ADDR, input: "0x01", chainId: 1, value: "0x5" }]),
    ).resolves.toBe("0xabc");
    const sent = r.prepared[0] as { request: { tx: Record<string, unknown> } };
    expect(sent.request.tx).toMatchObject({ data: "0x01", value: "0x5" });
    expect(sent.request.tx).not.toHaveProperty("to");
  });

  it("fails when the session network is not an EVM network and when no hash comes back", async () => {
    const solana = rig({ session: session("solana:abc"), group: GROUP });
    await expect(codeOf(run(solana, "eth_sendTransaction", tx()))).resolves.toBe(-32_603);
    const noHash = rig({
      session: session(),
      group: GROUP,
      outcome: async () => Promise.resolve({}),
    });
    await expect(codeOf(run(noHash, "eth_sendTransaction", tx()))).resolves.toBe(-32_603);
  });
});

describe("Eip1193Handler chain switching and reads", () => {
  it("validates the chainId, needs a session, and no-ops on the current network", async () => {
    const none = rig();
    await expect(codeOf(run(none, "wallet_switchEthereumChain", [{ chainId: 1 }]))).resolves.toBe(
      -32_602,
    );
    await expect(
      codeOf(run(none, "wallet_switchEthereumChain", [{ chainId: "0x1" }])),
    ).resolves.toBe(4100);
    const r = rig({ session: session() });
    await expect(run(r, "wallet_switchEthereumChain", [{ chainId: "0x1" }])).resolves.toBeNull();
    expect(r.calls.switched).toStrictEqual([]);
  });

  it("forwards read-only RPC through the network client and maps its failures", async () => {
    const r = rig({ session: session() });
    await expect(run(r, "eth_blockNumber", [])).resolves.toBe("0x10");
    expect(r.transport).toHaveBeenCalledWith({ method: "eth_blockNumber", params: [] });
    r.transport.mockRejectedValueOnce(new Error("node down"));
    await expect(codeOf(run(r, "eth_blockNumber", []))).resolves.toBe(-32_603);
    await expect(codeOf(run(r, "net_peerCount", []))).resolves.toBe(-32_601);
  });
});

describe("Eip1193Handler error conversion", () => {
  const converted = async (error: unknown): Promise<{ code: number; message: string }> => {
    const r = rig({
      session: session(),
      group: GROUP,
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the case under test
      prepare: async () => Promise.reject(error),
    });
    return r.handler.handle(SITE, { method: "personal_sign", params: ["hi", ADDR] }).then(
      () => ({ code: 0, message: "resolved" }),
      (error: unknown) => ({
        code: (error as ProviderError).code,
        message: (error as Error).message,
      }),
    );
  };

  it.each([
    ["a ProviderError", new ProviderError(4001, "no"), 4001],
    ["an origin already busy", new OriginBusyError(SITE), 4001],
    ["a rejected request", new RequestEndedError("rejected", undefined), 4001],
    ["an expired request", new RequestEndedError("expired", undefined), 4001],
    ["an invalidated request", new RequestEndedError("invalidated", undefined), 4001],
    ["a failed request", new RequestEndedError("failed", "boom"), -32_603],
    ["a chain error", new ChainError("invalid-request", "bad"), -32_602],
    ["a wallet error", new WalletError("invalid-input", "locked"), -32_603],
    ["an unknown error", new Error("odd"), -32_603],
  ])("maps %s", async (_name, error, code) => {
    await expect(converted(error)).resolves.toMatchObject({ code });
  });

  it("maps a thrown non-Error value to an internal error with its text", async () => {
    await expect(converted("plain text")).resolves.toStrictEqual({
      code: -32_603,
      message: "plain text",
    });
  });
});

describe("Eip1193Handler events", () => {
  it("emits connect, accountsChanged, chainChanged and disconnect from session changes", () => {
    const r = rig();
    const events: unknown[] = [];
    const off = r.handler.subscribe((e) => events.push(e));
    r.set({ a: session() });
    r.set({ a: session(SEPOLIA, [ADDR]) });
    r.set({ a: session(SEPOLIA, [`0x${"22".repeat(20)}`]) });
    r.set({});
    expect(events.map((e) => (e as { name: string }).name)).toStrictEqual([
      "connect",
      "accountsChanged",
      "chainChanged",
      "accountsChanged",
      "disconnect",
    ]);
    off();
    r.set({ a: session() });
    expect(events).toHaveLength(5);
  });

  it("does not emit accountsChanged for a session without accounts, and shares one subscription", () => {
    const r = rig();
    const first: unknown[] = [];
    const second: unknown[] = [];
    const offFirst = r.handler.subscribe((e) => first.push(e));
    const offSecond = r.handler.subscribe((e) => second.push(e));
    r.set({ a: session(MAINNET, []) });
    expect(first.map((e) => (e as { name: string }).name)).toStrictEqual(["connect"]);
    expect(second).toHaveLength(1);
    offFirst();
    r.set({});
    expect(second.map((e) => (e as { name: string }).name)).toStrictEqual([
      "connect",
      "disconnect",
    ]);
    offSecond();
  });
});
