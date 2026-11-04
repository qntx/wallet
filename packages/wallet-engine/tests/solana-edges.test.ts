import { describe, expect, it } from "vite-plus/test";

import { ProviderError } from "../src/connect/errors.ts";
import { SolanaWalletHandler } from "../src/connect/solana.ts";
import type { SolanaEvent } from "../src/connect/solana.ts";

const SITE = "https://app.example";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const ADDR = "SoLaNaBase58Address1111111111111111111";
const PUBKEY = new Uint8Array(32).fill(2);
const GROUP = { walletId: "w", groupIndex: 0 };

type SessionLike = {
  origin: { kind: "browser"; origin: string };
  scopes: Record<string, { accounts: string[] }>;
};
const solSession = (accounts = [ADDR], origin = SITE): SessionLike => ({
  origin: { kind: "browser", origin },
  scopes: { [NETWORK]: { accounts: accounts.map((a) => `${NETWORK}:${a}`) } },
});

function rig(
  options: {
    session?: boolean;
    group?: typeof GROUP | undefined;
    outcome?: unknown;
  } = {},
) {
  let state: { sessions: Record<string, SessionLike>; pending: object } = {
    sessions: {},
    pending: {},
  };
  const subscribers = new Set<(s: typeof state) => void>();
  let connected = options.session ?? true;
  const calls = { prepared: [] as unknown[], revoked: 0, requested: 0 };
  const handler = new SolanaWalletHandler({
    connections: {
      checkOrigin: () => ({ kind: "browser", origin: SITE }),
      session: () => (connected ? ({} as never) : undefined),
      authorize: () => {
        if (!connected) {
          throw new ProviderError(4100, "not authorized");
        }
        return {} as never;
      },
      solanaAccount: () => (connected ? ADDR : undefined),
      request: async () => {
        await Promise.resolve();
        calls.requested += 1;
        connected = true;
        return {} as never;
      },
      touch: async () => Promise.resolve(),
      revoke: async () => {
        await Promise.resolve();
        calls.revoked += 1;
      },
      getState: () => state as never,
      store: {
        subscribe: (listener: (s: typeof state) => void) => {
          subscribers.add(listener);
          return () => subscribers.delete(listener);
        },
      } as never,
    },
    requests: {
      prepare: async (input) => {
        await Promise.resolve();
        calls.prepared.push(input);
        return { id: "r" } as never;
      },
      outcome: async () => Promise.resolve(options.outcome as never),
    },
    solanaAccount: async () => Promise.resolve({ address: ADDR, publicKey: PUBKEY }),
    activeGroup: () => ("group" in options ? options.group : GROUP),
    solanaNetwork: () => NETWORK,
  });
  const set = (sessions: Record<string, SessionLike>): void => {
    state = { ...state, sessions };
    for (const s of subscribers) {
      s(state);
    }
  };
  return { handler, calls, set };
}

const call = async (
  r: ReturnType<typeof rig>,
  method: string,
  params?: unknown,
): Promise<unknown> => r.handler.handle(SITE, { method, params });
const codeOf = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => "resolved",
    (error: unknown) => (error instanceof ProviderError ? error.code : String(error)),
  );

describe("SolanaWalletHandler connect and disconnect", () => {
  it("disconnects and rejects unknown methods", async () => {
    const r = rig();
    await expect(call(r, "standard:disconnect")).resolves.toStrictEqual({});
    expect(r.calls.revoked).toBe(1);
    await expect(codeOf(call(r, "solana:nope"))).resolves.toBe(-32_602);
  });

  it("connects silently only when a session exists", async () => {
    const connected = rig();
    await expect(call(connected, "standard:connect", { silent: true })).resolves.toMatchObject({
      accounts: [{ address: ADDR }],
    });
    const none = rig({ session: false });
    await expect(codeOf(call(none, "standard:connect", { silent: true }))).resolves.toBe(4100);
    expect(none.calls.requested).toBe(0);
    await expect(call(none, "standard:connect", "ignored")).resolves.toMatchObject({
      accounts: [{ address: ADDR }],
    });
    expect(none.calls.requested).toBe(1);
  });

  it("fails to connect without an active group", async () => {
    await expect(codeOf(call(rig({ group: undefined }), "standard:connect"))).resolves.toBe(4100);
  });
});

