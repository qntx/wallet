import { secp256k1 } from "@noble/curves/secp256k1.js";
/**
 * Per-family fakes for refused-broadcast tests: a node stub that can hold a broadcast in flight and
 * refuse it for good, a bombed engine store, manual poll timers and a backing shared by every boot
 * — so a restart over the same durable state is one call. All rigs expose the same shape so the
 * model test can pick a family without knowing which one it got.
 */
import { base58, base64 } from "@scure/base";
import { isHex, keccak256 } from "viem";

import type { Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import { tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";
import type { chains } from "@qntx/wallet/chains";

import { EsploraError } from "../../src/chains/bitcoin.ts";
import { gatewaySession } from "../../src/gateway/session.ts";
import { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { TransactionController } from "../../src/transactions/controller.ts";
import type { SendParams, TrackedTransaction } from "../../src/transactions/route.ts";
import {
  bombedStore,
  fakeSignedEvm,
  idleNetworkDeps,
  send,
  simulateV1Result,
} from "../send-helpers.ts";
import {
  ACCOUNT as BTC_ACCOUNT,
  NET as BTC_NET,
  RECIP as BTC_RECIP,
  VERIFY as BTC_VERIFY,
  world as btcWorld,
} from "./btc-world.ts";
import type { Backing as BtcBacking } from "./btc-world.ts";
import { manualTimers } from "./timers.ts";
import type { ManualTimers } from "./timers.ts";

export const POLL_MS = 4000;
const GATEWAY = "https://gateway.test";
const HOST = "http://host.local";
/** A second host wired as the independent endpoint; the primary never reaches it. */
export const HOST2 = "http://independent.local";
/** A host that always fails — an "available but unreachable" independent endpoint. */
export const DEAD_HOST = "http://dead.local";
const VERIFY = { kind: "password" as const, password: "pw" };

type Backing = { collections: Map<string, Map<string, Uint8Array>> };

export type Booted = {
  readonly ctl: TransactionController;
  readonly timers: ManualTimers;
};

/** One bomb-able store write failure injector, shared by every boot of a world. */
export type Bomb = {
  fail: ((collection: string, key: string, bytes: Uint8Array) => boolean) | undefined;
};

/**
 * What every family's fake offers a refused-broadcast scenario: a gated broadcast endpoint, a
 * one-word `refuse`, the log of raw payloads the node processed, and a store bomb.
 */
export type RefusedRig = {
  readonly boot: () => Promise<Booted>;
  readonly send: (b: Booted) => Promise<TrackedTransaction>;
  /** An ordinary send whose bytes differ from `send`'s — a repost check compares by raw. */
  readonly sendSibling: (b: Booted) => Promise<TrackedTransaction>;
  /** Every raw the node processed — the refused attempt included. */
  readonly nodePosts: string[];
  /** Broadcast attempts reached the node, including ones still held at the gate. */
  readonly attemptCount: () => number;
  /** Holds every broadcast at the node until `releaseSendGate`. */
  readonly armSendGate: () => void;
  readonly releaseSendGate: () => void;
  /** The next broadcasts are refused for good until `accept`. */
  readonly refuse: () => void;
  readonly accept: () => void;
  readonly bomb: Bomb;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const newBacking = (): Backing => ({ collections: new Map<string, Map<string, Uint8Array>>() });

const persistedRow = async (
  backing: Backing,
  id: string,
): Promise<Record<string, unknown> | undefined> => {
  const raw = await createMemoryEngineStore(backing).collection("transactions").get(id);
  if (raw === undefined) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
  return isObject(parsed) ? parsed : undefined;
};

/* ------------------------------------------------------------------ EVM */

const EVM_ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const EVM_ACCOUNT = {
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template: "evm.bip44" as const,
};
export const EVM_SEND: SendParams = {
  account: EVM_ACCOUNT,
  network: "eip155:1",
  to: "0x00000000000000000000000000000000deadbeef",
  amount: 1n,
  fee: "normal",
  verify: VERIFY,
};
export const EVM_VERIFY = VERIFY;
const EVM_REFUSAL = { code: -32000, message: "insufficient funds for gas * price + value" };

export type EvmNode = {
  latest: number;
  pending: number;
  known: Set<string>;
  receipts: Map<string, unknown>;
  /** Every raw the node's eth_sendRawTransaction processed — refused ones included. */
  sent: string[];
  /** Every sendRawTransaction fetch, including ones still waiting at the gate. */
  attempts: string[];
  /** Armed per test: the next sendRawTransaction answers with this JSON-RPC error. */
  refuse: { code: number; message: string } | undefined;
  /** Armed per test: every sendRawTransaction fetch fails like a dropped connection. */
  drop: boolean;
};

/** The independent host endpoint's own view of the chain — reachable only via `HOST2`. */
export type EvmHost = {
  known: Set<string>;
  receipts: Map<string, unknown>;
  /** Armed per test: every request to the host endpoint fails. */
  fail: boolean;
};

export type EvmWorld = {
  readonly node: EvmNode;
  /** The host endpoint's answers, when a boot wires `HOST2` into `rpc`. */
  readonly host: EvmHost;
  /** The engine's injected clock — advancing it is how test schedules age rows. */
  readonly clock: { t: number };
  /** The same durable map every `boot` opens — a restart over it is one call. */
  readonly backing: Backing;
  /** Every message the engine's logger warned about, in order. */
  readonly warnings: string[];
  readonly bomb: Bomb;
  /** Every sign request the fake chains api saw, in order. */
  readonly signed: SignRequest[];
  /**
   * `hosts` replaces the `rpc` host list; `gateway` wires the session so the host list becomes the
   * independent endpoint instead of the primary.
   */
  readonly boot: (opts?: {
    readonly hosts?: ReadonlyArray<string>;
    readonly gateway?: boolean;
  }) => Promise<Booted>;
  readonly persistedTx: (id: string) => Promise<Record<string, unknown> | undefined>;
  /** Every sendRawTransaction waits on the armed gate. */
  readonly armSendGate: () => void;
  readonly releaseSendGate: () => void;
  /** Every sign call waits on the armed gate. */
  readonly armSignGate: () => void;
  readonly releaseSignGate: () => void;
  /** The next sendRawTransaction gets a permanent JSON-RPC refusal. */
  readonly refuse: () => void;
};

export const evmWorld = (): EvmWorld => {
  const node: EvmNode = {
    latest: 0,
    pending: 0,
    known: new Set(),
    receipts: new Map(),
    sent: [],
    attempts: [],
    refuse: undefined,
    drop: false,
  };
  const host: EvmHost = { known: new Set(), receipts: new Map(), fail: false };
  const clock = { t: 1_000_000 };
  const backing = newBacking();
  const bomb: Bomb = { fail: undefined };
  const warnings: string[] = [];
  const signed: SignRequest[] = [];
  let tag = 0;
  /** Armed per test: every sendRawTransaction waits on this gate. */
  let sendGate: { promise: Promise<void>; open: () => void } | undefined;
  /** Armed per test: every sign call waits on this gate. */
  let signGate: { promise: Promise<void>; open: () => void } | undefined;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${GATEWAY}/v1/networks`) {
      return Response.json({ networks: ["eip155:1"] });
    }
    const parsed: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    const body = isObject(parsed) ? parsed : {};
    const method = typeof body["method"] === "string" ? body["method"] : "";
    const params: unknown[] = Array.isArray(body["params"]) ? body["params"] : [];
    if (url.startsWith(DEAD_HOST)) {
      throw new TypeError("fetch failed");
    }
    if (url.startsWith(HOST2)) {
      if (host.fail) {
        throw new TypeError("fetch failed");
      }
      const hostReply = ((): { result: unknown } => {
        switch (method) {
          case "eth_getTransactionCount":
            return { result: "0x0" };
          case "eth_getTransactionByHash":
            return { result: host.known.has(String(params[0])) ? { hash: params[0] } : null };
          case "eth_getTransactionReceipt":
            return { result: host.receipts.get(String(params[0])) ?? null };
          case "eth_sendRawTransaction": {
            const raw = String(params[0]);
            if (!isHex(raw)) {
              throw new Error("sendRawTransaction param is not hex");
            }
            const hash = keccak256(raw);
            host.known.add(hash);
            return { result: hash };
          }
          default:
            return { result: null };
        }
      })();
      return Response.json({ jsonrpc: "2.0", id: 1, ...hostReply });
    }
    if (method === "eth_sendRawTransaction") {
      node.attempts.push(String(params[0]));
      const gate = sendGate;
      if (gate !== undefined) {
        await gate.promise;
      }
      if (node.drop) {
        throw new TypeError("fetch failed");
      }
    }
    const reply = ((): { result: unknown } | { error: { code: number; message: string } } => {
      try {
        switch (method) {
          case "eth_getTransactionCount":
            return {
              result: `0x${(params[1] === "latest" ? node.latest : node.pending).toString(16)}`,
            };
          case "eth_gasPrice":
            return { result: "0x1" };
          case "eth_estimateGas":
            return { result: "0x5208" };
          case "eth_feeHistory":
            return {
              result: {
                baseFeePerGas: ["0x1", "0x1"],
                reward: [
                  ["0x1", "0x2"],
                  ["0x1", "0x2"],
                ],
              },
            };
          case "eth_blockNumber":
            return { result: "0x2" };
          case "eth_getBlockByNumber":
            return { result: { number: "0x2" } };
          case "eth_getBalance":
            return { result: "0x0" };
          case "eth_getCode":
            return { result: "0x" };
          case "eth_call":
            return { result: `0x${"00".repeat(32)}` };
          case "eth_simulateV1":
            return { result: simulateV1Result(params) };
          case "eth_sendRawTransaction": {
            const raw = String(params[0]);
            if (!isHex(raw)) {
              throw new Error("sendRawTransaction param is not hex");
            }
            node.sent.push(raw);
            const { refuse } = node;
            if (refuse !== undefined) {
              node.refuse = undefined;
              throw Object.assign(new Error(refuse.message), { code: refuse.code });
            }
            const hash = keccak256(raw);
            node.known.add(hash);
            node.pending += 1;
            return { result: hash };
          }
          case "eth_getTransactionByHash":
            return { result: node.known.has(String(params[0])) ? { hash: params[0] } : null };
          case "eth_getTransactionReceipt":
            return { result: node.receipts.get(String(params[0])) ?? null };
          default:
            throw new Error(`unmocked ${method}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const thrown =
          isObject(error) && typeof error["code"] === "number" ? error["code"] : undefined;
        const code = thrown ?? (message.startsWith("unmocked") ? -32601 : -1);
        return { error: { code, message } };
      }
    })();
    return Response.json({ jsonrpc: "2.0", id: 1, ...reply });
  };

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake only covers the account/sign surface the route calls
  const apis = {
    // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
    account: async () => ({ template: "evm.bip44", network: "eip155:1", address: EVM_ADDR }),
    sign: async ({ request }: { request: SignRequest }) => {
      signed.push(request);
      const gate = signGate;
      if (gate !== undefined) {
        await gate.promise;
      }
      return fakeSignedEvm(request);
    },
  } as unknown as ReturnType<typeof chains>;

  const random = (n: number): Uint8Array => {
    tag += 1;
    return new Uint8Array(n).fill(tag);
  };

  const boot = async (opts?: {
    hosts?: ReadonlyArray<string>;
    gateway?: boolean;
  }): Promise<Booted> => {
    const timers = manualTimers();
    const networks = new NetworkController({
      ...idleNetworkDeps,
      fetch: fetchImpl,
      rpc: { "eip155:1": opts?.hosts ?? [HOST] },
      gateway: opts?.gateway === true ? gatewaySession(GATEWAY, random) : undefined,
      // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
      openStore: async () => createMemoryEngineStore(),
      logger: { warn: () => undefined },
    });
    await networks.init();
    const ctl = new TransactionController({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- routes receive the wallet but never read it here
      wallet: {} as Wallet,
      networks,
      // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
      openStore: async () => bombedStore(createMemoryEngineStore(backing), bomb),
      random,
      setTimer: timers.setTimer,
      now: () => clock.t,
      logger: {
        warn: (msg) => {
          warnings.push(msg);
        },
      },
      pollMs: POLL_MS,
      chains: apis,
    });
    await ctl.init();
    return { ctl, timers };
  };

  return {
    node,
    host,
    clock,
    backing,
    warnings,
    bomb,
    signed,
    boot,
    persistedTx: async (id: string) => persistedRow(backing, id),
    armSendGate: () => {
      let open!: () => void;
      sendGate = {
        promise: new Promise<void>((resolve) => {
          open = resolve;
        }),
        open,
      };
    },
    releaseSendGate: () => {
      sendGate?.open();
      sendGate = undefined;
    },
    armSignGate: () => {
      let open!: () => void;
      signGate = {
        promise: new Promise<void>((resolve) => {
          open = resolve;
        }),
        open,
      };
    },
    releaseSignGate: () => {
      signGate?.open();
      signGate = undefined;
    },
    refuse: () => {
      node.refuse = EVM_REFUSAL;
    },
  };
};

