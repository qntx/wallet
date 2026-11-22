import { Hono } from "hono";

import { eligibility } from "@qntx/wallet-engine/gateway/contract";

import { ELIGIBILITY, availabilityFor } from "../config/eligibility.ts";

/**
 * `GET /v1/eligibility` — the edge resolves the caller's IP to `cf.country`/`cf.regionCode`. A
 * missing country, `XX` (unknown) or `T1` (Tor) blocks every app: failing closed is the only honest
 * default for a jurisdiction gate. The answer depends on the caller's IP, so it is `private,
 * no-store`. Display gating only — the platforms enforce their own restrictions.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const eligibilityRoutes = new Hono().get(eligibility.path, (c) => {
  /* `cf` is the worker's edge metadata — absent under plain Request typings (engine tsc follows
     the contract import into this file), so it is narrowed rather than asserted. */
  const raw: unknown = c.req.raw;
  const cf = isRecord(raw) && isRecord(raw["cf"]) ? raw["cf"] : undefined;
  const country = typeof cf?.["country"] === "string" ? cf["country"] : null;
  const region = typeof cf?.["regionCode"] === "string" ? cf["regionCode"] : null;
  const resolved = Object.fromEntries(
    Object.entries(ELIGIBILITY).map(([app, table]) => [
      app,
      country === null || country === "XX" || country === "T1"
        ? "blocked"
        : availabilityFor(table, country, region ?? undefined),
    ]),
  );
  return c.json({ country, region, apps: resolved }, 200, {
    "cache-control": "private, no-store",
  });
});
