/**
 * The Fiat24 app definition: `fiat24()` returns the `AppDefinition` `createApps` builds over the
 * shared `AppContext` — the account read over the cross-checked Arbitrum One client, the visible-
 * and-unlocked live view, the enablement record machine, the resumable flows, the secured-read
 * sessions and the public REST reads. `enableWhen` allows `close-only`: a restricted jurisdiction
 * may still need the read surface to wind positions down. The REST api at api.fiat24.com has no
 * CORS and is reachable only through the host-injected `config.fetch` — `context.fetch` is never a
 * fallback. A wallet removal drops its groups' sessions, drafts and open requests; the group's
 * persisted flow records are pruned by the generic store cleanup with everything else.
 */
import { createFiat24Api } from "@qntx/fiat24/api";
import type {
  Fiat24Api,
  Bank,
  Banks,
  Countries,
  CountryCities,
  PaymentPurpose,
  Rate,
  RatePair,
} from "@qntx/fiat24/api";
import { kycUrl } from "@qntx/fiat24/flows";

import type { AppContext, AppDefinition, AppGroup } from "../spi.ts";
import { createFiat24Account } from "./account.ts";
import type { Fiat24AccountState } from "./account.ts";
import { createFiat24Enable } from "./enable.ts";
import { Fiat24AppError, fromSdk } from "./errors.ts";
import { createFiat24Flows } from "./flows.ts";
import type { Fiat24Flows } from "./flows.ts";
import { createFiat24Live } from "./live.ts";
import type { Fiat24LiveView } from "./live.ts";
import { createFiat24Owner } from "./owner.ts";
import { createFiat24Client } from "./rpc.ts";
import { createFiat24Sessions } from "./sessions.ts";
import type { Fiat24SecuredReads } from "./sessions.ts";

/** The host's config — `fetch` is for api.fiat24.com only; nothing else may use it. */
export type Fiat24Config = {
  readonly fetch?: typeof globalThis.fetch;
};

/** The unauthenticated Fiat24 REST reads — every one needs the injected fetch. */
export type Fiat24PublicReads = {
  readonly rates: () => Promise<Readonly<Partial<Record<RatePair, Rate>>>>;
  readonly paymentPurposes: () => Promise<ReadonlyArray<PaymentPurpose>>;
  readonly countries: () => Promise<Countries>;
  readonly countryCities: () => Promise<CountryCities>;
  readonly banks: () => Promise<Banks>;
  readonly bankByIban: (iban: string) => Promise<Bank>;
  /** The host's Sumsub KYC link — a pure URL build, no fetch needed. */
  readonly kycUrl: (walletProviderId?: bigint) => string;
};

/** The Fiat24 surface `createApps` returns under `fiat24`. */
export type Fiat24App = {
  /** The group's Fiat24 account — the SDK view over the pinned, corroborated deployment. */
  readonly account: (group: AppGroup) => Promise<Fiat24AccountState>;
  /** A 15 s account view — polls only while `setVisible(true)` and the vault is unlocked. */
  readonly live: (group: AppGroup) => Fiat24LiveView;
  /** The host's visibility signal — account and reconcile polling run only while visible. */
  readonly setVisible: (visible: boolean) => void;
  /** The resumable flows — state persisted per group, one advance at a time. */
  readonly flows: Fiat24Flows;
  /** The group's secured REST reads — the session grant is minted on first call. */
  readonly session: (group: AppGroup) => Fiat24SecuredReads;
  /** The unauthenticated REST reads. */
  readonly api: Fiat24PublicReads;
};