/* ---------------------------------------------------------------- Solana */

const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_PAYER = "11111111111111111111111111111112";
const SOL_SEND: SendParams = {
  account: {
    kind: "hd" as const,
    walletId: "w",
    groupIndex: 0,
    template: "solana.bip44-change" as const,
  },
  network: SOL_NET,
  to: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: 1000n,
  fee: "normal",
  verify: VERIFY,
};
const SOL_REFUSAL =
  "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1";

export type SolanaWorld = {
  /** Signature → the getSignatureStatuses entry; absent stays null. */
  readonly statuses: Map<string, unknown>;
  /** Every wire sendTransaction processed — refused ones included. */
  readonly wires: string[];
  /** Every sendTransaction fetch, including ones still waiting at the gate. */
  readonly attempts: string[];
  readonly env: { blockHeight: number; slot: number; statusSlot: number };
  /** The same durable map every `boot` opens — a restart over it is one call. */
  readonly backing: Backing;
  /** Every message the engine's logger warned about, in order. */
  readonly warnings: string[];
  readonly bomb: Bomb;
  readonly boot: () => Promise<Booted>;
  readonly persistedTx: (id: string) => Promise<Record<string, unknown> | undefined>;
  readonly setSendMode: (
    mode: { kind: "ok" } | { kind: "rpc-error"; message: string } | { kind: "drop" },
  ) => void;
  /** Every sendTransaction waits on the armed gate. */
  readonly armSendGate: () => void;
  readonly releaseSendGate: () => void;
};

