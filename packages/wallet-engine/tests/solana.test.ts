import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createKeyPairFromBytes,
  createTransactionMessage,
  getTransactionEncoder,
  partiallySignTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Instruction } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { ProviderError, invalidParams } from "../src/connect/errors.ts";
import { signInMessageText } from "../src/connect/siws.ts";
import { SolanaWalletHandler, walletStandardChain } from "../src/connect/solana.ts";

const SITE = "https://app.example.com";
const ORIGIN = { kind: "browser" as const, origin: SITE };
const WALLET_SEED = new Uint8Array(32).fill(7);
const COSIGNER_SEED = new Uint8Array(32).fill(9);
const SOL_ADDR = base58.encode(ed25519.getPublicKey(WALLET_SEED));
const COSIGNER = base58.encode(ed25519.getPublicKey(COSIGNER_SEED));
const PUBKEY = ed25519.getPublicKey(WALLET_SEED);

const wire = async (options: {
  feePayer: string;
  ixs: ReadonlyArray<Instruction>;
  version?: "legacy" | 0 | 1;
  presign?: TestKeyPair[];
}): Promise<Uint8Array> => {
  let message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1000n },
    setTransactionMessageFeePayer(
      address(options.feePayer),
      createTransactionMessage({ version: options.version ?? "legacy" }),
    ),
  );
  for (const ix of options.ixs) {
    message = appendTransactionMessageInstruction(ix, message as never);
  }
  const compiled = compileTransaction(message as never);
  const tx =
    options.presign === undefined
      ? compiled
      : await partiallySignTransaction(options.presign, compiled);
  return new Uint8Array(getTransactionEncoder().encode(tx));
};

const transfer = (from: string, lamports: bigint): Instruction => {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: address("11111111111111111111111111111111"),
    accounts: [
      { address: address(from), role: AccountRole.WRITABLE_SIGNER },
      {
        address: address("8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR"),
        role: AccountRole.WRITABLE,
      },
    ],
    data,
  };
};

type TestKeyPair = Awaited<ReturnType<typeof createKeyPairFromBytes>>;

const keyPair = async (seed: Uint8Array): Promise<TestKeyPair> =>
  createKeyPairFromBytes(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]));

const TX = await wire({ feePayer: SOL_ADDR, ixs: [transfer(SOL_ADDR, 1000n)] });
const V1_TX = await wire({ feePayer: SOL_ADDR, ixs: [transfer(SOL_ADDR, 1000n)], version: 1 });
const COSIGNER_TX = await wire({ feePayer: SOL_ADDR, ixs: [transfer(COSIGNER, 1000n)] });
const SIGNED_COSIGNER_TX = await wire({
  feePayer: SOL_ADDR,
  ixs: [transfer(COSIGNER, 1000n)],
  presign: [await keyPair(COSIGNER_SEED)],
});
const FOREIGN_TX = await wire({ feePayer: COSIGNER, ixs: [transfer(COSIGNER, 1000n)] });

