/**
 * Host composition for `@qntx/wallet-engine/apps`: the complete Hyperliquid flow — engine and apps
 * creation, terms acknowledgement, enable with the approval request, orders with a quote preview, a
 * live book, a close, a withdraw and a CCTP deposit. Compiled only; the engine README's Hyperliquid
 * section describes the same surface.
 */
import type { VerifyFactor, Wallet } from "@qntx/wallet";
import type { EngineOptions, EngineStore, PublicStore, WalletEngine } from "@qntx/wallet-engine";
import { createWalletEngine } from "@qntx/wallet-engine";
import type { AppsController, AppSocket } from "@qntx/wallet-engine/apps";
import { createApps } from "@qntx/wallet-engine/apps";
import type { HyperliquidGroup, HyperliquidProvider } from "@qntx/wallet-engine/apps/hyperliquid";
import { hyperliquid } from "@qntx/wallet-engine/apps/hyperliquid";
import { chains } from "@qntx/wallet/chains";

const random = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
const setTimer = (ms: number, fn: () => void): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export function createHost(params: {
  readonly wallet: Wallet;
  readonly verifyEvent: EngineOptions["verifyEvent"];
  readonly gatewayUrl: string;
  readonly openStore: () => Promise<EngineStore>;
  readonly publicStore: PublicStore;
}): {
  engine: WalletEngine;
  apps: {
    readonly controller: AppsController;
    readonly hyperliquid: HyperliquidProvider;
    readonly destroy: () => Promise<void>;
  };
} {
  const { wallet, verifyEvent, gatewayUrl } = params;
  const engine = createWalletEngine({
    wallet,
    verifyEvent,
    sparkNetwork: "mainnet",
    fetch: globalThis.fetch.bind(globalThis),
    random,
    now: () => Date.now(),
    weblnAlias: "Example",
    lightningMaxFee: (amountSats) => Math.max(10, Math.floor(amountSats / 100)),
    // oxlint-disable-next-line eslint/no-console -- the example logs to the console.
    logger: { warn: (message, error) => console.warn(message, error) },
    openStore: params.openStore,
    showCallsStatus: () => undefined,
    publicStore: params.publicStore,
    gateway: { url: gatewayUrl },
  });
  const apps = createApps({
    wallet,
    requests: engine.requests,
    networks: engine.networks,
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    setTimer,
    random,
    // oxlint-disable-next-line eslint/no-console -- the example logs to the console.
    logger: { warn: (message, error) => console.warn(message, error) },
    // A separate EngineStore from the engine's own — same port, own namespace.
    openStore: params.openStore,
    // One socket serves every live view — the platform WebSocket works everywhere.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every platform's WebSocket is an AppSocket; the DOM types just won't say so.
    socket: (url) => new WebSocket(url) as AppSocket,
    gateway: { url: gatewayUrl },
    apps: [
      hyperliquid({
        network: "Mainnet",
        agentName: "example-app",
        // Optional builder fee: 10 tenths of a basis point = 1 bp, attached only after the user
        // approves it on Hyperliquid and this session confirms the cap still covers it.
        builder: { address: "0x0000000000000000000000000000000000000001", feeRateTenthsBps: 10 },
      }),
    ],
  });
  return { engine, apps };
}

/**
 * Enable a group: record the terms acknowledgement, start the flow and approve the request it
 * publishes. A lock or a reload mid-flow resumes at the same step on the next unlock — the host
 * calls `enable` again only when the group reads `disabled`/`needs-reauthorization`.
 */
export async function enableGroup(
  engine: WalletEngine,
  apps: ReturnType<typeof createHost>["apps"],
  group: HyperliquidGroup,
  verify: VerifyFactor,
): Promise<void> {
  await apps.controller.acknowledgeTerms(group, "hyperliquid");
  const state = apps.controller.store;
  // React to the request the flow publishes — in a UI this is a subscription, not a poll.
  const unsubscribe = state.subscribe((s) => {
    const id = s.groups[`${group.walletId}/${group.groupIndex}`]?.hyperliquid?.requestId;
    if (id !== undefined) {
      // oxlint-disable-next-line promise/prefer-await-to-then -- a subscribe callback cannot await.
      void engine.requests.approve(id, "evm-sign", { verify }).catch(() => undefined);
    }
  });
  try {
    await apps.controller.enable(group, "hyperliquid");
  } finally {
    unsubscribe();
  }
}

/** The group's owner address — the EVM account on the signature chain the user views read. */
const ownerOf = async (wallet: Wallet, group: HyperliquidGroup): Promise<string> => {
  const account = await chains(wallet).account({
    walletId: group.walletId,
    groupIndex: group.groupIndex,
    template: "evm.bip44",
    network: "eip155:42161",
  });
  if (!("address" in account)) {
    throw new Error("the group has no EVM address");
  }
  return account.address;
};