export const solanaWorld = (): SolanaWorld => {
  /** Signature → the getSignatureStatuses entry; absent stays null. */
  const statuses = new Map<string, unknown>();
  /** Every wire sendTransaction processed — refused ones included. */
  const wires: string[] = [];
  /** Every sendTransaction fetch, including ones still waiting at the gate. */
  const attempts: string[] = [];
  const env = { blockHeight: 1, slot: 500, statusSlot: 500 };
  const backing = newBacking();
  const bomb: Bomb = { fail: undefined };
  const warnings: string[] = [];
  let tag = 0;
  let sendMode: { kind: "ok" } | { kind: "rpc-error"; message: string } | { kind: "drop" } = {
    kind: "ok",
  };
  let sendGate: { promise: Promise<void>; open: () => void } | undefined;

  const answerMethod = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case "getLatestBlockhash":
        return {
          value: {
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 100_000,
          },
        };
      case "getRecentPrioritizationFees":
        return [];
      case "getMultipleAccounts":
        return { value: (Array.isArray(params[0]) ? params[0] : []).map(() => null) };
      case "simulateTransaction": {
        const cfg = isObject(params[1]) ? params[1] : undefined;
        const accounts = isObject(cfg?.["accounts"]) ? cfg["accounts"] : undefined;
        const watch = Array.isArray(accounts?.["addresses"]) ? accounts["addresses"] : [];
        return {
          value: { err: null, logs: [], unitsConsumed: 6000, accounts: watch.map(() => null) },
        };
      }
      case "getBlockHeight":
        return env.blockHeight;
      case "getEpochInfo":
        return { absoluteSlot: env.slot, blockHeight: env.blockHeight };
      case "sendTransaction": {
        const wire = String(params[0]);
        wires.push(wire);
        if (sendMode.kind === "rpc-error") {
          throw Object.assign(new Error(sendMode.message), { code: -32002 });
        }
        return base58.encode(base64.decode(wire).slice(1, 65));
      }
      case "isBlockhashValid":
        return { context: { slot: env.slot }, value: false };
      case "getSignatureStatuses": {
        const sigs = Array.isArray(params[0]) ? params[0] : [];
        return {
          context: { slot: env.statusSlot },
          value: sigs.map((s) => statuses.get(String(s)) ?? null),
        };
      }
      default:
        throw new Error(`unmocked ${method}`);
    }
  };

  const fetchImpl: typeof fetch = async (_input, init) => {
    const parsed: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    const body = isObject(parsed) ? parsed : {};
    const method = typeof body["method"] === "string" ? body["method"] : "";
    const params: unknown[] = Array.isArray(body["params"]) ? body["params"] : [];
    if (method === "sendTransaction") {
      attempts.push(String(params[0]));
      const gate = sendGate;
      if (gate !== undefined) {
        await gate.promise;
      }
      if (sendMode.kind === "drop") {
        throw new TypeError("fetch failed");
      }
    }
    const reply = ((): { result: unknown } | { error: { code: number; message: string } } => {
      try {
        return { result: answerMethod(method, params) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const thrown =
          isObject(error) && typeof error["code"] === "number" ? error["code"] : undefined;
        const code = thrown ?? (message.startsWith("unmocked") ? -32601 : -1);
        return { error: { code, message } };
      }
    })();
    return Response.json({ jsonrpc: "2.0", id: 1, ...reply });
  };

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake only covers the account/sign surface the route calls
  const apis = {
    // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
    account: async () => ({
      template: "solana.bip44-change",
      network: SOL_NET,
      address: SOL_PAYER,
    }),
    sign: async ({ request }: { request: { kind: string } }) => {
      await Promise.resolve();
      if (request.kind !== "solana.transaction") {
        throw new Error("unexpected request kind");
      }
      return { kind: "solana.transaction" as const, signature: new Uint8Array(64).fill(7) };
    },
  } as unknown as ReturnType<typeof chains>;

  const boot = async (): Promise<Booted> => {
    const timers = manualTimers();
    const ctl = new TransactionController({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- routes receive the wallet but never read it here
      wallet: {} as Wallet,
      networks: new NetworkController({
        ...idleNetworkDeps,
        fetch: fetchImpl,
        rpc: { [SOL_NET]: [HOST] },
        // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
        openStore: async () => createMemoryEngineStore(),
        logger: { warn: () => undefined },
      }),
      // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
      openStore: async () => bombedStore(createMemoryEngineStore(backing), bomb),
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      setTimer: timers.setTimer,
      now: () => 1_000_000,
      logger: {
        warn: (msg) => {
          warnings.push(msg);
        },
      },
      pollMs: POLL_MS,
      chains: apis,
    });
    await ctl.init();
    return { ctl, timers };
  };

  return {
    statuses,
    wires,
    attempts,
    env,
    backing,
    warnings,
    bomb,
    boot,
    persistedTx: async (id: string) => persistedRow(backing, id),
    setSendMode: (mode: typeof sendMode) => {
      sendMode = mode;
    },
    armSendGate: () => {
      let open!: () => void;
      sendGate = {
        promise: new Promise<void>((resolve) => {
          open = resolve;
        }),
        open,
      };
    },
    releaseSendGate: () => {
      sendGate?.open();
      sendGate = undefined;
    },
  };
};

