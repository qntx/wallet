import type { PublicClient } from "viem";
import { expect } from "vite-plus/test";

/**
 * `createApps` end to end on the real Node kernel and a real `RequestController` (built the way
 * requests.test.ts builds it, with `chains` wired to the real wallet): enable/renew/disable, orphan
 * cleanup on every definitive failure, the revoke binding, cancel/busy rules, locked host methods,
 * persistence shape, and user-signed outcomes. Approval requests are approved with the password
 * factor; Hyperliquid answers come from an injected fetch; timers are manual.
 */
import { verifyEvent } from "@qntx/nostr";
import type { Wallet } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { sessions } from "@qntx/wallet/sessions";
import type { SessionInfo } from "@qntx/wallet/sessions";

import { fiat24 as fiat24App } from "../src/apps/fiat24/app.ts";
import type { Fiat24App } from "../src/apps/fiat24/app.ts";
import { hyperliquid as hyperliquidApp } from "../src/apps/hyperliquid/app.ts";
import type { AppsHyperliquidConfig } from "../src/apps/hyperliquid/app.ts";
import type { HyperliquidProvider } from "../src/apps/hyperliquid/provider.ts";
import type { HyperliquidGroupState } from "../src/apps/hyperliquid/state.ts";
import { createApps } from "../src/apps/index.ts";
import type { AppsController } from "../src/apps/index.ts";
import { polymarket as polymarketApp } from "../src/apps/polymarket/app.ts";
import type { AppsPolymarketConfig } from "../src/apps/polymarket/app.ts";
import { createPolymarketCredentials } from "../src/apps/polymarket/credentials.ts";
import type { PolymarketCredentialStore } from "../src/apps/polymarket/credentials.ts";
import type { PolymarketProvider } from "../src/apps/polymarket/provider.ts";
import type { PolymarketGroupState } from "../src/apps/polymarket/state.ts";
import {
  derivePolymarketWallets,
  expectedPolymarketWalletRuntime,
} from "../src/apps/polymarket/wallets.ts";
import { createAppStorage } from "../src/apps/storage.ts";
import type { AppGroupState } from "../src/apps/types.ts";
import type { EngineOptions } from "../src/engine.ts";
import type { EngineLogger } from "../src/events.ts";
import type { EligibilityResponse } from "../src/gateway/contract/eligibility.ts";
import { NetworkController } from "../src/networks/controller.ts";
import type { Independent } from "../src/networks/controller.ts";
import { AcknowledgementRequiredError, RequestController } from "../src/requests/controller.ts";
import { SignersController } from "../src/signers/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

export { describe, expect, it } from "vite-plus/test";

/** Chain-only tests never reach the Spark controller (send-helpers' pattern). */
const isSparkController = (_value: unknown): _value is SparkController => true;

const noSpark = ((): SparkController => {
  const stub: unknown = {};
  if (isSparkController(stub)) {
    return stub;
  }
  throw new Error("unreachable");
})();

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password" as const, password: PASSWORD };
const RANDOM = (length: number): Uint8Array => new Uint8Array(length).fill(7);
const DAY = 86_400_000;

export type ManualTimer = {
  time: number;
  readonly setTimer: (ms: number, fn: () => unknown) => () => void;
  readonly now: () => number;
  readonly pump: () => boolean;
};

