import * as z from "zod/mini";

import type { UpstreamAuth } from "../types.ts";
import { UPSTREAM_TIMEOUT_MS } from "./forward.ts";

const TOKEN_URL =
  "https://login.blockstream.com/realms/blockstream-public/protocol/openid-connect/token";

const tokenResponse = z.object({
  access_token: z.string().check(z.minLength(1)),
  expires_in: z.number().check(z.int(), z.positive()),
  token_type: z.string().check(z.refine((v) => v.toLowerCase() === "bearer")),
});

/** A constant bearer token — e.g. `Authorization: Bearer <key>`. */
export const bearer = (token: string): UpstreamAuth => {
  const resolved = Promise.resolve({ authorization: `Bearer ${token}` });
  return async () => resolved;
};

/** A constant header — e.g. `Drpc-Key: <key>`. */
export const header = (name: string, value: string): UpstreamAuth => {
  const resolved = Promise.resolve({ [name]: value });
  return async () => resolved;
};

/**
 * Blockstream Enterprise OAuth client-credentials token, cached per isolate until 30 s before its
 * `expires_in` elapses; concurrent callers share one in-flight fetch. A failed or malformed
 * response clears the slot so the next call retries. Errors never carry secret or token text.
 */
export const blockstreamAuth = (options: {
  readonly fetch: typeof globalThis.fetch;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly now: () => number;
}): UpstreamAuth => {
  const { fetch, clientId, clientSecret, now } = options;
  let inFlight: Promise<Readonly<Record<string, string>>> | undefined;
  let cached:
    | { readonly headers: Readonly<Record<string, string>>; readonly expiresAt: number }
    | undefined;
  return async () => {
    if (cached !== undefined && now() < cached.expiresAt - 30_000) {
      return cached.headers;
    }
    inFlight ??= (async () => {
      try {
        const body = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "client_credentials",
          scope: "openid",
        });
        const response = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`blockstream token request failed with status ${response.status}`);
        }
        const parsed = tokenResponse.safeParse(await response.json());
        if (!parsed.success) {
          throw new Error("blockstream token response is malformed");
        }
        cached = {
          headers: { authorization: `Bearer ${parsed.data.access_token}` },
          expiresAt: now() + parsed.data.expires_in * 1000,
        };
        return cached.headers;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };
};
