/**
 * Host composition for `@qntx/wallet-engine/apps`: the complete Polymarket flow — engine and apps
 * creation with a Remote Builder Signing oracle, terms acknowledgement, enable (locate → deploy →
 * credentials → approvals → verify), a quoted limit order, a cancel, a live book and a revoke
 * disable. Compiled only; the engine README's Polymarket section describes the same surface.
 */
import type { VerifyFactor, Wallet } from "@qntx/wallet";
import type { EngineOptions, EngineStore, PublicStore, WalletEngine } from "@qntx/wallet-engine";
import { createWalletEngine } from "@qntx/wallet-engine";
import type { AppGroup, AppsController, AppSocket } from "@qntx/wallet-engine/apps";
import { createApps } from "@qntx/wallet-engine/apps";
import type { PolymarketBuilder, PolymarketProvider } from "@qntx/wallet-engine/apps/polymarket";
import { polymarket } from "@qntx/wallet-engine/apps/polymarket";

const random = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
const setTimer = (ms: number, fn: () => void): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/**
 * The host's Remote Builder Signing oracle: the builder secret lives on the host's server, which
 * HMACs `{method, path, body}` and answers the four `POLY_BUILDER_*` headers. The endpoint must
 * authenticate its caller and should restrict `path` to `/submit` — the app never sees the secret.
 */
const remoteBuilder = (endpoint: string, code?: `0x${string}`): PolymarketBuilder => ({
  ...(code === undefined ? {} : { code }),
  sign: async (request) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const raw: unknown = await response.json();
    if (typeof raw !== "object" || raw === null) {
      throw new Error("the builder endpoint answered a non-object body");
    }
    const field = (name: string): string => {
      const value: unknown = Reflect.get(raw, name);
      return typeof value === "string" ? value : "";
    };
    return {
      POLY_BUILDER_API_KEY: field("POLY_BUILDER_API_KEY"),
      POLY_BUILDER_PASSPHRASE: field("POLY_BUILDER_PASSPHRASE"),
      POLY_BUILDER_SIGNATURE: field("POLY_BUILDER_SIGNATURE"),
      POLY_BUILDER_TIMESTAMP: field("POLY_BUILDER_TIMESTAMP"),
    };
  },
});

export function createHost(params: {
  readonly wallet: Wallet;
  readonly verifyEvent: EngineOptions["verifyEvent"];
  readonly gatewayUrl: string;
  readonly builderEndpoint: string;
  readonly builderCode?: `0x${string}`;
  readonly openStore: () => Promise<EngineStore>;
  readonly publicStore: PublicStore;
}): {
  engine: WalletEngine;
  apps: {
    readonly controller: AppsController;
    readonly polymarket: PolymarketProvider;
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
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    setTimer,
    random,
    // oxlint-disable-next-line eslint/no-console -- the example logs to the console.
    logger: { warn: (message, error) => console.warn(message, error) },
    openStore: params.openStore,
    // One socket serves every live view — the platform WebSocket works everywhere.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every platform's WebSocket is an AppSocket; the DOM types just won't say so.
    socket: (url) => new WebSocket(url) as AppSocket,
    gateway: { url: gatewayUrl },
    apps: [polymarket({ builder: remoteBuilder(params.builderEndpoint, params.builderCode) })],
  });
  return { engine, apps };
}

/**
 * Enable a group: record the terms acknowledgement, start the flow and approve every request it
 * publishes (the deposit deploy, the ClobAuth credential signature and the approvals `Batch` are
 * all kernel-described). A crash or lock mid-flow resumes at the same step — the host calls
 * `enable` again only when the group reads `disabled`/`needs-reauthorization`.
 */
export async function enableGroup(
  engine: WalletEngine,
  apps: ReturnType<typeof createHost>["apps"],
  group: AppGroup,
  verify: VerifyFactor,
): Promise<void> {
  await apps.controller.acknowledgeTerms(group, "polymarket");
  const state = apps.controller.store;
  const unsubscribe = state.subscribe((s) => {
    const id = s.groups[`${group.walletId}/${group.groupIndex}`]?.polymarket?.requestId;
    if (id !== undefined) {
      // oxlint-disable-next-line promise/prefer-await-to-then -- a subscribe callback cannot await.
      void engine.requests.approve(id, "evm-sign", { verify }).catch(() => undefined);
    }
  });
  try {
    await apps.controller.enable(group, "polymarket");
  } finally {
    unsubscribe();
  }
}

/**
 * Quote, place and cancel a limit BUY, then read a live book. `place` returns the `orderId` before
 * approval; an `unknown` outcome means the POST may have committed — reconcile by the order hash,
 * never re-post.
 */
export async function tradeAndWatch(
  apps: ReturnType<typeof createHost>["apps"],
  group: AppGroup,
  assetId: string,
): Promise<void> {
  const pm = apps.polymarket;
  if (pm === undefined) {
    throw new Error("polymarket is not configured");
  }
  /* Quote against the current book — the answer is the tick-aligned price/size the order signs. */
  const quote = await pm.trade.quote(group, {
    kind: "limit",
    assetId,
    side: "BUY",
    price: "0.10",
    size: "5",
    orderType: "GTC",
    postOnly: true,
  });
  const placed = await pm.trade.place(group, {
    kind: "limit",
    assetId,
    side: "BUY",
    price: quote.price ?? "0.10",
    size: quote.size ?? "5",
    orderType: "GTC",
    postOnly: true,
  });
  const outcome = await placed.outcome;
  if (outcome.kind === "unknown") {
    /* The POST may have committed — reconcile by the order hash, never re-post. */
  } else if (outcome.kind !== "rejected" && outcome.kind !== "canceled") {
    await pm.trade.cancel(group, placed.orderId);
  }
  const live = pm.live.book(assetId);
  const unsubscribe = live.subscribe((state) => {
    if (state.status === "live") {
      unsubscribe();
      void live.close();
    }
  });
  /* The account view streams the user channel: `source` is "stream" while the authenticated
     socket feeds it and "poll" while the REST fallback covers a disconnect. */
  const account = pm.live.account(group);
  const drop = account.subscribe((state) => {
    if (state.status === "live" && state.data?.source === "stream") {
      drop();
      void account.close();
    }
  });
}

/**
 * Disable the group: `revoke` asks the CLOB to delete the API key first, then the engine drops the
 * stored credential record. A local delete alone is not a revoke — the same wallet re-derives the
 * same credentials, so always pass `revoke: true` to cut off the key server-side too.
 */
export async function disableGroup(
  apps: ReturnType<typeof createHost>["apps"],
  group: AppGroup,
): Promise<void> {
  await apps.controller.disable(group, "polymarket", { revoke: true });
}
