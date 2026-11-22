import * as z from "zod/mini";

import { endpoint } from "./endpoint.ts";

/**
 * Whether an app may be offered to the caller — `available`, `close-only` (existing positions may
 * be managed, nothing opened) or `blocked`. Display-only guidance: the platforms enforce their own
 * restrictions; this is not a security boundary.
 */
export type AppAvailability = "available" | "close-only" | "blocked";
export const appAvailability = z.enum(["available", "close-only", "blocked"]);

export const eligibilityRequest = z.undefined();

/**
 * An app id — `^[a-z][a-z0-9-]{1,31}$`. The gateway's config decides which apps appear in the
 * answer; a client treats an absent app as unknown.
 */
const appId = z.string().check(z.regex(/^[a-z][a-z0-9-]{1,31}$/));

export const eligibilityResponse = z.object({
  /** The caller's country as the edge resolved it (ISO-3166 alpha-2), null when unknown. */
  country: z.nullable(z.string()),
  /** The caller's subdivision code as the edge resolved it, null when unknown. */
  region: z.nullable(z.string()),
  apps: z.record(appId, appAvailability),
});
export type EligibilityResponse = z.infer<typeof eligibilityResponse>;

/**
 * `GET /v1/eligibility` — the gateway resolves the caller's IP country/region at the edge and
 * answers per-app availability; responses are `private, no-store` (they depend on the caller IP).
 */
export const eligibility = endpoint(
  "GET",
  "/v1/eligibility",
  eligibilityRequest,
  eligibilityResponse,
);