describe("SolanaWalletHandler transaction inputs", () => {
  const signed = { kind: "solana.transactions", send: false, signedTransactions: [] };

  it("takes bytes, hex or a bytes envelope and rejects the rest", async () => {
    const r = rig({ outcome: signed });
    await call(r, "solana:signTransaction", {
      transactions: [new Uint8Array([1]), "0a0b", { __bytes: "0c" }],
    });
    const sent = r.calls.prepared[0] as { request: { transactions: Uint8Array[] } };
    expect(sent.request.transactions).toStrictEqual([
      new Uint8Array([1]),
      new Uint8Array([10, 11]),
      new Uint8Array([12]),
    ]);
    await expect(codeOf(call(r, "solana:signTransaction", {}))).resolves.toBe(-32_602);
    await expect(codeOf(call(r, "solana:signTransaction", "x"))).resolves.toBe(-32_602);
    await expect(codeOf(call(r, "solana:signTransaction", { transactions: [5] }))).resolves.toBe(
      -32_602,
    );
    await expect(
      codeOf(call(r, "solana:signTransaction", { transactions: [], chains: "x" })),
    ).resolves.toBe(-32_602);
  });

  it("fails on an unexpected outcome and without an active group", async () => {
    const odd = rig({ outcome: { kind: "other" } });
    await expect(
      codeOf(call(odd, "solana:signTransaction", { transactions: [new Uint8Array([1])] })),
    ).resolves.toBe(-32_603);
    const noGroup = rig({ group: undefined, outcome: signed });
    await expect(
      codeOf(call(noGroup, "solana:signTransaction", { transactions: [new Uint8Array([1])] })),
    ).resolves.toBe(4100);
  });

  it("returns an empty signature list for a send that reports none", async () => {
    const r = rig({ outcome: { kind: "solana.transactions", send: true } });
    await expect(
      call(r, "solana:signAndSendTransaction", {
        transactions: [new Uint8Array([1])],
        chains: ["solana:mainnet"],
      }),
    ).resolves.toStrictEqual({ signatures: [] });
  });
});

describe("SolanaWalletHandler messages", () => {
  const message = { kind: "solana.message", signature: new Uint8Array(64) };

  it("takes bytes, hex or an envelope and rejects the rest", async () => {
    const r = rig({ outcome: message });
    for (const raw of [new Uint8Array([65]), "41", { __bytes: "41" }]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time keeps failures readable
      await expect(call(r, "solana:signMessage", { message: raw })).resolves.toMatchObject({
        signedMessage: new Uint8Array([65]),
      });
    }
    await expect(codeOf(call(r, "solana:signMessage", { message: 5 }))).resolves.toBe(-32_602);
    await expect(codeOf(call(r, "solana:signMessage", "x"))).resolves.toBe(-32_602);
  });

  it("fails on an unexpected outcome or without a group", async () => {
    const odd = rig({ outcome: { kind: "other" } });
    await expect(
      codeOf(call(odd, "solana:signMessage", { message: new Uint8Array([65]) })),
    ).resolves.toBe(-32_603);
    const noGroup = rig({ group: undefined, outcome: message });
    await expect(
      codeOf(call(noGroup, "solana:signMessage", { message: new Uint8Array([65]) })),
    ).resolves.toBe(4100);
    await expect(codeOf(call(noGroup, "solana:signIn", {}))).resolves.toBe(4100);
  });

  it("signIn without params signs for the page", async () => {
    const r = rig({ outcome: message });
    await expect(call(r, "solana:signIn")).resolves.toHaveLength(1);
    await expect(call(r, "solana:signIn", "x")).resolves.toHaveLength(1);
  });
});

describe("SolanaWalletHandler events", () => {
  const collect = (r: ReturnType<typeof rig>) => {
    const events: SolanaEvent[] = [];
    const off = r.handler.subscribe((e) => events.push(e));
    return { events, off };
  };
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  };

  it("emits a change with the re-pointed account when a solana session appears or changes", async () => {
    const r = rig();
    const { events, off } = collect(r);
    r.set({ a: solSession() });
    await settle();
    r.set({ a: solSession([`${ADDR}2`]) });
    await settle();
    expect(events.map((e) => e.origin)).toStrictEqual([SITE, SITE]);
    expect(events[0]?.accounts).toMatchObject([{ address: ADDR, chains: ["solana:mainnet"] }]);
    off();
  });

  it("emits an empty-accounts change when the session is revoked", async () => {
    const r = rig();
    const { events, off } = collect(r);
    r.set({ a: solSession() });
    await settle();
    r.set({});
    await settle();
    expect(events).toHaveLength(2);
    off();
  });

  it("ignores sessions without solana accounts and unsubscribed listeners", async () => {
    const r = rig();
    const first = collect(r);
    const second = collect(r);
    r.set({ a: { origin: { kind: "browser", origin: SITE }, scopes: {} } });
    await settle();
    expect(first.events).toHaveLength(0);
    first.off();
    r.set({ b: solSession() });
    await settle();
    expect(first.events).toHaveLength(0);
    expect(second.events).toHaveLength(1);
    second.off();
  });

  it("answers an empty list for a change when no group is selected", async () => {
    const r = rig({ group: undefined });
    await expect(r.handler.solanaAccountsChanged(SITE)).resolves.toStrictEqual([]);
  });
});
