import { describe, expect, it } from "vite-plus/test";

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
import { chains } from "@qntx/wallet/chains";
import { hyperliquid } from "@qntx/wallet/hyperliquid";

import { HyperliquidError } from "../src/apps/hyperliquid/errors.ts";
import { createApps } from "../src/apps/index.ts";
import type { AppsController } from "../src/apps/index.ts";
import type { AppGroupState } from "../src/apps/types.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { AcknowledgementRequiredError, RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password" as const, password: PASSWORD };
const RANDOM = (length: number): Uint8Array => new Uint8Array(length).fill(7);
const DAY = 86_400_000;

const manualTimer = (start = Date.now()) => {
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

type Posted = { readonly endpoint: "info" | "exchange"; readonly body: Record<string, unknown> };

/** The live Hyperliquid state the injected fetch serves — tests mutate it between polls. */
type HlState = {
  /** Agents Hyperliquid lists for the owner (what `extraAgents` answers). */
  listed: Map<string, { address: string; name: string; validUntil: number }>;
  maxBuilderFee: number;
  role: string;
  exchange?: (body: Record<string, unknown>) => unknown;
  exchangeError?: () => unknown;
};

const listAgent = (
  timers: ReturnType<typeof manualTimer>,
  action: Record<string, unknown>,
): { address: string; name: string; validUntil: number } => ({
  address: String(action["agentAddress"]),
  name: String(action["agentName"]).split(" ")[0] ?? "",
  validUntil: timers.time + 179 * DAY,
});

const hlFetch =
  (posted: Posted[], timers: ReturnType<typeof manualTimer>, hl: HlState) =>
  async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const headers = { date: new Date(timers.time).toUTCString() };
    if (url.endsWith("/exchange")) {
      const action = body["action"] as Record<string, unknown>;
      posted.push({ endpoint: "exchange", body });
      if (hl.exchangeError !== undefined) {
        throw new Error("connection reset");
      }
      const answer =
        hl.exchange === undefined
          ? { status: "ok", response: { type: "default" } }
          : await hl.exchange(body);
      if (action["type"] === "approveAgent") {
        hl.listed.set(String(action["agentAddress"]), listAgent(timers, action));
      }
      return Response.json(answer, { headers });
    }
    posted.push({ endpoint: "info", body });
    const { type } = body;
    const response =
      type === "extraAgents"
        ? [...hl.listed.values()]
        : type === "maxBuilderFee"
          ? hl.maxBuilderFee
          : type === "userRole"
            ? { role: hl.role }
            : type === "allMids"
              ? { BTC: "57957.5" }
              : type === "orderStatus"
                ? { status: "unknownOid" }
                : {};
    return Response.json(response, { headers });
  };

const arbRpc = async (init?: RequestInit): Promise<Response> => {
  const body = JSON.parse(String(init?.body)) as { method: string };
  const result =
    body.method === "eth_chainId"
      ? "0x66eee"
      : body.method === "eth_blockNumber"
        ? "0x1"
        : body.method === "eth_call"
          ? `0x${"00".repeat(32)}`
          : body.method === "eth_getTransactionCount"
            ? "0x0"
            : body.method === "eth_estimateGas"
              ? "0x5208"
              : body.method === "eth_feeHistory"
                ? { baseFeePerGas: ["0x1"], gasUsedRatio: [0.1], oldestBlock: "0x1" }
                : "0x0";
  return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result }));
};

const tick = async (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve);
  });

const until = async (cond: () => boolean, tries = 300): Promise<void> => {
  for (let i = 0; i < tries && !cond(); i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- real-kernel turns need the event loop.
    await tick();
  }
  expect(cond()).toBe(true);
};

/** Pump manual timers until `cond` — for flows whose timers drive a verify window. */
const pumpUntil = async (
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
const swallow = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch {
    // The caller asserts the rejection separately.
  }
};

let shared: { wallet: Wallet; walletId: string } | undefined;

const nodeWallet = async (): Promise<{ wallet: Wallet; walletId: string }> => {
  if (shared === undefined) {
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
    shared = { wallet, walletId };
  }
  return shared;
};

