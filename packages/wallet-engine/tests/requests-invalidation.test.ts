import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  address,
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  createNoopSigner,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";

import type { Wallet } from "@qntx/wallet";
import type { PasskeyCeremony } from "@qntx/wallet/host";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import { ConnectionController } from "../src/connect/controller.ts";
import { Eip1193Handler } from "../src/connect/eip1193.ts";
import type { Eip1193Event } from "../src/connect/eip1193.ts";
import { ProviderError } from "../src/connect/errors.ts";
import { SOLANA_CHAIN_IDS } from "../src/connect/solana.ts";
import { createWalletEngine } from "../src/engine.ts";
import { NetworkController } from "../src/networks/controller.ts";
import type { PhishingStatus } from "../src/phishing/status.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { PendingRequest } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { approval } from "./approval.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, simulateV1Result } from "./send-helpers.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password" as const, password: PASSWORD };
const SITE = "https://app.example";
const MAINNET = "eip155:1";
const SEPOLIA = "eip155:11155111";
const SOL_NET = SOLANA_CHAIN_IDS["solana:mainnet"] ?? "solana:missing";
const logger = { warn: () => undefined };

const settled = async (
  run: Promise<unknown>,
): Promise<{ readonly value?: unknown; readonly code?: number | string }> =>
  run.then(
    (value) => ({ value }),
    (error: unknown) => ({ code: error instanceof ProviderError ? error.code : String(error) }),
  );

const awaiting = (r: Awaited<ReturnType<typeof rig>>): PendingRequest | undefined =>
  Object.values(r.requests.getState().requests).find((x) => x.stage === "awaiting-approval");

const latch = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** Every JSON-RPC answer a plain EOA send on mainnet needs. */
const EVM_ANSWERS: Record<string, unknown> = {
  eth_chainId: "0x1",
  eth_blockNumber: "0x1",
  eth_call: `0x${"00".repeat(32)}`,
  eth_getTransactionCount: "0x0",
  eth_estimateGas: "0x5208",
  eth_feeHistory: {
    baseFeePerGas: ["0x64", "0x64"],
    reward: [
      ["0x1", "0x2", "0x3"],
      ["0x1", "0x2", "0x3"],
    ],
  },
  eth_gasPrice: "0x1",
  eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
  eth_getTransactionReceipt: { status: "0x1", blockNumber: "0x1", blockHash: "0x1" },
  eth_getBlockByNumber: { number: "0x2" },
};

