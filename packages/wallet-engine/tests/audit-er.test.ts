/**
 * Security-audit PoCs for the engine-requests lane. Every test asserts the CURRENT behaviour of
 * the code under test — the assertions document the finding, including where that behaviour is
 * wrong. The rig is the `connect.test.ts` rig extended with a mutable selected group, the Solana
 * network and a `SolanaWalletHandler` over the same controllers.
 */
import { randomBytes } from "node:crypto";

import { recoverMessageAddress } from "viem";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Event } from "@qntx/nostr";
import { verifyEvent } from "@qntx/nostr";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  compileTransactionMessage,
  createNoopSigner,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";

import type { Wallet } from "@qntx/wallet";
import type { NostrKeyRef } from "@qntx/wallet";
import type { WalletSigner } from "@qntx/wallet/nostr";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";
import { ChainError, isBlindIntent } from "@qntx/wallet-chains";
import type { SignRequest } from "@qntx/wallet-chains";
import { decodeEvm } from "@qntx/wallet-chains/evm";
import { normalizeSolana } from "@qntx/wallet-chains/solana";

import { ConnectionController } from "../src/connect/controller.ts";
import type { ConnectionSession, NostrPolicy } from "../src/connect/controller.ts";
import { Eip1193Handler } from "../src/connect/eip1193.ts";
import type { Eip1193Event } from "../src/connect/eip1193.ts";
import { ProviderError } from "../src/connect/errors.ts";
import { createBrowserBridge } from "../src/connect/index.ts";
import { Nip07Handler } from "../src/connect/nip07.ts";
import type { Nip07HandlerOptions } from "../src/connect/nip07.ts";
import { SOLANA_CHAIN_IDS, SolanaWalletHandler } from "../src/connect/solana.ts";
import type { SolanaEvent } from "../src/connect/solana.ts";
import { NetworkController } from "../src/networks/controller.ts";
import type { PhishingStatus } from "../src/phishing/status.ts";
import { RequestController } from "../src/requests/controller.ts";
import type {
  NostrSignResult,
  PendingRequest,
  RequestControllerOptions,
} from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { approval } from "./approval.ts";
import { bookDeps, simulateSolanaStub, idleNetworkDeps } from "./send-helpers.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password" as const, password: PASSWORD };
const SITE = "https://app.example";
const MAINNET = "eip155:1";
const SEPOLIA = "eip155:11155111";
const NOSTR_PUBKEYS = ["a".repeat(64), "b".repeat(64)] as const;
const SOLANA_MAINNET = SOLANA_CHAIN_IDS["solana:mainnet"] ?? "solana:missing";
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

/** Like {@link codeOf} but keeps a resolved value too. */
const settled = async (
  run: Promise<unknown>,
): Promise<{ readonly value?: unknown; readonly code?: number | string }> =>
  run.then(
    (value) => ({ value }),
    (error: unknown) => ({ code: error instanceof ProviderError ? error.code : String(error) }),
  );

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

const awaiting = (r: Awaited<ReturnType<typeof rig>>): PendingRequest | undefined =>
  Object.values(r.requests.getState().requests).find((x) => x.stage === "awaiting-approval");

