import { randomBytes } from "node:crypto";

import { recoverMessageAddress, recoverTypedDataAddress } from "viem";
import { describe, expect, it, vi } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { createMessage } from "@qntx/siwx";
import { evm } from "@qntx/siwx/evm";
import type { Wallet } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import {
  CONNECTION_REQUEST_TTL_MS,
  ConnectionController,
  MAX_PENDING_CONNECTIONS,
  SESSION_TTL_MS,
} from "../src/connect/controller.ts";
import type { LightningPolicy, NostrPolicy } from "../src/connect/controller.ts";
import { Eip1193Handler } from "../src/connect/eip1193.ts";
import type { Eip1193Event } from "../src/connect/eip1193.ts";
import { ProviderError } from "../src/connect/errors.ts";
import { NetworkController } from "../src/networks/controller.ts";
import type { PhishingStatus } from "../src/phishing/status.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { bookDeps, simulateSolanaStub, idleNetworkDeps } from "./send-helpers.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password" as const, password: PASSWORD };
const SITE = "https://app.example";

const siweText = (domain: string, address: string): string =>
  evm().format(
    createMessage({
      domain,
      address,
      uri: `https://${domain}/login`,
      version: "1",
      chainId: "1",
      nonce: "12341234",
      issuedAt: "2022-03-17T12:45:13.610Z",
    }),
  );
const OTHER_SITE = "https://other.example";
const MAINNET = "eip155:1";
const NOSTR_PUBKEYS = ["a".repeat(64), "b".repeat(64)] as const;
const SEPOLIA = "eip155:11155111";

const logger = { warn: () => undefined };

const pendingId = (connections: ConnectionController): string => {
  const [first] = connections.pending();
  if (first === undefined) {
    throw new Error("no pending connection");
  }
  return first.id;
};

const lower = async (address: Promise<string>): Promise<string> => {
  const resolved = await address;
  return resolved.toLowerCase();
};

const codeOf = async (run: Promise<unknown>): Promise<number | string> =>
  run.then(
    () => "resolved",
    (error: unknown) => (error instanceof ProviderError ? error.code : String(error)),
  );

async function rig(options: { allowLocalhost?: boolean } = {}) {
  const wallet: Wallet = await createNodeWallet({
    verifyEvent,
    passkey: {
      rpId: "qntx.test",
      rpName: "qntx",
      walletSalt: "qntx/wallet",
      backupSalt: "qntx/backup",
      vaultSalt: "qntx/vault",
    },
    autoLock: { platform: "web", idleMinutes: 15 },
    authenticator: createSoftwarePasskey(randomBytes(32)),
    kernelUrl: KERNEL_URL,
  });
  const { walletId } = await wallet.wallets.importMnemonic({
    mnemonic: MNEMONIC,
    factor: { kind: "password", password: PASSWORD },
  });
  const apis = chains(wallet);
  const addressAt = async (groupIndex: number, network = MAINNET): Promise<string> => {
    const account = await apis.account({
      walletId,
      groupIndex,
      template: "evm.bip44",
      network,
    });
    return "address" in account ? account.address : "";
  };
  let counter = 0;
  const random = (n: number): Uint8Array => {
    counter += 1;
    return new Uint8Array(n).fill(counter % 251);
  };
  const rpcCalls: string[] = [];
  const fetchedUrls: string[] = [];
  const tokenState = {
    metadata: { symbol: "TKN", decimals: 18 },
    added: [] as string[],
    tracked: new Set<string>(),
  };
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: async (input, init) => {
      fetchedUrls.push(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      rpcCalls.push(body.method);
      return Promise.resolve(Response.json({ jsonrpc: "2.0", id: body.id, result: "0x10" }));
    },
    rpc: { [MAINNET]: ["https://rpc.example"], [SEPOLIA]: ["https://sepolia.example"] },
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    logger,
  });
  const transactions = new TransactionController({
    wallet,
    networks,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    random,
    setTimer: () => () => undefined,
    now: () => 1000,
    logger,
  });
  await transactions.init();
  let phishingStatus: PhishingStatus = "clear";
  const phishing = { check: () => phishingStatus };
  const requests = new RequestController({
    phishing,
    simulateSolana: simulateSolanaStub,
    tokens: {
      metadata: async () => Promise.resolve(tokenState.metadata),
      add: async (_network, address) => {
        await Promise.resolve();
        tokenState.added.push(address);
      },
    },
    transactions,
    ...bookDeps(),
    spark: {} as SparkController,
    nostrSign: async () => Promise.reject(new Error("nostr-sign is not wired in this test")),
    solanaSign: async () => {
      await Promise.resolve();
      throw new Error("solana-sign is not wired in this test");
    },
    fetch: globalThis.fetch,
    random,
    now: () => 1000,
    setTimer: () => () => undefined,
    logger,
  });
  await requests.init();
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  let clock = 1_800_000_000_000;
  const connectionTimers: Array<{ ms: number; fn: () => unknown; cancelled: boolean }> = [];
  const connectionOptions = {
    phishing,
    setTimer: (ms: number, fn: () => unknown) => {
      const timer = { ms, fn, cancelled: false };
      connectionTimers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
    random,
    now: () => clock,
    logger,
    allowLocalhost: options.allowLocalhost ?? false,
    selectedGroup: () => ({ walletId, groupIndex: 0 }),
    evmAddress: async (group: { walletId: string; groupIndex: number }, network: string) =>
      addressAt(group.groupIndex, network),
    enabledNetworks: () => [MAINNET, SEPOLIA],
    solanaAddress: async (group: { walletId: string; groupIndex: number }, network: string) => {
      await Promise.resolve();
      return `SoLaNaAdd${String(group.groupIndex)}-${network}`;
    },
    nostrPubkey: async (ref: { index: number }) =>
      Promise.resolve(NOSTR_PUBKEYS[ref.index] ?? NOSTR_PUBKEYS[0]),
    invalidate: (origin: string) => {
      requests.invalidateOrigin(origin);
    },
  };
  const connections = new ConnectionController(connectionOptions);
  await connections.init();
  const handler = new Eip1193Handler({
    connections,
    requests,
    networks,
    defaultNetwork: () => MAINNET,
    isTracked: (_network, address) => tokenState.tracked.has(address.toLowerCase()),
  });
  const events: Eip1193Event[] = [];
  handler.subscribe((event) => events.push(event));

  /** `eth_requestAccounts` answered by the host: approve the first pending connection. */
  const connect = async (origin = SITE, network = MAINNET): Promise<ReadonlyArray<string>> => {
    const accounts = handler.handle(origin, { method: "eth_requestAccounts" });
    await vi.waitFor(() => {
      expect(connections.pending().some((p) => p.origin.origin === origin)).toBe(true);
    });
    const pending = connections.pending().find((p) => p.origin.origin === origin);
    await connections.approveConnection(pending?.id ?? "", {
      accounts: [await addressAt(0, network)],
      network,
    });
    return (await accounts) as ReadonlyArray<string>;
  };

  const approveNext = async (origin = SITE): Promise<void> => {
    await vi.waitFor(() => {
      expect(
        Object.values(requests.getState().requests).some(
          (r) =>
            r.origin.kind === "browser" &&
            r.origin.origin === origin &&
            r.stage === "awaiting-approval",
        ),
      ).toBe(true);
    });
    const request = Object.values(requests.getState().requests).find(
      (r) =>
        r.origin.kind === "browser" &&
        r.origin.origin === origin &&
        r.stage === "awaiting-approval",
    );
    await requests.approve(request?.id ?? "", "evm-sign", VERIFY);
  };

  return {
    wallet,
    walletId,
    addressAt,
    connections,
    connectionOptions,
    backing,
    requests,
    networks,
    handler,
    events,
    rpcCalls,
    connect,
    approveNext,
    advance: (ms: number) => {
      clock += ms;
    },
    fetchedUrls,
    connectionTimers,
    tokenState,
    setPhishing: (status: PhishingStatus) => {
      phishingStatus = status;
    },
    destroy: async () => wallet.destroy(),
  };
}