export const manualTimer = (start = Date.now()): ManualTimer => {
  const queue: Array<{ at: number; fn: () => unknown; cancelled: boolean }> = [];
  const timers = {
    setTimer: (ms: number, fn: () => unknown) => {
      const entry = { at: timers.time + ms, fn, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    now: () => timers.time,
    time: start,
    pump: () => {
      for (const entry of queue.filter((e) => !e.cancelled && e.at <= timers.time)) {
        entry.cancelled = true;
        entry.fn();
      }
      const [next] = queue.filter((e) => !e.cancelled).toSorted((a, b) => a.at - b.at);
      if (next !== undefined) {
        timers.time = next.at;
      }
      timers.time += 1;
      return queue.some((e) => !e.cancelled);
    },
  };
  return timers;
};

export type Posted = {
  readonly endpoint: "info" | "exchange" | "iris";
  readonly body: Record<string, unknown>;
};

/** The live Hyperliquid state the injected fetch serves — tests mutate it between polls. */
export type HlState = {
  /** Agents Hyperliquid lists for the owner (what `extraAgents` answers). */
  listed: Map<string, { address: string; name: string; validUntil: number }>;
  maxBuilderFee: number;
  role: string;
  exchange?: (body: Record<string, unknown>) => unknown;
  exchangeError?: () => unknown;
  /** Info-endpoint override — answers before the defaults. */
  info?: (body: Record<string, unknown>) => unknown;
  /** ApproveAgent answers ok but Hyperliquid never lists the agent (verify-timeout tests). */
  noAutoList?: boolean;
  /** ApproveBuilderFee answers ok but maxBuilderFee never confirms (builder-timeout tests). */
  noAutoBuilderFee?: boolean;
  /** The gateway's /v1/eligibility answer — a response factory, or throw for `error` status. */
  eligibility?: () => EligibilityResponse;
  /** The Iris forward-fee rows `fund.deposit` parses — malformed/missing rows are tested here. */
  iris?: { readonly status: number; readonly body: unknown };
  /** The Arbitrum eth_call answers the deposit's CCTP reads get. */
  arb?: {
    /** `localMinter()` on the TokenMessengerV2 — defaults to a nonzero address. */
    readonly minter?: string;
    /** `burnLimitsPerMessage(USDC)` — defaults to `0xffffffffffffffff`. */
    readonly burnLimit?: bigint;
    /** `allowance(owner, messenger)` on USDC — defaults to 0 (approve runs). */
    readonly allowance?: bigint;
  };
};

const listAgent = (
  timers: ReturnType<typeof manualTimer>,
  action: Record<string, unknown>,
): { address: string; name: string; validUntil: number } => ({
  address: String(action["agentAddress"]),
  name: String(action["agentName"]).split(" ")[0] ?? "",
  validUntil: timers.time + 179 * DAY,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Request bodies are always JSON objects in these tests — a guard, not an assertion. */
const bodyJson = (init?: RequestInit): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  return isRecord(parsed) ? parsed : {};
};

export const hlFetch =
  (posted: Posted[], timers: ReturnType<typeof manualTimer>, hl: HlState) =>
  async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = bodyJson(init);
    const headers = { date: new Date(timers.time).toUTCString() };
    if (url.startsWith("https://iris-api")) {
      const iris = hl.iris ?? {
        status: 200,
        body: [
          {
            finalityThreshold: 1000,
            minimumFee: 0,
            forwardFee: { low: 200000, med: 200000, high: 200000 },
          },
          {
            finalityThreshold: 2000,
            minimumFee: 0,
            forwardFee: { low: 200000, med: 200000, high: 200000 },
          },
        ],
      };
      posted.push({ endpoint: "iris", body });
      return Response.json(iris.body, { status: iris.status, headers });
    }
    if (url.endsWith("/v1/eligibility")) {
      const answer =
        hl.eligibility === undefined
          ? {
              country: "US",
              region: null,
              apps: {
                fiat24: "available",
                hyperliquid: "available",
                polymarket: "available",
              },
            }
          : hl.eligibility();
      return Response.json(answer, { headers });
    }
    if (url.endsWith("/exchange")) {
      const action = isRecord(body["action"]) ? body["action"] : {};
      posted.push({ endpoint: "exchange", body });
      if (hl.exchangeError !== undefined) {
        throw new Error("connection reset");
      }
      const answer =
        hl.exchange === undefined
          ? { status: "ok", response: { type: "default" } }
          : await hl.exchange(body);
      if (action["type"] === "approveAgent" && hl.noAutoList !== true) {
        hl.listed.set(String(action["agentAddress"]), listAgent(timers, action));
      }
      if (action["type"] === "approveBuilderFee" && hl.noAutoBuilderFee !== true) {
        // The confirmation poll reads maxBuilderFee — a committed approval raises it.
        hl.maxBuilderFee = 10000;
      }
      return Response.json(answer, { headers });
    }
    posted.push({ endpoint: "info", body });
    const { type } = body;
    const override = hl.info?.(body);
    const response =
      override === undefined
        ? type === "extraAgents"
          ? [...hl.listed.values()]
          : type === "maxBuilderFee"
            ? hl.maxBuilderFee
            : type === "userRole"
              ? { role: hl.role }
              : type === "allMids"
                ? { BTC: "57957.5" }
                : type === "orderStatus"
                  ? { status: "unknownOid" }
                  : {}
        : override;
    return Response.json(response, { headers });
  };

const rpcString = (value: string): string => {
  // oxlint-disable-next-line unicorn/prefer-spread -- iterates code points, not UTF-16 units.
  const bytes = Array.from(value)
    .map((c) => (c.codePointAt(0) ?? 0).toString(16).padStart(2, "0"))
    .join("");
  return `0x${"00".repeat(31)}20${value.length.toString(16).padStart(64, "0")}${bytes.padEnd(64, "0")}`;
};

/** The Polygon chain-evidence a world's `locate` reads — set to mirror the relayer feed's claims. */
export type PolyChain = { code?: (address: string) => string | undefined };

/**
 * The `eth_getCode` a consistent chain would hold for `signer`'s account candidates given the
 * relayer feed's `deployed` claim — claimed deposit wallets get their expected runtime, a claimed
 * Safe any non-empty code.
 */
export const pmChainCode = (
  deployed: (address: string, type: string) => boolean,
  signer: `0x${string}`,
): ((address: string) => string) => {
  const candidates = derivePolymarketWallets(signer);
  const deposit = (address: string, kind: "beacon" | "uups"): string =>
    deployed(address, "WALLET") ? expectedPolymarketWalletRuntime(kind, signer) : "0x";
  return (address) => {
    const a = address.toLowerCase();
    if (a === candidates.beacon.toLowerCase()) {
      return deposit(a, "beacon");
    }
    if (a === candidates.uups.toLowerCase()) {
      return deposit(a, "uups");
    }
    return a === candidates.safe.toLowerCase() && deployed(a, "SAFE") ? "0x6001" : "0x";
  };
};

/** A PublicClient stub answering `eth_getCode` from `codeOf` ("0x" when it returns undefined). */
export const rpcStub = (codeOf: (address: string) => string | undefined): PublicClient => {
  const client = {
    transport: {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        await Promise.resolve();
        if (method !== "eth_getCode") {
          throw new Error(`unstubbed rpc ${method}`);
        }
        const args = Array.isArray(params) ? params : [];
        return codeOf(typeof args[0] === "string" ? args[0] : "") ?? "0x";
      },
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stub only covers transport.request.
  return client as unknown as PublicClient;
};

/**
 * The `networks` option for tests that build `createPolymarketWallets` or
 * `createPolymarketProvider` directly: `client` answers `eth_getCode` from `codeOf`;
 * `independentClient` defaults to `not-needed` (the primary reads are already the hosts').
 */
export const networksStub = (
  codeOf: (address: string) => string | undefined,
  independent?: Independent<PublicClient>,
): Pick<NetworkController, "client" | "independentClient"> => ({
  client: () => rpcStub(codeOf),
  independentClient: () => independent ?? { kind: "not-needed" },
});

/* Polygon — the Polymarket `send` deposit resolves pUSD metadata + gas over this endpoint, and
   `locate` reads eth_getCode on the account candidates from `poly.code`. */
const polyRpc = async (init: RequestInit | undefined, poly: PolyChain): Promise<Response> => {
  const body = bodyJson(init);
  await Promise.resolve();
  const rpcParams: unknown = body["params"];
  const firstParam: unknown = Array.isArray(rpcParams) ? rpcParams[0] : undefined;
  const callData =
    body["method"] === "eth_call" &&
    typeof firstParam === "object" &&
    firstParam !== null &&
    "data" in firstParam
      ? String(firstParam.data)
      : "";
  const result =
    body["method"] === "eth_chainId"
      ? "0x89"
      : body["method"] === "eth_blockNumber"
        ? "0x1"
        : body["method"] === "eth_call" && callData.startsWith("0x313ce567")
          ? `0x${"00".repeat(31)}06`
          : body["method"] === "eth_call" && callData.startsWith("0x95d89b41")
            ? rpcString("pUSD")
            : body["method"] === "eth_call" && callData.startsWith("0x06fdde03")
              ? rpcString("Polymarket USD")
              : body["method"] === "eth_call"
                ? `0x${"00".repeat(32)}`
                : body["method"] === "eth_getCode"
                  ? (poly.code?.(typeof firstParam === "string" ? firstParam : "") ?? "0x")
                  : body["method"] === "eth_getTransactionCount"
                    ? "0x0"
                    : body["method"] === "eth_estimateGas"
                      ? "0x5208"
                      : body["method"] === "eth_feeHistory"
                        ? { baseFeePerGas: ["0x1"], gasUsedRatio: [0.1], oldestBlock: "0x1" }
                        : "0x0";
  return Response.json({ jsonrpc: "2.0", id: 1, result });
};

const word = (v: bigint | string | number): string =>
  `0x${(typeof v === "bigint" ? v : BigInt(v)).toString(16).padStart(64, "0")}`;

const arbRpc = async (init: RequestInit | undefined, hl: HlState): Promise<Response> => {
  const body = bodyJson(init);
  await Promise.resolve();
  const params = Array.isArray(body["params"]) ? (body["params"] as unknown[]) : [];
  const ethCall = isRecord(params[0]) ? params[0] : undefined;
  const callData = typeof ethCall?.["data"] === "string" ? ethCall["data"] : "";
  const callResult = callData.startsWith("0xcb75c11c")
    ? word(hl.arb?.minter ?? "0x00000000000000000000000000000000deadbee5")
    : callData.startsWith("0xa56ec632")
      ? word(hl.arb?.burnLimit ?? 0xffffffffffffffffn)
      : callData.startsWith("0xdd62ed3e")
        ? word(hl.arb?.allowance ?? 0n)
        : `0x${"00".repeat(32)}`;
  /* On a real chain depositForBurnWithHook reverts while the approve is unmined — mirror that:
     estimateGas answers an execution-reverted error whenever the allowance is below the amount
     encoded in the call's first argument. */
  const estimateResult =
    callData.startsWith("0x779b432d") &&
    (hl.arb?.allowance ?? 0n) < BigInt(`0x${callData.slice(10, 74)}`)
      ? undefined
      : "0x5208";
  if (estimateResult === undefined) {
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      error: { code: 3, message: "execution reverted" },
    });
  }
  const result =
    body["method"] === "eth_chainId"
      ? "0x66eee"
      : body["method"] === "eth_blockNumber"
        ? "0x1"
        : body["method"] === "eth_call"
          ? callResult
          : body["method"] === "eth_getTransactionCount"
            ? "0x0"
            : body["method"] === "eth_estimateGas"
              ? estimateResult
              : body["method"] === "eth_feeHistory"
                ? { baseFeePerGas: ["0x1"], gasUsedRatio: [0.1], oldestBlock: "0x1" }
                : "0x0";
  return Response.json({ jsonrpc: "2.0", id: 1, result });
};

export const tick = async (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve);
  });

