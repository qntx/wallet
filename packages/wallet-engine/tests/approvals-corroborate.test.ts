/**
 * The corroborate rule, branch by branch: a row exists only when the primary read shows it active;
 * `verified` only when the independent read agrees; any disagreement on activeness or identity
 * removes the row; a failed second read shows primary values unverified.
 */
import { describe, expect, it } from "vite-plus/test";

import { corroborate, minAmount } from "../src/approvals/corroborate.ts";
import type { ReadResult } from "../src/approvals/corroborate.ts";
import type { Independent } from "../src/networks/controller.ts";

const CLIENT = { id: "independent" };

const available = (kind: "host" | "gateway" = "host"): Independent<typeof CLIENT> => ({
  kind: "available",
  source: kind,
  client: CLIENT,
});

type Value = { readonly amount: bigint; readonly spender: string };

const active = (value: Value): ReadResult<Value> => ({ kind: "active", value });
const inactive: ReadResult<Value> = { kind: "inactive" };

const merge = (a: Value, b: Value): Value | undefined =>
  a.spender === b.spender
    ? { amount: a.amount < b.amount ? a.amount : b.amount, spender: a.spender }
    : undefined;

const V: Value = { amount: 100n, spender: "spender" };

describe("corroborate", () => {
  it("not-needed shows the primary values, verified", async () => {
    const verdict = await corroborate(
      { kind: "not-needed" },
      async () => Promise.resolve(active(V)),
      async () => Promise.reject(new Error("must not be called")),
      merge,
    );
    expect(verdict).toStrictEqual({ kind: "shown", verified: true, value: V });
  });

  it("available + agreeing reads show the weaker values, verified", async () => {
    const verdict = await corroborate(
      available(),
      async () => Promise.resolve(active({ amount: 100n, spender: "spender" })),
      async () => Promise.resolve(active({ amount: 60n, spender: "spender" })),
      merge,
    );
    expect(verdict).toStrictEqual({
      kind: "shown",
      verified: true,
      value: { amount: 60n, spender: "spender" },
    });
  });

  it("available but independent inactive is disputed, never shown", async () => {
    const verdict = await corroborate(
      available(),
      async () => Promise.resolve(active(V)),
      async () => Promise.resolve(inactive),
      merge,
    );
    expect(verdict).toStrictEqual({ kind: "disputed" });
  });

  it("an identity-field mismatch is disputed", async () => {
    const verdict = await corroborate(
      available(),
      async () => Promise.resolve(active(V)),
      async () => Promise.resolve(active({ amount: 50n, spender: "other" })),
      merge,
    );
    expect(verdict).toStrictEqual({ kind: "disputed" });
  });

  it("an independent read that throws shows primary values, unverified", async () => {
    const verdict = await corroborate(
      available(),
      async () => Promise.resolve(active(V)),
      async () => Promise.reject(new Error("endpoint down")),
      merge,
    );
    expect(verdict).toStrictEqual({ kind: "shown", verified: false, value: V });
  });

  it("unavailable shows primary values, unverified", async () => {
    const verdict = await corroborate(
      { kind: "unavailable" },
      async () => Promise.resolve(active(V)),
      async () => Promise.reject(new Error("must not be called")),
      merge,
    );
    expect(verdict).toStrictEqual({ kind: "shown", verified: false, value: V });
  });

  it("primary inactive drops the candidate — the second read never happens", async () => {
    const verdict = await corroborate(
      available(),
      async () => Promise.resolve(inactive),
      async () => Promise.reject(new Error("must not be called")),
      merge,
    );
    expect(verdict).toStrictEqual({ kind: "dropped" });
  });

  it("a primary read that throws is unread", async () => {
    const verdict = await corroborate(
      available(),
      async () => Promise.reject(new Error("primary down")),
      async () => Promise.resolve(active(V)),
      merge,
    );
    expect(verdict).toStrictEqual({ kind: "unread" });
  });

  it("minAmount takes the smaller decimal string", () => {
    expect(minAmount("100", "60")).toBe("60");
    expect(minAmount("60", "100")).toBe("60");
    expect(minAmount("5", "5")).toBe("5");
  });
});