const TYPED = JSON.stringify({
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
    ],
    Mail: [{ name: "contents", type: "string" }],
  },
  primaryType: "Mail",
  domain: { name: "Test", chainId: 1 },
  message: { contents: "hello" },
});

describe("connection sessions", () => {
  it("accepts https origins, rejects the rest, localhost only in development", async () => {
    const r = await rig();
    expect(r.connections.checkOrigin(SITE)).toStrictEqual({ kind: "browser", origin: SITE });
    for (const bad of [
      "http://app.example",
      "https://app.example/path",
      "https://u:p@app.example",
      "app.example",
      "http://localhost:3000",
    ]) {
      expect(() => r.connections.checkOrigin(bad)).toThrow(ProviderError);
    }
    await expect(
      codeOf(r.handler.handle("http://app.example", { method: "eth_accounts" })),
    ).resolves.toBe(4100);
    await r.destroy();

    const dev = await rig({ allowLocalhost: true });
    expect(dev.connections.checkOrigin("http://localhost:3000").origin).toBe(
      "http://localhost:3000",
    );
    await dev.destroy();
  });

  it("builds a session from an approval, persists it and checks scope", async () => {
    const r = await rig();
    const accounts = await r.connect();
    const address = await lower(r.addressAt(0));
    expect(accounts).toStrictEqual([address]);
    const session = r.connections.session(SITE);
    expect(session).toMatchObject({
      currentNetwork: MAINNET,
      scopes: { [MAINNET]: { accounts: [`${MAINNET}:${address}`] } },
    });
    expect(r.connections.authorize(SITE, MAINNET, "personal_sign")).toBe(session);
    expect(() => r.connections.authorize(SITE, SEPOLIA, "personal_sign")).toThrow(ProviderError);
    expect(() => r.connections.authorize(SITE, MAINNET, "eth_sign")).toThrow(ProviderError);
    expect(() => r.connections.authorize(OTHER_SITE, MAINNET, "personal_sign")).toThrow(
      ProviderError,
    );

    const reopened = new ConnectionController(r.connectionOptions);
    await reopened.init();
    expect(reopened.session(SITE)).toStrictEqual(session);
    await r.destroy();
  });

  it("rejection gives 4001, a second pending request gives -32002, lock rejects and clears", async () => {
    const r = await rig();
    const first = codeOf(r.handler.handle(SITE, { method: "eth_requestAccounts" }));
    await vi.waitFor(() => {
      expect(r.connections.pending()).toHaveLength(1);
    });
    await expect(codeOf(r.handler.handle(SITE, { method: "eth_requestAccounts" }))).resolves.toBe(
      -32002,
    );
    r.connections.rejectConnection(pendingId(r.connections));
    await expect(first).resolves.toBe(4001);
    expect(r.connections.pending()).toHaveLength(0);

    const second = codeOf(r.handler.handle(SITE, { method: "eth_requestAccounts" }));
    await vi.waitFor(() => {
      expect(r.connections.pending()).toHaveLength(1);
    });
    r.connections.lock();
    await expect(second).resolves.toBe(4001);
    expect(r.connections.getState()).toStrictEqual({ sessions: {}, pending: {} });
    await r.destroy();
  });

  it("drops sessions unused for 90 days when unlocking", async () => {
    const r = await rig();
    await r.connect();
    await r.connect(OTHER_SITE);
    r.advance(SESSION_TTL_MS - 1);
    await r.connections.touch(OTHER_SITE);
    r.advance(2);
    const reopened = new ConnectionController(r.connectionOptions);
    await reopened.init();
    expect(reopened.session(SITE)).toBeUndefined();
    expect(reopened.session(OTHER_SITE)).toBeDefined();
    await r.destroy();
  });

  it("revoking voids the origin's pending request", async () => {
    const r = await rig();
    await r.connect();
    const signing = codeOf(
      r.handler.handle(SITE, {
        method: "personal_sign",
        params: ["0x68656c6c6f", await r.addressAt(0)],
      }),
    );
    await vi.waitFor(() => {
      expect(Object.values(r.requests.getState().requests)).toHaveLength(1);
    });
    await r.connections.revoke(SITE);
    await expect(signing).resolves.toBe(4001);
    expect(Object.values(r.requests.getState().requests)[0]?.stage).toBe("invalidated");
    expect(r.connections.session(SITE)).toBeUndefined();
    expect(r.events.map((e) => e.name)).toContain("disconnect");
    await r.destroy();
  });

  it("switching account group moves the accounts and emits accountsChanged", async () => {
    const r = await rig();
    const [first] = await r.connect();
    const second = await lower(r.addressAt(1));
    await r.connections.setActiveGroup(r.walletId, 1);
    expect(r.connections.accounts(SITE)).toStrictEqual([second]);
    // A fresh session's accounts go [] → [first] (connect emits accountsChanged), then the group
    // switch emits accountsChanged([second]).
    expect(r.events.filter((e) => e.name === "accountsChanged")).toStrictEqual([
      { name: "accountsChanged", origin: SITE, accounts: [first] },
      { name: "accountsChanged", origin: SITE, accounts: [second] },
    ]);
    await r.destroy();
  });
});