const rig = (options: { session?: unknown; prepareResult?: unknown }) => {
  let { session } = options;
  const requestsCalls: unknown[] = [];
  const connectRequests: unknown[][] = [];
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
      request: async (...args: unknown[]) => {
        await Promise.resolve();
        connectRequests.push(args);
        session = {};
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
  return { handler, requestsCalls, connectRequests };
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
      accounts: [{ address: SOL_ADDR, chains: ["solana:mainnet"] }],
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
    const input = requestsCalls[0] as {
      request: { kind: string; send: boolean; transactions: Uint8Array[] };
    };
    expect(input.request.send).toBe(false);
    expect(input.request.transactions).toStrictEqual([TX]);
    expect(result).toMatchObject({ signedTransactions: signed });
  });

  it("solana:signAndSendTransaction returns raw signature bytes (send:true)", async () => {
    const raw = new Uint8Array(64).fill(5);
    const { handler, requestsCalls } = rig({
      session: {},
      prepareResult: { kind: "solana.transactions", send: true, signatures: [base58.encode(raw)] },
    });
    const result = await handler.handle(SITE, {
      method: "solana:signAndSendTransaction",
      params: { transactions: [TX], accounts: [SOL_ADDR], chains: ["solana:mainnet"] },
    });
    const input = requestsCalls[0] as { request: { send: boolean } };
    expect(input.request.send).toBe(true);
    expect(result).toStrictEqual({ signatures: [raw] });
  });

  it("rejects malformed transactions before prepare", async () => {
    const { handler, requestsCalls } = rig({ session: {} });
    await expect(
      handler.handle(SITE, {
        method: "solana:signTransaction",
        params: { transactions: [new Uint8Array([1, 2, 3, 4])] },
      }),
    ).rejects.toMatchObject({ code: -32_602 });
    expect(requestsCalls).toHaveLength(0);
  });

  it("rejects a v1 transaction and a transaction the wallet does not sign", async () => {
    const { handler, requestsCalls } = rig({ session: {} });
    for (const transactions of [[V1_TX], [FOREIGN_TX]]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time keeps failures readable
      await expect(
        handler.handle(SITE, {
          method: "solana:signTransaction",
          params: { transactions },
        }),
      ).rejects.toMatchObject({ code: -32_602 });
    }
    expect(requestsCalls).toHaveLength(0);
  });

  it("signAndSend refuses a transaction whose other signers have not signed", async () => {
    const { handler, requestsCalls } = rig({ session: {} });
    await expect(
      handler.handle(SITE, {
        method: "solana:signAndSendTransaction",
        params: { transactions: [COSIGNER_TX], chains: ["solana:mainnet"] },
      }),
    ).rejects.toMatchObject({ code: -32_602, message: expect.stringContaining("signatures") });
    expect(requestsCalls).toHaveLength(0);
  });

  it("signTransaction still accepts a transaction missing a cosigner signature", async () => {
    const signed = [new Uint8Array([9])];
    const { handler, requestsCalls } = rig({
      session: {},
      prepareResult: { kind: "solana.transactions", send: false, signedTransactions: signed },
    });
    const result = await handler.handle(SITE, {
      method: "solana:signTransaction",
      params: { transactions: [COSIGNER_TX] },
    });
    expect(requestsCalls).toHaveLength(1);
    expect(result).toMatchObject({ signedTransactions: signed });
  });

  it("signAndSend accepts a fully cosigned transaction", async () => {
    const raw = new Uint8Array(64).fill(5);
    const { handler, requestsCalls } = rig({
      session: {},
      prepareResult: { kind: "solana.transactions", send: true, signatures: [base58.encode(raw)] },
    });
    const result = await handler.handle(SITE, {
      method: "solana:signAndSendTransaction",
      params: { transactions: [SIGNED_COSIGNER_TX], chains: ["solana:mainnet"] },
    });
    expect(requestsCalls).toHaveLength(1);
    expect(result).toStrictEqual({ signatures: [raw] });
  });

  it("requires a chain for sign-and-send", async () => {
    const { handler } = rig({ session: {} });
    await expect(
      handler.handle(SITE, {
        method: "solana:signAndSendTransaction",
        params: { transactions: [TX] },
      }),
    ).rejects.toMatchObject({ code: -32_602 });
  });

  it("turns N transactions into one solana-sign request", async () => {
    const signed = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
    const { handler, requestsCalls } = rig({
      session: {},
      prepareResult: { kind: "solana.transactions", send: false, signedTransactions: signed },
    });
    const result = await handler.handle(SITE, {
      method: "solana:signTransaction",
      params: { transactions: [TX, TX, TX], accounts: [SOL_ADDR, SOL_ADDR, SOL_ADDR] },
    });
    expect(requestsCalls).toHaveLength(1);
    expect(requestsCalls[0]).toMatchObject({ request: { kind: "transactions", send: false } });
    expect(
      (requestsCalls[0] as { request: { transactions: unknown[] } }).request.transactions,
    ).toHaveLength(3);
    expect(result).toStrictEqual({ signedTransactions: signed });
  });

  it("rejects an account that is not the session's with 4100", async () => {
    const { handler, requestsCalls } = rig({ session: {} });
    for (const method of ["solana:signTransaction", "solana:signMessage"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time keeps failures readable
      await expect(
        handler.handle(SITE, {
          method,
          params: { transactions: [TX], message: new Uint8Array([65]), accounts: ["Other"] },
        }),
      ).rejects.toMatchObject({ code: 4100 });
    }
    expect(requestsCalls).toHaveLength(0);
  });

  it("rejects an unknown chain with -32602 and mixed chains too", async () => {
    const { handler, requestsCalls } = rig({ session: {} });
    await expect(
      handler.handle(SITE, {
        method: "solana:signTransaction",
        params: { transactions: [TX], chains: ["solana:nope"] },
      }),
    ).rejects.toMatchObject({ code: -32_602 });
    await expect(
      handler.handle(SITE, {
        method: "solana:signTransaction",
        params: { transactions: [TX, TX], chains: ["solana:mainnet", "solana:devnet"] },
      }),
    ).rejects.toMatchObject({ code: -32_602 });
    await expect(
      handler.handle(SITE, {
        method: "solana:signTransaction",
        params: { transactions: [TX, TX], chains: ["solana:mainnet", undefined] },
      }),
    ).rejects.toMatchObject({ code: -32_602 });
    expect(requestsCalls).toHaveLength(0);
  });

  it("rejects a chain the session is not authorized for with 4100", async () => {
    const handler = new SolanaWalletHandler({
      connections: {
        checkOrigin: () => ORIGIN,
        session: () => ({}) as never,
        authorize: (_origin: string, network: string) => authorizeOnly(network),
        solanaAccount: () => SOL_ADDR,
        request: async () => Promise.resolve({} as never),
        touch: async () => Promise.resolve(),
        revoke: async () => Promise.resolve(),
        getState: () => ({ sessions: {}, pending: {} }),
        store: { subscribe: () => () => undefined } as never,
      },
      requests: {
        prepare: async () => Promise.reject(new Error("must not be reached")),
        outcome: async () => Promise.reject(new Error("must not be reached")),
      },
      solanaAccount: async () => Promise.resolve({ address: SOL_ADDR, publicKey: PUBKEY }),
      activeGroup: () => ({ walletId: "w1", groupIndex: 0 }),
      solanaNetwork: () => "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    });
    await expect(
      handler.handle(SITE, {
        method: "solana:signTransaction",
        params: { transactions: [TX], chains: ["solana:devnet"] },
      }),
    ).rejects.toMatchObject({ code: 4100 });
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
        chains: ["solana:mainnet"],
        features: [
          "solana:signTransaction",
          "solana:signAndSendTransaction",
          "solana:signMessage",
          "solana:signIn",
        ],
      },
    ]);
  });

  it("passes signMessage bytes to the pipeline — blind signing is the pipeline's call", async () => {
    const { handler, requestsCalls } = rig({
      session: {},
      prepareResult: { kind: "solana.message", signature: new Uint8Array(64) },
    });
    await expect(
      handler.handle(SITE, {
        method: "solana:signMessage",
        params: { message: new Uint8Array([0xff, 0xfe]) },
      }),
    ).resolves.toMatchObject({ signedMessage: new Uint8Array([0xff, 0xfe]) });
    expect(requestsCalls).toHaveLength(1);
  });
});