export const until = async (cond: () => boolean, tries = 300): Promise<void> => {
  for (let i = 0; i < tries && !cond(); i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- real-kernel turns need the event loop.
    await tick();
  }
  expect(cond()).toBe(true);
};

/** Poll an async read until it answers — a fire-and-forget record write lands a tick later. */
export const untilPresent = async <T>(
  read: () => Promise<T | undefined>,
  tries = 50,
): Promise<T> => {
  for (let i = 0; i < tries; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls.
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls.
    await tick();
  }
  throw new Error("read never produced a value");
};

/** Poll an async read until it goes away — the mirror of `untilPresent` for deleted records. */
export const untilGone = async <T>(
  read: () => Promise<T | undefined>,
  tries = 50,
): Promise<void> => {
  for (let i = 0; i < tries; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls.
    if ((await read()) === undefined) {
      return;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls.
    await tick();
  }
  throw new Error("read never went away");
};

/** Pump manual timers until `cond` — for flows whose timers drive a verify window. */
export const pumpUntil = async (
  timers: ReturnType<typeof manualTimer>,
  cond: () => boolean,
  tries = 300,
): Promise<void> => {
  for (let i = 0; i < tries; i++) {
    timers.pump();
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls.
    await tick();
    if (cond()) {
      return;
    }
  }
};

/** Await a flow's rejection without leaving it unhandled while pumps drive it. */
export const swallow = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch {
    // The caller asserts the rejection separately.
  }
};