async function rig() {
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
  const fetchImpl: typeof globalThis.fetch = (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown };
    rpcCalls.push(body.method);
    const result = body.method === "eth_simulateV1" ? simulateV1Result(body.params) : EVM_ANSWERS[body.method];
    return Promise.resolve(
      result === undefined
        ? Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32_601, message: `method not found: ${body.method}` },
          })
        : Response.json({ jsonrpc: "2.0", id: body.id, result }),
    );
  };
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: fetchImpl,
    rpc: { [MAINNET]: ["https://rpc.example"], [SEPOLIA]: ["https://sepolia.example"] },
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    logger,
  });
  // The chains test seam: the real proxy, so the signature is real — `afterSign` runs between the
  // kernel answer and the caller's next line, exactly where invalidation used to be lost.
  const signedNonces: number[] = [];
  const seam: { afterSign: (() => void) | undefined } = { afterSign: undefined };
  const wrapped = {
    account: apis.account,
    sign: (params: Parameters<typeof apis.sign>[0]) => {
      const { request } = params;
      if (request.kind === "evm.transaction") {
        signedNonces.push(request.tx.nonce);
      }
      return apis.sign(params).then((result) => {
        seam.afterSign?.();
        return result;
      });
    },
  };
  const transactions = new TransactionController({
    wallet,
    networks,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    random,
    setTimer: () => () => undefined,
    now: () => 1000,
    logger,
    chains: wrapped,
  });
  await transactions.init();
  let phishingStatus: PhishingStatus = "clear";
  const phishing = { check: () => phishingStatus };
  const requests = new RequestController({
    phishing,
    blindSigning: () => wallet.getSnapshot().blindSigning,
    simulateSolana: simulateSolanaStub,
    tokens: {
      metadata: async () => Promise.reject(new Error("tokens are not wired in this test")),
      add: async () => Promise.resolve(),
    },
    transactions,
    ...bookDeps(),
    spark: {} as SparkController,
    nostrSign: async () => Promise.reject(new Error("nostr-sign is not wired in this test")),
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("solana-sign is not wired in this test")),
    fetch: fetchImpl,
    random,
    now: () => 1000,
    setTimer: () => () => undefined,
    logger,
  });
  await requests.init();
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const clock = 1_800_000_000_000;
  const connections = new ConnectionController({
    phishing,
    setTimer: () => () => undefined,
    openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
    random,
    now: () => clock,
    logger,
    allowLocalhost: false,
    selectedGroup: () => ({ walletId, groupIndex: 0 }),
    evmAddress: async (group: { walletId: string; groupIndex: number }, network: string) =>
      addressAt(group.groupIndex, network),
    enabledNetworks: () => [MAINNET, SEPOLIA],
    bitcoinAddress: async () => Promise.resolve("bc1qunused"),
    solanaAddress: async () => Promise.resolve("SoLaNaUnused"),
    nostrPubkey: async () => Promise.resolve("a".repeat(64)),
    invalidate: (origin: string) => {
      requests.invalidateOrigin(origin);
    },
  });
  await connections.init();
  const handler = new Eip1193Handler({
    connections,
    requests,
    networks,
    defaultNetwork: () => MAINNET,
    isTracked: () => false,
    delegationState: async () => Promise.resolve({ supported: true, state: "none" }),
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

  const connect = async (origin = SITE, network = MAINNET): Promise<ReadonlyArray<string>> => {
    const accounts = handler.handle(origin, { method: "eth_requestAccounts" });
    await vi.waitFor(() => {
      expect(connections.pending().some((p) => p.origin.origin === origin)).toBe(true);
    });
    const [pending] = connections.pending();
    await connections.approveConnection(pending?.id ?? "", {
      accounts: [await addressAt(0, network)],
      network,
    });
    return (await accounts) as ReadonlyArray<string>;
  };

  /** Stage history of one request, from subscribe time on. */
  const stagesOf = (id: string): { readonly stages: string[]; readonly unsubscribe: () => void } => {
    const stages: string[] = [];
    const unsubscribe = requests.store.subscribe((state) => {
      const stage = state.requests[id]?.stage;
      if (stage !== undefined && stages.at(-1) !== stage) {
        stages.push(stage);
      }
    });
    return { stages, unsubscribe };
  };

  return {
    wallet,
    walletId,
    addressAt,
    connections,
    requests,
    transactions,
    handler,
    events,
    rpcCalls,
    connect,
    seam,
    signedNonces,
    stagesOf,
    destroy: async () => wallet.destroy(),
  };
}

const personalSign = async (r: Awaited<ReturnType<typeof rig>>) => {
  const addr = await r.addressAt(0);
  const dapp = settled(
    r.handler.handle(SITE, { method: "personal_sign", params: ["0x68656c6c6f", addr] }),
  );
  await vi.waitFor(() => {
    expect(awaiting(r)).toBeDefined();
  });
  const request = awaiting(r);
  if (request === undefined) {
    throw new Error("no request");
  }
  return { dapp, request };
};

/** The assertions every mid-approval invalidation shares. */
const expectInvalidated = async (
  r: Awaited<ReturnType<typeof rig>>,
  id: string,
  approving: Promise<unknown>,
  dapp: Promise<{ readonly value?: unknown; readonly code?: number | string }>,
): Promise<void> => {
  await expect(approving).rejects.toMatchObject({
    name: "RequestEndedError",
    stage: "invalidated",
  });
  await expect(dapp).resolves.toStrictEqual({ code: 4001 });
  expect(r.requests.getState().requests[id]?.stage).toBe("invalidated");
  const entries = (await r.requests.signLog()).filter((entry) => entry.id === id);
  expect(entries.map((entry) => entry.outcome)).toStrictEqual(["invalidated"]);
};

describe("invalidation during approval", () => {
  it("a revoke ends a personal_sign request and nothing is signed or submitted", async () => {
    const r = await rig();
    await r.connect();
    const { dapp, request } = await personalSign(r);
    const { stages, unsubscribe } = r.stagesOf(request.id);
    const approving = r.requests.approve(request.id, "evm-sign", approval(request, VERIFY));
    await r.connections.revoke(SITE);
    await expectInvalidated(r, request.id, approving, dapp);
    expect(stages).toStrictEqual(["signing", "invalidated"]);
    unsubscribe();
    await r.destroy();
  });

  it("navigation invalidation ends a personal_sign request and nothing is signed or submitted", async () => {
    const r = await rig();
    await r.connect();
    const { dapp, request } = await personalSign(r);
    const { stages, unsubscribe } = r.stagesOf(request.id);
    const approving = r.requests.approve(request.id, "evm-sign", approval(request, VERIFY));
    r.requests.invalidateOrigin(SITE);
    await expectInvalidated(r, request.id, approving, dapp);
    expect(stages).toStrictEqual(["signing", "invalidated"]);
    unsubscribe();
    await r.destroy();
  });

  it("an approved dApp chain switch ends a personal_sign request the same way", async () => {
    const r = await rig();
    await r.connect();
    const { dapp, request } = await personalSign(r);
    const { stages, unsubscribe } = r.stagesOf(request.id);
    const approving = r.requests.approve(request.id, "evm-sign", approval(request, VERIFY));
    const switching = r.handler.handle(SITE, {
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xaa36a7" }],
    });
    await vi.waitFor(() => {
      expect(r.connections.pending()).toHaveLength(1);
    });
    await r.connections.approveConnection(r.connections.pending()[0]?.id ?? "", {
      accounts: [await r.addressAt(0, SEPOLIA)],
      network: SEPOLIA,
    });
    await expect(switching).resolves.toBeNull();
    await expectInvalidated(r, request.id, approving, dapp);
    expect(stages).toStrictEqual(["signing", "invalidated"]);
    unsubscribe();
    await r.destroy();
  });
});

describe("invalidation after signing, before broadcast", () => {
  it("an eth_sendTransaction signed while invalidated is never broadcast and keeps its nonce", async () => {
    const r = await rig();
    await r.connect();
    const from = await r.addressAt(0);
    const send = () =>
      settled(
        r.handler.handle(SITE, {
          method: "eth_sendTransaction",
          params: [{ from, to: "0x00000000000000000000000000000000deadbeef", value: "0x1" }],
        }),
      );
    const dapp = send();
    await vi.waitFor(() => {
      expect(awaiting(r)).toBeDefined();
    });
    const request = awaiting(r);
    if (request === undefined) {
      throw new Error("no request");
    }
    // The real signature comes back; the request is invalidated before the broadcast runs.
    r.seam.afterSign = () => {
      r.requests.invalidateOrigin(SITE);
    };
    const approving = r.requests.approve(request.id, "evm-sign", approval(request, VERIFY));
    await expectInvalidated(r, request.id, approving, dapp);
    expect(r.rpcCalls).not.toContain("eth_sendRawTransaction");
    const tracked = Object.values(r.transactions.getState().txs);
    expect(tracked).toHaveLength(1);
    expect(tracked[0]?.state).not.toBe("submitted");

    // The next send from the same account signs at the same nonce — the first never consumed it.
    r.seam.afterSign = undefined;
    const second = send();
    await vi.waitFor(() => {
      expect(
        Object.values(r.requests.getState().requests).some((x) => x.stage === "awaiting-approval"),
      ).toBe(true);
    });
    const next = awaiting(r);
    if (next === undefined) {
      throw new Error("no second request");
    }
    await r.requests.approve(next.id, "evm-sign", approval(next, VERIFY));
    await expect(second).resolves.toStrictEqual({ value: `0x${"ab".repeat(32)}` });
    expect(r.rpcCalls).toContain("eth_sendRawTransaction");
    expect(r.signedNonces).toHaveLength(2);
    expect(r.signedNonces[1]).toBe(r.signedNonces[0]);
    await r.destroy();
  });
});

describe("invalidation while prepare is building", () => {
  it("the prepare rejects and the origin can immediately prepare a new request", async () => {
    const r = await rig();
    await r.connect();
    const addr = await r.addressAt(0);
    const input = {
      method: "evm-sign" as const,
      origin: { kind: "browser" as const, origin: SITE },
      account: { kind: "hd" as const, walletId: r.walletId, groupIndex: 0, template: "evm.bip44" as const },
      network: MAINNET,
      request: {
        kind: "evm.personal-message" as const,
        network: MAINNET,
        account: {
          kind: "hd" as const,
          walletId: r.walletId,
          groupIndex: 0,
          template: "evm.bip44" as const,
        },
        message: new Uint8Array([1, 2, 3]),
      },
    };
    void addr;
    // `prepare` runs synchronously until the build's first await, so this lands while it builds.
    const preparing = r.requests.prepare(input);
    r.requests.invalidateOrigin(SITE);
    await expect(preparing).rejects.toMatchObject({
      name: "RequestEndedError",
      stage: "invalidated",
    });
    expect(r.requests.getState().requests).toStrictEqual({});
    const next = await r.requests.prepare(input);
    expect(next.stage).toBe("awaiting-approval");
    await r.destroy();
  });
});

describe("engine solana-sign send", () => {
  it("invalidation during signing never broadcasts", async () => {
    // A passkey verification holds the kernel sign open at the ceremony, so the invalidation lands
    // while `solanaSign` is still awaiting the signature — before its commit and broadcast.
    const entered = latch();
    const release = latch();
    const authenticator = createSoftwarePasskey(randomBytes(32));
    const gated: PasskeyCeremony = {
      create: (input) => authenticator.create(input),
      assert: async (input) => {
        entered.resolve();
        await release.promise;
        return authenticator.assert(input);
      },
    };
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
      authenticator: gated,
      kernelUrl: KERNEL_URL,
    });
    const { walletId } = await wallet.wallets.importMnemonic({
      mnemonic: MNEMONIC,
      factor: { kind: "passkey", name: "main" },
    });
    const solanaCalls: string[] = [];
    const fetchImpl: typeof globalThis.fetch = (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      solanaCalls.push(body.method);
      const result =
        body.method === "simulateTransaction"
          ? { value: { err: null, logs: [], unitsConsumed: 21_000 } }
          : body.method === "sendTransaction"
            ? `sig${"a".repeat(80)}`
            : null;
      return Promise.resolve(Response.json({ jsonrpc: "2.0", id: body.id, result }));
    };
    const engine = createWalletEngine({
      wallet,
      verifyEvent,
      weblnAlias: "test",
      lightningMaxFee: () => 0,
      sparkNetwork: "regtest",
      sparkApis: {
        signer: () => null as never,
        approve: async () => Promise.resolve({}),
      },
      fetch: fetchImpl,
      random: (n) => new Uint8Array(n).fill(7),
      now: () => 0,
      logger,
      showCallsStatus: () => undefined,
      publicStore: createMemoryPublicStore(),
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      rpc: { [SOL_NET]: ["https://sol.example"] },
    });
    await engine.networks.init();
    await engine.requests.init();
    const account = await chains(wallet).account({
      walletId,
      groupIndex: 0,
      template: "solana.bip44-change",
      network: SOL_NET,
    });
    const payer = "address" in account ? account.address : "";
    let message = setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: address("11111111111111111111111111111111"),
        lastValidBlockHeight: 1000n,
      } as never,
      setTransactionMessageFeePayer(
        address(payer),
        createTransactionMessage({ version: "legacy" }),
      ),
    );
    message = appendTransactionMessageInstruction(
      getTransferSolInstruction({
        source: createNoopSigner(address(payer)),
        destination: address("8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR"),
        amount: 1000n,
      }) as never,
      message as never,
    );
    const bytes = new Uint8Array(
      getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message as never)),
    );
    const request = await engine.requests.prepare({
      method: "solana-sign",
      origin: { kind: "browser", origin: SITE },
      account: { walletId, groupIndex: 0, address: payer },
      network: SOL_NET,
      request: { kind: "transactions", transactions: [bytes], send: true },
    });
    const approving = engine.requests.approve(
      request.id,
      "solana-sign",
      approval(request, { kind: "passkey" }),
    );
    await entered.promise;
    engine.requests.invalidateOrigin(SITE);
    release.resolve();
    await expect(approving).rejects.toMatchObject({
      name: "RequestEndedError",
      stage: "invalidated",
    });
    expect(engine.requests.getState().requests[request.id]?.stage).toBe("invalidated");
    expect(solanaCalls).not.toContain("sendTransaction");
    engine.unsubscribe();
    await wallet.destroy();
  });
});
