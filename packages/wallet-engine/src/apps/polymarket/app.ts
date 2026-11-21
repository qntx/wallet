/**
 * The Polymarket app definition: `polymarket(config)` validates the builder code synchronously
 * and returns the `AppDefinition` `createApps` builds over the shared `AppContext` — the
 * provider and enable state machine wired exactly as the monolithic composition built them.
 */
import type { AppContext, AppDefinition } from "../types.ts";
import { createPolymarketEnable } from "./enable.ts";
import { createPolymarketProvider } from "./provider.ts";
import type { PolymarketBuilder, PolymarketProvider } from "./provider.ts";

export type AppsPolymarketConfig = {
  /**
   * The host's Remote Builder Signing oracle — its server holds the builder secret and HMACs
   * relayer submissions (design.md 不变量 9). `code` is the bytes32 builder code written into
   * orders; absent means the zero code.
   */
  readonly builder?: PolymarketBuilder;
};

export function polymarket(
  config: AppsPolymarketConfig = {},
): AppDefinition<"polymarket", PolymarketProvider> {
  const { builder } = config;
  if (builder?.code !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(builder.code)) {
    throw new Error("polymarket builder.code must be a 32-byte hex string");
  }

  return {
    id: "polymarket",
    create: (context: AppContext) => {
      const provider = createPolymarketProvider({
        fetch: context.fetch,
        setTimer: context.setTimer,
        now: context.now,
        wallet: context.wallet,
        requests: context.requests,
        random: context.random,
        socket: context.socket,
        logger: context.logger,
        /* The last ready eligibility answer's per-app availability — `undefined` (unknown or
           stale) fails BUY orders closed. */
        availability: () => {
          const state = context.state()?.eligibility;
          return state?.status === "ready" ? state.apps?.["polymarket"] : undefined;
        },
        ...(builder === undefined ? {} : { builder }),
      });
      return {
        api: provider,
        provider: createPolymarketEnable({
          wallet: context.wallet,
          account: provider.account,
          requests: context.requests,
          fetch: context.fetch,
          setTimer: context.setTimer,
          now: context.now,
          ...(builder === undefined ? {} : { builder }),
          logger: context.logger,
        }),
      };
    },
  };
}