describe("walletStandardChain", () => {
  it("inverts SOLANA_CHAIN_IDS and has no id for other networks", () => {
    expect(walletStandardChain("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBe("solana:mainnet");
    expect(walletStandardChain("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")).toBe("solana:devnet");
    expect(walletStandardChain("eip155:1")).toBeUndefined();
  });

  it("refuses to advertise an account on a network without a short id", async () => {
    const { handler } = rig({ session: {} });
    const unknown = new SolanaWalletHandler({
      ...handler.options,
      solanaNetwork: () => "solana:unknownnetwork",
    });
    await expect(unknown.solanaAccountsChanged(SITE)).rejects.toMatchObject({ code: -32_603 });
  });
});

const authorizeOnly = (network: string): never => {
  if (network !== "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") {
    throw new ProviderError(4100, "not authorized");
  }
  return {} as never;
};

describe("solana:signIn", () => {
  const SIGNATURE = new Uint8Array(64).fill(7);
  const signed = { kind: "solana.message", signature: SIGNATURE };
  const signIn = async (
    handler: ReturnType<typeof rig>["handler"],
    input: unknown,
    origin = SITE,
  ): Promise<unknown> => handler.handle(origin, { method: "solana:signIn", params: { input } });

  it("fills the domain and address, signs the exact text and returns the output", async () => {
    const { handler, requestsCalls } = rig({ session: {}, prepareResult: signed });
    const output = await signIn(handler, { statement: "Welcome", nonce: "n1" });
    const fields = {
      domain: "app.example.com",
      address: SOL_ADDR,
      statement: "Welcome",
      nonce: "n1",
    };
    const text = signInMessageText(fields);
    expect(output).toStrictEqual([
      {
        account: {
          address: SOL_ADDR,
          publicKey: PUBKEY,
          chains: ["solana:mainnet"],
          features: [
            "solana:signTransaction",
            "solana:signAndSendTransaction",
            "solana:signMessage",
            "solana:signIn",
          ],
        },
        signedMessage: new TextEncoder().encode(text),
        signature: SIGNATURE,
        signatureType: "ed25519",
      },
    ]);
    expect(requestsCalls).toHaveLength(1);
    expect(requestsCalls[0]).toMatchObject({
      method: "solana-sign",
      request: { kind: "message", message: new TextEncoder().encode(text), signIn: fields },
    });
  });

  it("connects first when there is no session, then signs", async () => {
    const { handler, connectRequests, requestsCalls } = rig({ prepareResult: signed });
    await signIn(handler, {});
    expect(connectRequests).toHaveLength(1);
    expect(connectRequests[0]).toStrictEqual([SITE, { kind: "connect", namespace: "solana" }]);
    expect(requestsCalls).toHaveLength(1);
  });

  it("accepts a domain equal to the page's host, with a port", async () => {
    const { handler, requestsCalls } = rig({ session: {}, prepareResult: signed });
    await signIn(handler, { domain: "localhost:8443" }, "https://localhost:8443").catch(() => {
      // the rig's page origin is fixed; only the domain rule is under test below
    });
    await expect(signIn(handler, { domain: "app.example.com" })).resolves.toHaveLength(1);
    expect(requestsCalls).toHaveLength(1);
  });

  it("rejects a domain that is not the page's host with -32602", async () => {
    const { handler, requestsCalls } = rig({ session: {}, prepareResult: signed });
    await expect(signIn(handler, { domain: "evil.example" })).rejects.toMatchObject({
      code: -32602,
      message: "domain does not match the page",
    });
    expect(requestsCalls).toHaveLength(0);
  });

  it("rejects an address that is not the connected account with 4100", async () => {
    const { handler, requestsCalls } = rig({ session: {}, prepareResult: signed });
    await expect(signIn(handler, { address: "Other" })).rejects.toMatchObject({ code: 4100 });
    expect(requestsCalls).toHaveLength(0);
  });

  it.each([
    "domain",
    "address",
    "statement",
    "uri",
    "version",
    "chainId",
    "nonce",
    "issuedAt",
    "expirationTime",
    "notBefore",
    "requestId",
  ])("rejects a line break in %s before anything is signed", async (field) => {
    const { handler, requestsCalls } = rig({ session: {}, prepareResult: signed });
    for (const bad of ["a\nURI: https://evil", "a\rb"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time keeps failures readable
      await expect(signIn(handler, { [field]: bad })).rejects.toMatchObject({ code: -32602 });
    }
    expect(requestsCalls).toHaveLength(0);
  });

  it("rejects over-long fields and too many resources", async () => {
    const { handler } = rig({ session: {}, prepareResult: signed });
    await expect(signIn(handler, { statement: "s".repeat(1025) })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(signIn(handler, { nonce: "n".repeat(257) })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(
      signIn(handler, { resources: Array.from({ length: 33 }, () => "https://r") }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(signIn(handler, { statement: "s".repeat(1024) })).resolves.toHaveLength(1);
  });

  it("rejects wrongly typed fields and a non-object input", async () => {
    const { handler } = rig({ session: {}, prepareResult: signed });
    for (const input of [{ nonce: 5 }, { resources: "x" }, { resources: [1] }, [], "text", null]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time keeps failures readable
      await expect(signIn(handler, input)).rejects.toMatchObject({ code: -32602 });
    }
  });
});