let shared: { wallet: Wallet; walletId: string } | undefined;

/** A brand-new node wallet + mnemonic import — each call gets its own kernel and vault. */
export const freshNodeWallet = async (): Promise<{ wallet: Wallet; walletId: string }> => {
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
    authenticator: createSoftwarePasskey(new Uint8Array(32).fill(11)),
    kernelUrl: KERNEL_URL,
  });
  const { walletId } = await wallet.wallets.importMnemonic({
    mnemonic: MNEMONIC,
    factor: VERIFY,
  });
  return { wallet, walletId };
};

export const nodeWallet = async (): Promise<{ wallet: Wallet; walletId: string }> => {
  shared ??= await freshNodeWallet();
  return shared;
};

/** The group map a world builds — its app lanes' provider-owned group states. */
type WorldGroups = {
  readonly fiat24: AppGroupState;
  readonly hyperliquid: HyperliquidGroupState;
  readonly polymarket: PolymarketGroupState;
};

/** A JSON-RPC answer source for `eip155:42161` — the fiat24 lane's chain reads replay through it. */
export type Arb1Rpc = (body: { readonly method: string; readonly params?: unknown }) => unknown;

/** A JSON-RPC error answer — `arb1Error(…)` makes the endpoint refuse the call instead of answering. */
export const arb1Error = (code: number, message: string, data?: string) =>
  ({ rpcError: { code, message, ...(data === undefined ? {} : { data }) } }) as const;