export function fiat24(config: Fiat24Config = {}): AppDefinition<"fiat24", Fiat24App> {
  if (config.fetch !== undefined && typeof config.fetch !== "function") {
    throw new Error("the fiat24 api fetch must be a function");
  }
  return {
    id: "fiat24",
    /* `close-only` enables too — a restricted jurisdiction still reads and winds down. */
    enableWhen: ["available", "close-only"],
    create: (context: AppContext) => {
      const owner = createFiat24Owner(context.wallet);
      const client = createFiat24Client(context.networks);
      const account = createFiat24Account({ owner, client });
      const live = createFiat24Live({
        account,
        wallet: context.wallet,
        setTimer: context.setTimer,
        now: context.now,
      });
      const api =
        config.fetch === undefined
          ? undefined
          : createFiat24Api({ fetch: config.fetch, now: context.now });
      const sessions = createFiat24Sessions({ requests: context.requests, owner, api });
      const flows = createFiat24Flows({
        wallet: context.wallet,
        requests: context.requests,
        storage: context.storage,
        random: context.random,
        setTimer: context.setTimer,
        logger: context.logger,
        availability: context.availability,
        groupState: context.groupState,
        client,
        owner,
        account,
        api,
        sessions,
      });
      const requireApi = (): Fiat24Api => {
        if (api === undefined) {
          throw new Fiat24AppError(
            "api-unavailable",
            "no api.fiat24.com fetch was injected — the Fiat24 REST api is off",
          );
        }
        return api;
      };
      /** Api.fiat24.com answers are untrusted — the SDK validates and we normalize its errors. */
      const call = async <T>(body: (api: Fiat24Api) => Promise<T>): Promise<T> => {
        try {
          return await body(requireApi());
        } catch (error) {
          throw fromSdk(error);
        }
      };
      const publicReads: Fiat24PublicReads = {
        rates: async () => call(async (a) => a.rates()),
        paymentPurposes: async () => call(async (a) => a.paymentPurposes()),
        countries: async () => call(async (a) => a.countries()),
        countryCities: async () => call(async (a) => a.countryCities()),
        banks: async () => call(async (a) => a.banks()),
        bankByIban: async (iban) => call(async (a) => a.bankByIban(iban)),
        kycUrl: (walletProviderId) => kycUrl(walletProviderId),
      };

      /** The group's tokenId once it has an owned live account — the session's identity. */
      const session = (group: AppGroup): Fiat24SecuredReads => {
        const gated = async (): Promise<Fiat24SecuredReads> => {
          if (context.wallet.getSnapshot().vault !== "unlocked") {
            throw new Fiat24AppError("unlock-required", "unlock the vault to use the Fiat24 app");
          }
          if (context.groupState(group)?.status !== "enabled") {
            throw new Fiat24AppError("not-enabled", "enable the Fiat24 app for this group first");
          }
          requireApi();
          const state = await account(group);
          if (state.status !== "live" || !state.view.account.ownsToken) {
            throw new Fiat24AppError("no-account", "the group owns no live Fiat24 account");
          }
          const reads = sessions.reads(group, state.view.account.tokenId);
          if (reads === undefined) {
            throw new Fiat24AppError(
              "api-unavailable",
              "no api.fiat24.com fetch was injected — the Fiat24 REST api is off",
            );
          }
          return reads;
        };
        /** Secured answers are untrusted too — every error normalizes through `fromSdk`. */
        const secured = async <T>(body: (reads: Fiat24SecuredReads) => Promise<T>): Promise<T> => {
          try {
            return await body(await gated());
          } catch (error) {
            throw fromSdk(error);
          }
        };
        return {
          profile: async () => secured(async (reads) => reads.profile()),
          cards: async () => secured(async (reads) => reads.cards()),
          cardDisplayToken: async (externalId) =>
            secured(async (reads) => reads.cardDisplayToken(externalId)),
          transactions: async (query) => secured(async (reads) => reads.transactions(query)),
          end: () => sessions.end(group),
        };
      };

      /* A removed wallet's groups must not keep bearer sessions, PII drafts or open requests. */
      const unsubscribe = context.wallet.subscribe(() => {
        const wallets = new Set(
          context.wallet.getSnapshot().wallets.map((wallet) => wallet.walletId),
        );
        flows.dropMissing(wallets);
      });

      const appApi: Fiat24App = {
        account,
        live: live.view,
        setVisible: (visible) => {
          live.setVisible(visible);
          flows.setVisible(visible);
        },
        flows: flows.flows,
        session,
        api: publicReads,
      };
      return {
        api: appApi,
        provider: createFiat24Enable({
          storage: context.storage,
          onDisable: flows.dropGroup,
          onEnabled: (group) => void flows.reconcileGroup(group),
          owner,
          client,
          account,
        }),
        unlock: async () => {
          await live.unlock();
          flows.unlock();
        },
        lock: () => {
          live.lock();
          flows.lock();
        },
        close: () => {
          unsubscribe();
          live.close();
          flows.close();
        },
      };
    },
  };
}