async function rig(
  options: {
    allowLocalhost?: boolean;
    blindSigning?: boolean;
    simulateSolana?: RequestControllerOptions["simulateSolana"];
  } = {},
) {
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
  await wallet.vault.setBlindSigning(options.blindSigning ?? false, VERIFY);
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
    blindSigning: () => wallet.getSnapshot().blindSigning,
    simulateSolana: options.simulateSolana ?? simulateSolanaStub,
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
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
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
  let selectedIndex = 0;
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
    // The app-level selection the host would mirror with `setActiveGroup` — mutable, so a test can
    // move it without going through the controller (AccountTreeController.select).
    selectedGroup: () => ({ walletId, groupIndex: selectedIndex }),
    evmAddress: async (group: { walletId: string; groupIndex: number }, network: string) =>
      addressAt(group.groupIndex, network),
    enabledNetworks: () => [MAINNET, SEPOLIA, SOLANA_MAINNET],
    bitcoinAddress: async () => Promise.resolve("bc1qunused"),
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
    delegationState: async () => {
      await Promise.resolve();
      return { supported: true, state: "none" };
    },
    batches: {
      record: async () => {
        await Promise.resolve();
      },
      get: () => undefined,
    },
    txById: () => undefined,
    showCallsStatus: () => undefined,
    now: () => 0,
    random: (n) => new Uint8Array(n),
  });
  const events: Eip1193Event[] = [];
  handler.subscribe((event) => events.push(event));
  const solanaHandler = new SolanaWalletHandler({
    connections,
    requests,
    solanaAccount: async (group, network) => {
      await Promise.resolve();
      return {
        address: `SoLaNaAdd${String(group.groupIndex)}-${network}`,
        publicKey: new Uint8Array(32).fill(group.groupIndex + 1),
      };
    },
    activeGroup: () => connections.activeGroup(),
    solanaNetwork: () => SOLANA_MAINNET,
  });

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
    const pendingOf = () =>
      Object.values(requests.getState().requests).find(
        (q) =>
          q.origin.kind === "browser" &&
          q.origin.origin === origin &&
          q.stage === "awaiting-approval",
      );
    await vi.waitFor(() => {
      expect(pendingOf()).toBeDefined();
    });
    const request = pendingOf();
    await requests.approve(request?.id ?? "", "evm-sign", approval(request, VERIFY));
  };

  const r = {
    wallet,
    walletId,
    addressAt,
    connections,
    connectionOptions,
    backing,
    requests,
    networks,
    transactions,
    handler,
    solanaHandler,
    events,
    rpcCalls,
    connect,
    approveNext,
    select: (index: number) => {
      selectedIndex = index;
    },
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
  return r;
}

/** Approves the pending `solana` connection the way a host would. */
const solanaConnect = async (r: Awaited<ReturnType<typeof rig>>): Promise<unknown> => {
  const connecting = r.solanaHandler.handle(SITE, { method: "standard:connect" });
  await vi.waitFor(() => {
    expect(r.connections.pending()).toHaveLength(1);
  });
  await r.connections.approveConnection(pendingId(r.connections), {
    accounts: [],
    network: SOLANA_MAINNET,
  });
  return connecting;
};