const isArb1Error = (answer: unknown): answer is ReturnType<typeof arb1Error> =>
  typeof answer === "object" && answer !== null && "rpcError" in answer;

export type World = {
  wallet: Wallet;
  provider: HyperliquidProvider;
  /** The configured Polymarket provider — `undefined` unless `options.polymarket` was set. */
  pm: PolymarketProvider | undefined;
  /** The configured Fiat24 api — the getter throws unless `options.fiat24` was set. */
  readonly f24: Fiat24App;
  /** The Polygon chain facts `locate` reads — set `code` to mirror the relayer feed's claims. */
  poly: PolyChain;
  walletId: string;
  apps: AppsController<WorldGroups>;
  destroy: () => Promise<void>;
  requests: RequestController;
  posted: Posted[];
  timers: ReturnType<typeof manualTimer>;
  hl: HlState;
  store: EngineStore;
  /** The session store the apps controller currently holds — `undefined` while locked. */
  session: () => EngineStore | undefined;
  /** The Polymarket credential store over the live session — seeds and reads records. */
  credentials: PolymarketCredentialStore;
  group: { walletId: string; groupIndex: number };
  /** Logger warnings collected for the world (diagnostics). */
  warns: string[];
  state: () => HyperliquidGroupState | undefined;
  /** The group's `polymarket` app state — undefined until a flow or reconcile writes it. */
  pmState: () => PolymarketGroupState | undefined;
  /** The group's `fiat24` app state — undefined until a flow or reconcile writes it. */
  f24State: () => AppGroupState | undefined;
  approve: (id: string) => Promise<void>;
  /** The one signing path — its `active` mirrors a running device operation. */
  signers: SignersController;
};

