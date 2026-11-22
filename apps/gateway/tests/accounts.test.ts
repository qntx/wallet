import { describe, expect, it } from "vite-plus/test";

import type { Account } from "../src/config/accounts.ts";
import { PRODUCTION_ACCOUNTS, STAGING_ACCOUNTS } from "../src/config/accounts.ts";
import { SHARE_LIMIT, shareDelta, sharePerMinute } from "../src/middleware/rate-limit.ts";
import { TEST_ACCOUNTS, fakeFetch, gateway } from "./helpers.ts";

/**
 * The minimum per-prefix call rate each account must admit inside one share window, sourced from
 * the measured fresh all-family cold start in packages/wallet-engine/tests/gateway-capacity.test.ts
 * (scenario "all fresh cold"): 3 × the measured upstream calls, so three wallets' cold starts in
 * one minute fit one prefix's share. Staging rows keep the generic floor — third parties' public
 * endpoints get no raised share.
 */
const SHARE_FLOOR_PRODUCTION: Readonly<Record<string, number>> = {
  alchemy: 360,
  blockstream: 600,
  coingecko: 243,
  defillama: 261,
};
const SHARE_FLOOR_DEFAULT = 10;

describe.each([
  ["production", PRODUCTION_ACCOUNTS],
  ["staging", STAGING_ACCOUNTS],
] as const)("%s accounts", (env, accounts) => {
  describe.each(Object.entries(accounts))("%s", (id, account) => {
    it("admits at least the per-prefix floor inside the share window", () => {
      // oxlint-disable vitest/no-conditional-in-test -- the floor table is per-env
      const floor =
        env === "production"
          ? (SHARE_FLOOR_PRODUCTION[id] ?? SHARE_FLOOR_DEFAULT)
          : SHARE_FLOOR_DEFAULT;
      // oxlint-enable vitest/no-conditional-in-test
      const delta = shareDelta(account, 1);
      expect(delta).toBeLessThanOrEqual(SHARE_LIMIT);
      expect(Math.floor(SHARE_LIMIT / delta)).toBeGreaterThanOrEqual(floor);
    });
  });
});

/** Every row of a cost model that carries a billing unit, flattened for source checks. */
const costRows = (account: Account): ReadonlyArray<{ readonly source: string }> =>
  account.costs.kind === "request"
    ? [account.costs.request]
    : [
        ...Object.values(account.costs.methods),
        ...(account.costs.transfers === undefined ? [] : [account.costs.transfers]),
      ];

describe("account sources", () => {
  describe.each([
    ["production", PRODUCTION_ACCOUNTS],
    ["staging", STAGING_ACCOUNTS],
  ] as const)("%s", (_env, accounts) => {
    it.each(Object.entries(accounts))("%s cites the page its budget comes from", (_id, account) => {
      expect(new URL(account.source).protocol).toBe("https:");
      for (const row of costRows(account)) {
        expect(new URL(row.source).protocol).toBe("https:");
      }
    });
  });
});

describe("share window validation", () => {
  const dayOnly: Account = {
    costs: { kind: "request", request: { units: 1, source: "https://test.invalid" } },
    budget: [{ units: 10_000, seconds: 86_400 }],
    clientShare: 0.05,
    source: "https://test.invalid",
  };

  it("rejects an account whose only window is longer than a minute", () => {
    expect(() => sharePerMinute(dayOnly)).toThrow(/minute-scale/);
  });

  it.each([0, -0.5, 1.5, Number.NaN])("rejects a clientShare of %s", (clientShare) => {
    expect(() =>
      sharePerMinute({ ...dayOnly, budget: [{ units: 60, seconds: 60 }], clientShare }),
    ).toThrow(/clientShare/);
  });

  it("fails gateway construction on a misconfigured account row", () => {
    expect(() =>
      gateway({
        fetch: fakeFetch({}).fetch,
        accounts: { ...TEST_ACCOUNTS, broken: dayOnly },
      }),
    ).toThrow(/broken/);
  });
});
