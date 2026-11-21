/**
 * The L2 client — every authenticated CLOB request signs its headers inside the kernel
 * (`polymarket(wallet).signL2`, design.md §l2): `timestamp` floors the injected clock to seconds,
 * the kernel allow-list binds (method, path) — query strings ride unsigned on the URL — and the
 * body string sent is exactly the body string signed. Kernel `WalletError`s map the way the
 * Hyperliquid exchange maps them: `locked` → `unlock-required`, `not-found` → `not-enabled`,
 * `invalid-input` → `invalid-input`.
 *
 * Clock gate: the kernel refuses a timestamp more than ±30 s off its wall clock, so a device clock
 * that far from the CLOB's `/time` can only produce refused signatures — before the first L2
 * request of a session and every ten minutes the client checks and fails `clock-skew` early.
 */
import type * as z from "zod/mini";

import { WalletError } from "@qntx/wallet";
import type { Wallet } from "@qntx/wallet";
import { polymarket } from "@qntx/wallet/polymarket";
import type { PolymarketCredentialsInfo, PolymarketL2Method } from "@qntx/wallet/polymarket";

import type { AppGroup } from "../types.ts";
import { CLOB_HOST } from "./constants.ts";
import { PolymarketError } from "./errors.ts";
import type { PolymarketHttp } from "./http.ts";

/** The kernel sign window — a skew beyond it guarantees a refused signature. */
export const MAX_SKEW_MS = 30_000;
const SKEW_REFRESH_MS = 600_000;

export type PolymarketL2Request = {
  readonly method: PolymarketL2Method;
  /** The allow-listed path — never carries a query string. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  /** The exact body string — the same bytes the kernel HMACs. */
  readonly body?: string;
};

export type PolymarketL2 = {
  readonly request: <S extends z.ZodMiniType>(
    group: AppGroup,
    request: PolymarketL2Request,
    schema: S,
  ) => Promise<z.output<S>>;
  /** The group's credential header fields — `undefined` when the vault holds none. */
  readonly credentials: (group: AppGroup) => Promise<PolymarketCredentialsInfo | undefined>;
};

/** The signing path's only failure mapping — never wraps request payloads into errors. */
const mapKernel = (error: unknown): never => {
  if (error instanceof WalletError) {
    if (error.code === "locked") {
      throw new PolymarketError("unlock-required", "the vault is locked", { cause: error });
    }
    if (error.code === "not-found") {
      throw new PolymarketError("not-enabled", "the group has no Polymarket credentials", {
        cause: error,
      });
    }
    if (error.code === "invalid-input") {
      throw new PolymarketError("invalid-input", "the kernel rejected the request", {
        cause: error,
      });
    }
  }
  throw new PolymarketError("unavailable", "the wallet failed to sign", { cause: error });
};

export function createPolymarketL2(options: {
  readonly wallet: Wallet;
  readonly http: PolymarketHttp;
  readonly now: () => number;
}): PolymarketL2 {
  const api = (): ReturnType<typeof polymarket> => polymarket(options.wallet);
  /** Last `now()` a skew check passed — one `/time` per session plus a refresh every 10 min. */
  let checkedAt: number | undefined;

  /** The group's credential header fields — `undefined` when the vault holds none. */
  const credentials = async (group: AppGroup): Promise<PolymarketCredentialsInfo | undefined> => {
    const listed = await api().listCredentials().catch(mapKernel);
    return listed.find(
      (creds) => creds.walletId === group.walletId && creds.groupIndex === group.groupIndex,
    );
  };

  const assertClock = async (): Promise<void> => {
    if (checkedAt !== undefined && options.now() - checkedAt <= SKEW_REFRESH_MS) {
      return;
    }
    const { skewMs } = await options.http.time();
    checkedAt = options.now();
    if (Math.abs(skewMs) > MAX_SKEW_MS) {
      throw new PolymarketError(
        "clock-skew",
        `the device clock is ${Math.round(skewMs)} ms off the CLOB's`,
      );
    }
  };

  return {
    request: async (group, input, schema) => {
      /* Fail cheap, in order: a locked vault or missing credentials refuse before any request
         leaves the process, then the clock gate runs before the kernel is asked to sign. */
      if ((await credentials(group)) === undefined) {
        throw new PolymarketError("not-enabled", "the group has no Polymarket credentials");
      }
      await assertClock();
      const timestamp = Math.floor(options.now() / 1000);
      const headers = await api()
        .signL2({
          owner: { walletId: group.walletId, groupIndex: group.groupIndex },
          method: input.method,
          path: input.path,
          ...(input.body === undefined ? {} : { body: input.body }),
          timestamp,
        })
        .catch(mapKernel);
      return options.http.request(
        {
          host: CLOB_HOST,
          method: input.method,
          path: input.path,
          ...(input.query === undefined ? {} : { query: input.query }),
          headers: {
            ...headers,
            ...(input.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(input.body === undefined ? {} : { body: input.body }),
        },
        schema,
      );
    },
    credentials,
  };
}