export const world = async (
  groupIndex = 0,
  options: {
    agentName?: string;
    store?: EngineStore;
    openStore?: () => Promise<EngineStore>;
    hl?: Partial<HlState>;
    builder?: { address: string; feeRateTenthsBps: number };
    /** Enable the Polymarket lane (provider + enable state machine) with this config. */
    polymarket?: AppsPolymarketConfig;
    /** The `eth_getCode` answers `locate` reads on Polygon — must mirror the relayer feed. */
    polyCode?: PolyChain["code"];
    /** `false` omits the Hyperliquid lane entirely (Polymarket-only worlds). */
    hyperliquid?: AppsHyperliquidConfig | false;
    /** Register the Fiat24 lane — `true` for no api fetch, or the `fiat24()` config. */
    fiat24?: boolean | Parameters<typeof fiat24App>[0];
    /**
     * JSON-RPC answers for `eip155:42161` — required when the Fiat24 lane reads the chain; without
     * it any Arbitrum One call throws in the fetch shim.
     */
    arb1?: Arb1Rpc;
    /**
     * Replaces `hlFetch` for the apps composition — the Polymarket tests script every host
     * (relayer, CLOB, Data API, eligibility) themselves.
     */
    fetch?: typeof globalThis.fetch;
    /** A caller-anchored clock — Polymarket's kernel-signed L2 ops need real-time alignment. */
    timers?: ReturnType<typeof manualTimer>;
    /** Request/record ids — a counter source when a test must tell two requests apart. */
    random?: (length: number) => Uint8Array;
    /** The host's transport for paired devices — the world's signing path runs through signers. */
    deviceIo?: EngineOptions["deviceIo"];
    /** A caller-provided wallet (the card rig's) — the shared node wallet otherwise. */
    wallet?: { wallet: Wallet; walletId: string };
    /** Extra host endpoints per network (the e2e harness registers its stub upstreams here). */
    rpc?: Record<string, ReadonlyArray<string>>;
    /**
     * Wraps the real `requests` handed to `createApps` — a capture shim for the typed-data
     * documents the flows prepare (approvals still go through `w.requests`).
     */
    wrapRequests?: (
      requests: RequestController,
    ) => Pick<RequestController, "prepare" | "outcome" | "reject">;
  } = {},
): Promise<World> => {
  const { wallet, walletId } = options.wallet ?? (await nodeWallet());
  // A previous test may have locked the shared wallet — restore the unlocked precondition.
  await wallet.vault.unlock(VERIFY).catch(() => undefined);
  const posted: Posted[] = [];
  const timers = options.timers ?? manualTimer();
  const warns: string[] = [];
  const logger = { warn: (...args: unknown[]) => warns.push(String(args[0])) };
  const hl: HlState = { listed: new Map(), maxBuilderFee: 0, role: "user", ...options.hl };
  /* The chain facts `locate` reads on Polygon — init-time reconciles already locate, so the
     option must be in place before createApps runs. */
  const poly: PolyChain = options.polyCode === undefined ? {} : { code: options.polyCode };
  const fetch = options.fetch ?? hlFetch(posted, timers, hl);
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://arb-sepolia.test/rpc") {
        return arbRpc(init, hl);
      }
      if (url === "https://arbitrum-one.test/rpc") {
        const body = bodyJson(init);
        if (options.arb1 === undefined) {
          throw new Error("no arb1 rpc answers configured");
        }
        const method = typeof body["method"] === "string" ? body["method"] : "";
        const answer = await options.arb1({ method, params: body["params"] });
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          ...(isArb1Error(answer) ? { error: answer.rpcError } : { result: answer }),
        });
      }
      return url === "https://polygon.test/rpc" ? polyRpc(init, poly) : fetch(input, init);
    },
    rpc: {
      "eip155:421614": ["https://arb-sepolia.test/rpc"],
      "eip155:42161": ["https://arbitrum-one.test/rpc"],
      "eip155:137": ["https://polygon.test/rpc"],
      ...options.rpc,
    },
    openStore: async () => {
      await Promise.resolve();
      return createMemoryEngineStore();
    },
    logger,
  });
  const signers = new SignersController({
    wallet,
    deviceIo: options.deviceIo,
    recheck: async () => {
      // Unit fixtures keep no material cache — nothing to recheck.
    },
    /* Same wiring as engine.ts: fetchAccounts derives on one enabled network per family. */
    networks: { enabled: (family) => networks.enabled(family) },
    random: options.random ?? RANDOM,
    logger,
  });
  const transactions = new TransactionController({
    wallet,
    networks,
    openStore: async () => {
      await Promise.resolve();
      return createMemoryEngineStore();
    },
    random: options.random ?? RANDOM,
    setTimer: timers.setTimer,
    now: () => timers.time,
    logger,
    pollMs: 1,
    chains: signers.apis,
  });
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    ...bookDeps(),
    spark: noSpark,
    nostrSign: async () => {
      await Promise.resolve();
      throw new Error("unused");
    },
    bitcoinPrepare: async () => {
      await Promise.resolve();
      throw new Error("unused");
    },
    bitcoinSignPsbts: async () => {
      await Promise.resolve();
      throw new Error("unused");
    },
    bitcoinSign: async () => {
      await Promise.resolve();
      throw new Error("unused");
    },
    solanaSign: async () => {
      await Promise.resolve();
      throw new Error("unused");
    },
    fetch,
    random: options.random ?? RANDOM,
    now: () => timers.time,
    setTimer: timers.setTimer,
    logger,
  });
  /* Session stores are restartable facades over `tables` — a lock closes the session, never the
     records; `w.store` is a persistent read handle over the same backing. A caller-supplied
     `store` keeps the old single-store wiring (worlds that share one deliberately). */
  const tables = new Map<string, Map<string, Uint8Array>>();
  const store = options.store ?? createMemoryEngineStore({ collections: tables });
  const rawOpenStore =
    options.openStore ??
    (options.store === undefined
      ? restartableStore(tables)
      : async () => {
          await Promise.resolve();
          return store;
        });
  /* Tracks the session store the apps controller holds — the same read `createApps` makes — so
     the world can seed and inspect app records while unlocked. */
  let session: EngineStore | undefined;
  const openStore = async (): Promise<EngineStore> => {
    const next = await rawOpenStore();
    let closed = false;
    const facade: EngineStore = {
      collection: (name) => next.collection(name),
      close: async () => {
        if (!closed) {
          closed = true;
          session = undefined;
          await next.close();
        }
      },
    };
    session = facade;
    return facade;
  };
  const credentials = createPolymarketCredentials({
    /* The vault flag gates the session like the real close — deterministic under a lock that
       has resolved but whose transition is still queued. */
    storage: createAppStorage("polymarket", () =>
      wallet.getSnapshot().vault === "unlocked" ? session : undefined,
    ),
    logger,
  });
  const definitions = [
    /* Only worlds built with `hyperliquid: false` omit the Hyperliquid lane, and they never
       read `provider`. */
    ...(options.hyperliquid === false
      ? []
      : [
          hyperliquidApp(
            options.hyperliquid ?? {
              network: "Testnet",
              agentName: options.agentName ?? "qntx-test",
              ...(options.builder === undefined ? {} : { builder: options.builder }),
            },
          ),
        ]),
    ...(options.polymarket === undefined ? [] : [polymarketApp(options.polymarket)]),
    ...(options.fiat24 === undefined || options.fiat24 === false
      ? []
      : [fiat24App(options.fiat24 === true ? {} : options.fiat24)]),
  ];
  const created = createApps({
    wallet,
    requests: options.wrapRequests === undefined ? requests : options.wrapRequests(requests),
    networks,
    fetch,
    /* Advances 1 ms per read — two clock reads never agree, which is exactly what the
       revoke binding's single-read `validUntil` protects against. */
    now: () => {
      timers.time += 1;
      return timers.time;
    },
    setTimer: timers.setTimer,
    random: options.random ?? RANDOM,
    logger,
    openStore,
    /* A socket that never opens — these tests exercise HTTP flows; live views are covered in
       hyperliquid-live.test.ts with a controllable fake. */
    socket: () => ({
      readyState: 0,
      send: () => undefined,
      close: () => undefined,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    }),
    /* Every existing test enables apps → the stub answers "available" unless overridden. */
    gateway: { url: "https://gateway.test" },
    apps: definitions,
  });
  const { controller, destroy } = created;
  /* The `AppApis` surface claims every listed definition's api — a world built with
     `hyperliquid: false` still lacks `hyperliquid` at runtime. */
  const provider: HyperliquidProvider | undefined = created.hyperliquid;
  const polymarket: PolymarketProvider | undefined = created.polymarket;
  const fiat24: Fiat24App | undefined = created.fiat24;
  await networks.init();
  await transactions.init();
  await requests.init();
  /* The controller's init chain (agents refresh → eligibility → reconcile) runs on the
     wallet's subscribe event — wait for the eligibility answer before the test drives. */
  await until(() => controller.getState().eligibility.status !== "unknown");
  const group = { walletId, groupIndex };
  const gkey = `${walletId}/${groupIndex}`;
  const state = (): HyperliquidGroupState | undefined =>
    controller.getState().groups[gkey]?.["hyperliquid"];
  const pmState = (): PolymarketGroupState | undefined =>
    controller.getState().groups[gkey]?.["polymarket"];
  const f24State = (): AppGroupState | undefined => controller.getState().groups[gkey]?.["fiat24"];
  const approve = async (id: string): Promise<void> => {
    try {
      await requests.approve(id, "evm-sign", { verify: VERIFY });
    } catch (error) {
      if (!(error instanceof AcknowledgementRequiredError)) {
        throw error;
      }
      await requests.approve(id, "evm-sign", {
        verify: VERIFY,
        acknowledged: error.required,
      });
    }
  };
  await until(() => !controller.getState().locked);
  return {
    wallet,
    walletId,
    /* `provider` is `undefined` for worlds built with `hyperliquid: false` — they never read
       it, and the getter makes that misuse loud rather than a silent undefined. */
    get provider(): HyperliquidProvider {
      if (provider === undefined) {
        throw new Error("the world was built with hyperliquid: false");
      }
      return provider;
    },
    pm: polymarket,
    /* `f24` is `undefined` for worlds built without `fiat24: true` — they never read it, and the
       getter makes that misuse loud rather than a silent undefined. */
    get f24(): Fiat24App {
      if (fiat24 === undefined) {
        throw new Error("the world was built without fiat24: true");
      }
      return fiat24;
    },
    poly,
    apps: controller,
    destroy,
    requests,
    signers,
    posted,
    timers,
    hl,
    store,
    session: () => session,
    credentials,
    group,
    warns,
    state,
    pmState,
    f24State,
    approve,
  };
};