describe("nostr connections", () => {
  const pendingNostrId = (r: Awaited<ReturnType<typeof rig>>, origin = SITE): string =>
    r.connections.pending().find((p) => p.origin.origin === origin)?.id ?? "";

  const nostrConnect = async (
    r: Awaited<ReturnType<typeof rig>>,
    pubkey: string,
    policy: NostrPolicy,
    origin = SITE,
  ): Promise<void> => {
    const pending = r.connections.request(origin, { kind: "connect", namespace: "nostr" });
    await vi.waitFor(() => {
      expect(r.connections.pending().some((p) => p.origin.origin === origin)).toBe(true);
    });
    const id = pendingNostrId(r, origin);
    await r.connections.approveConnection(id, {
      accounts: [await r.addressAt(0)],
      network: MAINNET,
      nostr: { pubkey, policy },
    });
    await pending;
  };

  it("a nostr approval creates the nostr scope and persists the policy", async () => {
    const r = await rig();
    const [pubkey] = NOSTR_PUBKEYS;
    await r.connections.setActiveIdentity({ kind: "derived", walletId: r.walletId, index: 0 });
    const policy: NostrPolicy = { signing: "ask", decrypt: false };
    await nostrConnect(r, pubkey, policy);
    const session = r.connections.session(SITE);
    expect(session?.scopes["nostr"]?.accounts).toStrictEqual([`nostr:${pubkey}`]);
    expect(session?.scopes["nostr"]?.methods).toContain("signEvent");
    expect(r.connections.nostrPolicy(SITE)).toStrictEqual(policy);
    expect(r.connections.nostrAccount(SITE)).toBe(pubkey);
    expect(r.connections.authorize(SITE, "nostr", "signEvent")).toBe(session);
    await r.destroy();
  });

  it("approving a pubkey other than the active identity's is rejected", async () => {
    const r = await rig();
    await r.connections.setActiveIdentity({ kind: "derived", walletId: r.walletId, index: 0 });
    const pending = r.connections.request(SITE, { kind: "connect", namespace: "nostr" });
    await vi.waitFor(() => {
      expect(r.connections.pending().length).toBeGreaterThan(0);
    });
    const id = pendingNostrId(r);
    await expect(
      r.connections.approveConnection(id, {
        accounts: [await r.addressAt(0)],
        network: MAINNET,
        nostr: { pubkey: "c".repeat(64), policy: { signing: "ask", decrypt: false } },
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    r.connections.rejectConnection(id);
    await expect(pending).rejects.toBeInstanceOf(ProviderError);
    await r.destroy();
  });

  it("setActiveIdentity re-points authorized nostr sessions' account", async () => {
    const r = await rig();
    const [first, second] = NOSTR_PUBKEYS;
    await r.connections.setActiveIdentity({ kind: "derived", walletId: r.walletId, index: 0 });
    await nostrConnect(r, first, { signing: "ask", decrypt: false });
    expect(r.connections.nostrAccount(SITE)).toBe(first);
    // Switching to index 1 re-points the session's nostr account.
    await r.connections.setActiveIdentity({ kind: "derived", walletId: r.walletId, index: 1 });
    expect(r.connections.nostrAccount(SITE)).toBe(second);
    // Clearing the identity empties it.
    await r.connections.setActiveIdentity(undefined);
    expect(r.connections.nostrAccount(SITE)).toBeUndefined();
    await r.destroy();
  });
});

describe("Eip1193Handler", () => {
  it("answers an unconnected page with no accounts and the default chain", async () => {
    const r = await rig();
    await expect(r.handler.handle(SITE, { method: "eth_accounts" })).resolves.toStrictEqual([]);
    await expect(r.handler.handle(SITE, { method: "eth_chainId" })).resolves.toBe("0x1");
    await expect(
      r.handler.handle(SITE, { method: "wallet_getPermissions" }),
    ).resolves.toStrictEqual([]);
    await r.destroy();
  });

  it("eth_requestAccounts waits for the host's approval by id", async () => {
    const r = await rig();
    const accounts = await r.connect();
    await expect(r.handler.handle(SITE, { method: "eth_accounts" })).resolves.toStrictEqual(
      accounts,
    );
    await expect(
      r.handler.handle(SITE, { method: "wallet_getPermissions" }),
    ).resolves.toMatchObject([{ parentCapability: "eth_accounts", invoker: SITE }]);
    expect(r.events.map((e) => e.name)).toContain("connect");
    await r.destroy();
  });

  it("personal_sign goes through the pipeline and the signature recovers to the account", async () => {
    const r = await rig();
    await r.connect();
    const address = await r.addressAt(0);
    const signature = r.handler.handle(SITE, {
      method: "personal_sign",
      params: [`0x${Buffer.from("hello dapp").toString("hex")}`, address],
    });
    await r.approveNext();
    const hex = (await signature) as `0x${string}`;
    await expect(recoverMessageAddress({ message: "hello dapp", signature: hex })).resolves.toBe(
      address,
    );
    await vi.waitFor(async () => {
      await expect(r.requests.signLog()).resolves.toHaveLength(1);
    });
    const log = await r.requests.signLog();
    expect(log[0]).toMatchObject({
      method: "evm-sign",
      outcome: "submitted",
      origin: { kind: "browser", origin: SITE },
      summary: "message",
    });
    await r.destroy();
  });

  it("a SIWE message for another domain is refused with -32602 before approval", async () => {
    const r = await rig();
    await r.connect();
    const address = await r.addressAt(0);
    const text = siweText("evil.example", address);
    await expect(
      r.handler.handle(SITE, {
        method: "personal_sign",
        params: [`0x${Buffer.from(text).toString("hex")}`, address],
      }),
    ).rejects.toMatchObject({ code: -32_602 });
    expect(Object.values(r.requests.getState().requests)).toHaveLength(0);
    await r.destroy();
  });

  it("a SIWE message for the page reaches approval with the parsed sign-in", async () => {
    const r = await rig();
    await r.connect();
    const address = await r.addressAt(0);
    const text = siweText("app.example", address);
    const signature = r.handler.handle(SITE, {
      method: "personal_sign",
      params: [`0x${Buffer.from(text).toString("hex")}`, address],
    });
    await vi.waitFor(() => {
      expect(Object.values(r.requests.getState().requests)).toHaveLength(1);
    });
    const [pending] = Object.values(r.requests.getState().requests);
    expect(pending?.display).toMatchObject({
      message: { kind: "text", text, signIn: { status: "valid" } },
    });
    expect(pending?.risk).toStrictEqual([]);
    await r.approveNext();
    await signature;
    await vi.waitFor(async () => {
      await expect(r.requests.signLog()).resolves.toHaveLength(1);
    });
    const [entry] = await r.requests.signLog();
    expect(entry?.summary).toBe("sign-in app.example");
    await r.destroy();
  });

  it("refuses a personal_sign whose bytes are not UTF-8 text without reaching the pipeline", async () => {
    const r = await rig();
    await r.connect();
    const address = await r.addressAt(0);
    await expect(
      r.handler.handle(SITE, { method: "personal_sign", params: ["0xff", address] }),
    ).rejects.toMatchObject({ code: 4200, message: expect.stringContaining("blind signing") });
    expect(Object.values(r.requests.getState().requests)).toHaveLength(0);
    await expect(r.requests.signLog()).resolves.toHaveLength(0);

    const text = r.handler.handle(SITE, {
      method: "personal_sign",
      params: [`0x${Buffer.from("héllo ✓").toString("hex")}`, address],
    });
    await r.approveNext();
    const hex = (await text) as `0x${string}`;
    await expect(recoverMessageAddress({ message: "héllo ✓", signature: hex })).resolves.toBe(
      address,
    );
    await r.destroy();
  });

  it("eth_signTypedData_v4 recovers to the account", async () => {
    const r = await rig();
    await r.connect();
    const address = await r.addressAt(0);
    const signature = r.handler.handle(SITE, {
      method: "eth_signTypedData_v4",
      params: [address, TYPED],
    });
    await r.approveNext();
    const parsed = JSON.parse(TYPED) as {
      domain: { name: string; chainId: number };
      types: Record<string, Array<{ name: string; type: string }>>;
      message: { contents: string };
    };
    const { EIP712Domain: _domain, ...types } = parsed.types;
    await expect(
      recoverTypedDataAddress({
        domain: parsed.domain,
        types,
        primaryType: "Mail",
        message: parsed.message,
        signature: (await signature) as `0x${string}`,
      }),
    ).resolves.toBe(address);
    await r.destroy();
  });

  it("refuses unsafe and deferred methods with 4200", async () => {
    const r = await rig();
    await r.connect();
    for (const method of [
      "eth_sign",
      "eth_signTypedData",
      "eth_signTypedData_v3",
      "eth_signTransaction",
      "eth_sendRawTransaction",
      "wallet_sendCalls",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time keeps failures readable
      await expect(codeOf(r.handler.handle(SITE, { method, params: [] }))).resolves.toBe(4200);
    }
    await r.destroy();
  });

  it("gives the second concurrent request from one origin 4001", async () => {
    const r = await rig();
    await r.connect();
    const address = await r.addressAt(0);
    const params = ["0x01", address];
    const first = r.handler.handle(SITE, { method: "personal_sign", params });
    await vi.waitFor(() => {
      expect(Object.values(r.requests.getState().requests)).toHaveLength(1);
    });
    await expect(codeOf(r.handler.handle(SITE, { method: "personal_sign", params }))).resolves.toBe(
      4001,
    );
    await r.approveNext();
    await first;
    await r.destroy();
  });

  it("rejects signing without a session or for an account that was not granted", async () => {
    const r = await rig();
    const address = await r.addressAt(0);
    await expect(
      codeOf(r.handler.handle(SITE, { method: "personal_sign", params: ["0x01", address] })),
    ).resolves.toBe(4100);
    await r.connect();
    await expect(
      codeOf(
        r.handler.handle(SITE, { method: "personal_sign", params: ["0x01", await r.addressAt(1)] }),
      ),
    ).resolves.toBe(4100);
    await r.destroy();
  });

  it("switching network voids the session's pending request and emits chainChanged", async () => {
    const r = await rig();
    await r.connect();
    const signing = codeOf(
      r.handler.handle(SITE, { method: "personal_sign", params: ["0x01", await r.addressAt(0)] }),
    );
    await vi.waitFor(() => {
      expect(Object.values(r.requests.getState().requests)).toHaveLength(1);
    });
    const switching = r.handler.handle(SITE, {
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xaa36a7" }],
    });
    await vi.waitFor(() => {
      expect(r.connections.pending()).toHaveLength(1);
    });
    await r.connections.approveConnection(pendingId(r.connections), {
      accounts: [await r.addressAt(0, SEPOLIA)],
      network: SEPOLIA,
    });
    await expect(switching).resolves.toBeNull();
    await expect(signing).resolves.toBe(4001);
    await expect(r.handler.handle(SITE, { method: "eth_chainId" })).resolves.toBe("0xaa36a7");
    expect(r.events.filter((e) => e.name === "chainChanged")).toStrictEqual([
      { name: "chainChanged", origin: SITE, chainId: "0xaa36a7" },
    ]);
    await expect(
      codeOf(
        r.handler.handle(SITE, {
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x539" }],
        }),
      ),
    ).resolves.toBe(4902);
    await r.destroy();
  });

  it("forwards read-only RPC and never eth_sendRawTransaction", async () => {
    const r = await rig();
    await expect(r.handler.handle(SITE, { method: "eth_blockNumber" })).resolves.toBe("0x10");
    expect(r.rpcCalls).toContain("eth_blockNumber");
    await expect(codeOf(r.handler.handle(SITE, { method: "eth_nope" }))).resolves.toBe(-32601);
    await r.destroy();
  });

  it("wallet_revokePermissions ends the session", async () => {
    const r = await rig();
    await r.connect();
    await r.handler.handle(SITE, {
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }],
    });
    await expect(r.handler.handle(SITE, { method: "eth_accounts" })).resolves.toStrictEqual([]);
    await r.destroy();
  });
});

describe("lightning connections", () => {
  const pendingLightningId = (r: Awaited<ReturnType<typeof rig>>, origin = SITE): string =>
    r.connections.pending().find((p) => p.origin.origin === origin)?.id ?? "";

  const lightningConnect = async (
    r: Awaited<ReturnType<typeof rig>>,
    policy: LightningPolicy,
    origin = SITE,
  ): Promise<void> => {
    const pending = r.connections.request(origin, { kind: "connect", namespace: "lightning" });
    await vi.waitFor(() => {
      expect(r.connections.pending().some((p) => p.origin.origin === origin)).toBe(true);
    });
    const id = pendingLightningId(r, origin);
    await r.connections.approveConnection(id, {
      accounts: [],
      network: "",
      lightning: { policy },
    });
    await pending;
  };

  it("a lightning approval creates the lightning scope and persists the policy", async () => {
    const r = await rig();
    const policy: LightningPolicy = { balance: true };
    await lightningConnect(r, policy);
    const session = r.connections.session(SITE);
    expect(session?.scopes["lightning"]?.accounts).toHaveLength(1);
    expect(session?.scopes["lightning"]?.methods).toContain("sendPayment");
    expect(r.connections.lightningPolicy(SITE)).toStrictEqual(policy);
    expect(r.connections.authorize(SITE, "lightning", "sendPayment")).toBe(session);
    await r.destroy();
  });
});

const idOf = (entry: { readonly id: string } | undefined): string => entry?.id ?? "";

describe("phishing enforcement", () => {
  const personalSign = async (r: Awaited<ReturnType<typeof rig>>) =>
    r.handler.handle(SITE, {
      method: "personal_sign",
      params: [`0x${Buffer.from("hello").toString("hex")}`, await r.addressAt(0)],
    });

  const preparePersonalSign = async (r: Awaited<ReturnType<typeof rig>>) =>
    r.requests.prepare({
      method: "evm-sign",
      origin: { kind: "browser", origin: SITE },
      account: { kind: "hd", walletId: r.walletId, groupIndex: 0, template: "evm.bip44" },
      network: MAINNET,
      request: {
        kind: "evm.personal-message",
        network: MAINNET,
        account: { kind: "hd", walletId: r.walletId, groupIndex: 0, template: "evm.bip44" },
        message: new TextEncoder().encode("hello"),
      },
    });

  const awaiting = (r: Awaited<ReturnType<typeof rig>>) =>
    Object.values(r.requests.getState().requests).find((x) => x.stage === "awaiting-approval");

  it("checkOrigin rejects a blocked origin with 4100 and lets a trusted one through", async () => {
    const r = await rig();
    r.setPhishing("blocked");
    expect(() => r.connections.checkOrigin(SITE)).toThrow("origin is on the phishing list");
    await expect(codeOf(r.handler.handle(SITE, { method: "eth_accounts" }))).resolves.toBe(4100);
    r.setPhishing("trusted");
    expect(r.connections.checkOrigin(SITE).origin).toBe(SITE);
    r.setPhishing("unchecked");
    expect(r.connections.checkOrigin(SITE).origin).toBe(SITE);
    await r.destroy();
  });

  it("approving a connection fails with 4100 once the origin has been listed", async () => {
    const r = await rig();
    const accounts = r.handler.handle(SITE, { method: "eth_requestAccounts" });
    const settled = codeOf(accounts);
    await vi.waitFor(() => {
      expect(r.connections.pending()).toHaveLength(1);
    });
    const pending = r.connections.pending().find((p) => p.origin.origin === SITE);
    r.setPhishing("blocked");
    await expect(
      r.connections.approveConnection(idOf(pending), {
        accounts: [await r.addressAt(0)],
        network: MAINNET,
      }),
    ).rejects.toMatchObject({ code: 4100 });
    await expect(settled).resolves.toBe(4100);
    expect(r.connections.pending()).toHaveLength(0);
    expect(r.connections.session(SITE)).toBeUndefined();
    await r.destroy();
  });

  it("prepare refuses a blocked browser origin before claiming anything", async () => {
    const r = await rig();
    r.setPhishing("blocked");
    await expect(preparePersonalSign(r)).rejects.toThrow("origin is on the phishing list");
    r.setPhishing("clear");
    const pending = await preparePersonalSign(r);
    expect(pending.risk).toStrictEqual([]);
    await r.destroy();
  });

  it("marks a trusted origin as a danger and an unchecked one as a warning", async () => {
    const r = await rig();
    r.setPhishing("trusted");
    const trusted = await preparePersonalSign(r);
    expect(trusted.risk).toStrictEqual([{ code: "phishing-origin", level: "danger" }]);
    r.requests.invalidateOrigin(SITE);

    r.setPhishing("unchecked");
    const unchecked = await preparePersonalSign(r);
    expect(unchecked.risk).toStrictEqual([{ code: "phishing-unchecked", level: "warning" }]);
    await r.destroy();
  });

  it("approve fails without signing when the origin was listed after prepare", async () => {
    const r = await rig();
    await r.connect();
    const signature = codeOf(personalSign(r));
    await vi.waitFor(() => {
      expect(awaiting(r)).toBeDefined();
    });
    const request = awaiting(r);
    r.setPhishing("blocked");
    await expect(r.requests.approve(idOf(request), "evm-sign", VERIFY)).rejects.toThrow(
      "origin is on the phishing list",
    );
    expect(r.requests.getState().requests[idOf(request)]?.stage).toBe("failed");
    await expect(signature).resolves.toBe(-32_603);
    await r.destroy();
  });
});

const DAPP_RPC = "https://dapp-rpc.example/evil";
const chain = (overrides: Record<string, unknown> = {}) => ({
  chainId: "0xaa36a7",
  chainName: "Sepolia",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [DAPP_RPC],
  blockExplorerUrls: ["https://explorer.example"],
  ...overrides,
});
const addChain = async (r: Awaited<ReturnType<typeof rig>>, param: unknown) =>
  r.handler.handle(SITE, { method: "wallet_addEthereumChain", params: [param] });
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TOKEN_ADDRESS = "0x1111111111111111111111111111111111111111";
const watch = async (r: Awaited<ReturnType<typeof rig>>, params: unknown, origin = SITE) =>
  r.handler.handle(origin, { method: "wallet_watchAsset", params });
const erc20 = (options: Record<string, unknown>) => ({ type: "ERC20", options });

describe("wallet_addEthereumChain", () => {
  it.each([
    ["not an object", "x"],
    ["no chainId", chain({ chainId: undefined })],
    ["leading zero", chain({ chainId: "0x01" })],
    ["zero", chain({ chainId: "0x0" })],
    ["decimal chainId", chain({ chainId: "11155111" })],
    ["empty chainName", chain({ chainName: "" })],
    ["chainName not a string", chain({ chainName: 5 })],
    ["no nativeCurrency", chain({ nativeCurrency: undefined })],
    ["empty currency name", chain({ nativeCurrency: { name: "", symbol: "ETH", decimals: 18 } })],
    ["short symbol", chain({ nativeCurrency: { name: "E", symbol: "E", decimals: 18 } })],
    ["long symbol", chain({ nativeCurrency: { name: "E", symbol: "ETHERUM", decimals: 18 } })],
    ["decimals not 18", chain({ nativeCurrency: { name: "E", symbol: "ETH", decimals: 6 } })],
    ["no rpcUrls", chain({ rpcUrls: undefined })],
    ["empty rpcUrls", chain({ rpcUrls: [] })],
    ["rpcUrls not strings", chain({ rpcUrls: [1] })],
  ])("rejects %s with -32602", async (_name, param) => {
    const r = await rig();
    await expect(codeOf(addChain(r, param))).resolves.toBe(-32_602);
    await r.destroy();
  });

  it("accepts an upper-case chainId and ignores other keys", async () => {
    const r = await rig();
    await expect(addChain(r, chain({ chainId: "0xAA36A7", iconUrls: [1] }))).resolves.toBeNull();
    await r.destroy();
  });

  it("answers 4902 for a chain the wallet does not enable", async () => {
    const r = await rig();
    await expect(codeOf(addChain(r, chain({ chainId: "0x539" })))).resolves.toBe(4902);
    await r.destroy();
  });

  it("answers null without a session", async () => {
    const r = await rig();
    await expect(addChain(r, chain())).resolves.toBeNull();
    expect(r.connections.pending()).toHaveLength(0);
    await r.destroy();
  });

  it("answers null for a chain already in the session without asking", async () => {
    const r = await rig();
    await r.connect();
    await expect(addChain(r, chain({ chainId: "0x1" }))).resolves.toBeNull();
    expect(r.connections.pending()).toHaveLength(0);
    await r.destroy();
  });

  it("asks for approval for an enabled chain outside the session, then answers null", async () => {
    const r = await rig();
    await r.connect();
    const adding = addChain(r, chain());
    await vi.waitFor(() => {
      expect(r.connections.pending()).toHaveLength(1);
    });
    const [pending] = r.connections.pending();
    expect(pending).toMatchObject({ kind: "network", network: SEPOLIA });
    await r.connections.approveConnection(idOf(pending), {
      accounts: [await r.addressAt(0, SEPOLIA)],
      network: SEPOLIA,
    });
    await expect(adding).resolves.toBeNull();
    expect(r.connections.session(SITE)?.currentNetwork).toBe(MAINNET);
    await r.destroy();
  });

  it("never fetches or stores the dApp's rpcUrls", async () => {
    const r = await rig();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await r.connect();
    const adding = addChain(r, chain());
    await vi.waitFor(() => {
      expect(r.connections.pending()).toHaveLength(1);
    });
    r.connections.rejectConnection(idOf(r.connections.pending()[0]));
    await adding.catch(() => undefined);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.fetchedUrls.some((url) => url.includes("dapp-rpc.example"))).toBe(false);
    expect(r.networks.endpoints(SEPOLIA)).not.toContain(DAPP_RPC);
    expect(r.networks.getState().customRpc).toStrictEqual({});
    fetchSpy.mockRestore();
    await r.destroy();
  });
});

describe("wallet_watchAsset", () => {
  const awaitingWatch = (r: Awaited<ReturnType<typeof rig>>) =>
    Object.values(r.requests.getState().requests).find(
      (x) => x.method === "watch-asset" && x.stage === "awaiting-approval",
    );

  it("rejects an unauthorized origin with 4100", async () => {
    const r = await rig();
    await expect(codeOf(watch(r, erc20({ address: TOKEN_ADDRESS })))).resolves.toBe(4100);
    await r.destroy();
  });

  it.each([
    ["array params", [erc20({ address: TOKEN_ADDRESS })]],
    ["no type", { options: { address: TOKEN_ADDRESS } }],
    ["ERC721", { type: "ERC721", options: { address: TOKEN_ADDRESS } }],
    ["no options", { type: "ERC20" }],
    ["no address", erc20({})],
    ["short address", erc20({ address: "0x1234" })],
    ["address not hex", erc20({ address: `0x${"zz".repeat(20)}` })],
    ["chainId of another network", erc20({ address: TOKEN_ADDRESS, chainId: 11_155_111 })],
  ])("rejects %s with -32602", async (_name, params) => {
    const r = await rig();
    await r.connect();
    await expect(codeOf(watch(r, params))).resolves.toBe(-32_602);
    await r.destroy();
  });

  it("answers true without asking for a token that is already tracked", async () => {
    const r = await rig();
    await r.connect();
    r.tokenState.tracked.add(USDC_ADDRESS.toLowerCase());
    await expect(watch(r, erc20({ address: USDC_ADDRESS.toLowerCase() }))).resolves.toBe(true);
    expect(awaitingWatch(r)).toBeUndefined();
    expect(r.tokenState.added).toStrictEqual([]);
    await r.destroy();
  });

  it("shows the on-chain token, adds it on approval and answers true", async () => {
    const r = await rig();
    await r.connect();
    const watching = watch(
      r,
      erc20({
        address: TOKEN_ADDRESS,
        symbol: "LIE",
        decimals: 2,
        image: "https://img.example/x.png",
        chainId: "0x1",
      }),
    );
    await vi.waitFor(() => {
      expect(awaitingWatch(r)).toBeDefined();
    });
    const request = awaitingWatch(r);
    expect(request?.display).toStrictEqual({
      kind: "token.watch",
      network: MAINNET,
      address: TOKEN_ADDRESS,
      symbol: "TKN",
      decimals: 18,
      verified: false,
    });
    expect(request?.risk).toStrictEqual([]);
    await r.requests.approve(idOf(request), "watch-asset");
    await expect(watching).resolves.toBe(true);
    expect(r.tokenState.added).toStrictEqual([TOKEN_ADDRESS]);
    const log = await r.requests.signLog();
    expect(log[0]).toMatchObject({
      method: "watch-asset",
      outcome: "submitted",
      summary: "watch token TKN",
    });
    await r.destroy();
  });

  it("answers 4001 when the user rejects", async () => {
    const r = await rig();
    await r.connect();
    const watching = codeOf(watch(r, erc20({ address: TOKEN_ADDRESS })));
    await vi.waitFor(() => {
      expect(awaitingWatch(r)).toBeDefined();
    });
    r.requests.reject(idOf(awaitingWatch(r)));
    await expect(watching).resolves.toBe(4001);
    expect(r.tokenState.added).toStrictEqual([]);
    await r.destroy();
  });

  it("marks a lookalike of a built-in symbol as a danger", async () => {
    const r = await rig();
    await r.connect();
    r.tokenState.metadata = { symbol: "usdc", decimals: 6 };
    const watching = codeOf(watch(r, erc20({ address: TOKEN_ADDRESS })));
    await vi.waitFor(() => {
      expect(awaitingWatch(r)).toBeDefined();
    });
    const request = awaitingWatch(r);
    expect(request?.risk).toContainEqual({ code: "token-impersonation", level: "danger" });
    r.requests.reject(idOf(request));
    await watching;
    await r.destroy();
  });

  it.each([
    ["a control character", "T\u0007K"],
    ["a bidi override", "T\u202EK"],
    ["a zero-width space", "T\u200BK"],
    ["too long a symbol", "S".repeat(33)],
    ["an empty symbol", " "],
  ])("rejects %s in the on-chain symbol with -32602 before any approval", async (_name, symbol) => {
    const r = await rig();
    await r.connect();
    r.tokenState.metadata = { symbol, decimals: 18 };
    await expect(codeOf(watch(r, erc20({ address: TOKEN_ADDRESS })))).resolves.toBe(-32_602);
    expect(awaitingWatch(r)).toBeUndefined();
    await r.destroy();
  });

  it.each([-1, 37, 1.5])("rejects decimals %s with -32602", async (decimals) => {
    const r = await rig();
    await r.connect();
    r.tokenState.metadata = { symbol: "TKN", decimals };
    await expect(codeOf(watch(r, erc20({ address: TOKEN_ADDRESS })))).resolves.toBe(-32_602);
    await r.destroy();
  });

  it("warns about a non-ASCII symbol such as a Cyrillic lookalike", async () => {
    const r = await rig();
    await r.connect();
    r.tokenState.metadata = { symbol: "USDС", decimals: 6 };
    const watching = codeOf(watch(r, erc20({ address: TOKEN_ADDRESS })));
    await vi.waitFor(() => {
      expect(awaitingWatch(r)).toBeDefined();
    });
    const request = awaitingWatch(r);
    expect(request?.risk).toContainEqual({ code: "token-symbol-unicode", level: "warning" });
    r.requests.reject(idOf(request));
    await watching;
    await r.destroy();
  });

  it("refuses a blocked origin before anything", async () => {
    const r = await rig();
    await r.connect();
    r.setPhishing("blocked");
    await expect(codeOf(watch(r, erc20({ address: TOKEN_ADDRESS })))).resolves.toBe(4100);
    await r.destroy();
  });
});

describe("pending connection limits", () => {
  const origin = (n: number): string => `https://site${String(n)}.example`;
  const settle = async (run: Promise<unknown>): Promise<number | string> => codeOf(run);

  it("caps pending requests at 64 across distinct origins", async () => {
    const r = await rig();
    const requests = Array.from({ length: MAX_PENDING_CONNECTIONS }, async (_, n) =>
      settle(r.connections.request(origin(n), { kind: "connect" })),
    );
    expect(r.connections.pending()).toHaveLength(MAX_PENDING_CONNECTIONS);
    await expect(
      settle(r.connections.request(origin(MAX_PENDING_CONNECTIONS), { kind: "connect" })),
    ).resolves.toBe(-32_002);
    expect(r.connections.pending()).toHaveLength(MAX_PENDING_CONNECTIONS);
    r.connections.lock();
    await expect(Promise.all(requests)).resolves.toStrictEqual(
      Array.from({ length: MAX_PENDING_CONNECTIONS }, () => 4001),
    );
    await r.destroy();
  });

  it("still dedupes by origin", async () => {
    const r = await rig();
    const first = settle(r.connections.request(SITE, { kind: "connect" }));
    await expect(settle(r.connections.request(SITE, { kind: "connect" }))).resolves.toBe(-32_002);
    expect(r.connections.pending()).toHaveLength(1);
    r.connections.lock();
    await first;
    await r.destroy();
  });

  it("expires an unanswered request: rejects with 4001 and clears the entry", async () => {
    const r = await rig();
    const pending = settle(r.connections.request(SITE, { kind: "connect" }));
    const timer = r.connectionTimers.find((t) => t.ms === CONNECTION_REQUEST_TTL_MS);
    expect(timer).toBeDefined();
    timer?.fn();
    await expect(pending).resolves.toBe(4001);
    expect(r.connections.pending()).toHaveLength(0);
    await r.destroy();
  });

  it("cancels the timer on approve, reject, navigation and lock", async () => {
    const r = await rig();
    const cancelled = (): number => r.connectionTimers.filter((t) => t.cancelled).length;
    const rejected = settle(r.connections.request(origin(1), { kind: "connect" }));
    r.connections.rejectConnection(idOf(r.connections.pending()[0]));
    await rejected;
    expect(cancelled()).toBe(1);

    const navigated = settle(r.connections.request(origin(2), { kind: "connect" }));
    r.connections.invalidateOrigin(origin(2));
    await navigated;
    expect(cancelled()).toBe(2);

    const approving = settle(r.connections.request(origin(3), { kind: "connect" }));
    await r.connections.approveConnection(idOf(r.connections.pending()[0]), {
      accounts: [await r.addressAt(0)],
      network: MAINNET,
    });
    await approving;
    expect(cancelled()).toBe(3);

    const locked = settle(r.connections.request(origin(4), { kind: "connect" }));
    r.connections.lock();
    await locked;
    expect(cancelled()).toBe(4);
    expect(r.connections.pending()).toHaveLength(0);
    await r.destroy();
  });
});