type World = {
  wallet: Wallet;
  provider: Awaited<ReturnType<typeof createApps>>["hyperliquid"];
  walletId: string;
  apps: AppsController;
  destroy: () => Promise<void>;
  requests: RequestController;
  posted: Posted[];
  timers: ReturnType<typeof manualTimer>;
  hl: HlState;
  store: EngineStore;
  group: { walletId: string; groupIndex: number };
  state: () => AppGroupState | undefined;
  approve: (id: string) => Promise<void>;
};

const world = async (
  groupIndex = 0,
  options: { agentName?: string; store?: EngineStore; hl?: Partial<HlState> } = {},
): Promise<World> => {
  const { wallet, walletId } = await nodeWallet();
  // A previous test may have locked the shared wallet — restore the unlocked precondition.
  await wallet.vault.unlock(VERIFY).catch(async () => Promise.resolve());
  const posted: Posted[] = [];
  const timers = manualTimer();
  const warns: string[] = [];
  const logger = { warn: (...args: unknown[]) => warns.push(String(args[0])) };
  const hl: HlState = { listed: new Map(), maxBuilderFee: 0, role: "user", ...options.hl };
  const fetch = hlFetch(posted, timers, hl);
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url === "https://arb-sepolia.test/rpc" ? arbRpc(init) : fetch(input, init);
    },
    rpc: { "eip155:421614": ["https://arb-sepolia.test/rpc"] },
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    logger,
  });
  const transactions = new TransactionController({
    wallet,
    networks,
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    random: RANDOM,
    setTimer: timers.setTimer,
    now: () => timers.time,
    logger,
    pollMs: 1,
    chains: chains(wallet),
  });
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    ...bookDeps(),
    spark: {
      createInvoice: async () => Promise.reject(new Error("unused")),
      quoteExit: async () => Promise.reject(new Error("unused")),
    } as unknown as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    fetch,
    random: RANDOM,
    now: () => timers.time,
    setTimer: timers.setTimer,
    logger,
  });
  const store = options.store ?? createMemoryEngineStore();
  const {
    controller,
    hyperliquid: provider,
    destroy,
  } = createApps({
    wallet,
    requests,
    fetch,
    /* Advances 1 ms per read — two clock reads never agree, which is exactly what the
       revoke binding's single-read `validUntil` protects against. */
    now: () => {
      timers.time += 1;
      return timers.time;
    },
    setTimer: timers.setTimer,
    random: RANDOM,
    logger,
    openStore: async () => Promise.resolve(store),
    hyperliquid: { network: "Testnet", agentName: options.agentName ?? "qntx-test" },
  });
  await networks.init();
  await transactions.init();
  await requests.init();
  const group = { walletId, groupIndex };
  const gkey = `${walletId}/${groupIndex}`;
  const state = (): AppGroupState | undefined =>
    controller.getState().groups[gkey]?.["hyperliquid"];
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
    provider,
    apps: controller,
    destroy,
    requests,
    posted,
    timers,
    hl,
    store,
    group,
    state,
    approve,
  };
};

const requestId = (w: World): string => w.state()?.requestId ?? "";
const agentAddress = (w: World): string => w.state()?.agent?.address ?? "";
const isApprovePost = (p: Posted): boolean =>
  p.endpoint === "exchange" && (p.body["action"] as { type?: string }).type === "approveAgent";
const restoredStatus = (w: World): boolean =>
  w.state()?.status === "enabled" || w.state()?.status === "needs-reauthorization";

const kernelAgents = async (w: World) => {
  const agents = await hyperliquid(w.wallet).listAgents();
  return agents.filter((a) => a.walletId === w.walletId && a.groupIndex === w.group.groupIndex);
};

/** Approve the pending request the flow published, then pump the verify poll to a status. */
const finishFlow = async (w: World, promise: Promise<unknown>, target: string): Promise<void> => {
  await until(() => w.state()?.requestId !== undefined);
  await w.approve(requestId(w));
  await pumpUntil(w.timers, () => w.state()?.status === target, 80);
  await swallow(promise);
  await until(() => w.state()?.status === target);
};

