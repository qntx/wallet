/**
 * The Polymarket app definition: `polymarket(config)` validates the builder code synchronously and
 * returns the `AppDefinition` `createApps` builds over the shared `AppContext` — the credential
 * store scoped to `context.storage`, the provider and the enable state machine wired exactly as the
 * monolithic composition built them.
 */
import type { AppContext, AppDefinition } from "../spi.ts";
import { createPolymarketCredentials } from "./credentials.ts";
import { createPolymarketEnable } from "./enable.ts";
import { createPolymarketProvider } from "./provider.ts";
import type { PolymarketBuilder, PolymarketProvider } from "./provider.ts";
import type { PolymarketDetail } from "./state.ts";

export type AppsPolymarketConfig = {
  /**
   * The host's Remote Builder Signing oracle — its server holds the builder secret and HMACs
   * relayer submissions (design.md 不变量 9). `code` is the bytes32 builder code written into orders;
   * absent means the zero code.
   */
  readonly builder?: PolymarketBuilder;
};

export function polymarket(
  config: AppsPolymarketConfig = {},
): AppDefinition<"polymarket", PolymarketProvider, PolymarketDetail> {
  const { builder } = config;
  if (builder?.code !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(builder.code)) {
    throw new Error("polymarket builder.code must be a 32-byte hex string");
  }

  return {
    id: "polymarket",
    /* `close-only` enables too — users need credentials to sell; the trade path gates opening
       positions itself. */
    enableWhen: ["available", "close-only"],
    create: (context: AppContext<PolymarketDetail>) => {
      const credentials = createPolymarketCredentials({
        storage: context.storage,
        logger: context.logger,
      });
      const provider = createPolymarketProvider({
        fetch: context.fetch,
        setTimer: context.setTimer,
        now: context.now,
        wallet: context.wallet,
        account: context.account,
        credentials,
        requests: context.requests,
        random: context.random,
        networks: context.networks,
        socket: context.socket,
        logger: context.logger,
        /* `undefined` (unknown or failed eligibility) fails BUY orders closed. */
        availability: context.availability,
        ...(builder === undefined ? {} : { builder }),
      });
      return {
        api: provider,
        provider: createPolymarketEnable({
          credentials,
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