/* ------------------------------------------------------------------ TRON */

const TRON_NET = "tron:3448148188";
const TRON_PRIV = new Uint8Array(32).fill(0x11);
const TRON_FROM = tronAddressFromPublicKey(secp256k1.getPublicKey(TRON_PRIV, false));
const TRON_TO = tronAddressFromPublicKey(
  secp256k1.getPublicKey(new Uint8Array(32).fill(0x22), false),
);
const TRON_SOLID_ID = "ab".repeat(32);
const TRON_SEND: SendParams = {
  account: {
    kind: "hd" as const,
    walletId: "w",
    groupIndex: 0,
    template: "tron.bip44" as const,
  },
  network: TRON_NET,
  to: TRON_TO,
  amount: 1_000_000n,
  fee: "normal",
  verify: VERIFY,
};
const TRON_PARAMS = {
  getTransactionFee: 1000,
  getEnergyFee: 210,
  getCreateAccountFee: 100_000,
  getCreateNewAccountFeeInSystemContract: 1_000_000,
  getMaxFeeLimit: 5_000_000_000,
  getCreateNewAccountBandwidthRate: 4,
  getMaxCreateAccountTxSize: 5000,
  getMemoFee: 1_000_000,
};

export type TronWorld = {
  /** Every `/wallet/broadcasthex` body the node processed — refused ones included. */
  readonly broadcasts: string[];
  /** Every broadcasthex fetch, including ones still waiting at the gate. */
  readonly attempts: string[];
  readonly env: {
    solidTime: number;
    fullHead: number;
    solidInfo: Map<string, Record<string, unknown>>;
    fullInfo: Map<string, Record<string, unknown>>;
    known: Set<string>;
    blockIds: Map<number, string>;
  };
  /** The same durable map every `boot` opens — a restart over it is one call. */
  readonly backing: Backing;
  /** Every message the engine's logger warned about, in order. */
  readonly warnings: string[];
  readonly bomb: Bomb;
  readonly boot: () => Promise<Booted>;
  readonly persistedTx: (id: string) => Promise<Record<string, unknown> | undefined>;
  readonly setBroadcastMode: (
    mode: { kind: "ok" } | { kind: "refuse"; code: string; message?: string } | { kind: "drop" },
  ) => void;
  /** Every broadcasthex fetch waits on the armed gate. */
  readonly armSendGate: () => void;
  readonly releaseSendGate: () => void;
};

