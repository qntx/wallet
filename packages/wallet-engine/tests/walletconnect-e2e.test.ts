/* oxlint-disable vitest/no-conditional-in-test -- the helpers narrow results for assertions */
/* oxlint-disable typescript/require-await -- the storage contract is async; the memory double is synchronous */
/**
 * Gated e2e (ENGINE_E2E_WALLETCONNECT=1 and WALLETCONNECT_PROJECT_ID set): no relay stub — real
 * fetch and WebSocket against the Reown relay. The wallet side is a real Node-kernel engine with
 * the public `createWalletConnect` entry; the dApp side is a real in-process `SignClient` over its
 * own storage prefix (DISABLE_GLOBAL_CORE keeps the two Cores separate). Chain RPC stays canned
 * (evm*.invalid/esplora.invalid) — only the WalletConnect transport is real, so the run needs a
 * reachable relay but no funded accounts.
 *
 * Flow: pair → propose (eip155 + solana + bip122 optional namespaces) → approve → personal_sign →
 * solana_signMessage → bip122 getAccountAddresses + BIP-322 signMessage → group switch (dApp sees
 * session_update + accountsChanged) → dispose with a request in flight → the recreated client
 * recovers it → answer → disconnect.
 */
import { randomBytes } from "node:crypto";

import type { SignClient } from "@walletconnect/sign-client";
import type { SessionTypes } from "@walletconnect/types";
import { verifyMessage } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { verifyBitcoinMessage } from "@qntx/wallet-chains/bitcoin";
import { verifySolanaSignature } from "@qntx/wallet-chains/solana";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";

import { createWalletEngine } from "../src/engine.ts";
import { walletConnectKey } from "../src/requests/types.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";
import type {
  createWalletConnect as CreateWalletConnect,
  WalletConnectStorage,
} from "../src/walletconnect/client.ts";
import { approval } from "./approval.ts";
import { simulateV1Result } from "./send-helpers.ts";

const RUN =
  process.env["ENGINE_E2E_WALLETCONNECT"] === "1" &&
  process.env["WALLETCONNECT_PROJECT_ID"] !== undefined;
const PROJECT_ID = process.env["WALLETCONNECT_PROJECT_ID"] ?? "missing-project-id";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSWORD = "correct horse battery staple";
const PW = { kind: "password" as const, password: PASSWORD };
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const GATEWAY = "https://gateway.test";
const EVM1 = "eip155:1";
const SOL_MAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BTC_MAIN = "bip122:000000000019d6689c085ae165831e93";
const DAPP_META = { name: "e2e dapp", description: "dapp", url: "https://dapp.example", icons: [] };
const WALLET_META = {
  name: "qntx wallet e2e",
  description: "the e2e wallet",
  url: "https://wallet.example",
  icons: [],
};
const EVM_METHODS = [
  "personal_sign",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
  "wallet_sendCalls",
  "wallet_getCallsStatus",
  "wallet_showCallsStatus",
  "wallet_getCapabilities",
  "wallet_watchAsset",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
];
const SOL_METHODS = [
  "solana_signMessage",
  "solana_signTransaction",
  "solana_signAllTransactions",
  "solana_signAndSendTransaction",
];
const BTC_METHODS = ["getAccountAddresses", "signMessage", "signPsbt", "sendTransfer"];

const setTimer = (ms: number, fn: () => void): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/** A cloning in-memory WalletConnectStorage — the e2e's answer to localStorage. */
const memoryStorage = (): WalletConnectStorage => {
  const map = new Map<string, unknown>();
  const clone = (value: unknown): unknown => structuredClone(value);
  return {
    getKeys: async () => [...map.keys()],
    getEntries: async () => [...map.entries()].map(([key, value]) => [key, clone(value)]),
    getItem: async (key) => clone(map.get(key)),
    setItem: async (key, value) => {
      map.set(key, clone(value));
    },
    removeItem: async (key) => {
      map.delete(key);
    },
  };
};

