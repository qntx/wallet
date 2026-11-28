// oxlint-disable vitest/no-conditional-in-test -- a stateful live-server e2e is inherently conditional
// oxlint-disable vitest/no-conditional-expect -- live-server outcomes branch between acceptable typed forms
// oxlint-disable eslint/no-await-in-loop -- testnet polling and cleanup are inherently serial
// oxlint-disable unicorn/no-await-expression-member -- serial live-server reads stay inline in assertions
// oxlint-disable vitest/no-standalone-expect -- afterAll intentionally asserts the network guard
// oxlint-disable vitest/prefer-hooks-on-top -- the cleanup hook is documented next to the steps it protects
// oxlint-disable eslint/no-loop-func -- the decode/reject matrix closes over its loop discriminand safely
// oxlint-disable vitest/expect-expect -- several steps assert through shared server-state helpers
/**
 * Opt-in Hyperliquid testnet e2e. The funded test mnemonic also holds mainnet funds, so every
 * network byte goes through the testnet guard and the suite aborts before signing unless the
 * derived owner is the expected test account.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { WalletError } from "@qntx/wallet";
import type { Wallet } from "@qntx/wallet";
import type { HyperliquidAction } from "@qntx/wallet-chains";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";
import type { ChainsApi } from "@qntx/wallet/chains";
import type { HyperliquidAgentSpent } from "@qntx/wallet/protocol";
import { sessions } from "@qntx/wallet/sessions";
import type { HyperliquidAgentLimits } from "@qntx/wallet/sessions";

import { HyperliquidError } from "../src/apps/hyperliquid/errors.ts";
import { hyperliquid as hyperliquidApp } from "../src/apps/hyperliquid/index.ts";
import { roundPrice, roundSize } from "../src/apps/hyperliquid/numbers.ts";
import type { HyperliquidProviderInternals } from "../src/apps/hyperliquid/provider.ts";
import { createApps } from "../src/apps/index.ts";
import type { AppSocket } from "../src/apps/socket.ts";
import { parseDecimal } from "../src/decimal.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { AcknowledgementRequiredError, RequestController } from "../src/requests/controller.ts";
import type { PendingRequest } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { bookDeps, idleNetworkDeps, simulateSolanaStub, tokensStub } from "./send-helpers.ts";
import { createTestnetGuard } from "./support/hyperliquid-testnet.ts";

const RUN = process.env["HYPERLIQUID_E2E_MNEMONIC_FILE"] !== undefined;
const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const OWNER_EXPECTED = "0x2DF708F21B029B6A44EB1Cb72F78630cfCfe2816";
const VERIFY = { kind: "password" as const, password: "testnet e2e password" };
const NETWORK = "Testnet" as const;
const AGENT_NAME = "qntx-e2e";
const STEP_TIMEOUT = 150_000;

const realTimer = (ms: number, fn: () => void): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => {
    clearTimeout(id);
  };
};
const now = (): number => Date.now();
const random = (length: number): Uint8Array => new Uint8Array(randomBytes(length));
const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  label: string,
  ms = 30_000,
): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() <= deadline) {
    if (await condition()) {
      return;
    }
    await sleep(200);
  }
  throw new Error(`e2e condition never held: ${label}`);
};

const decimalText = (value: number, digits = 12): string => {
  const fixed = value.toFixed(digits);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
};

const SCALE = 10n ** 16n;
const unitsOf = (text: string): bigint => {
  const parsed = parseDecimal(text);
  if (parsed.scale > 16) {
    throw new Error(`decimal precision over 16: ${text}`);
  }
  return parsed.units * 10n ** BigInt(16 - parsed.scale);
};
const textOfUnits = (units: bigint): string => {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / SCALE;
  const fraction = String(magnitude % SCALE)
    .padStart(16, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction === "" ? "" : `.${fraction}`}`;
};
const addDecimal = (a: string, b: string): string => textOfUnits(unitsOf(a) + unitsOf(b));
const subDecimal = (a: string, b: string): string => textOfUnits(unitsOf(a) - unitsOf(b));
const mulDecimal = (a: string, b: string): string => textOfUnits((unitsOf(a) * unitsOf(b)) / SCALE);
const cmpDecimal = (a: string, b: string): number => {
  const left = unitsOf(a);
  const right = unitsOf(b);
  return left === right ? 0 : left < right ? -1 : 1;
};

type Spent = HyperliquidAgentSpent;
const spentOf = (value: unknown): Spent => {
  const spent = value as Spent;
  if (
    typeof spent !== "object" ||
    spent === null ||
    typeof spent.notional !== "string" ||
    !Array.isArray(spent.size)
  ) {
    throw new Error("session spent is not hyperliquid metering");
  }
  return spent;
};

const sameSpent = (a: Spent, b: Spent): boolean =>
  a.notional === b.notional &&
  a.size.length === b.size.length &&
  a.size.every((entry, index) => entry === b.size[index]);

const hyperliquidActionOf = (request: PendingRequest): HyperliquidAction => {
  const display = request.display as {
    message?: { kind?: string; hyperliquid?: HyperliquidAction };
  };
  const action = display.message?.kind === "typed-data" ? display.message.hyperliquid : undefined;
  if (action === undefined) {
    throw new Error(`request ${request.id} has no kernel-decoded hyperliquid action`);
  }
  return action;
};

const errorFact = async (
  promise: Promise<unknown>,
): Promise<{ readonly category: string; readonly message: string }> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HyperliquidError) {
      return { category: error.category, message: error.message };
    }
    if (error instanceof WalletError) {
      return { category: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error("expected a typed failure");
};

describe.runIf(RUN)("hyperliquid testnet e2e", () => {
  const guard = createTestnetGuard({
    fetch: globalThis.fetch.bind(globalThis),
    socket: (url) => new WebSocket(url) as AppSocket,
  });
  const logPath = process.env["HYPERLIQUID_E2E_LOG"];
  if (logPath !== undefined) {
    mkdirSync(dirname(logPath), { recursive: true });
  }
  let postLogIndex = 0;
  const writeLog = (entry: Record<string, unknown>): void => {
    if (logPath !== undefined) {
      appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
    }
  };
  const flushPostLog = (): void => {
    for (; postLogIndex < guard.exchangePosts.length; postLogIndex += 1) {
      const post = guard.exchangePosts[postLogIndex];
      writeLog({
        event: "exchange-post",
        type: post?.type,
        nonce: post?.nonce,
        action: post?.action,
        response: post?.response,
      });
    }
  };
  const mark = (step: string, data?: unknown): void => {
    flushPostLog();
    writeLog({ event: "step", step, data });
    console.log(`[hl-e2e] ${step}`);
  };

  let wallet!: Wallet;
  let walletId = "";
  let owner = "";
  const group = { walletId: "", groupIndex: 0 };
  let networks!: NetworkController;
  let transactions!: TransactionController;
  let requests!: RequestController;

  const buildApps = () =>
    createApps({
      networks,
      wallet,
      account: async (params: Parameters<ChainsApi["account"]>[0]) =>
        chains(wallet).account(params),
      requests,
      fetch: guard.fetch,
      now,
      setTimer: realTimer,
      random,
      logger: { warn: (...args: unknown[]) => console.warn("apps warn:", ...args) },
      openStore: async () => {
        await Promise.resolve();
        return createMemoryEngineStore();
      },
      socket: guard.socket,
      gateway: { url: "https://gateway.test" },
      apps: [hyperliquidApp({ network: NETWORK, agentName: AGENT_NAME })],
    });
  let apps!: ReturnType<typeof buildApps>;

  const requestEvents: PendingRequest[] = [];
  const requestSeen = new Set<string>();
  const requestWaiters = new Set<() => void>();
  const approving = new Map<string, Promise<void>>();
  let automaticApprovals = true;

  const approveRequest = async (request: PendingRequest): Promise<void> => {
    const existing = approving.get(request.id);
    if (existing !== undefined) {
      return existing;
    }
    const task = (async (): Promise<void> => {
      if (request.method !== "evm-sign") {
        throw new Error(`unexpected hyperliquid request method ${request.method}`);
      }
      try {
        await requests.approve(request.id, "evm-sign", { verify: VERIFY });
      } catch (error) {
        if (!(error instanceof AcknowledgementRequiredError)) {
          throw error;
        }
        await requests.approve(request.id, "evm-sign", {
          verify: VERIFY,
          acknowledged: error.required,
        });
      }
    })().finally(() => {
      approving.delete(request.id);
    });
    approving.set(request.id, task);
    return task;
  };

  const scanRequests = (): void => {
    for (const request of Object.values(requests.getState().requests)) {
      if (
        request.stage === "awaiting-approval" &&
        request.origin.kind === "app" &&
        request.origin.id === "hyperliquid" &&
        !requestSeen.has(request.id)
      ) {
        requestSeen.add(request.id);
        requestEvents.push(request);
        for (const wake of requestWaiters) {
          wake();
        }
        if (automaticApprovals) {
          void approveRequest(request).catch((error: unknown) => {
            writeLog({
              event: "approval-error",
              requestId: request.id,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
    }
  };

  const setAutomaticApprovals = (enabled: boolean): void => {
    automaticApprovals = enabled;
  };

  const nextRequest = async (index: number): Promise<PendingRequest> => {
    for (;;) {
      scanRequests();
      const request = requestEvents[index];
      if (request !== undefined) {
        return request;
      }
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          requestWaiters.delete(wake);
          resolve();
        };
        requestWaiters.add(wake);
        setTimeout(() => {
          requestWaiters.delete(wake);
          resolve();
        }, 250);
      });
    }
  };

  const manualPending = async <T extends { readonly requestId: string }>(
    start: () => Promise<T>,
  ): Promise<{ readonly pending: T; readonly request: PendingRequest }> => {
    setAutomaticApprovals(false);
    const cursor = requestEvents.length;
    try {
      const pending = await start();
      const request = await nextRequest(cursor);
      expect(request.id).toBe(pending.requestId);
      return { pending, request };
    } finally {
      setAutomaticApprovals(true);
    }
  };

  const hl = () => apps.hyperliquid;
  const internals = (): HyperliquidProviderInternals =>
    hl() as unknown as HyperliquidProviderInternals;
  const groupState = () => apps.controller.getState().groups[`${walletId}/0`]?.["hyperliquid"];

  type Asset = { readonly coin: string; readonly asset: number; readonly szDecimals: number };
  let btc!: Asset;
  let eth!: Asset;
  let spot!: Asset;
  let limits!: HyperliquidAgentLimits;
  let mainAgent = "";
  let mainSpent: Spent = { notional: "0", size: [] };
  let offListCoin = "SOL";
  let triggerModifyEvidence: unknown;
  let gtcModifyEvidence: unknown;
  let replayEvidence: unknown;
  let tamperEvidence: unknown;
  let minNotionalEvidence: unknown;
  let transferEvidence: unknown;

  const mainRecord = async () => {
    const record = (await sessions(wallet).list()).find(
      (entry) => entry.address.toLowerCase() === mainAgent.toLowerCase(),
    );
    if (record === undefined) {
      throw new Error("main agent missing from kernel sessions");
    }
    return record;
  };
  const refreshMainSpent = async (): Promise<Spent> => spentOf((await mainRecord()).spent);
  const saveMainSpent = async (): Promise<void> => {
    mainSpent = await refreshMainSpent();
  };

  const marketAsset = async (coin: string): Promise<Asset> => {
    const [meta] = await hl().markets.perps();
    const index = meta.universe.findIndex((entry) => entry.name === coin);
    const entry = meta.universe[index];
    if (entry === undefined) {
      throw new Error(`${coin} missing from testnet meta`);
    }
    return { coin, asset: index, szDecimals: entry.szDecimals };
  };

  const spotMarketAsset = async (coin: string): Promise<Asset> => {
    const [meta] = await hl().markets.spot();
    const pair = meta.universe.find((entry) => entry.name === coin);
    const base = pair === undefined ? undefined : meta.tokens[pair.tokens[0] ?? -1];
    if (pair === undefined || base === undefined) {
      throw new Error(`${coin} missing from testnet spot meta`);
    }
    return { coin, asset: 10_000 + pair.index, szDecimals: base.szDecimals };
  };

  const spotUsdc = async (): Promise<string> => {
    const spotState = await hl().account.spot({ user: owner });
    return spotState.balances.find((entry) => entry.coin === "USDC")?.total ?? "0";
  };

  const mid = async (coin: string): Promise<number> => {
    const value = (await hl().markets.mids())[coin];
    if (value === undefined) {
      throw new Error(`no testnet mid for ${coin}`);
    }
    return Number(value);
  };

  const sizeFor = (asset: Asset, price: string, dollars: number): string =>
    roundSize(decimalText(dollars / Number(price)), asset.szDecimals);

  const orderParams = async (
    asset: Asset,
    ratio: number,
    dollars = 12.5,
    tif: "Alo" | "Gtc" | "Ioc" = "Alo",
  ) => {
    const reference = decimalText((await mid(asset.coin)) * ratio);
    return {
      coin: asset.coin,
      side: "buy" as const,
      size: sizeFor(asset, reference, dollars),
      order: { kind: "limit" as const, price: reference, tif },
    };
  };

  const openOrders = async () => hl().account.openOrders({ user: owner });
  const openPositions = async () =>
    (await hl().account.state({ user: owner })).assetPositions.filter(
      (entry) => parseDecimal(entry.position.szi).units !== 0n,
    );

  const spotEmpty = async (): Promise<boolean> =>
    (await hl().account.spot({ user: owner })).balances.every(
      (entry) => parseDecimal(entry.total).units === 0n,
    );

  const returnSpotUsdc = async (): Promise<void> => {
    const amount = await spotUsdc();
    if (cmpDecimal(amount, "0") <= 0) {
      return;
    }
    const pending = await hl().transfer.toPerp(group, amount);
    const outcome = await pending.outcome;
    if (outcome.kind !== "ok") {
      throw new Error(`spot cleanup transfer did not commit: ${outcome.kind}`);
    }
  };

  const cancelAndFlatten = async (): Promise<void> => {
    await hl().trade.cancelAll(group);
    for (;;) {
      const positions = await openPositions();
      const [first] = positions;
      if (first === undefined) {
        break;
      }
      await hl().trade.close(group, { coin: first.position.coin, slippageBps: 100 });
    }
    await returnSpotUsdc();
  };

  const assertFlat = async (): Promise<void> => {
    await waitFor(
      async () =>
        (await openOrders()).length === 0 &&
        (await openPositions()).length === 0 &&
        (await spotEmpty()),
      "account flat",
    );
  };

  const expectNumericOpen = async (cloid: string, oid: number): Promise<void> => {
    let observed:
      | { readonly oid: number; readonly status: string; readonly cloid?: string }
      | undefined;
    await waitFor(async () => {
      const result = await hl().account.orderStatus({ user: owner, oid });
      if (
        result.status === "order" &&
        result.order.status === "open" &&
        result.order.order.oid === oid &&
        result.order.order.cloid?.toLowerCase() === cloid.toLowerCase()
      ) {
        observed = {
          oid: result.order.order.oid,
          status: result.order.status,
          cloid: result.order.order.cloid ?? undefined,
        };
        return true;
      }
      return false;
    }, `orderStatus(${oid}) open with cloid`);
    expect(observed).toMatchObject({ oid, status: "open" });
  };

  const expectOriginalCloidCanceled = async (
    cloid: string,
    originalOid: number,
  ): Promise<{ readonly oid: number; readonly status: string }> => {
    let observed: { readonly oid: number; readonly status: string } | undefined;
    await waitFor(async () => {
      const result = await hl().account.orderStatus({ user: owner, oid: cloid });
      if (
        result.status === "order" &&
        result.order.status === "canceled" &&
        result.order.order.oid === originalOid
      ) {
        observed = { oid: result.order.order.oid, status: result.order.status };
        return true;
      }
      return false;
    }, `orderStatus(${cloid}) keeps original ${originalOid} canceled`);
    if (observed === undefined) {
      throw new Error("original cloid lookup evidence missing");
    }
    return observed;
  };

  const expectOrderCanceled = async (oid: number | string): Promise<void> => {
    let observed: string | undefined;
    await waitFor(async () => {
      const result = await hl().account.orderStatus({ user: owner, oid });
      if (result.status === "order" && result.order.status === "canceled") {
        observed = result.order.status;
        return true;
      }
      return false;
    }, `orderStatus(${oid}) canceled`);
    expect(observed).toBe("canceled");
  };

  const waitReplacement = async (
    cloid: string,
    previousOid: number,
    label: string,
  ): Promise<Awaited<ReturnType<typeof openOrders>>[number]> => {
    let row: Awaited<ReturnType<typeof openOrders>>[number] | undefined;
    await waitFor(async () => {
      row = (await openOrders()).find(
        (entry) => entry.cloid?.toLowerCase() === cloid.toLowerCase() && entry.oid !== previousOid,
      );
      return row !== undefined;
    }, label);
    if (row === undefined) {
      throw new Error(`${label}: replacement row missing`);
    }
    expect(row.cloid?.toLowerCase()).toBe(cloid.toLowerCase());
    await expectNumericOpen(cloid, row.oid);
    return row;
  };

  beforeAll(async () => {
    if (NETWORK !== "Testnet") {
      throw new Error("the e2e app is not configured for testnet");
    }
    const mnemonicFile = process.env["HYPERLIQUID_E2E_MNEMONIC_FILE"];
    if (mnemonicFile === undefined) {
      throw new Error("HYPERLIQUID_E2E_MNEMONIC_FILE is required");
    }
    const mnemonic = readFileSync(mnemonicFile, "utf8").trim();
    wallet = await createNodeWallet({
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
    const { walletId: importedWalletId } = await wallet.wallets.importMnemonic({
      mnemonic,
      factor: VERIFY,
    });
    walletId = importedWalletId;
    group.walletId = walletId;
    await wallet.vault.unlock(VERIFY);
    const account = await chains(wallet).account({
      walletId,
      groupIndex: 0,
      template: "evm.bip44",
      network: "eip155:421614",
    });
    if (!("address" in account)) {
      throw new Error("the imported wallet has no EVM account");
    }
    owner = account.address.toLowerCase();
    if (owner !== OWNER_EXPECTED.toLowerCase()) {
      throw new Error("the e2e mnemonic does not derive the expected testnet account");
    }

    networks = new NetworkController({
      ...idleNetworkDeps,
      fetch: guard.fetch,
      rpc: {},
      openStore: async () => {
        await Promise.resolve();
        return createMemoryEngineStore();
      },
      logger: { warn: () => undefined },
    });
    transactions = new TransactionController({
      wallet,
      networks,
      openStore: async () => {
        await Promise.resolve();
        return createMemoryEngineStore();
      },
      random,
      setTimer: realTimer,
      now,
      logger: { warn: () => undefined },
      pollMs: 1,
      chains: chains(wallet),
    });
    requests = new RequestController({
      phishing: { check: () => "clear" },
      blindSigning: () => false,
      simulateSolana: simulateSolanaStub,
      tokens: tokensStub,
      transactions,
      ...bookDeps(),
      spark: Object.create(null) as SparkController,
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
      fetch: guard.fetch,
      random,
      now,
      setTimer: realTimer,
      logger: { warn: (...args: unknown[]) => console.warn("requests warn:", ...args) },
    });
    await networks.init();
    await transactions.init();
    await requests.init();
    requests.store.subscribe(scanRequests);
    apps = buildApps();
    await waitFor(
      () => apps.controller.getState().eligibility.status === "ready",
      "apps eligibility ready",
    );
    mark("setup", { owner: OWNER_EXPECTED });
  }, 120_000);

  it(
    "1 reads market data and live views reach live",
    async () => {
      const [meta] = await hl().markets.perps();
      expect(meta.universe.length).toBeGreaterThan(0);
      btc = await marketAsset("BTC");
      eth = await marketAsset("ETH");
      spot = await spotMarketAsset("PURR/USDC");
      const offList = meta.universe.find((entry) => entry.name !== "BTC" && entry.name !== "ETH");
      offListCoin = offList?.name ?? "SOL";
      const mids = await hl().markets.mids();
      expect(mids["BTC"]).toBeTypeOf("string");
      expect(mids["ETH"]).toBeTypeOf("string");
      expect(mids["PURR/USDC"]).toBeTypeOf("string");
      const book = await hl().markets.book({ coin: "BTC" });
      expect(book).not.toBeNull();
      expect(book?.levels[0]?.length).toBeGreaterThan(0);
      expect(book?.levels[1]?.length).toBeGreaterThan(0);

      const bookView = hl().live?.book("BTC");
      const tradesView = hl().live?.trades("BTC");
      expect(bookView).toBeDefined();
      expect(tradesView).toBeDefined();
      await waitFor(() => bookView?.getState().status === "live", "book live");
      await waitFor(() => tradesView?.getState().status === "live", "trades live");
      expect(bookView?.getState().data?.coin).toBe("BTC");
      await bookView?.close();
      await tradesView?.close();

      const assets = [btc, eth, spot].toSorted((a, b) => a.asset - b.asset);
      limits = {
        notional: "400",
        maxLeverage: 5,
        assets: await Promise.all(
          assets.map(async (asset) => ({
            asset: asset.asset,
            size: roundSize(decimalText(600 / (await mid(asset.coin))), asset.szDecimals),
          })),
        ),
      };
      mark("1-reads-live", { btc, eth, spot, offListCoin, limits });
    },
    STEP_TIMEOUT,
  );

  it(
    "2 enables with kernel-bound limits and proves the server lists the agent",
    async () => {
      await apps.controller.acknowledgeTerms(group, "hyperliquid");
      const cursor = requestEvents.length;
      setAutomaticApprovals(false);
      try {
        const enabling = apps.controller.enable(group, "hyperliquid", { limits, verify: VERIFY });
        const request = await nextRequest(cursor);
        const decoded = hyperliquidActionOf(request);
        const created = (await sessions(wallet).list()).find(
          (entry) => entry.scheme === "hyperliquid-l1-agent" && entry.name === AGENT_NAME,
        );
        expect(created).toBeDefined();
        expect(decoded).toMatchObject({
          kind: "approve-agent",
          chain: "Testnet",
          name: AGENT_NAME,
          validUntil: created?.validUntil,
        });
        expect(decoded.kind === "approve-agent" && decoded.agent.toLowerCase()).toBe(
          created?.address.toLowerCase(),
        );
        await approveRequest(request);
        await enabling;
      } finally {
        setAutomaticApprovals(true);
      }
      expect(groupState()?.status).toBe("enabled");
      const record = (await sessions(wallet).list()).find(
        (entry) => entry.scheme === "hyperliquid-l1-agent" && entry.name === AGENT_NAME,
      );
      expect(record).toBeDefined();
      mainAgent = record?.address ?? "";
      expect(record?.limits).toStrictEqual(limits);
      expect(record?.spent).toStrictEqual({
        notional: "0",
        size: limits.assets.map(() => "0"),
      });
      await saveMainSpent();
      const listed = await hl().account.extraAgents(owner);
      expect(listed.some((entry) => entry.address.toLowerCase() === mainAgent.toLowerCase())).toBe(
        true,
      );
      expect((await hl().account.role(owner)).role).toBe("user");
      mark("2-enabled", { agent: mainAgent, validUntil: record?.validUntil, spent: mainSpent });
    },
    STEP_TIMEOUT,
  );

  it(
    "3 pre-cleans interrupted state and leaves the account flat",
    async () => {
      await cancelAndFlatten();
      await assertFlat();
      mark("3-preclean-flat");
    },
    STEP_TIMEOUT,
  );

  it(
    "4 enforces the leverage cap before signing",
    async () => {
      const before = guard.exchangePosts.length;
      const ok = await hl().trade.setLeverage(group, {
        coin: "ETH",
        leverage: 3,
        marginMode: "cross",
      });
      expect(ok.kind).toBe("ok");
      expect(guard.exchangePosts).toHaveLength(before + 1);
      expect(guard.exchangePosts.at(-1)?.type).toBe("updateLeverage");

      const refusedPosts = guard.exchangePosts.length;
      const failure = await errorFact(
        hl().trade.setLeverage(group, { coin: "ETH", leverage: 6, marginMode: "cross" }),
      );
      expect(failure.category).toBe("limit-exceeded");
      expect(guard.exchangePosts).toHaveLength(refusedPosts);
      mark("4-leverage", { refusal: failure });
    },
    STEP_TIMEOUT,
  );

  let orderA: { oid: number; cloid: string; price: string; size: string } | undefined;

  it(
    "5 rests a post-only BTC order and charges exactly its signed notional",
    async () => {
      const before = await refreshMainSpent();
      const posts = guard.exchangePosts.length;
      const params = await orderParams(btc, 0.7);
      const result = await hl().trade.place(group, params);
      const [placed] = result.outcomes;
      expect(placed?.kind).toBe("resting");
      if (placed?.kind !== "resting" || placed.oid === undefined || placed.cloid === undefined) {
        throw new Error("the resting order did not return oid and cloid");
      }
      orderA = { oid: placed.oid, cloid: placed.cloid, price: result.price, size: params.size };
      const open = await openOrders();
      const row = open.find((entry) => entry.oid === placed.oid);
      expect(row?.coin).toBe("BTC");
      expect(row?.cloid?.toLowerCase()).toBe(placed.cloid.toLowerCase());
      const status = await hl().account.orderStatus({ user: owner, oid: placed.cloid });
      expect(status.status).toBe("order");
      if (status.status === "order") {
        expect(status.order.status).toBe("open");
      }
      const action = guard.exchangePosts.at(-1)?.action;
      expect(guard.exchangePosts).toHaveLength(posts + 1);
      expect(action).toMatchObject({ type: "order" });
      const after = await refreshMainSpent();
      const charge = mulDecimal(result.price, params.size);
      expect(after.notional).toBe(addDecimal(before.notional, charge));
      const btcIndex = limits.assets.findIndex((entry) => entry.asset === btc.asset);
      expect(after.size[btcIndex]).toBe(addDecimal(before.size[btcIndex] ?? "0", params.size));
      expect(after.size.filter((_, index) => index !== btcIndex)).toStrictEqual(
        before.size.filter((_, index) => index !== btcIndex),
      );
      mainSpent = after;
      mark("5-resting", { order: orderA, charge, spent: after, serverStatus: status });
    },
    STEP_TIMEOUT,
  );

  it(
    "6 modifies resting and trigger orders, batch-modifies, then cancels by oid and cloid",
    async () => {
      if (orderA === undefined) {
        throw new Error("step 5 left no resting order");
      }
      const cloidA = orderA.cloid;
      const originalOidA = orderA.oid;

      const numericModify = await hl().trade.modify(group, {
        oid: orderA.oid,
        ...(await orderParams(btc, 0.68, 13)),
      });
      expect(numericModify.kind).toBe("ok");
      let rowA = await waitReplacement(cloidA, orderA.oid, "numeric modify visible");
      const originalCloidLookup = await expectOriginalCloidCanceled(cloidA, originalOidA);
      orderA = { ...orderA, oid: rowA.oid };

      const cloidModify = await hl().trade.modify(group, {
        oid: orderA.cloid,
        ...(await orderParams(btc, 0.675, 13.5)),
      });
      expect(cloidModify.kind).toBe("ok");
      rowA = await waitReplacement(cloidA, orderA.oid, "cloid modify visible");
      orderA = { ...orderA, oid: rowA.oid };

      const second = await hl().trade.place(group, await orderParams(btc, 0.64, 12.5));
      const [secondPlaced] = second.outcomes;
      expect(secondPlaced?.kind).toBe("resting");
      if (
        secondPlaced?.kind !== "resting" ||
        secondPlaced.oid === undefined ||
        secondPlaced.cloid === undefined
      ) {
        throw new Error("the second resting order is missing oid or cloid");
      }
      const batchA = await orderParams(btc, 0.66, 13, "Gtc");
      const batchB = await orderParams(btc, 0.63, 12.5, "Alo");
      const batch = await hl().trade.batchModify(group, [
        { oid: orderA.oid, ...batchA },
        { oid: secondPlaced.oid, ...batchB },
      ]);
      expect(batch).toHaveLength(2);
      expect(batch.every((entry) => entry.kind === "resting")).toBe(true);
      expect(batch[0]?.cloid?.toLowerCase()).toBe(cloidA.toLowerCase());
      expect(batch[1]?.cloid?.toLowerCase()).toBe(secondPlaced.cloid.toLowerCase());
      const batchOidA = batch[0]?.kind === "resting" ? batch[0].oid : undefined;
      const batchOidB = batch[1]?.kind === "resting" ? batch[1].oid : undefined;
      expect(batchOidA).toBeTypeOf("number");
      expect(batchOidB).toBeTypeOf("number");
      if (typeof batchOidA !== "number" || typeof batchOidB !== "number") {
        throw new TypeError("the batch-modified orders have no replacement oids");
      }
      let open = await openOrders();
      await waitFor(async () => {
        open = await openOrders();
        return (
          open.some((entry) => entry.oid === batchOidA) &&
          open.some((entry) => entry.oid === batchOidB)
        );
      }, "batch-modified orders visible");
      const batchRowA = open.find((entry) => entry.oid === batchOidA);
      const rowB = open.find((entry) => entry.oid === batchOidB);
      expect(batchRowA?.cloid?.toLowerCase()).toBe(cloidA.toLowerCase());
      expect(rowB?.cloid?.toLowerCase()).toBe(secondPlaced.cloid.toLowerCase());
      await expectNumericOpen(cloidA, batchOidA);
      await expectNumericOpen(secondPlaced.cloid, batchOidB);
      const batchWire = guard.exchangePosts.at(-1)?.action as {
        modifies?: Array<{ order?: { p?: string; c?: string } }>;
      };
      const batchPriceA = batchWire.modifies?.[0]?.order?.p;
      const batchPriceB = batchWire.modifies?.[1]?.order?.p;
      expect(batchWire.modifies?.[0]?.order?.c).toBe(cloidA);
      expect(batchWire.modifies?.[1]?.order?.c).toBe(secondPlaced.cloid);
      expect(batchPriceA).toBeTypeOf("string");
      expect(batchPriceB).toBeTypeOf("string");
      if (batchPriceA !== undefined && batchPriceB !== undefined) {
        expect(cmpDecimal(batchRowA?.limitPx ?? "0", batchPriceA)).toBe(0);
        expect(cmpDecimal(rowB?.limitPx ?? "0", batchPriceB)).toBe(0);
      }
      orderA = { ...orderA, oid: batchOidA };
      gtcModifyEvidence = {
        requestedTif: batchA.order.tif,
        observedTif: batchRowA?.tif,
        outcomes: batch,
      };
      expect(["Alo", "Gtc"]).toContain(batchRowA?.tif);

      const third = await hl().trade.place(group, await orderParams(btc, 0.62, 12.5));
      const [thirdPlaced] = third.outcomes;
      expect(thirdPlaced?.kind).toBe("resting");
      if (
        thirdPlaced?.kind !== "resting" ||
        thirdPlaced.oid === undefined ||
        thirdPlaced.cloid === undefined
      ) {
        throw new Error("the cloid-cancel order is missing");
      }

      const markPrice = await mid("BTC");
      const triggerReference = decimalText(markPrice * 1.51);
      const trigger = await hl().trade.place(group, {
        coin: "BTC",
        side: "buy",
        size: sizeFor(btc, triggerReference, 12.5),
        order: {
          kind: "trigger",
          tpsl: "sl",
          market: false,
          triggerPx: decimalText(markPrice * 1.5),
          price: triggerReference,
        },
      });
      const [triggerPlaced] = trigger.outcomes;
      expect(triggerPlaced?.kind).toBe("resting");
      if (triggerPlaced?.kind !== "resting" || triggerPlaced.cloid === undefined) {
        throw new Error("the trigger placement returned no cloid");
      }
      const triggerCloid = triggerPlaced.cloid;
      await waitFor(async () => {
        const rows = await openOrders();
        return rows.some((entry) => entry.cloid?.toLowerCase() === triggerCloid.toLowerCase());
      }, "trigger order visible");
      open = await openOrders();
      const triggerRow = open.find(
        (entry) => entry.cloid?.toLowerCase() === triggerCloid.toLowerCase(),
      );
      expect(triggerRow?.isTrigger).toBe(true);
      if (triggerRow === undefined) {
        throw new Error("trigger row missing");
      }
      const triggerModify = await hl().trade.modify(group, {
        oid: triggerRow.oid,
        coin: "BTC",
        side: "buy",
        size: triggerRow.sz,
        order: {
          kind: "trigger",
          tpsl: "sl",
          market: false,
          triggerPx: decimalText(markPrice * 1.6),
          price: decimalText(markPrice * 1.61),
        },
      });
      expect(triggerModify.kind).toBe("ok");
      const modifiedTriggerRow = await waitReplacement(
        triggerCloid,
        triggerRow.oid,
        "modified trigger visible",
      );
      expect(modifiedTriggerRow.isTrigger).toBe(true);
      triggerModifyEvidence = { outcome: triggerModify, row: modifiedTriggerRow };

      const cancelTrigger = await hl().trade.cancel(group, [
        { coin: "BTC", oid: modifiedTriggerRow.oid },
      ]);
      expect(cancelTrigger[0]?.kind).toBe("cancelled");
      const cancelA = await hl().trade.cancelByCloid(group, [{ coin: "BTC", cloid: cloidA }]);
      expect(cancelA[0]?.kind).toBe("cancelled");
      const cancelB = await hl().trade.cancelByCloid(group, [
        { coin: "BTC", cloid: thirdPlaced.cloid },
      ]);
      expect(cancelB[0]?.kind).toBe("cancelled");
      const cancelSecond = await hl().trade.cancel(group, [{ coin: "BTC", oid: batchOidB }]);
      expect(cancelSecond[0]?.kind).toBe("cancelled");
      for (const oid of [cloidA, thirdPlaced.cloid, batchOidB] as Array<number | string>) {
        await expectOrderCanceled(oid);
      }
      await waitFor(async () => {
        open = await openOrders();
        return (
          !open.some((entry) => entry.oid === orderA?.oid) &&
          !open.some((entry) => entry.oid === batchOidB) &&
          !open.some((entry) => entry.oid === thirdPlaced.oid)
        );
      }, "modified orders canceled");

      const refusedPosts = guard.exchangePosts.length;
      const canceledModify = await errorFact(
        hl().trade.modify(group, {
          oid: originalOidA,
          ...(await orderParams(btc, 0.61, 12.5)),
        }),
      );
      expect(canceledModify.category).toBe("invalid-input");
      expect(canceledModify.message).toContain("is not open");
      expect(guard.exchangePosts).toHaveLength(refusedPosts);

      orderA = undefined;
      mark("6-modify-cancel", {
        gtc: gtcModifyEvidence,
        trigger: triggerModifyEvidence,
        originalCloidLookup,
        cancelA,
        cancelB,
        cancelSecond,
        canceledModify,
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "7 fills a tiny ETH IOC, observes position leverage and fills, then closes flat",
    async () => {
      const reference = decimalText(await mid("ETH"));
      const size = sizeFor(eth, reference, 12.5);
      const result = await hl().trade.place(group, {
        coin: "ETH",
        side: "buy",
        size,
        order: { kind: "market", slippageBps: 100 },
      });
      const [filled] = result.outcomes;
      expect(filled?.kind).toBe("filled");
      if (filled?.kind !== "filled") {
        throw new Error("the IOC did not fill");
      }
      expect(parseDecimal(filled.totalSz).units).toBeGreaterThan(0n);
      expect(filled.avgPx).toBeTypeOf("string");
      const state = await hl().account.state({ user: owner });
      const position = state.assetPositions.find((entry) => entry.position.coin === "ETH");
      expect(position?.position.leverage).toMatchObject({ type: "cross", value: 3 });
      const fills = await hl().account.fills({ user: owner });
      expect(fills.some((entry) => entry.oid === filled.oid)).toBe(true);

      const closed = await hl().trade.close(group, { coin: "ETH", slippageBps: 100 });
      expect(closed.outcomes[0]?.kind).toBe("filled");
      await waitFor(async () => (await openPositions()).length === 0, "ETH flat");
      mark("7-eth-fill-close", { filled, position: position?.position, closed: closed.outcomes });
    },
    STEP_TIMEOUT,
  );

  it(
    "8 maps typed server rejections and records the minimum-notional boundary",
    async () => {
      const book = await hl().markets.book({ coin: "BTC" });
      const bestAsk = book?.levels[1]?.[0]?.px;
      if (bestAsk === undefined) {
        throw new Error("BTC book has no ask");
      }
      const aggressive = decimalText(Number(bestAsk) * 1.01);
      const alo = await hl().trade.place(group, {
        coin: "BTC",
        side: "buy",
        size: sizeFor(btc, aggressive, 12.5),
        order: { kind: "limit", price: aggressive, tif: "Alo" },
      });
      expect(alo.outcomes[0]).toMatchObject({ kind: "rejected", reason: "post-only-would-match" });

      const lowReference = decimalText((await mid("BTC")) * 0.5);
      const ioc = await hl().trade.place(group, {
        coin: "BTC",
        side: "buy",
        size: sizeFor(btc, lowReference, 12.5),
        order: { kind: "limit", price: lowReference, tif: "Ioc" },
      });
      expect(ioc.outcomes[0]).toMatchObject({ kind: "rejected", reason: "ioc-no-match" });

      const tinyPrice = decimalText((await mid("BTC")) * 0.02);
      const tinySize = roundSize(
        decimalText(10 ** -btc.szDecimals, btc.szDecimals + 2),
        btc.szDecimals,
      );
      const posts = guard.exchangePosts.length;
      const failure = await errorFact(
        hl().trade.place(group, {
          coin: "BTC",
          side: "buy",
          size: tinySize,
          order: { kind: "limit", price: tinyPrice, tif: "Alo" },
        }),
      );
      minNotionalEvidence = { failure, price: tinyPrice, size: tinySize };
      expect(["invalid-input", "rejected"]).toContain(failure.category);
      if (failure.category === "invalid-input") {
        expect(guard.exchangePosts).toHaveLength(posts);
      }
      mark("8-typed-rejections", {
        postOnly: alo.outcomes[0],
        ioc: ioc.outcomes[0],
        minNotional: minNotionalEvidence,
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "9 refuses off-list and over-budget actions without an exchange post",
    async () => {
      const before = await refreshMainSpent();
      const posts = guard.exchangePosts.length;
      const offList = await marketAsset(offListCoin);
      const offFailure = await errorFact(hl().trade.place(group, await orderParams(offList, 0.7)));
      expect(offFailure.category).toBe("limit-exceeded");
      expect(guard.exchangePosts).toHaveLength(posts);

      const cancelFailure = await errorFact(
        hl().trade.cancel(group, [{ coin: offListCoin, oid: 1 }]),
      );
      expect(cancelFailure.category).toBe("limit-exceeded");
      expect(guard.exchangePosts).toHaveLength(posts);

      const btcIndex = limits.assets.findIndex((entry) => entry.asset === btc.asset);
      const remainingSize = subDecimal(
        limits.assets[btcIndex]?.size ?? "0",
        before.size[btcIndex] ?? "0",
      );
      const sellReference = decimalText((await mid("BTC")) * 1.5);
      const tooMuchSize = addDecimal(
        remainingSize,
        decimalText(10 ** -btc.szDecimals, btc.szDecimals + 2),
      );
      const sellFailure = await errorFact(
        hl().trade.place(group, {
          coin: "BTC",
          side: "sell",
          size: tooMuchSize,
          order: { kind: "limit", price: sellReference, tif: "Alo" },
        }),
      );
      expect(sellFailure.category).toBe("limit-exceeded");
      expect(guard.exchangePosts).toHaveLength(posts);

      const remainingNotional = subDecimal(limits.notional, before.notional);
      const buyReference = decimalText((await mid("BTC")) * 0.7);
      const overSize = roundSize(
        decimalText((Number(remainingNotional) * 2) / Number(buyReference)),
        btc.szDecimals,
      );
      const buyFailure = await errorFact(
        hl().trade.place(group, {
          coin: "BTC",
          side: "buy",
          size: overSize,
          order: { kind: "limit", price: buyReference, tif: "Alo" },
        }),
      );
      expect(buyFailure.category).toBe("limit-exceeded");
      expect(guard.exchangePosts).toHaveLength(posts);
      expect(sameSpent(await refreshMainSpent(), before)).toBe(true);
      mark("9-limit-refusals", {
        offFailure,
        cancelFailure,
        sellFailure,
        buyFailure,
        spent: before,
      });
    },
    STEP_TIMEOUT,
  );

  it("10 commits spent before a dropped post and reconciles the outcome unknown", async () => {
    const before = await refreshMainSpent();
    const posts = guard.exchangePosts.length;
    const params = await orderParams(btc, 0.69);
    guard.nextExchange(() => "drop");
    const result = await hl().trade.place(group, params);
    expect(result.outcomes[0]?.kind).toBe("unknown");
    expect(guard.exchangePosts).toHaveLength(posts);
    const charge = mulDecimal(result.price, params.size);
    const after = await refreshMainSpent();
    expect(after.notional).toBe(addDecimal(before.notional, charge));
    const btcIndex = limits.assets.findIndex((entry) => entry.asset === btc.asset);
    expect(after.size[btcIndex]).toBe(addDecimal(before.size[btcIndex] ?? "0", params.size));
    const cloid = result.outcomes[0]?.cloid;
    expect(cloid).toBeTypeOf("string");
    if (cloid !== undefined) {
      const status = await hl().account.orderStatus({ user: owner, oid: cloid });
      expect(status.status).toBe("unknownOid");
    }
    mainSpent = after;
    mark("10-drop-unknown", {
      cloid,
      charge,
      spent: after,
      outcome: result.outcomes[0],
    });
  }, 90_000);

  it(
    "11 keeps nonces distinct, then proves replay and signature tamper are plain rejections",
    async () => {
      const placements = await Promise.all(
        [0.66, 0.65, 0.64, 0.63].map(async (ratio) =>
          hl().trade.place(group, await orderParams(btc, ratio)),
        ),
      );
      expect(placements.every((entry) => entry.outcomes[0]?.kind === "resting")).toBe(true);
      const nonces = guard.exchangePosts.slice(-4).map((entry) => entry.nonce);
      expect(new Set(nonces).size).toBe(4);
      await hl().trade.cancelAll(group);
      await waitFor(async () => (await openOrders()).length === 0, "parallel orders canceled");

      let acceptedBody: Record<string, unknown> | undefined;
      guard.nextExchange((body) => {
        acceptedBody = body;
        return body;
      });
      const capture = await hl().trade.place(group, await orderParams(btc, 0.68));
      expect(capture.outcomes[0]?.kind).toBe("resting");
      if (acceptedBody === undefined) {
        throw new Error("the accepted body was not captured");
      }
      const replayBody = acceptedBody;
      guard.nextExchange(() => replayBody);
      const replayFailure = await errorFact(hl().trade.place(group, await orderParams(btc, 0.67)));
      replayEvidence = replayFailure;
      expect(replayFailure.category).toBe("rejected");
      expect(replayFailure.category).not.toBe("reauthorization-required");

      guard.nextExchange((body) => ({
        ...body,
        nonce: (typeof body["nonce"] === "number" ? body["nonce"] : 0) + 1,
      }));
      const tamperFailure = await errorFact(hl().trade.place(group, await orderParams(btc, 0.66)));
      tamperEvidence = tamperFailure;
      expect(tamperFailure.category).toBe("rejected");
      expect(tamperFailure.category).not.toBe("reauthorization-required");

      const working = await hl().trade.place(group, await orderParams(btc, 0.65));
      expect(working.outcomes[0]?.kind).toBe("resting");
      await hl().trade.cancelAll(group);
      mark("11-nonces-replay-tamper", {
        nonces,
        replay: replayEvidence,
        tamper: tamperEvidence,
        recovery: working.outcomes[0],
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "12 enforces reopen after a kernel restart while spent survives",
    async () => {
      const beforeLock = await refreshMainSpent();
      await wallet.vault.lock();
      await wallet.vault.unlock(VERIFY);
      await waitFor(() => groupState()?.status === "enabled", "reconciled enabled after unlock");
      const posts = guard.exchangePosts.length;
      const failure = await errorFact(hl().trade.place(group, await orderParams(btc, 0.67)));
      expect(failure.category).toBe("reopen-required");
      expect(guard.exchangePosts).toHaveLength(posts);
      expect(sameSpent(await refreshMainSpent(), beforeLock)).toBe(true);

      await hl().reopen(group, VERIFY);
      const result = await hl().trade.place(group, await orderParams(btc, 0.67));
      expect(result.outcomes[0]?.kind).toBe("resting");
      await hl().trade.cancelAll(group);
      mark("12-relock-reopen", { failure, spent: beforeLock, recovery: result.outcomes[0] });
    },
    STEP_TIMEOUT,
  );

  it(
    "13 reconciles and reopens through a fresh apps instance after restart",
    async () => {
      const maxNonce = Math.max(0, ...guard.exchangePosts.map((entry) => entry.nonce));
      await apps.destroy();
      await wallet.vault.lock();
      await wallet.vault.unlock(VERIFY);
      apps = buildApps();
      await waitFor(() => groupState()?.status === "enabled", "fresh apps reconcile enabled");
      await hl().reopen(group, VERIFY);
      const posts = guard.exchangePosts.length;
      const result = await hl().trade.place(group, await orderParams(btc, 0.66));
      expect(result.outcomes[0]?.kind).toBe("resting");
      const nonce = guard.exchangePosts.at(-1)?.nonce;
      expect(guard.exchangePosts).toHaveLength(posts + 1);
      expect(nonce).toBeGreaterThan(maxNonce);
      await hl().trade.cancelAll(group);
      mark("13-fresh-apps-restart", { maxNonce, nonce, outcome: result.outcomes[0] });
    },
    STEP_TIMEOUT,
  );

  it("14 signs through a short-lived second session until expiry, then deletes it", async () => {
    const validUntil = Date.now() + 75_000;
    const sizeCap = sizeFor(btc, decimalText(await mid("BTC")), 30);
    const sessionLimits: HyperliquidAgentLimits = {
      notional: "30",
      maxLeverage: 1,
      assets: [{ asset: btc.asset, size: sizeCap }],
    };
    const address = await sessions(wallet).create({
      scheme: "hyperliquid-l1-agent",
      owner: group,
      scope: "Testnet",
      name: "qntx-e2e-exp",
      validUntil,
      limits: sessionLimits,
      verify: VERIFY,
    });
    const records = await sessions(wallet).list();
    const record = records.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
    expect(record?.validUntil).toBe(validUntil);
    const approve = await manualPending(async () =>
      internals().userSigned.approveAgent(group, {
        agentAddress: address,
        agentName: `qntx-e2e-exp valid_until ${validUntil}`,
      }),
    );
    const decoded = hyperliquidActionOf(approve.request);
    expect(decoded).toMatchObject({
      kind: "approve-agent",
      chain: "Testnet",
      agent: address,
      name: "qntx-e2e-exp",
      validUntil,
    });
    await approveRequest(approve.request);
    expect((await approve.pending.outcome).kind).toBe("ok");

    const reference = roundPrice(
      decimalText((await mid("BTC")) * 0.68),
      btc.szDecimals,
      "perp",
      "down",
    );
    const size = sizeFor(btc, reference, 12.5);
    const cloid = `0x${randomBytes(16).toString("hex")}`;
    const action = {
      type: "order",
      orders: [
        {
          a: btc.asset,
          b: true,
          p: reference,
          s: size,
          r: false,
          t: { limit: { tif: "Alo" } },
          c: cloid,
        },
      ],
      grouping: "na",
    } as const;
    const nonce = Date.now();
    const expiresAfter = Date.now() + 15_000;
    const signatureBytes = await sessions(wallet).sign({
      scheme: "hyperliquid-l1-agent",
      address,
      params: { action, nonce, expiresAfter },
    });
    const hex = Array.from(signatureBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const response = await guard.fetch("https://api.hyperliquid-testnet.xyz/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        nonce,
        expiresAfter,
        signature: {
          r: `0x${hex.slice(0, 64)}`,
          s: `0x${hex.slice(64, 128)}`,
          v: signatureBytes[64] ?? 27,
        },
      }),
    });
    const body: unknown = await response.json();
    const restingOid = (() => {
      if (typeof body !== "object" || body === null || !("response" in body)) {
        return undefined;
      }
      const responseBody = (body as { response?: unknown }).response;
      if (typeof responseBody !== "object" || responseBody === null || !("data" in responseBody)) {
        return undefined;
      }
      const statuses = (responseBody as { data?: { statuses?: unknown } }).data?.statuses;
      const first = Array.isArray(statuses) ? statuses[0] : undefined;
      if (typeof first === "object" && first !== null && "resting" in first) {
        const { resting } = first as { resting?: unknown };
        if (typeof resting === "object" && resting !== null && "oid" in resting) {
          const { oid } = resting as { oid?: unknown };
          return typeof oid === "number" ? oid : undefined;
        }
      }
      return undefined;
    })();
    expect(restingOid).toBeTypeOf("number");
    if (restingOid !== undefined) {
      const cancel = await hl().trade.cancel(group, [{ coin: "BTC", oid: restingOid }]);
      expect(cancel[0]?.kind).toBe("cancelled");
    }

    await waitFor(() => Date.now() > validUntil, "short session expiry", 90_000);
    const expired = await errorFact(
      sessions(wallet).sign({
        scheme: "hyperliquid-l1-agent",
        address,
        params: { action, nonce: Date.now(), expiresAfter: Date.now() + 15_000 },
      }),
    );
    expect(expired.category).toBe("invalid-input");
    await sessions(wallet).delete(address);
    expect(
      (await sessions(wallet).list()).some(
        (entry) => entry.address.toLowerCase() === address.toLowerCase(),
      ),
    ).toBe(false);
    mark("14-session-expiry", {
      agent: address,
      validUntil,
      directOrder: body,
      expired,
    });
  }, 140_000);

  it(
    "15 decodes user-signed transfers and rejects withdrawal/send before anything posts",
    async () => {
      const spotAmount = async (): Promise<string> => {
        const spot = await hl().account.spot({ user: owner });
        return spot.balances.find((entry) => entry.coin === "USDC")?.total ?? "0";
      };
      const beforeSpot = await spotAmount();
      const toSpot = await manualPending(async () => hl().transfer.toSpot(group, "1"));
      const toSpotAction = hyperliquidActionOf(toSpot.request);
      expect(toSpotAction).toMatchObject({
        kind: "usd-class-transfer",
        chain: "Testnet",
        amount: "1",
        toPerp: false,
      });
      await approveRequest(toSpot.request);
      const toSpotOutcome = await toSpot.pending.outcome.catch((error: unknown) => error);
      const afterSpot = await spotAmount();

      const toPerp = await manualPending(async () => hl().transfer.toPerp(group, "1"));
      const toPerpAction = hyperliquidActionOf(toPerp.request);
      expect(toPerpAction).toMatchObject({
        kind: "usd-class-transfer",
        chain: "Testnet",
        amount: "1",
        toPerp: true,
      });
      await approveRequest(toPerp.request);
      const toPerpOutcome = await toPerp.pending.outcome.catch((error: unknown) => error);
      const finalSpot = await spotAmount();
      transferEvidence = {
        beforeSpot,
        afterSpot,
        finalSpot,
        toSpotOutcome:
          toSpotOutcome instanceof Error
            ? {
                category: (toSpotOutcome as HyperliquidError).category,
                message: toSpotOutcome.message,
              }
            : toSpotOutcome,
        toPerpOutcome:
          toPerpOutcome instanceof Error
            ? {
                category: (toPerpOutcome as HyperliquidError).category,
                message: toPerpOutcome.message,
              }
            : toPerpOutcome,
      };
      if (toSpotOutcome instanceof HyperliquidError) {
        expect(toSpotOutcome.category).toBe("rejected");
      } else {
        expect(toSpotOutcome).toMatchObject({ kind: "ok" });
        expect(cmpDecimal(afterSpot, addDecimal(beforeSpot, "1"))).toBe(0);
      }
      if (toPerpOutcome instanceof HyperliquidError) {
        expect(toPerpOutcome.category).toBe("rejected");
      } else {
        expect(toPerpOutcome).toMatchObject({ kind: "ok" });
        expect(cmpDecimal(finalSpot, beforeSpot)).toBe(0);
      }

      for (const kind of ["withdraw", "usdSend"] as const) {
        const posts = guard.exchangePosts.length;
        const pending = await manualPending(async () =>
          kind === "withdraw"
            ? hl().transfer.withdraw(group, { destination: owner, amount: "2" })
            : hl().transfer.usdSend(group, { destination: owner, amount: "2" }),
        );
        const decoded = hyperliquidActionOf(pending.request);
        expect(decoded).toMatchObject({
          kind: kind === "withdraw" ? "withdraw" : "usd-send",
          chain: "Testnet",
          destination: expect.any(String),
          amount: "2",
        });
        if (decoded.kind === "withdraw" || decoded.kind === "usd-send") {
          expect(decoded.destination.toLowerCase()).toBe(owner);
        }
        requests.reject(pending.request.id);
        const failure = await errorFact(pending.pending.outcome);
        expect(failure.category).toBe("approval-rejected");
        expect(guard.exchangePosts).toHaveLength(posts);
        writeLog({ event: "user-signed-reject", kind, failure });
      }
      mark("15-user-signed", transferEvidence);
    },
    STEP_TIMEOUT,
  );

  it(
    "16 places and cancels a spot order, then transfers the USDC back",
    async () => {
      const amount = "15";
      const startingSpot = await spotUsdc();
      expect(cmpDecimal(startingSpot, "0")).toBe(0);
      const toSpot = await manualPending(async () => hl().transfer.toSpot(group, amount));
      await approveRequest(toSpot.request);
      expect((await toSpot.pending.outcome).kind).toBe("ok");
      await waitFor(async () => cmpDecimal(await spotUsdc(), amount) === 0, "spot USDC credited");

      const params = await orderParams(spot, 0.5, 12.5);
      const beforeSpent = await refreshMainSpent();
      const placed = await hl().trade.place(group, params);
      const [resting] = placed.outcomes;
      expect(resting?.kind).toBe("resting");
      if (resting?.kind !== "resting" || resting.oid === undefined || resting.cloid === undefined) {
        throw new Error("the spot order did not rest with oid and cloid");
      }
      let row = (await openOrders()).find((entry) => entry.oid === resting.oid);
      await waitFor(async () => {
        row = (await openOrders()).find((entry) => entry.oid === resting.oid);
        return row !== undefined;
      }, "spot order visible");
      expect(row?.coin).toBe(spot.coin);
      expect(row?.cloid?.toLowerCase()).toBe(resting.cloid.toLowerCase());
      const charge = mulDecimal(placed.price, params.size);
      const afterSpent = await refreshMainSpent();
      expect(afterSpent.notional).toBe(addDecimal(beforeSpent.notional, charge));
      const spotIndex = limits.assets.findIndex((entry) => entry.asset === spot.asset);
      expect(afterSpent.size[spotIndex]).toBe(
        addDecimal(beforeSpent.size[spotIndex] ?? "0", params.size),
      );

      const canceled = await hl().trade.cancelByCloid(group, [
        { coin: spot.coin, cloid: resting.cloid },
      ]);
      expect(canceled[0]?.kind).toBe("cancelled");
      await expectOrderCanceled(resting.cloid);

      const toPerp = await manualPending(async () => hl().transfer.toPerp(group, amount));
      await approveRequest(toPerp.request);
      expect((await toPerp.pending.outcome).kind).toBe("ok");
      await waitFor(
        async () => cmpDecimal(await spotUsdc(), startingSpot) === 0,
        "spot USDC returned",
      );
      expect(cmpDecimal(await spotUsdc(), "0")).toBe(0);
      mark("16-spot-order", {
        amount,
        order: { oid: resting.oid, cloid: resting.cloid, price: placed.price, size: params.size },
        charge,
        canceled,
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "17 finishes flat, revokes the agent, and disables trading",
    async () => {
      await cancelAndFlatten();
      await assertFlat();
      const spentBeforeRevoke = await refreshMainSpent();
      await apps.controller.disable(group, "hyperliquid", { revoke: true, verify: VERIFY });
      expect(groupState()?.status).toBe("disabled");
      const kernelAgents = (await sessions(wallet).list()).filter((entry) =>
        entry.name.startsWith("qntx-e2e"),
      );
      expect(kernelAgents).toHaveLength(0);
      const listed = await hl().account.extraAgents(owner);
      expect(listed.some((entry) => entry.address.toLowerCase() === mainAgent.toLowerCase())).toBe(
        false,
      );
      const posts = guard.exchangePosts.length;
      const failure = await errorFact(hl().trade.place(group, await orderParams(btc, 0.7)));
      expect(failure.category).toBe("not-enabled");
      expect(guard.exchangePosts).toHaveLength(posts);
      mark("17-flat-revoked", { failure, spentBeforeRevoke });
    },
    STEP_TIMEOUT,
  );

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    try {
      if (apps !== undefined && wallet !== undefined && owner !== "") {
        if (wallet.getSnapshot().vault.status !== "unlocked") {
          await wallet.vault.unlock(VERIFY);
        }
        await waitFor(
          () => apps.controller.getState().eligibility.status === "ready",
          "cleanup apps ready",
          10_000,
        ).catch((error: unknown) => cleanupErrors.push(error));
        const dirty =
          (await openOrders().catch(() => [])).length > 0 ||
          (await openPositions().catch(() => [])).length > 0 ||
          !(await spotEmpty().catch(() => true));
        if (dirty) {
          try {
            await cancelAndFlatten();
          } catch (error) {
            if (error instanceof HyperliquidError && error.category === "not-enabled") {
              setAutomaticApprovals(true);
              await apps.controller.acknowledgeTerms(group, "hyperliquid");
              await apps.controller.enable(group, "hyperliquid", { limits, verify: VERIFY });
              await hl()
                .reopen(group, VERIFY)
                .catch(() => undefined);
              await cancelAndFlatten();
            } else {
              cleanupErrors.push(error);
            }
          }
        }
        if (groupState()?.status === "enabled") {
          await apps.controller
            .disable(group, "hyperliquid", { revoke: true, verify: VERIFY })
            .catch((error: unknown) => cleanupErrors.push(error));
        }
      }
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      setAutomaticApprovals(true);
      await apps?.destroy().catch((error: unknown) => cleanupErrors.push(error));
      flushPostLog();
      mark("afterall", {
        cleanupErrors: cleanupErrors.map((error) =>
          error instanceof Error ? error.message : String(error),
        ),
        violations: guard.violations,
      });
      expect(guard.violations).toStrictEqual([]);
    }
  }, 120_000);
});