export const tronWorld = (): TronWorld => {
  /** Every `/wallet/broadcasthex` body the node processed — refused ones included. */
  const broadcasts: string[] = [];
  /** Every broadcasthex fetch, including ones still waiting at the gate. */
  const attempts: string[] = [];
  const backing = newBacking();
  const bomb: Bomb = { fail: undefined };
  const warnings: string[] = [];
  const env = {
    solidTime: 900_000,
    fullHead: 105,
    solidInfo: new Map<string, Record<string, unknown>>(),
    fullInfo: new Map<string, Record<string, unknown>>(),
    known: new Set<string>(),
    blockIds: new Map<number, string>([[100, TRON_SOLID_ID]]),
  };
  let broadcastMode:
    | { kind: "ok" }
    | { kind: "refuse"; code: string; message?: string }
    | { kind: "drop" } = { kind: "ok" };
  let sendGate: { promise: Promise<void>; open: () => void } | undefined;
  let tag = 0;

  const answer = (path: string, body: Record<string, unknown>): unknown => {
    switch (path) {
      case "/walletsolidity/getnowblock":
        return {
          blockID: TRON_SOLID_ID,
          block_header: { raw_data: { number: 100, timestamp: env.solidTime } },
        };
      case "/wallet/getnowblock":
        return {
          blockID: "cd".repeat(32),
          block_header: { raw_data: { number: env.fullHead, timestamp: 910_000 } },
        };
      case "/wallet/getblockbynum":
      case "/walletsolidity/getblockbynum": {
        const id = env.blockIds.get(Number(body["num"]));
        return id === undefined
          ? {}
          : {
              blockID: id,
              block_header: { raw_data: { number: body["num"], timestamp: 900_000 } },
            };
      }
      case "/wallet/getchainparameters":
        return {
          chainParameter: Object.entries(TRON_PARAMS).map(([key, value]) => ({ key, value })),
        };
      case "/wallet/getaccount":
        return body["address"] === TRON_FROM
          ? { address: TRON_FROM, balance: 100_000_000 }
          : { address: TRON_TO, balance: 0 };
      case "/wallet/getaccountresource":
        return { freeNetLimit: 600, freeNetUsed: 0 };
      case "/wallet/broadcasthex": {
        const hex = String(body["transaction"]);
        broadcasts.push(hex);
        if (broadcastMode.kind === "refuse") {
          return {
            result: false,
            code: broadcastMode.code,
            message: broadcastMode.message ?? broadcastMode.code,
          };
        }
        return { result: true, txid: "ee".repeat(32) };
      }
      case "/wallet/gettransactionbyid":
        return env.known.has(String(body["value"])) ? { txID: String(body["value"]) } : {};
      case "/wallet/gettransactioninfobyid":
        return env.fullInfo.get(String(body["value"])) ?? {};
      case "/walletsolidity/gettransactioninfobyid":
        return env.solidInfo.get(String(body["value"])) ?? {};
      default:
        throw new Error(`unmocked ${path}`);
    }
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    await Promise.resolve();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const parsed: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    const body = isObject(parsed) ? parsed : {};
    if (path === "/wallet/broadcasthex") {
      attempts.push(String(body["transaction"]));
      const gate = sendGate;
      if (gate !== undefined) {
        await gate.promise;
      }
      if (broadcastMode.kind === "drop") {
        throw new TypeError("fetch failed");
      }
    }
    return Response.json(answer(path, body));
  };

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake only covers the account/sign surface the route calls
  const apis = {
    // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
    account: async () => ({ template: "tron.bip44", network: TRON_NET, address: TRON_FROM }),
    sign: async ({ request }: { request: { kind: string; rawData?: Uint8Array } }) => {
      await Promise.resolve();
      if (request.kind !== "tron.transaction" || !(request.rawData instanceof Uint8Array)) {
        throw new Error("unexpected request kind");
      }
      const sig = secp256k1.sign(request.rawData, TRON_PRIV, {
        lowS: true,
        format: "recovered",
      });
      const out = new Uint8Array(65);
      out.set(sig.subarray(1), 0);
      out[64] = 27 + (sig[0] ?? 0);
      return { kind: "tron.transaction" as const, signature: out };
    },
  } as unknown as ReturnType<typeof chains>;

  const boot = async (): Promise<Booted> => {
    const timers = manualTimers();
    const ctl = new TransactionController({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- routes receive the wallet but never read it here
      wallet: {} as Wallet,
      networks: new NetworkController({
        ...idleNetworkDeps,
        fetch: fetchImpl,
        rpc: { [TRON_NET]: [HOST] },
        // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
        openStore: async () => createMemoryEngineStore(),
        logger: { warn: () => undefined },
      }),
      // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
      openStore: async () => bombedStore(createMemoryEngineStore(backing), bomb),
      random: (n) => {
        tag += 1;
        return new Uint8Array(n).fill(tag);
      },
      setTimer: timers.setTimer,
      now: () => 1_000_000,
      logger: {
        warn: (msg) => {
          warnings.push(msg);
        },
      },
      pollMs: POLL_MS,
      chains: apis,
    });
    await ctl.init();
    return { ctl, timers };
  };

  return {
    broadcasts,
    attempts,
    env,
    backing,
    warnings,
    bomb,
    boot,
    persistedTx: async (id: string) => persistedRow(backing, id),
    setBroadcastMode: (mode: typeof broadcastMode) => {
      broadcastMode = mode;
    },
    armSendGate: () => {
      let open!: () => void;
      sendGate = {
        promise: new Promise<void>((resolve) => {
          open = resolve;
        }),
        open,
      };
    },
    releaseSendGate: () => {
      sendGate?.open();
      sendGate = undefined;
    },
  };
};