const realFetch = globalThis.fetch.bind(globalThis);
/** The engine's canned chain/gateway answers; anything else goes to the real network. */
const fetchImpl: typeof globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === `${GATEWAY}/v1/risk/lists/phishing`) {
    return Response.json({ kind: "snapshot", version: 1, deny: [], allow: [] });
  }
  if (url === `${GATEWAY}/v1/networks`) {
    return Response.json({ networks: [] });
  }
  const base = url.endsWith("/") ? url.slice(0, -1) : url;
  if (base === "https://evm1.invalid") {
    const table: Record<string, unknown> = {
      eth_chainId: "0x1",
      net_version: "1",
      eth_blockNumber: "0x1",
      eth_getTransactionCount: "0x0",
      eth_estimateGas: "0x5208",
      eth_call: `0x${"00".repeat(32)}`,
      eth_getCode: "0x",
      eth_getBalance: "0xde0b6b3a7640000",
      eth_feeHistory: { baseFeePerGas: ["0x64", "0x64"], reward: [["0x1", "0x2", "0x3"]] },
      eth_getBlockByNumber: { number: "0x2" },
    };
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params?: unknown;
    };
    if (body.method === "eth_simulateV1") {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: simulateV1Result(body.params) });
    }
    if (body.method in table) {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: table[body.method] });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32_601, message: `method not found: ${body.method}` },
    });
  }
  if (base === "https://solana.invalid") {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32_601, message: `method not found: ${body.method}` },
    });
  }
  if (base === "https://esplora.invalid") {
    const path = new URL(url).pathname;
    if (path === "/blocks/tip/height") {
      return new Response("100");
    }
    if (path === "/fee-estimates") {
      return Response.json({ "1": 10, "3": 5, "6": 2, "144": 1 });
    }
    return Response.json([]);
  }
  return realFetch(input, init);
};

