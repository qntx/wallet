import { describe, expect, it } from "vite-plus/test";

import { BitcoinWalletHandler, bitcoinStandardChain } from "../src/connect/bitcoin.ts";
import type { BitcoinEvent } from "../src/connect/bitcoin.ts";
import { invalidParams } from "../src/connect/errors.ts";

const SITE = "https://app.example.com";
const ORIGIN = { kind: "browser" as const, origin: SITE };
const NETWORK = "bip122:000000000019d6689c085ae165831e93";
const PAYMENT = "bc1qpayment";
const ORDINALS = "bc1pordinals";
const PAYMENT_KEY = new Uint8Array(33).fill(2);
const ORDINALS_KEY = new Uint8Array(32).fill(3);
const SIGNATURE = new Uint8Array([2, 71, 48, 68, 2, 32, 9, 9, 9]);
const SIGNATURE_BASE64 = `smp${Buffer.from(SIGNATURE).toString("base64")}`;

const rig = (options: { connected?: boolean; outcome?: unknown; network?: string } = {}) => {
  let connected = options.connected === true;
  let group = { walletId: "w1", groupIndex: 0 };
  const requestsCalls: unknown[] = [];
  const connectRequests: unknown[][] = [];
  const revoked: string[] = [];
  const sessionListeners: Array<(state: { sessions: unknown }) => void> = [];
  let sessions: Record<string, unknown> = {};
  const handler = new BitcoinWalletHandler({
    connections: {
      checkOrigin: () => ORIGIN,
      session: () => (connected ? ({} as never) : undefined),
      authorize: () => {
        if (!connected) {
          throw invalidParams("test unauthorized");
        }
        return {} as never;
      },
      bitcoinAccounts: () => (connected ? { payment: PAYMENT, ordinals: ORDINALS } : undefined),
      request: async (...args: unknown[]) => {
        await Promise.resolve();
        connectRequests.push(args);
        connected = true;
        return {} as never;
      },
      touch: async () => Promise.resolve(),
      revoke: async (origin: string) => {
        await Promise.resolve();
        revoked.push(origin);
      },
      getState: () => ({ sessions: sessions as never, pending: {} }),
      store: {
        subscribe: (listener: (state: { sessions: unknown }) => void) => {
          sessionListeners.push(listener);
          return () => undefined;
        },
      } as never,
    },
    requests: {
      prepare: async (input) => {
        await Promise.resolve();
        requestsCalls.push(input);
        return { id: "req-1" } as never;
      },
      outcome: async () => Promise.resolve(options.outcome as never),
    },
    bitcoinAccount: async (_group, _network, purpose) => {
      await Promise.resolve();
      return purpose === "payment"
        ? { address: PAYMENT, publicKey: PAYMENT_KEY }
        : { address: ORDINALS, publicKey: ORDINALS_KEY };
    },
    activeGroup: () => group,
    bitcoinNetwork: () => options.network ?? NETWORK,
  });
  return {
    handler,
    requestsCalls,
    connectRequests,
    revoked,
    switchGroup: (next: { walletId: string; groupIndex: number }) => {
      group = next;
    },
    setSessions: (next: Record<string, unknown>) => {
      sessions = next;
      for (const listener of sessionListeners) {
        listener({ sessions: next });
      }
    },
  };
};