/* ------------------------------------------------------------ rig facade */

/** `fc` picks a family by name; each entry builds that family's uniform rig. */
export const refusedRigs: Record<"evm" | "bitcoin" | "solana" | "tron", () => RefusedRig> = {
  evm: () => {
    const w = evmWorld();
    return {
      boot: w.boot,
      send: async (b) => send(b.ctl, EVM_SEND),
      sendSibling: async (b) =>
        send(b.ctl, { ...EVM_SEND, to: "0x00000000000000000000000000000000cafef00d" }),
      nodePosts: w.node.sent,
      attemptCount: () => w.node.attempts.length,
      armSendGate: w.armSendGate,
      releaseSendGate: w.releaseSendGate,
      refuse: w.refuse,
      accept: () => {
        w.node.refuse = undefined;
      },
      bomb: w.bomb,
    };
  },
  bitcoin: () => {
    const w = btcWorld();
    w.fund(1, 50_000);
    w.fund(2, 45_000);
    /** One shared backing for every boot — a restart over the same durable state. */
    const backing: BtcBacking = { collections: new Map() };
    let n = 0;
    let openGate: (() => void) | undefined;
    return {
      boot: async (): Promise<Booted> => w.boot(backing),
      send: async (b) => {
        n += 1;
        const prepared = await b.ctl.prepareSend(
          {
            account: BTC_ACCOUNT,
            network: BTC_NET,
            to: BTC_RECIP,
            amount: 10_000n,
            fee: "slow",
          },
          `req-${n}`,
        );
        return prepared.submit(BTC_VERIFY, () => undefined);
      },
      sendSibling: async (b) => {
        n += 1;
        const prepared = await b.ctl.prepareSend(
          {
            account: BTC_ACCOUNT,
            network: BTC_NET,
            to: BTC_RECIP,
            amount: 20_000n,
            fee: "slow",
          },
          `req-${n}`,
        );
        return prepared.submit(BTC_VERIFY, () => undefined);
      },
      nodePosts: w.posts,
      attemptCount: () => w.postAttempts.length,
      armSendGate: () => {
        w.gatePost(
          new Promise<void>((resolve) => {
            openGate = resolve;
          }),
        );
      },
      releaseSendGate: () => {
        openGate?.();
        openGate = undefined;
      },
      refuse: () => {
        w.setPost({
          kind: "throw",
          error: new EsploraError(
            'esplora /tx: 400 sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}',
            false,
          ),
        });
      },
      accept: () => {
        w.setPost({ kind: "ok" });
      },
      bomb: w.bomb,
    };
  },
  solana: () => {
    const w = solanaWorld();
    return {
      boot: w.boot,
      send: async (b) => send(b.ctl, SOL_SEND),
      sendSibling: async (b) => send(b.ctl, { ...SOL_SEND, amount: 2000n }),
      nodePosts: w.wires,
      attemptCount: () => w.attempts.length,
      armSendGate: w.armSendGate,
      releaseSendGate: w.releaseSendGate,
      refuse: () => {
        w.setSendMode({ kind: "rpc-error", message: SOL_REFUSAL });
      },
      accept: () => {
        w.setSendMode({ kind: "ok" });
      },
      bomb: w.bomb,
    };
  },
  tron: () => {
    const w = tronWorld();
    return {
      boot: w.boot,
      send: async (b) => send(b.ctl, TRON_SEND),
      sendSibling: async (b) => send(b.ctl, { ...TRON_SEND, amount: 2_000_000n }),
      nodePosts: w.broadcasts,
      attemptCount: () => w.attempts.length,
      armSendGate: w.armSendGate,
      releaseSendGate: w.releaseSendGate,
      refuse: () => {
        w.setBroadcastMode({ kind: "refuse", code: "CONTRACT_VALIDATE_ERROR" });
      },
      accept: () => {
        w.setBroadcastMode({ kind: "ok" });
      },
      bomb: w.bomb,
    };
  },
};
