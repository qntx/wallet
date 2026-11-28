/* oxlint-disable typescript/require-await -- the storage contract is async; the memory double is synchronous */
/**
 * Shared rig for the gated WalletConnect e2e (tests/walletconnect-e2e.test.ts): a real Node-kernel
 * engine plus the wallet-side `createWalletConnectClient` handles on one side and a real
 * `@walletconnect/sign-client` dApp on the other — over the real Reown relay, never the in-process
 * relay stub (tests/support/walletconnect-relay.ts must stay out of this file). Chain RPC is the
 * only canned part: eip155:1 is served by a local anvil, every other network by a static table.
 */
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";

import { base58, hex } from "@scure/base";
import { Address, OutScript, Transaction } from "@scure/btc-signer";
import { NETWORK } from "@scure/btc-signer/utils.js";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Instruction } from "@solana/kit";
import type { SignClient } from "@walletconnect/sign-client";
import type {
  ProposalTypes,
  RelayerTypes,
  SessionTypes,
  SignClientTypes,
} from "@walletconnect/types";
import { expect } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";

import { scripthash } from "../../src/chains/bitcoin-scan.ts";
import { createWalletEngine } from "../../src/engine.ts";
import type { WalletEngine } from "../../src/engine.ts";
import type { PendingRequest } from "../../src/index.ts";
import { walletConnectKey } from "../../src/requests/types.ts";
import { createMemoryEngineStore, createMemoryPublicStore } from "../../src/store/memory.ts";
import type { EngineStore } from "../../src/store/port.ts";
import type {
  WalletConnectStorage,
  createWalletConnectClient,
} from "../../src/walletconnect/client.ts";
import { approval } from "../approval.ts";
import { b64 } from "../phishing-helpers.ts";
import { simulateV1Result } from "../send-helpers.ts";

// DISABLE_GLOBAL_CORE before the SDK loads so the wallet's Core and the dApps' never share a
// singleton. The SDKs are dynamically imported in the factories below — never at module load.
process.env["DISABLE_GLOBAL_CORE"] = "true";

export const KERNEL_URL = new URL("../../../wallet-worker/dist/kernel.node.js", import.meta.url);
export const PASSWORD = "correct horse battery staple";
export const PW = { kind: "password" as const, password: PASSWORD };
export const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
export const GATEWAY = "https://gateway.test";
export const EVM1 = "eip155:1";
export const SEPOLIA = "eip155:11155111";
export const SOL_MAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const BTC_MAIN = "bip122:000000000019d6689c085ae165831e93";
export const TRON_MAIN = "tron:0x2b6653dc";
export const BTC_GENESIS = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
export const DAPP_URL = "https://dapp.example";
export const WALLET_META = {
  name: "qntx wallet e2e",
  description: "the e2e wallet",
  url: "https://wallet.example",
  icons: [],
};
export const DAPP_META = {
  name: "e2e dapp",
  description: "dapp",
  url: DAPP_URL,
  icons: [] as string[],
};
// The test mnemonic's first bip84/bip86 receive addresses — the session's two purposes.
export const BIP84_FIRST = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
export const BIP86_FIRST = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
export const RECIP = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
export const SOL_DEST = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
export const RPC_SIG = base58.encode(new Uint8Array(64).fill(0x5a));