const message = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("BitcoinWalletHandler", () => {
  it("maps the Wallet Standard chains to the registry networks", () => {
    expect(bitcoinStandardChain(NETWORK)).toBe("bitcoin:mainnet");
    expect(bitcoinStandardChain("bip122:00000000da84f2bafbbc53dee25a72ae")).toBe("bitcoin:testnet");
    expect(bitcoinStandardChain("bip122:0f9188f13cb7b2c71f2a335e3a4fc328")).toBeUndefined();
  });

  it("bitcoin:connect requests a bip122 connection and returns accounts in purposes order", async () => {
    const { handler, connectRequests } = rig();
    const result = await handler.handle(SITE, {
      method: "bitcoin:connect",
      params: { purposes: ["ordinals", "payment"] },
    });
    expect(connectRequests).toStrictEqual([[SITE, { kind: "connect", namespace: "bip122" }]]);
    const { accounts } = result as {
      accounts: Array<{ address: string; publicKey: Uint8Array; chains: string[] }>;
    };
    expect(accounts.map((a) => a.address)).toStrictEqual([ORDINALS, PAYMENT]);
    expect(accounts[0]?.publicKey).toStrictEqual(ORDINALS_KEY);
    expect(accounts[1]?.publicKey).toStrictEqual(PAYMENT_KEY);
    expect(accounts[0]?.chains).toStrictEqual(["bitcoin:mainnet"]);
  });

  it("an already connected origin is not asked again", async () => {
    const { handler, connectRequests } = rig({ connected: true });
    await handler.handle(SITE, { method: "bitcoin:connect", params: { purposes: ["payment"] } });
    expect(connectRequests).toHaveLength(0);
  });

  it("rejects an unknown or missing purpose before asking the user", async () => {
    const { handler, connectRequests } = rig();
    for (const params of [
      { purposes: ["stacks"] },
      { purposes: [] },
      { purposes: "payment" },
      {},
      undefined,
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time keeps failures readable
      await expect(
        handler.handle(SITE, { method: "bitcoin:connect", params }),
      ).rejects.toMatchObject({ code: -32_602 });
    }
    expect(connectRequests).toHaveLength(0);
  });

  it("standard:disconnect revokes the origin", async () => {
    const { handler, revoked } = rig({ connected: true });
    await expect(handler.handle(SITE, { method: "standard:disconnect" })).resolves.toStrictEqual(
      {},
    );
    expect(revoked).toStrictEqual([SITE]);
  });

  it("rejects an unsupported method", async () => {
    const { handler } = rig({ connected: true });
    await expect(
      handler.handle(SITE, { method: "bitcoin:signTransaction", params: {} }),
    ).rejects.toMatchObject({ code: -32_602 });
  });

  it("bitcoin:signMessage goes through bitcoin-sign and returns the witness bytes", async () => {
    const { handler, requestsCalls } = rig({
      connected: true,
      outcome: { kind: "bitcoin.message", signature: SIGNATURE_BASE64 },
    });
    const bytes = message("hello bitcoin");
    const result = await handler.handle(SITE, {
      method: "bitcoin:signMessage",
      params: { account: ORDINALS, message: bytes },
    });
    expect(requestsCalls).toStrictEqual([
      {
        method: "bitcoin-sign",
        origin: ORIGIN,
        account: { walletId: "w1", groupIndex: 0, address: ORDINALS, template: "btc.bip86" },
        network: NETWORK,
        request: { kind: "message", message: "hello bitcoin" },
      },
    ]);
    expect(result).toStrictEqual({ signedMessage: bytes, signature: SIGNATURE });
  });

  it("signs for the payment account with the bip84 template", async () => {
    const { handler, requestsCalls } = rig({
      connected: true,
      outcome: { kind: "bitcoin.message", signature: SIGNATURE_BASE64 },
    });
    await handler.handle(SITE, {
      method: "bitcoin:signMessage",
      params: { account: PAYMENT, message: { __bytes: "6869" } },
    });
    expect(requestsCalls[0]).toMatchObject({
      account: { address: PAYMENT, template: "btc.bip84" },
      request: { message: "hi" },
    });
  });

  it("rejects an account that is not the session's with 4100, and no session too", async () => {
    const connected = rig({ connected: true });
    await expect(
      connected.handler.handle(SITE, {
        method: "bitcoin:signMessage",
        params: { account: "bc1qother", message: message("x") },
      }),
    ).rejects.toMatchObject({ code: 4100 });
    expect(connected.requestsCalls).toHaveLength(0);
    const disconnected = rig();
    await expect(
      disconnected.handler.handle(SITE, {
        method: "bitcoin:signMessage",
        params: { account: PAYMENT, message: message("x") },
      }),
    ).rejects.toThrow("test unauthorized");
  });

  it("non-UTF-8 message bytes are 4200 with the blind-signing message", async () => {
    const { handler, requestsCalls } = rig({ connected: true });
    await expect(
      handler.handle(SITE, {
        method: "bitcoin:signMessage",
        params: { account: PAYMENT, message: new Uint8Array([0xff, 0xfe]) },
      }),
    ).rejects.toMatchObject({
      code: 4200,
      message: "blind signing is not enabled: the message is not UTF-8 text",
    });
    expect(requestsCalls).toHaveLength(0);
  });

  it("rejects malformed signMessage params", async () => {
    const { handler } = rig({ connected: true });
    for (const params of [
      { message: message("x") },
      { account: PAYMENT },
      { account: PAYMENT, message: "text" },
      { account: PAYMENT, message: { __bytes: "xyz" } },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time keeps failures readable
      await expect(
        handler.handle(SITE, { method: "bitcoin:signMessage", params }),
      ).rejects.toMatchObject({ code: -32_602 });
    }
  });

  it("an unrecognized signature encoding is an internal error", async () => {
    const { handler } = rig({
      connected: true,
      outcome: { kind: "bitcoin.message", signature: "AAAA" },
    });
    await expect(
      handler.handle(SITE, {
        method: "bitcoin:signMessage",
        params: { account: PAYMENT, message: message("x") },
      }),
    ).rejects.toMatchObject({ code: -32_603 });
  });

  it("an unexpected outcome is an internal error", async () => {
    const { handler } = rig({ connected: true, outcome: { kind: "solana.message" } });
    await expect(
      handler.handle(SITE, {
        method: "bitcoin:signMessage",
        params: { account: PAYMENT, message: message("x") },
      }),
    ).rejects.toMatchObject({ code: -32_603 });
  });

  it("emits both re-pointed accounts when the session's bitcoin accounts change", async () => {
    const { handler, setSessions } = rig();
    const events: BitcoinEvent[] = [];
    const off = handler.subscribe((event) => events.push(event));
    const session = (accounts: string[]) => ({
      s1: {
        id: "s1",
        origin: ORIGIN,
        scopes: { [NETWORK]: { accounts: accounts.map((a) => `${NETWORK}:${a}`) } },
      },
    });
    setSessions(session([PAYMENT, ORDINALS]));
    await new Promise((resolve) => setTimeout(resolve));
    setSessions(session(["bc1qnew", "bc1pnew"]));
    await new Promise((resolve) => setTimeout(resolve));
    off();
    expect(events.map((e) => e.name)).toStrictEqual([
      "bitcoinAccountsChanged",
      "bitcoinAccountsChanged",
    ]);
    expect(events[1]?.origin).toBe(SITE);
    expect(events[1]?.accounts.map((a) => a.address)).toStrictEqual([PAYMENT, ORDINALS]);
  });

  it("fails with 4100 when no account group is selected", async () => {
    const connect = rig({ connected: true });
    connect.switchGroup(undefined as never);
    await expect(
      connect.handler.handle(SITE, {
        method: "bitcoin:connect",
        params: { purposes: ["payment"] },
      }),
    ).rejects.toMatchObject({ code: 4100 });
    await expect(
      connect.handler.handle(SITE, {
        method: "bitcoin:signMessage",
        params: { account: PAYMENT, message: message("x") },
      }),
    ).rejects.toMatchObject({ code: 4100 });
  });

  it("a network without a Wallet Standard chain id is an internal error", async () => {
    const { handler } = rig({
      connected: true,
      network: "bip122:0f9188f13cb7b2c71f2a335e3a4fc328",
    });
    await expect(
      handler.handle(SITE, { method: "bitcoin:connect", params: { purposes: ["payment"] } }),
    ).rejects.toMatchObject({ code: -32_603 });
  });

  it("bitcoinAccountsChanged is empty without an active group", async () => {
    const { handler, switchGroup } = rig();
    await expect(handler.bitcoinAccountsChanged()).resolves.toHaveLength(2);
    switchGroup(undefined as never);
    await expect(handler.bitcoinAccountsChanged()).resolves.toStrictEqual([]);
  });
});