/** A limit and a market order: preview first — the market preview's price is the slippage cap. */
export async function placeOrders(
  apps: ReturnType<typeof createHost>["apps"],
  group: HyperliquidGroup,
): Promise<void> {
  const hl = apps.hyperliquid;
  const [meta, mids] = await Promise.all([hl.markets.perps(), hl.markets.mids()]);
  const asset = meta[0]?.universe.find((u) => u.name === "BTC");
  if (asset === undefined) {
    throw new Error("BTC is not in the perp universe");
  }
  const preview = hl.quote.limit({
    price: "50000",
    size: "0.001",
    side: "buy",
    szDecimals: asset.szDecimals,
    market: "perp",
  });
  if (!preview.meetsMinimum) {
    throw new Error("below the exchange minimum");
  }
  const placed = await hl.trade.place(group, {
    coin: "BTC",
    side: "buy",
    size: preview.size,
    order: { kind: "limit", price: preview.price, tif: "Gtc" },
  });
  // Stable cloids reconcile a lost POST: `unknown` may have committed — never re-send it.
  const [first] = placed.outcomes;
  if (first !== undefined && first.kind === "rejected") {
    throw new Error(first.message ?? "the order was rejected");
  }
  const mark = mids["BTC"];
  if (mark === undefined) {
    return;
  }
  const market = hl.quote.market({
    reference: mark,
    size: "0.001",
    side: "sell",
    slippageBps: 50,
    szDecimals: asset.szDecimals,
    market: "perp",
  });
  // The cap the exchange fills against is `market.price` — show it before posting.
  // oxlint-disable-next-line eslint/no-console -- the example logs to the console.
  console.log("market sell cap", market.price);
  await hl.trade.place(group, {
    coin: "BTC",
    side: "sell",
    size: market.size,
    order: { kind: "market", slippageBps: 50 },
  });
}

/** A live book: data renders as `live` only after the first post-confirmation snapshot. */
export function readBook(apps: ReturnType<typeof createHost>["apps"]): () => void {
  const view = apps.hyperliquid.live?.book("BTC");
  if (view === undefined) {
    return () => undefined;
  }
  const unsubscribe = view.subscribe((state) => {
    // `stale` keeps the last data — display it marked, never as live.
    if (state.status === "live" && state.data !== undefined) {
      // oxlint-disable-next-line eslint/no-console -- the example logs to the console.
      console.log("top bid", state.data.levels[0]?.[0]?.px);
    }
  });
  return () => {
    unsubscribe();
    void view.close();
  };
}

/** Close the whole BTC position at a 50 bp cap, then withdraw and deposit. */
export async function fundAndWithdraw(
  engine: WalletEngine,
  apps: ReturnType<typeof createHost>["apps"],
  wallet: Wallet,
  group: HyperliquidGroup,
  verify: VerifyFactor,
): Promise<void> {
  const hl = apps.hyperliquid;
  const owner = await ownerOf(wallet, group);
  const state = await hl.account.state({ user: owner });
  const position = state.assetPositions.find((p) => p.position.coin === "BTC");
  if (position !== undefined && position.position.szi !== "0") {
    // Reduce-only IOC at the slippage cap — the same approval-free path as other trades.
    await hl.trade.close(group, { coin: "BTC", slippageBps: 50 });
  }
  // User-signed actions return a pending action: render `requestId`, await `outcome`.
  const withdrawal = await hl.transfer.withdraw(group, {
    destination: "0x0000000000000000000000000000000000000002",
    amount: "10",
  });
  await engine.requests.approve(withdrawal.requestId, "evm-sign", { verify });
  const outcome = await withdrawal.outcome;
  if (outcome.kind === "unknown") {
    // The action may have committed — refresh the account instead of retrying.
    await hl.account.state({ user: owner });
  }
  /* The CCTP deposit burns USDC on Arbitrum's TokenMessengerV2 — Circle's forwarder mints it
     on HyperEVM into the Hyperliquid account. It must clear the Circle fee the provider reads
     from Iris and the on-chain per-message burn limit. When the messenger's USDC allowance is
     short the call returns `approval-required` with only the exact-amount approve request — the
     burn call cannot be prepared while the approval is unmined, so the host approves it and calls
     `deposit` again; the re-read allowance then covers the amount and the `deposit` variant
     carries the burn request. */
  const first = await hl.fund.deposit(group, {
    amount: 20_000_000n, // 20 USDC
    fee: "normal",
    dex: hl.fund.depositInfo.dex, // "perps" by default — "spot" funds the spot account.
  });
  if (first.kind === "approval-required") {
    await engine.requests.approve(first.approval.requestId, "evm-sign", { verify });
    await first.approval.outcome;
  }
  const result = await hl.fund.deposit(group, {
    amount: 20_000_000n,
    fee: "normal",
    dex: hl.fund.depositInfo.dex,
  });
  if (result.kind === "deposit") {
    await engine.requests.approve(result.deposit.requestId, "evm-sign", { verify });
    await result.deposit.outcome;
  }
}

export { HYPERLIQUID_DEPOSIT } from "@qntx/wallet-engine/apps/hyperliquid";

/**
 * The builder fee is optional now: `AppGroupState.builder` is `"approved" | "declined"` — a refusal
 * during enable finishes `enabled` and trades without the builder. The host offers `approveBuilder`
 * for a later consent; a second refusal stays declined and resolves normally.
 */
export async function offerBuilder(
  apps: Awaited<ReturnType<typeof createApps>>,
  group: HyperliquidGroup,
): Promise<"approved" | "declined" | "unconfigured"> {
  const state =
    apps.controller.getState().groups[`${group.walletId}/${group.groupIndex}`]?.hyperliquid;
  if (state?.builder === "approved") {
    return "approved";
  }
  if (state?.status !== "enabled") {
    throw new Error("the group is not enabled");
  }
  try {
    await apps.controller.approveBuilder(group, "hyperliquid");
  } catch (error) {
    if (error instanceof Error && error.name === "HyperliquidError") {
      return "unconfigured";
    }
    throw error;
  }
  return (
    apps.controller.getState().groups[`${group.walletId}/${group.groupIndex}`]?.hyperliquid
      ?.builder ?? "declined"
  );
}