export const EVM_METHODS = [
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
export const SOL_METHODS = [
  "solana_signMessage",
  "solana_signTransaction",
  "solana_signAllTransactions",
  "solana_signAndSendTransaction",
];
export const BTC_METHODS = ["getAccountAddresses", "signMessage", "signPsbt", "sendTransfer"];
export const BTC_EVENTS = ["accountsChanged", "chainChanged", "bip122_addressesChanged"];
export const EVM_EVENTS = ["accountsChanged", "chainChanged"];
export const TRON_METHODS = ["tron_signTransaction", "tron_signMessage"];
export const USER_REJECTED = 5000;
export const UNSUPPORTED_CHAINS = 5100;
export const UNSUPPORTED_METHODS = 5101;
export const UNSUPPORTED_NAMESPACE_KEY = 5104;
export const MISSING_OR_INVALID = 5;
export const UNAUTHORIZED_UPDATE_REQUEST = 3003;

export const eip155Namespace = (
  chains: ReadonlyArray<string>,
  methods: ReadonlyArray<string> = EVM_METHODS,
  events: ReadonlyArray<string> = EVM_EVENTS,
): { chains: string[]; methods: string[]; events: string[] } => ({
  chains: [...chains],
  methods: [...methods],
  events: [...events],
});

const setTimer = (ms: number, fn: () => void): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

const cloneStored = (value: unknown): unknown => structuredClone(value);

/** A cloning in-memory WalletConnectStorage — the e2e's answer to localStorage. */
export const memoryStorage = (): WalletConnectStorage => {
  const map = new Map<string, unknown>();
  return {
    getKeys: async () => [...map.keys()],
    getEntries: async () => [...map.entries()].map(([key, value]) => [key, cloneStored(value)]),
    getItem: async (key) => cloneStored(map.get(key)),
    setItem: async (key, value) => {
      map.set(key, cloneStored(value));
    },
    removeItem: async (key) => {
      map.delete(key);
    },
  };
};

export async function until(read: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!read()) {
    if (Date.now() > deadline) {
      throw new Error("until() timed out");
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
  }
}

/** The mutable clock the wallet side sees; the engine's own `now` stays real. */
export type WalletClock = {
  readonly now: () => number;
  readonly shift: (ms: number) => void;
  readonly set: (ms: number) => void;
};

const walletClock = (): WalletClock => {
  let offset = 0;
  let absolute: number | undefined;
  return {
    now: () => absolute ?? Date.now() + offset,
    shift: (ms) => {
      offset += ms;
      absolute = undefined;
    },
    set: (ms) => {
      absolute = ms;
    },
  };
};

const realFetch = globalThis.fetch.bind(globalThis);

const evmRpcTable = (chainId: string): Record<string, unknown> => ({
  eth_chainId: chainId,
  net_version: Number.parseInt(chainId, 16).toString(),
  eth_blockNumber: "0x1",
  eth_getTransactionCount: "0x0",
  eth_estimateGas: "0x5208",
  eth_call: `0x${"00".repeat(32)}`,
  eth_getCode: "0x",
  eth_getBalance: "0xde0b6b3a7640000",
  eth_feeHistory: { baseFeePerGas: ["0x64", "0x64"], reward: [["0x1", "0x2", "0x3"]] },
  eth_getBlockByNumber: { number: "0x2" },
});

const SOL_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

const solanaRpc = (method: string, params: unknown[]): unknown => {
  if (method === "getGenesisHash") {
    return SOL_GENESIS;
  }
  if (method === "getBlockHeight") {
    return 500;
  }
  if (method === "getEpochInfo") {
    return { absoluteSlot: 700, blockHeight: 500 };
  }
  if (method === "getSignatureStatuses") {
    const sigs = Array.isArray(params[0]) ? params[0] : [];
    return { context: { slot: 1 }, value: sigs.map(() => null) };
  }
  if (method === "isBlockhashValid") {
    return { context: { slot: 1 }, value: params[0] === "11111111111111111111111111111111" };
  }
  if (method === "sendTransaction") {
    return RPC_SIG;
  }
  throw new Error(`no solana rpc answer for ${method}`);
};

const scriptOf = (addr: string): Uint8Array => OutScript.encode(Address(NETWORK).decode(addr));

/**
 * The per-rig canned world: what the fake solana/esplora endpoints remember. An eip155:1 anvil is
 * real; every other network's answers come from these maps.
 */
export type CannedWorld = {
  /** Raw previous transactions esplora serves by txid — `dappPsbt`/`fundPrev` register here. */
  readonly prevs: Map<string, Uint8Array>;
  /** The raw hex esplora was asked to broadcast, in order. */
  readonly broadcasts: string[];
  readonly acceptedTxids: Set<string>;
  /** The signed solana wires the canned endpoint saw, in order. */
  readonly solanaWires: Uint8Array[];
  funded: { txid: string; vout: number; value: number } | undefined;
  /** A prevout paying `to` — the send the tests fund themselves with. */
  readonly fundPrev: (to: string, value: bigint) => void;
  /** A PSBT spending one prevout of `from` (a wallet address) to `to`, as a dApp builds it. */
  readonly dappPsbt: (opts: {
    from: string;
    to: string;
    value: bigint;
    sighash?: number;
  }) => Uint8Array;
};

const cannedWorld = (): CannedWorld => {
  const world: CannedWorld = {
    prevs: new Map(),
    broadcasts: [],
    acceptedTxids: new Set(),
    solanaWires: [],
    funded: undefined,
    fundPrev: (to, value) => {
      const prev = new Transaction({ version: 2 });
      prev.addInput({ txid: new Uint8Array(32).fill(7), index: 0, sequence: 0xffffffff });
      prev.addOutput({ script: scriptOf(to), amount: value });
      world.prevs.set(prev.id, prev.toBytes(true, false));
      world.funded = { txid: prev.id, vout: 0, value: Number(value) };
    },
    dappPsbt: (opts) => {
      const prev = new Transaction({ version: 2 });
      prev.addInput({ txid: new Uint8Array(32).fill(9), index: 0, sequence: 0xffffffff });
      prev.addOutput({ script: scriptOf(opts.from), amount: opts.value });
      world.prevs.set(prev.id, prev.toBytes(true, false));
      const tx = new Transaction({ version: 2 });
      tx.addInput({
        txid: prev.id,
        index: 0,
        sequence: 0xfffffffd,
        witnessUtxo: { script: scriptOf(opts.from), amount: opts.value },
        ...(opts.sighash === undefined ? {} : { sighashType: opts.sighash }),
      });
      tx.addOutput({ script: scriptOf(opts.to), amount: opts.value - 1000n });
      return tx.toPSBT(0);
    },
  };
  return world;
};

/** The engine's canned chain/gateway answers; anvil and anything else go to the real network. */
const fetchImpl = (world: CannedWorld): typeof globalThis.fetch => {
  const ourHash = scripthash(BIP84_FIRST, NETWORK);
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GATEWAY}/v1/risk/lists/phishing`) {
      return Response.json({ kind: "snapshot", version: 1, deny: b64([]), allow: b64([]) });
    }
    if (url === `${GATEWAY}/v1/networks`) {
      return Response.json({ networks: [] });
    }
    const base = url.endsWith("/") ? url.slice(0, -1) : url;
    if (base === "https://evm2.invalid") {
      const table = evmRpcTable("0xaa36a7");
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON-RPC bodies are engine-shaped
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "") as {
        id: number;
        method: string;
        params?: unknown;
      };
      if (body.method === "eth_simulateV1") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: simulateV1Result(body.params),
        });
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
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON-RPC bodies are engine-shaped
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "") as {
        id: number;
        method: string;
        params: unknown[];
      };
      if (body.method === "sendTransaction") {
        world.solanaWires.push(Uint8Array.from(Buffer.from(String(body.params[0]), "base64")));
      }
      try {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: solanaRpc(body.method, body.params),
        });
      } catch (error) {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: -32_601,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    if (url.startsWith("https://esplora.invalid")) {
      const path = url.slice("https://esplora.invalid".length);
      if (init?.method === "POST") {
        const raw = typeof init.body === "string" ? init.body : "";
        world.broadcasts.push(raw);
        const txid = Transaction.fromRaw(hex.decode(raw)).id;
        world.acceptedTxids.add(txid);
        return new Response(txid);
      }
      const hexMatch = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(path);
      if (hexMatch !== null) {
        return new Response(Buffer.from(world.prevs.get(hexMatch[1] ?? "") ?? []).toString("hex"));
      }
      const statusMatch = /^\/tx\/([0-9a-f]{64})\/status$/.exec(path);
      if (statusMatch !== null) {
        return statusMatch[1] === world.funded?.txid
          ? Response.json({ confirmed: true, block_height: 1 })
          : world.acceptedTxids.has(statusMatch[1] ?? "")
            ? Response.json({ confirmed: false })
            : new Response("Transaction not found", { status: 404 });
      }
      const outspendsMatch = /^\/tx\/([0-9a-f]{64})\/outspends$/.exec(path);
      if (outspendsMatch !== null) {
        return Response.json([{ spent: false }, { spent: false }]);
      }
      if (path === "/block-height/0") {
        return new Response(BTC_GENESIS);
      }
      if (path === "/blocks/tip/height") {
        return new Response("100");
      }
      if (path === "/fee-estimates") {
        return Response.json({ "1": 10, "3": 5, "6": 2, "144": 1 });
      }
      const txsMatch = /^\/scripthash\/([0-9a-f]{64})\/txs$/.exec(path);
      if (txsMatch !== null) {
        return Response.json(
          txsMatch[1] === ourHash && world.funded !== undefined
            ? [{ txid: world.funded.txid }]
            : [],
        );
      }
      const utxoMatch = /^\/scripthash\/([0-9a-f]{64})\/utxo$/.exec(path);
      if (utxoMatch !== null) {
        return Response.json(
          utxoMatch[1] === ourHash && world.funded !== undefined
            ? [
                {
                  txid: world.funded.txid,
                  vout: world.funded.vout,
                  value: world.funded.value,
                  status: { confirmed: true, block_height: 1 },
                },
              ]
            : [],
        );
      }
      return Response.json([]);
    }
    return realFetch(input, init);
  };
};

export type Rig = {
  readonly wallet: Awaited<ReturnType<typeof createNodeWallet>>;
  readonly engine: WalletEngine;
  readonly walletId: string;
  readonly clock: WalletClock;
  readonly world: CannedWorld;
  readonly storage: WalletConnectStorage;
};

export async function rig(anvilUrl: string): Promise<Rig> {
  const world = cannedWorld();
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
  // One backing for every unlock — the engine store keeps its data across lock cycles.
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const durableStore = (): EngineStore => {
    const store = createMemoryEngineStore(backing);
    return { collection: (name) => store.collection(name), close: async () => undefined };
  };
  const engine = createWalletEngine({
    setTimer,
    publicStore: createMemoryPublicStore(),
    verifyEvent,
    weblnAlias: "test",
    lightningMaxFee: () => 0,
    wallet,
    sparkNetwork: "regtest",
    fetch: fetchImpl(world),
    random: (n) => randomBytes(n),
    now: () => Date.now(),
    logger: {
      // oxlint-disable-next-line eslint/no-console -- engine warnings are diagnostics in this opt-in suite
      warn: (...args: unknown[]) => console.warn("engine warn:", ...args),
    },
    showCallsStatus: () => undefined,
    openStore: async () => durableStore(),
    rpc: {
      [EVM1]: [anvilUrl],
      [SEPOLIA]: ["https://evm2.invalid"],
      [SOL_MAIN]: ["https://solana.invalid"],
      [BTC_MAIN]: ["https://esplora.invalid"],
    },
    gateway: { url: GATEWAY },
  });
  const info = await wallet.wallets.importMnemonic({ mnemonic: MNEMONIC, factor: PW });
  await until(() => engine.accounts.getState().selected !== null);
  return {
    wallet,
    engine,
    walletId: info.walletId,
    clock: walletClock(),
    world,
    storage: memoryStorage(),
  };
}

type Client = Awaited<ReturnType<typeof createWalletConnectClient>>;

export type WalletClient = {
  readonly wc: Client["walletConnect"];
  readonly core: Client["core"];
  readonly kit: Client["kit"];
  readonly dispose: () => Promise<void>;
};

export const openWalletConnect = async (
  r: Rig,
  projectId: string,
  storage: WalletConnectStorage,
): Promise<WalletClient> => {
  const { createWalletConnectClient } = await import("../../src/walletconnect/client.ts");
  const client = await createWalletConnectClient({
    projectId,
    metadata: WALLET_META,
    storage,
    wallet: r.wallet,
    engine: r.engine,
    now: r.clock.now,
    logger: {
      // oxlint-disable-next-line eslint/no-console -- walletconnect warnings are diagnostics in this opt-in suite
      warn: (...args: unknown[]) => console.warn("wc warn:", ...args),
    },
  });
  return {
    wc: client.walletConnect,
    core: client.core,
    kit: client.kit,
    dispose: async () => client.walletConnect.dispose(),
  };
};

export type Dapp = Awaited<ReturnType<typeof SignClient.init>>;

export async function dapp(
  projectId: string,
  options: {
    readonly metadata?: typeof DAPP_META;
    readonly storage?: WalletConnectStorage;
    readonly prefix?: string;
  } = {},
): Promise<Dapp> {
  const { SignClient } = await import("@walletconnect/sign-client");
  return SignClient.init({
    projectId,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- our storage satisfies the SDK's storage contract structurally
    storage: (options.storage ?? memoryStorage()) as unknown as NonNullable<
      SignClientTypes.Options["storage"]
    >,
    customStoragePrefix: options.prefix ?? `dapp-${randomBytes(4).toString("hex")}`,
    metadata: options.metadata ?? DAPP_META,
    logger: "silent",
    telemetryEnabled: false,
  });
}

/** Closes a dApp's relay transport — the SignClient leaves no sockets behind. */
export const closeDapp = async (client: Dapp): Promise<void> => {
  try {
    await client.core.relayer.transportClose();
  } catch {
    // a dApp that never connected has nothing to close
  }
};

type NamespaceEntry = { chains?: string[]; methods: string[]; events: string[] };

/** Unions the namespace entries of two proposals — chains, methods and events deduped. */
const mergeNamespaces = (
  base: Record<string, NamespaceEntry>,
  extra: Record<string, NamespaceEntry>,
): Record<string, NamespaceEntry> => {
  const merged: Record<string, NamespaceEntry> = {};
  for (const [key, value] of [...Object.entries(base), ...Object.entries(extra)]) {
    let target = merged[key];
    if (target === undefined) {
      target = {
        ...(value.chains === undefined ? {} : { chains: [] }),
        methods: [],
        events: [],
      };
      merged[key] = target;
    }
    for (const chain of value.chains ?? []) {
      if (target.chains === undefined) {
        target.chains = [chain];
      } else if (!target.chains.includes(chain)) {
        target.chains.push(chain);
      }
    }
    for (const method of value.methods) {
      if (!target.methods.includes(method)) {
        target.methods.push(method);
      }
    }
    for (const event of value.events) {
      if (!target.events.includes(event)) {
        target.events.push(event);
      }
    }
  }
  return merged;
};

/**
 * `connect()` folds requiredNamespaces into optionalNamespaces (sign-client engine.ts). A legacy
 * dApp's published proposal still carries them — wrap the engine's `sendProposeSession` so the wire
 * proposal (and the stored copy, which is the same object) carries `required`. The two tables are
 * merged for the optional half so required+optional chains are all proposed.
 */
export const legacyConnect = async (
  client: Dapp,
  options: {
    readonly requiredNamespaces: ProposalTypes.Struct["requiredNamespaces"];
    readonly optionalNamespaces?: ProposalTypes.Struct["optionalNamespaces"];
  },
): Promise<{ uri: string | undefined; approval: () => Promise<SessionTypes.Struct> }> => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sendProposeSession is private on the sign-client engine
  const { engine } = client as unknown as {
    engine: {
      sendProposeSession: (params: {
        proposal: ProposalTypes.Struct;
        publishOpts: unknown;
      }) => Promise<void>;
    };
  };
  const original = engine.sendProposeSession;
  engine.sendProposeSession = async (params) => {
    params.proposal.requiredNamespaces = options.requiredNamespaces;
    await original(params);
  };
  try {
    const { uri, approval } = await client.connect({
      optionalNamespaces: mergeNamespaces(
        options.optionalNamespaces ?? {},
        options.requiredNamespaces ?? {},
      ),
    });
    return { uri, approval };
  } finally {
    engine.sendProposeSession = original;
  }
};

/** Raw JSON-RPC publish on a session/pairing topic, bypassing the dApp SignClient's validation. */
export const sendRaw = async (
  client: Dapp,
  topic: string,
  id: number,
  rpcMethod: string,
  params: unknown,
  tag = 1108,
): Promise<void> => {
  const message = await client.core.crypto.encode(topic, {
    id,
    jsonrpc: "2.0",
    method: rpcMethod,
    params,
  });
  await client.core.relayer.publish(topic, message, { tag, ttl: 300 });
};

/** A raw `wc_sessionRequest` — the shape `client.request` publishes without its own checks. */
export const sendRawRequest = async (
  client: Dapp,
  topic: string,
  id: number,
  method: string,
  params: unknown,
  chainId: string,
  expiryTimestamp?: number,
): Promise<void> =>
  sendRaw(
    client,
    topic,
    id,
    "wc_sessionRequest",
    {
      request: {
        method,
        params,
        ...(expiryTimestamp === undefined ? {} : { expiryTimestamp }),
      },
      chainId,
    },
    1108,
  );

export type RawAnswer = {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
};

/**
 * JSON-RPC answers the dApp receives on `topic`, decoded with its copy of the topic key. The
 * listener is installed once per (client, topic) — call `watchTopic` before the first publish so no
 * answer is missed.
 */
const watched = new WeakMap<Dapp, Map<string, Map<number, RawAnswer>>>();

export const watchTopic = (client: Dapp, topic: string): Map<number, RawAnswer> => {
  let byTopic = watched.get(client);
  if (byTopic === undefined) {
    byTopic = new Map();
    watched.set(client, byTopic);
    const topics = byTopic;
    client.core.relayer.on("relayer_message", (event: RelayerTypes.MessageEvent) => {
      const answers = topics.get(event.topic);
      if (answers === undefined) {
        return;
      }
      void (async () => {
        try {
          const payload = (await client.core.crypto.decode(event.topic, event.message)) as {
            id?: number;
            result?: unknown;
            error?: { code: number; message: string };
          };
          if (
            typeof payload === "object" &&
            payload !== null &&
            typeof payload.id === "number" &&
            ("result" in payload || "error" in payload)
          ) {
            answers.set(payload.id, payload);
          }
        } catch {
          // Settlement envelopes decode differently — only JSON-RPC answers matter here.
        }
      })();
    });
  }
  let answers = byTopic.get(topic);
  if (answers === undefined) {
    answers = new Map();
    byTopic.set(topic, answers);
  }
  return answers;
};

/** Polls until the decoded JSON-RPC answer for `id` appears on `topic`. */
export const answerFor = async (
  client: Dapp,
  topic: string,
  id: number,
  ms = 30_000,
): Promise<RawAnswer> => {
  const answers = watchTopic(client, topic);
  const deadline = Date.now() + ms;
  for (;;) {
    const found = answers.get(id);
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`no response for request ${id}`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
};

export const awaiting = (r: Rig): PendingRequest[] =>
  Object.values(r.engine.requests.getState().requests).filter(
    (request) => request.stage === "awaiting-approval",
  );

/**
 * Waits for exactly one awaiting-approval request and asserts its origin is the WalletConnect peer
 * on `topic` whose URL is `dappUrl` — every signing request in the e2e goes through this.
 */
export const pipelineRequest = async (
  r: Rig,
  topic: string,
  dappUrl: string,
  ms = 60_000,
): Promise<PendingRequest> => {
  await until(() => awaiting(r).length === 1, ms);
  const [request] = awaiting(r);
  if (request === undefined) {
    throw new Error("no awaiting request");
  }
  expect(request.origin).toMatchObject({
    kind: "walletconnect",
    topic,
    origin: walletConnectKey(topic),
    url: dappUrl,
  });
  return request;
};

export const approve = async (r: Rig, request: PendingRequest): Promise<unknown> => {
  const options = approval(request, PW);
  switch (request.method) {
    case "evm-sign":
    case "tron-sign":
      return r.engine.requests.approve(request.id, request.method, options);
    case "send":
      return r.engine.requests.approve(request.id, "send", options);
    case "solana-sign":
      return r.engine.requests.approve(request.id, "solana-sign", options);
    case "bitcoin-sign":
      return r.engine.requests.approve(request.id, "bitcoin-sign", options);
    default:
      throw new Error(`approve: no WalletConnect path prepares a ${request.method}`);
  }
};

export type SettledRequest = { value: unknown } | { error: unknown };

/** `client.request` as a settle-record — the test awaits it after approving/rejecting. */
export const settled = async (call: Promise<unknown>): Promise<SettledRequest> => {
  try {
    return { value: await call };
  } catch (error) {
    return { error };
  }
};

export const requestValue = (s: SettledRequest): unknown => {
  if ("error" in s) {
    throw new Error(`request failed: ${JSON.stringify(s.error)}`);
  }
  return s.value;
};

const transferIx = (from: string, to: string, lamports: bigint): Instruction => {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: address("11111111111111111111111111111111"),
    accounts: [
      { address: address(from), role: AccountRole.WRITABLE_SIGNER },
      { address: address(to), role: AccountRole.WRITABLE },
    ],
    data,
  };
};

/** An unsigned legacy wire transaction the given solana account is the fee payer of. */
export const solTx = (feePayer: string): Uint8Array => {
  const message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1000n },
    setTransactionMessageFeePayer(
      address(feePayer),
      createTransactionMessage({ version: "legacy" }),
    ),
  );
  const withIx = appendTransactionMessageInstruction(
    transferIx(feePayer, SOL_DEST, 1000n),
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- kit's branded message type does not carry over the blockhash setter
    message as never,
  );
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(withIx)));
};

export const caip10Tail = (account: string): string => account.split(":").pop() ?? "";

const anvilBin = (): string => {
  const local = `${process.env["HOME"] ?? ""}/.foundry/bin/anvil`;
  return existsSync(local) ? local : execFileSync("which", ["anvil"]).toString().trim();
};

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const bound = server.address();
      const port = typeof bound === "object" && bound !== null ? bound.port : 0;
      server.close(() => resolve(port));
    });
  });

export type Anvil = { readonly url: string; readonly port: number; readonly stop: () => void };

/** One anvil on a free port, chain-id 1 — the suite's only real chain endpoint. */
export const startAnvil = async (): Promise<Anvil> => {
  const port = await freePort();
  const proc = execFile(anvilBin(), ["--port", String(port), "--chain-id", "1", "--silent"]);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- readiness polling
      await rpcCall(url, "eth_chainId", []);
      break;
    } catch {
      if (Date.now() > deadline) {
        proc.kill();
        throw new Error("anvil did not come up");
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- readiness polling
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
    }
  }
  return {
    url,
    port,
    stop: () => {
      proc.kill();
    },
  };
};

export const rpcCall = async (url: string, method: string, params: unknown[]): Promise<unknown> => {
  const res = await realFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JSON-RPC envelope is peer-shaped
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) {
    throw new Error(body.error.message);
  }
  return body.result;
};
