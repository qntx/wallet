import { describe, expect, it } from "vite-plus/test";

import { invalidParams } from "../src/connect/errors.ts";
import { SolanaWalletHandler } from "../src/connect/solana.ts";

const SITE = "https://app.example.com";
const ORIGIN = { kind: "browser" as const, origin: SITE };
const SOL_ADDR = "SoLaNaBase58Address1111111111111111111";
const TX = new Uint8Array([1, 2, 3, 4]);
const PUBKEY = new Uint8Array(32).fill(2);

const rig = (options: { session?: unknown; prepareResult?: unknown }) => {
  const { session } = options;
  const requestsCalls: unknown[] = [];
  const handler = new SolanaWalletHandler({
    connections: {
      checkOrigin: (_origin) => ORIGIN,
      session: () => session as never,
      authorize: () => {
        if (session === undefined) {
          throw invalidParams("test unauthorized");
        }
        return session as never;
      },
      solanaAccount: () => (session === undefined ? undefined : SOL_ADDR),
      request: async () => {
        await Promise.resolve();
        return {} as never;
      },
      touch: async () => Promise.resolve(),
      revoke: async () => Promise.resolve(),
      getState: () => ({ sessions: {}, pending: {} }),
      store: { subscribe: () => () => undefined } as never,
    },
    requests: {
      prepare: async (input) => {
        await Promise.resolve();
        requestsCalls.push(input);
        return { id: "req-1" } as never;
      },
      outcome: async () => Promise.resolve(options.prepareResult as never),
    },
    solanaAccount: async () => {
      await Promise.resolve();
      return { address: SOL_ADDR, publicKey: PUBKEY };
    },
    activeGroup: () => ({ walletId: "w1", groupIndex: 0 }),
    solanaNetwork: () => "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  });
  return { handler, requestsCalls };
};

describe("SolanaWalletHandler", () => {
  it("rejects unauthorized solana:signMessage before the pipeline", async () => {
    const { handler } = rig({});
    await expect(
      handler.handle(SITE, {
        method: "solana:signMessage",
        params: { message: new Uint8Array([1]) },
      }),
    ).rejects.toThrow("test unauthorized");
  });

  it("standard:connect requests a solana connection then returns the wallet account", async () => {
    const { handler } = rig({});
    const result = await handler.handle(SITE, { method: "standard:connect" });
    expect(result).toMatchObject({
      accounts: [{ address: SOL_ADDR, chains: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"] }],
    });
    expect(
      (result as { accounts: Array<{ publicKey: Uint8Array }> }).accounts[0]?.publicKey,
    ).toStrictEqual(PUBKEY);
  });

  it("solana:signMessage goes through the solana-sign pipeline and returns the signature", async () => {
    const sig = new Uint8Array(64).fill(9);
    const { handler, requestsCalls } = rig({
      session: {},
      prepareResult: { kind: "solana.message", signature: sig },
    });
    const result = await handler.handle(SITE, {
      method: "solana:signMessage",
      params: { message: new Uint8Array([7, 8]) },
    });
    expect(requestsCalls).toHaveLength(1);
    const input = requestsCalls[0] as { method: string; request: { kind: string } };
    expect(input.method).toBe("solana-sign");
    expect(input.request.kind).toBe("message");
    expect(result).toMatchObject({ signature: sig });
  });

  it("solana:signTransaction returns the signed transactions (send:false)", async () => {
    const signed = [new Uint8Array([5, 5, 5])];
    const { handler, requestsCalls } = rig({
      session: {},
      prepareResult: { kind: "solana.transactions", send: false, signedTransactions: signed },
    });
    const result = await handler.handle(SITE, {
      method: "solana:signTransaction",
      params: { transactions: [TX] },
    });
    const input = requestsCalls[0] as { request: { kind: string; send: boolean } };
    expect(input.request.send).toBe(false);
    expect(result).toMatchObject({ signedTransactions: signed });
  });

  it("solana:signAndSendTransaction returns the signatures (send:true)", async () => {
    const { handler, requestsCalls } = rig({
      session: {},
      prepareResult: { kind: "solana.transactions", send: true, signatures: ["sig1"] },
    });
    const result = await handler.handle(SITE, {
      method: "solana:signAndSendTransaction",
      params: { transactions: [TX] },
    });
    const input = requestsCalls[0] as { request: { send: boolean } };
    expect(input.request.send).toBe(true);
    expect(result).toMatchObject({ signatures: ["sig1"] });
  });

  it("rejects a non-bytes transaction before the pipeline", async () => {
    const { handler, requestsCalls } = rig({ session: {} });
    await expect(
      handler.handle(SITE, {
        method: "solana:signTransaction",
        params: { transactions: ["not-bytes"] },
      }),
    ).rejects.toThrow("each transaction");
    expect(requestsCalls).toHaveLength(0);
  });

  it("solanaAccountsChanged returns the new group's wallet account", async () => {
    const { handler } = rig({});
    const accounts = await handler.solanaAccountsChanged(SITE);
    expect(accounts).toStrictEqual([
      {
        address: SOL_ADDR,
        publicKey: PUBKEY,
        chains: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
        features: ["solana:signTransaction", "solana:signAndSendTransaction", "solana:signMessage"],
      },
    ]);
  });
});
