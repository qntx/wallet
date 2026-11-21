/**
 * The Hyperliquid app definition: `hyperliquid(config)` validates the config synchronously and
 * returns the `AppDefinition` `createApps` builds over the shared `AppContext` — the socket,
 * provider and enable state machine wired exactly as the monolithic composition built them, with
 * the lifecycle hooks (`unlock` = agents refresh, `lock` = agents reset, `close` = shared socket
 * close) that keep the controller's lock semantics byte-for-byte.
 */
import type { HyperliquidNetwork } from "@qntx/wallet/protocol";

import type { AppContext, AppDefinition } from "../types.ts";
import { createHyperliquidEnable } from "./enable.ts";
import { createHyperliquidProvider } from "./provider.ts";
import type { HyperliquidProvider } from "./provider.ts";
import { createHyperliquidSocket } from "./socket.ts";

export type AppsBuilderConfig = {
  /** The builder address the trades attach once `maxBuilderFee` confirms `feeRateTenthsBps`. */
  readonly address: string;
  /** Tenths of a basis point: 1..100 (the perps cap is 0.1 %). */
  readonly feeRateTenthsBps: number;
};

export type AppsHyperliquidConfig = {
  readonly network: HyperliquidNetwork;
  /** The agent name — `^[A-Za-z0-9._-]{1,16}$`, the exchange's limit. */
  readonly agentName: string;
  readonly builder?: AppsBuilderConfig;
};

export function hyperliquid(
  config: AppsHyperliquidConfig,
): AppDefinition<"hyperliquid", HyperliquidProvider> {
  const { network, agentName, builder } = config;
  if (!/^[A-Za-z0-9._-]{1,16}$/.test(agentName)) {
    throw new Error("hyperliquid agentName must match ^[A-Za-z0-9._-]{1,16}$");
  }
  if (builder !== undefined) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(builder.address)) {
      throw new Error("hyperliquid builder.address must be a 20-byte hex address");
    }
    if (
      !Number.isInteger(builder.feeRateTenthsBps) ||
      builder.feeRateTenthsBps < 1 ||
      builder.feeRateTenthsBps > 100
    ) {
      throw new Error("hyperliquid builder.feeRateTenthsBps must be an integer in 1..100");
    }
  }

  return {
    id: "hyperliquid",
    create: (context: AppContext) => {
      const socket = createHyperliquidSocket({
        network,
        socket: context.socket,
        setTimer: context.setTimer,
        random: context.random,
      });
      const provider = createHyperliquidProvider({
        wallet: context.wallet,
        network,
        fetch: context.fetch,
        setTimer: context.setTimer,
        now: context.now,
        random: context.random,
        logger: context.logger,
        requests: context.requests,
        socket,
        builderFor: (group) => {
          /* Trades carry the builder only while the controller confirmed the fee this session —
             a lock or a stale approval makes it return undefined and the field is omitted. */
          if (builder === undefined) {
            return undefined;
          }
          const state =
            context.state()?.groups[`${group.walletId}/${group.groupIndex}`]?.hyperliquid;
          return state?.builder === "approved" ? builder : undefined;
        },
      });
      return {
        api: provider,
        provider: createHyperliquidEnable({
          wallet: context.wallet,
          provider,
          userSigned: provider.userSigned,
          requests: context.requests,
          network,
          agentName,
          ...(builder === undefined ? {} : { builder }),
          now: context.now,
          setTimer: context.setTimer,
          logger: context.logger,
        }),
        unlock: provider.agents.refresh,
        lock: provider.agents.reset,
        close: () => socket.close(),
      };
    },
  };
}