/**
 * A credential store over `store` — the getter models the engine's session, so a test that returns
 * `undefined` while the vault is locked gets `unlock-required` from every method.
 */
const QUIET_LOGGER: EngineLogger = { warn: () => undefined };

export const credentialsStore = (
  store: () => EngineStore | undefined,
  logger: EngineLogger = QUIET_LOGGER,
): PolymarketCredentialStore =>
  createPolymarketCredentials({ storage: createAppStorage("polymarket", store), logger });

export const requestId = (w: World): string => w.state()?.requestId ?? "";
export const agentAddress = (w: World): string => w.state()?.agent?.address ?? "";
export const isApprovePost = (p: Posted): boolean =>
  p.endpoint === "exchange" &&
  isRecord(p.body["action"]) &&
  p.body["action"]["type"] === "approveAgent";
export const restoredStatus = (w: World): boolean =>
  w.state()?.status === "enabled" || w.state()?.status === "needs-reauthorization";

export const kernelAgents = async (w: World): Promise<ReadonlyArray<SessionInfo>> => {
  const list = await sessions(w.wallet).list();
  return list.filter(
    (a) =>
      a.scheme === "hyperliquid-l1-agent" &&
      a.walletId === w.walletId &&
      a.groupIndex === w.group.groupIndex,
  );
};