describe("audit: engine-requests", () => {
  it("ER-01 approve signs after the request was invalidated by revoke", async () => {
    const r = await rig();
    await r.connect();
    const addr0 = await r.addressAt(0);
    const dapp = settled(
      r.handler.handle(SITE, { method: "personal_sign", params: ["0x68656c6c6f", addr0] }),
    );
    await vi.waitFor(() => {
      expect(awaiting(r)).toBeDefined();
    });
    const request = awaiting(r);
    const id = request?.id ?? "";
    const stages: string[] = [];
    const unsubscribe = r.requests.store.subscribe((state) => {
      const stage = state.requests[id]?.stage;
      if (stage !== undefined && stages.at(-1) !== stage) {
        stages.push(stage);
      }
    });
    const approving = r.requests.approve(id, "evm-sign", approval(request, VERIFY));
    await r.connections.revoke(SITE);
    // The dApp call was settled by the invalidation; the in-flight approve keeps signing anyway.
    await expect(dapp).resolves.toStrictEqual({ code: 4001 });
    const result = await approving;
    expect("signature" in result && result.signature instanceof Uint8Array).toBe(true);
    const hex = `0x${Buffer.from(
      "signature" in result ? result.signature : new Uint8Array(),
    ).toString("hex")}` as `0x${string}`;
    await expect(recoverMessageAddress({ message: "hello", signature: hex })).resolves.toBe(addr0);
    expect(stages.indexOf("invalidated")).toBeGreaterThanOrEqual(0);
    expect(stages.indexOf("invalidated")).toBeLessThan(stages.indexOf("submitted"));
    expect(r.requests.getState().requests[id]?.stage).toBe("submitted");
    unsubscribe();
    await r.destroy();
  });

  it("ER-01b approve signs after the request was invalidated by invalidateOrigin (navigation)", async () => {
    const r = await rig();
    await r.connect();
    const addr0 = await r.addressAt(0);
    const dapp = settled(
      r.handler.handle(SITE, { method: "personal_sign", params: ["0x68656c6c6f", addr0] }),
    );
    await vi.waitFor(() => {
      expect(awaiting(r)).toBeDefined();
    });
    const request = awaiting(r);
    const id = request?.id ?? "";
    const stages: string[] = [];
    const unsubscribe = r.requests.store.subscribe((state) => {
      const stage = state.requests[id]?.stage;
      if (stage !== undefined && stages.at(-1) !== stage) {
        stages.push(stage);
      }
    });
    const approving = r.requests.approve(id, "evm-sign", approval(request, VERIFY));
    r.requests.invalidateOrigin(SITE);
    await expect(dapp).resolves.toStrictEqual({ code: 4001 });
    const result = await approving;
    expect("signature" in result && result.signature instanceof Uint8Array).toBe(true);
    const hex = `0x${Buffer.from(
      "signature" in result ? result.signature : new Uint8Array(),
    ).toString("hex")}` as `0x${string}`;
    await expect(recoverMessageAddress({ message: "hello", signature: hex })).resolves.toBe(addr0);
    expect(stages.indexOf("invalidated")).toBeGreaterThanOrEqual(0);
    expect(stages.indexOf("invalidated")).toBeLessThan(stages.indexOf("submitted"));
    expect(r.requests.getState().requests[id]?.stage).toBe("submitted");
    unsubscribe();
    await r.destroy();
  });

  it("ER-02 an account-group switch does not invalidate a pending request", async () => {
    const r = await rig();
    await r.connect();
    const addr0 = await r.addressAt(0);
    const dapp = r.handler.handle(SITE, {
      method: "personal_sign",
      params: ["0x68656c6c6f", addr0],
    });
    await vi.waitFor(() => {
      expect(awaiting(r)).toBeDefined();
    });
    const request = awaiting(r);
    const addr1 = await lower(r.addressAt(1));
    await r.connections.setActiveGroup(r.walletId, 1);
    expect(r.connections.accounts(SITE)).toStrictEqual([addr1]);
    expect(r.events.filter((e) => e.name === "accountsChanged").at(-1)).toStrictEqual({
      name: "accountsChanged",
      origin: SITE,
      accounts: [addr1],
    });
    expect(r.requests.getState().requests[request?.id ?? ""]?.stage).toBe("awaiting-approval");
    await r.requests.approve(request?.id ?? "", "evm-sign", approval(request, VERIFY));
    const hex = (await dapp) as `0x${string}`;
    await expect(recoverMessageAddress({ message: "hello", signature: hex })).resolves.toBe(addr0);
    await r.destroy();
  });

  it("ER-03 signing follows the app selection while the session's accounts stay on the old group", async () => {
    const r = await rig();
    await r.connect();
    const addr0 = await r.addressAt(0);
    const addr1 = await r.addressAt(1);
    r.select(1);
    await expect(r.handler.handle(SITE, { method: "eth_accounts" })).resolves.toStrictEqual([
      addr0.toLowerCase(),
    ]);
    const dapp = r.handler.handle(SITE, {
      method: "personal_sign",
      params: ["0x68656c6c6f", addr0],
    });
    await vi.waitFor(() => {
      expect(awaiting(r)).toBeDefined();
    });
    const request = awaiting(r);
    expect(request?.account).toMatchObject({ groupIndex: 1 });
    await r.requests.approve(request?.id ?? "", "evm-sign", approval(request, VERIFY));
    const hex = (await dapp) as `0x${string}`;
    expect(addr1).not.toBe(addr0);
    await expect(recoverMessageAddress({ message: "hello", signature: hex })).resolves.toBe(addr1);
    await r.destroy();
  });

  it("ER-03b solana standard:connect answers from the app selection, not the session account", async () => {
    const r = await rig();
    const connected = (await solanaConnect(r)) as { accounts: Array<{ address: string }> };
    expect(connected.accounts[0]?.address).toBe(`SoLaNaAdd0-${SOLANA_MAINNET}`);
    // `solanaAccount` slices the CAIP-10 account after its LAST colon; the stubbed address itself
    // contains a colon, so what it returns is the network tail, not the group-0 address string.
    expect(r.connections.solanaAccount(SITE, SOLANA_MAINNET)).toBe(
      SOLANA_MAINNET.slice("solana:".length),
    );
    expect(r.connections.session(SITE)?.scopes[SOLANA_MAINNET]?.accounts).toStrictEqual([
      `${SOLANA_MAINNET}:SoLaNaAdd0-${SOLANA_MAINNET}`,
    ]);
    r.select(1);
    const silent = (await r.solanaHandler.handle(SITE, {
      method: "standard:connect",
      params: { silent: true },
    })) as { accounts: Array<{ address: string }> };
    expect(r.connections.pending()).toHaveLength(0);
    expect(silent.accounts[0]?.address).toBe(`SoLaNaAdd1-${SOLANA_MAINNET}`);
    // The session's account is still the group-0 grant.
    expect(r.connections.session(SITE)?.scopes[SOLANA_MAINNET]?.accounts).toStrictEqual([
      `${SOLANA_MAINNET}:SoLaNaAdd0-${SOLANA_MAINNET}`,
    ]);
    await r.destroy();
  });

  it("ER-04 the solana change event after disconnect carries an account", async () => {
    const r = await rig();
    const solEvents: SolanaEvent[] = [];
    r.solanaHandler.subscribe((event) => solEvents.push(event));
    await solanaConnect(r);
    await vi.waitFor(() => {
      expect(solEvents.filter((e) => e.origin === SITE)).not.toHaveLength(0);
    });
    await r.solanaHandler.handle(SITE, { method: "standard:disconnect" });
    await vi.waitFor(() => {
      expect(solEvents.filter((e) => e.origin === SITE).length).toBeGreaterThanOrEqual(2);
    });
    const last = solEvents.filter((e) => e.origin === SITE).at(-1);
    // Per the Wallet Standard a disconnect should emit `change` with no accounts; it carries one.
    expect(last?.name).toBe("solanaAccountsChanged");
    expect(last?.accounts).toHaveLength(1);
    expect(r.connections.session(SITE)).toBeUndefined();
    await r.destroy();
  });

  it("ER-05 unknown-shape EIP-712 is refused with 4200 by default", async () => {
    const r = await rig();
    await r.connect();
    const addr0 = await r.addressAt(0);
    await expect(
      codeOf(r.handler.handle(SITE, { method: "eth_signTypedData_v4", params: [addr0, TYPED] })),
    ).resolves.toBe(4200);
    expect(Object.values(r.requests.getState().requests)).toHaveLength(0);
    await r.destroy();
  });

  it("ER-05b an arbitrary contract call decodes opaque and counts as blind", () => {
    const request: SignRequest = {
      kind: "evm.transaction",
      network: "eip155:1",
      account: { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" },
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        to: "0x00000000000000000000000000000000000000aa",
        value: "0x0",
        data: "0x12345678",
        accessList: [],
        maxFeePerGas: "0x1",
        maxPriorityFeePerGas: "0x1",
      },
    };
    const intent = decodeEvm(request, "0x1111111111111111111111111111111111111111");
    expect(intent.verifiability).toBe("opaque");
    expect(isBlindIntent(intent)).toBe(true);
  });

  it("ER-06 approving an added network drops the origin's NIP-07 policy", async () => {
    const r = await rig();
    await r.connect();
    await r.connections.setActiveIdentity({ kind: "derived", walletId: r.walletId, index: 0 });
    const policy: NostrPolicy = { signing: "always", decrypt: true };
    const pending = r.connections.request(SITE, { kind: "connect", namespace: "nostr" });
    await vi.waitFor(() => {
      expect(r.connections.pending()).toHaveLength(1);
    });
    await r.connections.approveConnection(pendingId(r.connections), {
      accounts: [await r.addressAt(0)],
      network: MAINNET,
      nostr: { pubkey: NOSTR_PUBKEYS[0] ?? "", policy },
    });
    await pending;
    expect(r.connections.nostrPolicy(SITE)).toStrictEqual(policy);
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
    expect(r.connections.nostrPolicy(SITE)).toBeUndefined();
    expect(r.connections.session(SITE)?.scopes["nostr"]).toBeDefined();
    await r.destroy();
  });

  it("ER-07 a TransactionController-prepared request signs with no approve or acknowledgement", async () => {
    const r = await rig();
    const addr0 = await r.addressAt(0);
    const account = {
      kind: "hd" as const,
      walletId: r.walletId,
      groupIndex: 0,
      template: "evm.bip44" as const,
    };
    const prepared = await r.transactions.prepareDapp(account, {
      kind: "evm.personal-message",
      network: MAINNET,
      account,
      message: new TextEncoder().encode("hello"),
    });
    const out = await prepared.submit(VERIFY);
    expect("signature" in out && out.signature instanceof Uint8Array).toBe(true);
    const hex = `0x${Buffer.from(
      "signature" in out ? out.signature : new Uint8Array(),
    ).toString("hex")}` as `0x${string}`;
    await expect(recoverMessageAddress({ message: "hello", signature: hex })).resolves.toBe(addr0);
    expect(Object.keys(r.requests.getState().requests)).toHaveLength(0);
    await expect(r.requests.signLog()).resolves.toHaveLength(0);
    await r.destroy();
  });

  it("ER-08 same-origin navigation delivers an old document's reply into the new one", async () => {
    let resolveHandle: ((value: unknown) => void) | undefined;
    const deferred = new Promise((resolve) => {
      resolveHandle = resolve;
    });
    const injected: string[] = [];
    const invalidateOrigin = vi.fn();
    const bridge = createBrowserBridge({
      inject: (script) => {
        injected.push(script);
      },
      now: () => 0,
      eip1193: {
        handle: async () => deferred,
        subscribe: () => () => undefined,
      },
      nip07: { handle: async () => Promise.resolve("nostr") },
      webln: { handle: async () => Promise.resolve("webln") },
      solana: {
        handle: async () => Promise.resolve("solana"),
        subscribe: () => () => undefined,
      },
      bitcoin: {
        handle: async () => Promise.resolve("bitcoin"),
        subscribe: () => () => undefined,
      },
      connections: {
        checkOrigin: (origin) => ({ kind: "browser", origin }),
        invalidateOrigin: (origin) => {
          invalidateOrigin(origin);
        },
      },
    });
    bridge.navigated("https://app.example/a");
    bridge.message(
      "https://app.example/a",
      JSON.stringify({ qntx: 1, provider: "eip1193", id: 1, method: "personal_sign" }),
    );
    bridge.navigated("https://app.example/b");
    resolveHandle?.("0xsig");
    await vi.waitFor(() => {
      expect(injected).not.toHaveLength(0);
    });
    expect(invalidateOrigin).not.toHaveBeenCalled();
    const last = injected.at(-1) ?? "";
    expect(last).toContain(String.raw`\"id\":1`);
    expect(last).toContain("0xsig");
  });

  it("ER-11 the NIP-07 'always' policy signs ephemeral auth/control kinds with no request", async () => {
    const ORIGIN = "https://dapp.example";
    const REF: NostrKeyRef = { kind: "derived", walletId: "w", index: 0 };
    const PUBKEY = "aa".repeat(32);
    const SIGNED: Event = {
      id: "e1",
      sig: "s",
      pubkey: PUBKEY,
      kind: 1,
      content: "hi",
      created_at: 1,
      tags: [],
    };
    const signedInputs: unknown[] = [];
    const signer: WalletSigner = {
      unwrapGiftWraps: async () => Promise.resolve([]),
      getPublicKey: async () => Promise.resolve(PUBKEY),
      signEvent: async (event) => {
        signedInputs.push(event);
        return Promise.resolve(SIGNED);
      },
      nip04Encrypt: async () => Promise.resolve("c04"),
      nip04Decrypt: async () => Promise.resolve("p04"),
      nip44Encrypt: async () => Promise.resolve("c44"),
      nip44Decrypt: async () => Promise.resolve("p44"),
    };
    const policy: NostrPolicy = { signing: "always", decrypt: false };
    const session: ConnectionSession = {
      id: "s1",
      origin: { kind: "browser", origin: ORIGIN },
      scopes: {
        nostr: { accounts: [`nostr:${PUBKEY}`], methods: ["signEvent"], notifications: [] },
      },
      currentNetwork: "",
      nostrPolicy: policy,
      createdAt: 0,
      lastUsedAt: 0,
    };
    const connections: Nip07HandlerOptions["connections"] = {
      checkOrigin: (origin) => ({ kind: "browser", origin }),
      authorize: () => session,
      session: () => session,
      nostrAccount: () => PUBKEY,
      nostrPolicy: () => policy,
      activeIdentity: () => REF,
      request: async () => Promise.resolve(session),
      touch: async () => Promise.resolve(),
    };
    const prepared: string[] = [];
    const requests: Nip07HandlerOptions["requests"] = {
      prepare: async () => {
        const id = `req-${prepared.length}`;
        prepared.push(id);
        return Promise.resolve({ id } as PendingRequest);
      },
      outcome: async () => Promise.resolve({ kind: "nostr.event", event: SIGNED } as NostrSignResult),
    };
    const handler = new Nip07Handler({ connections, requests, signerFor: () => signer });
    for (const kind of [27235, 22242, 23194, 24133]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time keeps failures readable
      const signed = await handler.handle(ORIGIN, {
        method: "signEvent",
        params: [{ kind, content: "auth", created_at: 1, tags: [] }],
      });
      expect(signed).toMatchObject({ id: "e1" });
      expect(signedInputs.at(-1)).toMatchObject({ kind, pubkey: PUBKEY });
    }
    expect(prepared).toHaveLength(0);
  });

  it("ER-12 solana:signTransaction treats a serialized transaction as a compiled message", async () => {
    const FEE_PAYER = "11111111111111111111111111111112";
    const payer = createNoopSigner(address(FEE_PAYER));
    let message = setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: address("11111111111111111111111111111111"),
        lastValidBlockHeight: 1000n,
      } as never,
      setTransactionMessageFeePayer(
        address(FEE_PAYER),
        createTransactionMessage({ version: "legacy" }),
      ),
    );
    message = appendTransactionMessageInstruction(
      getTransferSolInstruction({
        source: payer,
        destination: address("8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR"),
        amount: 1000n,
      }) as never,
      message as never,
    );
    const messageBytes = new Uint8Array(
      getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message as never)),
    );
    // What the Wallet Standard actually sends: the serialized transaction (signature slots + message).
    const wire = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message as never)));
    const request = (body: Uint8Array): SignRequest => ({
      kind: "solana.transaction",
      network: SOLANA_MAINNET,
      account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44-change" },
      message: body,
    });
    expect(() => normalizeSolana(request(messageBytes), FEE_PAYER)).not.toThrow();
    let thrown: unknown;
    try {
      normalizeSolana(request(wire), FEE_PAYER);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ChainError);
    expect((thrown as ChainError).message).toBe("compiled message has trailing bytes");

    const r = await rig({
      simulateSolana: async () => Promise.resolve({ status: "success", changes: [] }),
    });
    const pending = await r.requests.prepare({
      method: "solana-sign",
      origin: { kind: "browser", origin: SITE },
      account: { walletId: "w", groupIndex: 0, address: FEE_PAYER },
      network: SOLANA_MAINNET,
      request: { kind: "transactions", transactions: [wire], send: false },
    });
    expect(pending.display).toMatchObject({
      kind: "solana.sign",
      transactions: [{ error: "compiled message has trailing bytes" }],
    });
    expect(pending.verification).toBe("verified");
    expect(pending.checks).toStrictEqual([]);
    expect(pending.risk).toStrictEqual([]);
    await r.destroy();
  });
});