async function until(read: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!read()) {
    if (Date.now() > deadline) {
      throw new Error("until() timed out");
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function rig() {
  const wallet = await createNodeWallet({
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
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const durableStore = (): EngineStore => {
    const store = createMemoryEngineStore(backing);
    return { collection: (name) => store.collection(name), close: async () => Promise.resolve() };
  };
  const engine = createWalletEngine({
    setTimer,
    publicStore: createMemoryPublicStore(),
    verifyEvent,
    weblnAlias: "test",
    lightningMaxFee: () => 0,
    wallet,
    sparkNetwork: "regtest",
    fetch: fetchImpl,
    random: (n) => randomBytes(n),
    now: () => Date.now(),
    logger: { warn: (...args: unknown[]) => console.warn("engine warn:", ...args) },
    showCallsStatus: () => undefined,
    openStore: async () => Promise.resolve(durableStore()),
    rpc: {
      [EVM1]: ["https://evm1.invalid"],
      [SOL_MAIN]: ["https://solana.invalid"],
      [BTC_MAIN]: ["https://esplora.invalid"],
    },
    gateway: { url: GATEWAY },
  });
  const info = await wallet.wallets.importMnemonic({ mnemonic: MNEMONIC, factor: PW });
  await until(() => engine.accounts.getState().selected !== null);
  return { wallet, engine, walletId: info.walletId };
}

type Rig = Awaited<ReturnType<typeof rig>>;

const openWalletConnect = async (r: Rig, storage: WalletConnectStorage) => {
  // DISABLE_GLOBAL_CORE before the SDK loads so this Core and the dApp's never share a singleton.
  process.env["DISABLE_GLOBAL_CORE"] = "true";
  const { createWalletConnect } = (await import("../src/walletconnect/client.ts")) as {
    createWalletConnect: typeof CreateWalletConnect;
  };
  return createWalletConnect({
    projectId: PROJECT_ID,
    metadata: WALLET_META,
    storage,
    wallet: r.wallet,
    engine: r.engine,
    now: () => Date.now(),
    logger: { warn: (...args: unknown[]) => console.warn("wc warn:", ...args) },
  });
};

type Dapp = Awaited<ReturnType<typeof SignClient.init>>;

async function dapp(): Promise<Dapp> {
  process.env["DISABLE_GLOBAL_CORE"] = "true";
  const { SignClient } = await import("@walletconnect/sign-client");
  return SignClient.init({
    projectId: PROJECT_ID,
    storage: memoryStorage() as never,
    customStoragePrefix: "dapp",
    metadata: DAPP_META,
    logger: "silent",
    telemetryEnabled: false,
  });
}

const awaiting = (r: Rig) =>
  Object.values(r.engine.requests.getState().requests).filter(
    (request) => request.stage === "awaiting-approval",
  );

const openRequest = async (r: Rig) => {
  await until(() => awaiting(r).length === 1);
  const [request] = awaiting(r);
  if (request === undefined) {
    throw new Error("no awaiting request");
  }
  return request;
};

const caip10Tail = (account: string): string => account.split(":").pop() ?? "";

describe.runIf(RUN)("walletconnect e2e: real relay", () => {
  it(
    "pairs, signs over three namespaces, survives a group switch and a restart",
    { timeout: 300_000 },
    async () => {
      const r = await rig();
      const storage = memoryStorage();
      let wc = await openWalletConnect(r, storage);
      const client = await dapp();
      const events: Array<{ name: string; chainId: string; data: unknown }> = [];
      const updates: SessionTypes.Namespaces[] = [];
      client.on("session_event", (event) => {
        events.push({
          name: event.params.event.name,
          chainId: event.params.chainId,
          data: event.params.event.data,
        });
      });
      client.on("session_update", (event) => {
        updates.push(event.params.namespaces);
      });

      // Pair → propose with one chain per namespace → approve everything offered.
      const { uri, approval: sessionApproval } = await client.connect({
        optionalNamespaces: {
          eip155: {
            chains: [EVM1],
            methods: EVM_METHODS,
            events: ["accountsChanged", "chainChanged"],
          },
          solana: { chains: [SOL_MAIN], methods: SOL_METHODS, events: ["accountsChanged"] },
          bip122: {
            chains: [BTC_MAIN],
            methods: BTC_METHODS,
            events: ["accountsChanged", "chainChanged", "bip122_addressesChanged"],
          },
        },
      });
      if (uri === undefined) {
        throw new Error("connect produced no uri");
      }
      await wc.pair(uri);
      await until(() => Object.keys(wc.getState().proposals).length === 1);
      const [proposal] = Object.values(wc.getState().proposals);
      if (proposal === undefined) {
        throw new Error("no proposal in state");
      }
      const session = await wc.approve(proposal.id, { networks: [...proposal.networks] });
      const live = await sessionApproval();
      const accounts = (chain: string): string =>
        caip10Tail(session.scopes[chain]?.accounts[0] ?? "");
      const evmAccount = accounts(EVM1) as `0x${string}`;
      const solAccount = accounts(SOL_MAIN);
      const btcAccount = accounts(BTC_MAIN);
      expect(evmAccount.startsWith("0x")).toBe(true);
      expect(solAccount.length).toBeGreaterThan(0);
      expect(btcAccount.length).toBeGreaterThan(0);

      // eip155 personal_sign — pipeline request, signature verified with viem.
      const message = `0x${Buffer.from("hello e2e").toString("hex")}`;
      const personal = client.request({
        topic: live.topic,
        chainId: EVM1,
        request: { method: "personal_sign", params: [message, evmAccount] },
      });
      let pending = await openRequest(r);
      await r.engine.requests.approve(pending.id, "evm-sign", approval(pending, PW));
      const signature = (await personal) as `0x${string}`;
      await expect(
        verifyMessage({ address: evmAccount, message: "hello e2e", signature }),
      ).resolves.toBe(true);

      // solana_signMessage — verified against the session's Solana address.
      const solText = new TextEncoder().encode("hello solana");
      const { base58 } = await import("@scure/base");
      const solCall = client.request({
        topic: live.topic,
        chainId: SOL_MAIN,
        request: {
          method: "solana_signMessage",
          params: { message: base58.encode(solText), pubkey: solAccount },
        },
      });
      pending = await openRequest(r);
      await r.engine.requests.approve(pending.id, "solana-sign", approval(pending, PW));
      const solResult = (await solCall) as { signature: string };
      expect(verifySolanaSignature(solText, base58.decode(solResult.signature), solAccount)).toBe(
        true,
      );

      // bip122 getAccountAddresses + BIP-322 signMessage.
      const addresses = await client.request<Array<{ address: string; intention?: string }>>({
        topic: live.topic,
        chainId: BTC_MAIN,
        request: { method: "getAccountAddresses", params: { account: btcAccount } },
      });
      expect(addresses.length).toBeGreaterThanOrEqual(1);
      expect(addresses[0]?.address).toBe(btcAccount);
      const btcCall = client.request({
        topic: live.topic,
        chainId: BTC_MAIN,
        request: {
          method: "signMessage",
          params: { account: btcAccount, message: "hello bitcoin", protocol: "bip322" },
        },
      });
      pending = await openRequest(r);
      await r.engine.requests.approve(pending.id, "bitcoin-sign", approval(pending, PW));
      const btcResult = (await btcCall) as { address: string; signature: string };
      const { hex } = await import("@scure/base");
      expect(
        verifyBitcoinMessage(
          btcAccount,
          "hello bitcoin",
          `smp${Buffer.from(hex.decode(btcResult.signature)).toString("base64")}`,
          BTC_MAIN,
        ),
      ).toBe(true);

      // Group switch — the dApp sees session_update plus accountsChanged on every granted chain.
      const group = r.engine.accounts.addGroup(r.walletId);
      r.engine.accounts.select(r.walletId, group);
      await until(() =>
        [EVM1, SOL_MAIN, BTC_MAIN].every((chainId) =>
          events.some((e) => e.name === "accountsChanged" && e.chainId === chainId),
        ),
      );
      await until(() => updates.length > 0);
      const moved = updates.at(-1);
      const movedEvm = caip10Tail(moved?.["eip155"]?.accounts[0] ?? "");
      expect(movedEvm).not.toBe(evmAccount);
      expect(moved?.["eip155"]?.accounts[0]).toBe(`${EVM1}:${movedEvm}`);

      // A request in flight while the wallet side disposes is recovered by the recreated client —
      // either from the sign client's pending-request store or by relay redelivery.
      const recovered = client
        .request({
          topic: live.topic,
          chainId: EVM1,
          request: {
            method: "personal_sign",
            params: [`0x${Buffer.from("after restart").toString("hex")}`, movedEvm],
          },
        })
        .then((value) => ({ value }))
        .catch((error: unknown) => ({ error }));
      await wc.dispose();
      wc = await openWalletConnect(r, storage);
      pending = await openRequest(r);
      await r.engine.requests.approve(pending.id, "evm-sign", approval(pending, PW));
      const settled = await recovered;
      if ("error" in settled) {
        throw new Error(`recovered request failed: ${JSON.stringify(settled.error)}`);
      }
      await expect(
        verifyMessage({
          address: movedEvm as `0x${string}`,
          message: "after restart",
          signature: settled.value as `0x${string}`,
        }),
      ).resolves.toBe(true);

      // The dApp disconnects; the wallet's session for the topic is revoked.
      const { getSdkError } = await import("@walletconnect/utils");
      await client.disconnect({ topic: live.topic, reason: getSdkError("USER_DISCONNECTED") });
      await until(() => r.engine.connections.session(walletConnectKey(live.topic)) === undefined);
      await wc.dispose();
    },
  );
});
