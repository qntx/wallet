// oxlint-disable vitest/no-conditional-in-test -- hostile-matrix cases assert only the grant headers actually sent
// oxlint-disable eslint/no-await-in-loop -- each hostile case runs setup, assert and teardown in sequence
import type { Address } from "viem";
/**
 * The Fiat24 secured/public REST surface over the recorded api fixtures: the session grant mints
 * once through the real request pipeline and is reused until `end()`/lock, secured reads and the
 * card endpoints hit the fixture bodies, hostile answers surface as `protocol` errors carrying only
 * SDK codes, and nothing without `config.fetch` works.
 */
import { describe, expect, it } from "vite-plus/test";

import { fiat24 } from "../src/apps/fiat24/app.ts";
import { Fiat24AppError } from "../src/apps/fiat24/errors.ts";
import type { World } from "./apps-helpers.ts";
import { until, world } from "./apps-helpers.ts";
import { fixtureBody, makeFiat24ApiFetch } from "./support/fiat24-api.ts";
import {
  accountEntries,
  allowanceEntries,
  availabilityEntries,
  balanceEntries,
  honestStorage,
  makeFiat24Chain,
  mergeCalls,
  proxyAdminEntry,
  SENDER_ID,
} from "./support/fiat24-chain.ts";

const OWNER = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" as Address;

const openRequests = (w: World) => Object.values(w.requests.getState().requests);

const setup = async (
  options: {
    api?: boolean;
    calls?: NonNullable<Parameters<typeof makeFiat24Chain>[0]["calls"]>;
    routes?: NonNullable<Parameters<typeof makeFiat24ApiFetch>[0]>["routes"];
  } = {},
) => {
  const api = makeFiat24ApiFetch({ routes: options.routes ?? {} });
  const calls =
    options.calls ??
    mergeCalls(
      proxyAdminEntry(),
      availabilityEntries({}),
      accountEntries(OWNER, { owner: OWNER, historic: SENDER_ID, rounds: 8 }),
      balanceEntries(OWNER),
      allowanceEntries(OWNER),
    );
  const chain = makeFiat24Chain({
    calls,
    storage: honestStorage(),
    count: { pending: 5, latest: 5 },
  });
  const w = await world(0, {
    fiat24: options.api === false ? true : { fetch: api.fetch },
    arb1: chain.arb1,
  });
  await w.apps.acknowledgeTerms(w.group, "fiat24");
  await w.apps.enable(w.group, "fiat24");
  return { w, api, chain };
};

const approveNext = async (w: World): Promise<void> => {
  const pending = () =>
    openRequests(w).find((request) => request.stage !== "submitted" && request.stage !== "failed");
  await until(() => pending() !== undefined, 5000);
  await w.approve(pending()?.id ?? "");
};