/** Approve the pending request the flow published, then pump the verify poll to a status. */
export const finishFlow = async (
  w: World,
  promise: Promise<unknown>,
  target: string,
): Promise<void> => {
  await until(() => w.state()?.requestId !== undefined);
  await w.approve(requestId(w));
  await pumpUntil(w.timers, () => w.state()?.status === target, 80);
  await swallow(promise);
  await until(() => w.state()?.status === target);
};

export { KERNEL_URL, MNEMONIC, PASSWORD, VERIFY, DAY };

/**
 * An EngineStore whose `close()` ends the session but keeps the backing — each `openStore()`
 * returns a fresh facade over the same records, like a real persistent store across lock/unlock.
 * `collections` may be shared with a read handle so a test can inspect what sessions wrote.
 */
export const restartableStore = (
  collections = new Map<string, Map<string, Uint8Array>>(),
): (() => Promise<EngineStore>) => {
  return async () => {
    await Promise.resolve();
    let closed = false;
    const store: EngineStore = {
      collection: (name) => {
        let table = collections.get(name);
        if (table === undefined) {
          table = new Map();
          collections.set(name, table);
        }
        return {
          get: async (key) => {
            await Promise.resolve();
            return closed ? undefined : table.get(key);
          },
          put: async (key, bytes) => {
            await Promise.resolve();
            if (!closed) {
              table.set(key, new Uint8Array(bytes));
            }
          },
          delete: async (key) => {
            await Promise.resolve();
            if (!closed) {
              table.delete(key);
            }
          },
          list: async () => {
            await Promise.resolve();
            return closed ? [] : [...table.keys()];
          },
        };
      },
      close: async () => {
        closed = true;
        await Promise.resolve();
      },
    };
    return store;
  };
};
