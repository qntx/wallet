import { describe, expect, it } from "vite-plus/test";

import type { Account } from "../src/config/accounts.ts";
import { PRODUCTION_ACCOUNTS, STAGING_ACCOUNTS } from "../src/config/accounts.ts";
import { SHARE_LIMIT, shareDelta, sharePerMinute } from "../src/middleware/rate-limit.ts";
import { TEST_ACCOUNTS, fakeFetch, gateway } from "./helpers.ts";

/** The minimum per-prefix call rate any account must admit; resized to measured usage later. */
const SHARE_FLOOR_PER_MINUTE = 10;

describe.each([
  ["production", PRODUCTION_ACCOUNTS],
  ["staging", STAGING_ACCOUNTS],
] as const)("%s accounts", (_env, accounts) => {
  describe.each(Object.entries(accounts))("%s", (_id, account) => {
    it("admits at least the per-prefix floor inside the share window", () => {
      const delta = shareDelta(account, 1);
      expect(delta).toBeLessThanOrEqual(SHARE_LIMIT);
      expect(Math.floor(SHARE_LIMIT / delta)).toBeGreaterThanOrEqual(SHARE_FLOOR_PER_MINUTE);
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