describe("fiat24 sessions and api reads", () => {
  it("grants once, reuses the session and re-grants after end()", async () => {
    const { w, api } = await setup();
    const secured = w.f24.session(w.group);
    const first = secured.profile();
    await approveNext(w);
    const profile = await first;
    expect(profile.tokenId).toBe(690333n);

    /* The cached grant serves the next read — no second request. */
    const settled = openRequests(w).length;
    const cards = await secured.cards();
    expect(cards.length).toBeGreaterThan(0);
    expect(openRequests(w)).toHaveLength(settled);
    const granted = api.calls.filter((call) => call.url.includes("/timestamp"));
    expect(granted).toHaveLength(1);

    secured.end();
    const second = secured.profile();
    await approveNext(w);
    await second;
    expect(api.calls.filter((call) => call.url.includes("/timestamp"))).toHaveLength(2);
    await w.destroy();
  }, 30_000);

  it("answers the public reads without a request and reports kycUrl", async () => {
    const { w } = await setup();
    const countries = await w.f24.api.countries();
    expect(countries.eligibleDomiciles.length).toBeGreaterThan(0);
    const purposes = await w.f24.api.paymentPurposes();
    expect(purposes.length).toBeGreaterThan(0);
    const banks = await w.f24.api.banks();
    expect(Object.keys(banks).length).toBeGreaterThan(0);
    const rates = await w.f24.api.rates();
    expect(Object.keys(rates).length).toBeGreaterThan(0);
    /* The recorded banks-iban fixture is the whitelist's "not found" answer — a typed refusal. */
    await expect(w.f24.api.bankByIban("CH9300762011623852957")).rejects.toBeInstanceOf(
      Fiat24AppError,
    );
    const cities = await w.f24.api.countryCities();
    expect(cities).toBeDefined();
    expect(w.f24.api.kycUrl(469709n)).toContain("469709");
    expect(openRequests(w)).toStrictEqual([]);
    await w.destroy();
  });

  it("refuses every api and secured read without the injected fetch", async () => {
    const { w } = await setup({ api: false });
    await expect(w.f24.api.countries()).rejects.toMatchObject({ category: "api-unavailable" });
    await expect(w.f24.session(w.group).profile()).rejects.toMatchObject({
      category: "api-unavailable",
    });
    /* kycUrl is a pure URL build — the one read that needs no fetch. */
    expect(w.f24.api.kycUrl(469709n)).toContain("469709");
    await w.destroy();
  });

  it("maps a hostile secured answer to a protocol error carrying only the SDK code", async () => {
    const { w, api } = await setup({
      routes: { "/br": "{ not json" },
    });
    const secured = w.f24.session(w.group);
    const pending = secured.profile();
    pending.catch(() => undefined);
    await approveNext(w);
    const error = await pending.catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(Fiat24AppError);
    const appError = error as Fiat24AppError;
    expect(appError.category).toBe("protocol");
    const serialized = JSON.stringify(appError);
    for (const call of api.calls) {
      expect(serialized).not.toContain(JSON.stringify(call.init.headers));
    }
    expect(serialized).not.toContain("PII-SENTINEL");
    await w.destroy();
  }, 30_000);

  it("unwraps the secured fixture envelope to the recorded body", () => {
    expect(fixtureBody("secured/br.json")).toContain("690333");
    expect(fixtureBody("public/timestamp.json")).toContain("timestamp");
  });

  it("maps the hostile api matrix to protocol errors carrying only the SDK code", async () => {
    /* Public reads need no request — each hostile answer is tried on `/rates`. */
    const publicCases: ReadonlyArray<{
      readonly name: string;
      readonly route: NonNullable<
        NonNullable<Parameters<typeof makeFiat24ApiFetch>[0]>["routes"]
      >[string];
      readonly code: string;
    }> = [
      { name: "malformed JSON", route: "{ not json", code: "invalid-response" },
      /* The documented public-abuse answer 500 maps to `rate-limited` (a secured 500 would be
         `http-error`). */
      { name: "HTTP 500", route: { status: 500, body: "upstream exploded" }, code: "rate-limited" },
      {
        /* A 3xx is refused before any status handling — the request may have carried a bearer
           grant to another origin's answer. */
        name: "redirect",
        route: { status: 302, body: "", headers: { location: "https://attacker.example" } },
        code: "invalid-response",
      },
      {
        name: "oversized body",
        route: `[${"1,".repeat(600_000)}1]`,
        code: "invalid-response",
      },
      {
        name: "trailing garbage",
        route: fixtureBody("secured/trailing-garbage.json"),
        code: "invalid-response",
      },
    ];
    for (const hostile of publicCases) {
      const { w, api } = await setup({ routes: { "/rates": hostile.route } });
      const error = await w.f24.api.rates().then(
        () => {
          throw new Error(`${hostile.name}: expected a refusal`);
        },
        (error_: unknown) => error_,
      );
      expect(error).toBeInstanceOf(Fiat24AppError);
      const appError = error as Fiat24AppError;
      expect(appError.category).toBe("protocol");
      expect(appError.code).toBe(hostile.code);
      /* Nothing the API sent or held echoes back — no headers, no signature, no label. */
      const serialized = JSON.stringify(appError);
      for (const auth of api.calls.flatMap((call) => {
        const header = (call.init.headers as Record<string, string> | undefined)?.["Authorization"];
        return header === undefined ? [] : [header];
      })) {
        expect(serialized).not.toContain(auth);
      }
      expect(serialized).not.toContain("fiat24-session-v1:");
      expect(w.warns.join("\n")).not.toContain("fiat24-session-v1:");
      expect(JSON.stringify(w.requests.getState())).not.toContain("fiat24-session-v1:");
      await w.destroy();
    }

    /* The hostile secured bodies — duplicate keys and an unsafe integer — go through the granted
       session so the grant headers are in flight when the error lands. */
    for (const [fixture, name] of [
      ["secured/duplicate-keys.json", "duplicate keys"],
      ["secured/unsafe-int.json", "unsafe integer"],
    ] as const) {
      const { w, api } = await setup({ routes: { "/br": fixtureBody(fixture) } });
      const profile = w.f24.session(w.group).profile();
      profile.catch(() => undefined);
      await approveNext(w);
      const error = await profile.then(
        () => {
          throw new Error(`${name}: expected a refusal`);
        },
        (error_: unknown) => error_,
      );
      expect(error).toBeInstanceOf(Fiat24AppError);
      const appError = error as Fiat24AppError;
      expect(appError.category).toBe("protocol");
      expect(appError.code).toBe("invalid-response");
      const serialized = JSON.stringify(appError);
      for (const auth of api.calls.flatMap((call) => {
        const header = (call.init.headers as Record<string, string> | undefined)?.["Authorization"];
        return header === undefined ? [] : [header];
      })) {
        expect(serialized).not.toContain(auth);
        expect(JSON.stringify(w.requests.getState())).not.toContain(auth);
        expect(w.warns.join("\n")).not.toContain(auth);
      }
      expect(serialized).not.toContain("fiat24-session-v1:");
      await w.destroy();
    }
  }, 120_000);

  it("refuses a non-function api fetch at definition time", () => {
    expect(() => fiat24({ fetch: "text" as unknown as typeof globalThis.fetch })).toThrow(
      "must be a function",
    );
  });

  it("refuses flow calls and secured reads while the vault is locked or the group is disabled", async () => {
    const { w } = await setup();
    /* A disabled group refuses before any account read or request opens. */
    await w.apps.disable(w.group, "fiat24", { revoke: true });
    await expect(w.f24.session(w.group).profile()).rejects.toMatchObject({
      category: "not-enabled",
    });
    await w.apps.enable(w.group, "fiat24");
    /* A locked vault fails closed everywhere — nothing is read, no request opens. */
    await w.wallet.vault.lock();
    w.requests.lock();
    await expect(w.f24.flows.list(w.group)).rejects.toMatchObject({
      category: "unlock-required",
    });
    await expect(w.f24.session(w.group).profile()).rejects.toMatchObject({
      category: "unlock-required",
    });
    await w.destroy();
  });

  it("refuses the secured reads when the group owns no live account", async () => {
    const { w } = await setup({
      calls: mergeCalls(
        proxyAdminEntry(),
        availabilityEntries({}),
        accountEntries(OWNER, { historic: 0n, balance: 0n, rounds: 8 }),
        balanceEntries(OWNER),
        allowanceEntries(OWNER),
      ),
    });
    await expect(w.f24.session(w.group).profile()).rejects.toMatchObject({
      category: "no-account",
    });
    await w.destroy();
  });

  it("reads the card display token and the transaction page through the cached grant", async () => {
    const { w } = await setup();
    const secured = w.f24.session(w.group);
    const token = secured.cardDisplayToken("123456");
    token.catch(() => undefined);
    await approveNext(w);
    await expect(token).resolves.toBe("PII-SENTINEL-31");
    /* The grant is cached — the transaction page opens no second request. */
    const page = await secured.transactions({ currency: "EUR" });
    expect(page.transactions.length).toBeGreaterThan(0);
    await w.destroy();
  }, 30_000);
});