describe("apps hyperliquid enablement on the node host", () => {
  it("enables through the approval request and leaves no orphan", async () => {
    const w = await world(10);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    await finishFlow(w, done, "enabled");
    expect(w.state()?.status).toBe("enabled");
    expect(agentAddress(w)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // The kernel-held agent is listed and marked — trading would now sign.
    await expect(kernelAgents(w)).resolves.toHaveLength(1);
    // The approveAgent POST carried the kernel-bound agentName.
    const post = w.posted.find(isApprovePost);
    expect(post).toBeDefined();
    const action = post?.body["action"] as { agentName?: string } | undefined;
    expect(String(action?.agentName)).toContain("valid_until");
    await w.destroy();
  });

  it("request rejected: cleans the orphan agent and disables", async () => {
    const w = await world(11);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    void swallow(done);
    await until(() => w.state()?.requestId !== undefined);
    w.requests.reject(requestId(w));
    await until(() => w.state()?.status === "disabled");
    await expect(done).rejects.toBeInstanceOf(HyperliquidError);
    expect(w.state()?.agent).toBeUndefined();
    expect(w.state()?.error?.category).toBe("approval-rejected");
    // The definitive failure deleted the kernel agent Hyperliquid never approved.
    await expect(kernelAgents(w)).resolves.toHaveLength(0);
    await w.destroy();
  });

  it("POST status:err: cleans the orphan agent and disables", async () => {
    const w = await world(12, { hl: { exchange: () => ({ status: "err", response: "nope" }) } });
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    void swallow(done);
    await until(() => w.state()?.requestId !== undefined);
    await w.approve(requestId(w));
    await until(() => w.state()?.status === "disabled");
    await expect(done).rejects.toBeInstanceOf(HyperliquidError);
    await expect(kernelAgents(w)).resolves.toHaveLength(0);
    expect(w.state()?.error?.category).toBe("rejected");
    await w.destroy();
  });

  it(
    "lost POST + never listed: retries verify then cleans the orphan",
    { timeout: 30000 },
    async () => {
      const w = await world(13, { hl: { exchangeError: () => undefined } });
      await w.apps.acknowledgeTerms(w.group, "hyperliquid");
      const done = w.apps.enable(w.group, "hyperliquid");
      let settled = false;
      void (async () => {
        await swallow(done);
        settled = true;
      })();
      await until(() => w.state()?.requestId !== undefined);
      await w.approve(requestId(w));
      // The POST threw; the flow goes to verify — extraAgents stays empty for 30 s of polls.
      await pumpUntil(w.timers, () => settled, 300);
      await expect(done).rejects.toBeInstanceOf(HyperliquidError);
      await until(() => w.state()?.status === "disabled");
      await expect(kernelAgents(w)).resolves.toHaveLength(0);
      await w.destroy();
    },
  );

  it("cancel cannot delete the enabled agent; cancel mid-flow cleans the unenabled one", async () => {
    const w = await world(14);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    // Enable fully first.
    await finishFlow(w, w.apps.enable(w.group, "hyperliquid"), "enabled");
    const enabled = agentAddress(w);
    expect(enabled).not.toBe("");
    // Cancel against an enabled agent is invalid-input and deletes nothing.
    await expect(w.apps.cancel(w.group, "hyperliquid")).rejects.toMatchObject({
      category: "invalid-input",
    });
    await expect(kernelAgents(w)).resolves.toHaveLength(1);
    expect(w.state()?.status).toBe("enabled");
    // Cancel mid-enable (waiting on the request) aborts and cleans.
    const w2 = await world(15);
    await w2.apps.acknowledgeTerms(w2.group, "hyperliquid");
    const done = w2.apps.enable(w2.group, "hyperliquid");
    void swallow(done);
    await until(() => w2.state()?.requestId !== undefined);
    await w2.apps.cancel(w2.group, "hyperliquid");
    await expect(done).rejects.toBeInstanceOf(HyperliquidError);
    await until(() => w2.state()?.status === "disabled");
    await expect(kernelAgents(w2)).resolves.toHaveLength(0);
    await w.destroy();
    await w2.destroy();
  });

  it("a second flow while one runs is busy; acknowledging terms does not stale it", async () => {
    const w = await world(16);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    await until(() => w.state()?.requestId !== undefined);
    // Concurrent flows for the same group are busy.
    await expect(w.apps.enable(w.group, "hyperliquid")).rejects.toMatchObject({
      category: "busy",
    });
    await expect(w.apps.disable(w.group, "hyperliquid", { revoke: false })).rejects.toMatchObject({
      category: "busy",
    });
    // Acknowledging terms mid-flow must not supersede the running generation.
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    await finishFlow(w, done, "enabled");
    expect(w.state()?.status).toBe("enabled");
    await w.destroy();
  });

  it("disable without revoke deletes the kernel agent; revoke signs and cleans the throwaway", async () => {
    const w = await world(17);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    await finishFlow(w, w.apps.enable(w.group, "hyperliquid"), "enabled");
    /* Revoke: the throwaway ApproveAgent request must sign under the kernel binding — a second
       clock read for `valid_until` would make the kernel reject it. */
    const done = w.apps.disable(w.group, "hyperliquid", { revoke: true });
    await until(() => w.state()?.requestId !== undefined);
    await w.approve(requestId(w));
    await until(() => w.state()?.status === "disabled");
    await done;
    await expect(kernelAgents(w)).resolves.toHaveLength(0);
    expect(w.posted.filter(isApprovePost)).toHaveLength(2); // enable + revoke
    await w.destroy();
  });

  it("renew failure cleans the new agent and restores the old enabled state", async () => {
    const w = await world(18);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    await finishFlow(w, w.apps.enable(w.group, "hyperliquid"), "enabled");
    const oldAddress = agentAddress(w);
    w.hl.exchange = () => ({ status: "err", response: "renew denied" });
    const done = w.apps.renew(w.group, "hyperliquid");
    void swallow(done);
    await until(() => w.state()?.requestId !== undefined);
    await w.approve(requestId(w));
    await until(() => restoredStatus(w));
    await expect(done).rejects.toBeInstanceOf(HyperliquidError);
    expect(w.state()?.status).toBe("enabled");
    expect(agentAddress(w)).toBe(oldAddress);
    // Only the old agent survives — the failed renewal deleted its candidate.
    const agents = await kernelAgents(w);
    expect(agents.map((a) => a.address.toLowerCase())).toStrictEqual([oldAddress.toLowerCase()]);
    await w.destroy();
  });

  it("locked host methods throw unlock-required and lock closes the store", async () => {
    const w = await world(19);
    let closed = 0;
    const tracked = w.store as { close: () => Promise<void> };
    tracked.close = async () => {
      closed += 1;
      await Promise.resolve();
    };
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    await w.wallet.vault.lock();
    await until(() => w.apps.getState().locked, 2000);
    await expect(w.apps.acknowledgeTerms(w.group, "hyperliquid")).rejects.toMatchObject({
      category: "unlock-required",
    });
    await expect(w.apps.enable(w.group, "hyperliquid")).rejects.toMatchObject({
      category: "unlock-required",
    });
    expect(closed).toBe(1);
    await w.wallet.vault.unlock(VERIFY);
    await w.destroy();
  });

  it("persisted record keeps only termsAcknowledged and the last enabled agent", async () => {
    const w = await world(20);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    await finishFlow(w, w.apps.enable(w.group, "hyperliquid"), "enabled");
    const enabled = agentAddress(w);
    await tick();
    const key = `${w.walletId}/20/hyperliquid`;
    const raw = await w.store.collection("apps").get(key);
    expect(raw).toBeDefined();
    const record = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    expect(Object.keys(record).toSorted()).toStrictEqual(["enabledAgent", "termsAcknowledged"]);
    expect(record["termsAcknowledged"]).toBe(true);
    expect(record["enabledAgent"]).toBe(enabled);
    await w.destroy();
  });

  it("reconcile on unlock covers a kernel agent without a persisted record", async () => {
    // Enable on a first world, then a second world (fresh store) reconciles group 24's kernel
    // agent even though the store knows nothing about it.
    const w1 = await world(24);
    await w1.apps.acknowledgeTerms(w1.group, "hyperliquid");
    await finishFlow(w1, w1.apps.enable(w1.group, "hyperliquid"), "enabled");
    const agent = agentAddress(w1);
    await w1.destroy();
    const hl2: HlState = { listed: new Map(), maxBuilderFee: 0, role: "user" };
    hl2.listed.set(agent, {
      address: agent,
      name: "qntx-test",
      validUntil: Date.now() + 179 * DAY,
    });
    const w2 = await world(24, { store: createMemoryEngineStore(), hl: hl2 });
    // The kernel agent existed for group 24 — the union reconcile sees it (enabled on HL).
    await until(() => w2.state()?.status === "enabled", 2000);
    expect(w2.state()?.status).toBe("enabled");
    await w2.destroy();
  });

  it("user-signed POST: malformed answer and transport failure are unknown, never rejected", async () => {
    const w = await world(25, { hl: { exchange: () => ({ unexpected: true }) } });
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const pending = await w.provider.transfer.toPerp(w.group, "1");
    await w.approve(pending.requestId);
    await expect(pending.outcome).resolves.toStrictEqual({ kind: "unknown" });
    // A signed action was posted — a malformed answer may have committed.
    expect(w.posted.some((p) => p.endpoint === "exchange")).toBe(true);
    // Transport failure is unknown too.
    delete (w.hl as { exchange?: unknown }).exchange;
    w.hl.exchangeError = () => undefined;
    const pending2 = await w.provider.transfer.toPerp(w.group, "1");
    await w.approve(pending2.requestId);
    await expect(pending2.outcome).resolves.toStrictEqual({ kind: "unknown" });
    await w.destroy();
  });

  it("transfer typed-data is signed by the owner and the kernel describes it", async () => {
    const w = await world(26);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const pending = await w.provider.transfer.toSpot(w.group, "2.5");
    const request = w.requests.getState().requests[pending.requestId];
    expect(request).toBeDefined();
    // The kernel decoded the user-signed typed data — the display is not blind.
    const message = (request as { display?: { message?: { hyperliquid?: unknown } } }).display
      ?.message?.hyperliquid;
    expect(message).toBeDefined();
    await w.approve(pending.requestId);
    await expect(pending.outcome).resolves.toStrictEqual({ kind: "ok" });
    const post = w.posted.find((p) => p.endpoint === "exchange");
    const body = post?.body as
      | { action?: Record<string, unknown>; signature?: { r: string } }
      | undefined;
    expect(body?.action?.["type"]).toBe("usdClassTransfer");
    // The posted action carries the signed fields plus type and signatureChainId.
    expect(body?.action?.["signatureChainId"]).toBe("0x66eee");
    expect(body?.action?.["amount"]).toBe("2.5");
    expect(body?.signature?.r).toMatch(/^0x[0-9a-f]{64}$/);
    await w.destroy();
  });

  it("deposit rejects below 5 USDC and prepares a send to Bridge2", async () => {
    const w = await world(27);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    await expect(
      w.provider.fund.deposit(w.group, { amount: 4_999_999n, fee: "normal" }),
    ).rejects.toMatchObject({ category: "invalid-input" });
    const pending = await w.provider.fund.deposit(w.group, {
      amount: 5_000_000n,
      fee: "normal",
    });
    const request = w.requests.getState().requests[pending.requestId];
    expect(request).toBeDefined();
    const { display } = request as {
      display?: { outflows?: Array<{ to?: string; token?: string }> };
    };
    expect(display?.outflows?.[0]?.to?.toLowerCase()).toBe(
      "0x08cfc1b6b2dcf36a1480b99353a354aa8ac56f89",
    );
    await w.destroy();
  });
});
