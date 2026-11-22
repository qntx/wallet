/**
 * The L2 client — every authenticated CLOB request HMACs its headers in the engine over the group's
 * stored credentials (design.md §返工): `timestamp` floors the injected clock to seconds and the body
 * string sent is exactly the body string signed. A missing record, a stored `owner` that no longer
 * equals the group's `evm.bip44` signer, or a locked vault fails the request before anything leaves
 * the process — `not-enabled`/`unlock-required` respectively.
 *
 * Clock gate: the CLOB validates `POLY_TIMESTAMP` against an undocumented tolerance, so a device
 * clock far off can only produce refused requests — before the first L2 request of a session and
 * every ten minutes the client checks the `/time` skew and fails `clock-skew` early, which beats an
 * opaque 401.
 *
 * Error hygiene: a hostile server can echo the credentials it issued back inside an error body —
 * every error the http call throws is scrubbed of the apiKey/secret/passphrase before it escapes
 * (message redacted, body and cause dropped).
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { base64url } from "@scure/base";
import type * as z from "zod/mini";

import type { AppGroup } from "../types.ts";
import { CLOB_HOST } from "./constants.ts";
import { decodeSecret } from "./credentials.ts";
import type { PolymarketCredentialStore, PolymarketCredentials } from "./credentials.ts";
import { PolymarketError } from "./errors.ts";
import type { PolymarketHttp } from "./http.ts";

/** The skew bound — beyond it the CLOB's timestamp check can only fail. */
export const MAX_SKEW_MS = 30_000;
const SKEW_REFRESH_MS = 600_000;

export type PolymarketL2Method = "GET" | "POST" | "DELETE";

export type PolymarketL2Request = {
  readonly method: PolymarketL2Method;
  /** The CLOB path — never carries a query string (queries ride unsigned on the URL). */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  /** The exact body string — the same bytes the HMAC covers. */
  readonly body?: string;
};

export type PolymarketL2Headers = {
  readonly POLY_ADDRESS: string;
  readonly POLY_SIGNATURE: string;
  readonly POLY_TIMESTAMP: string;
  readonly POLY_API_KEY: string;
  readonly POLY_PASSPHRASE: string;
};

export type PolymarketL2 = {
  readonly request: <S extends z.ZodMiniType>(
    group: AppGroup,
    request: PolymarketL2Request,
    schema: S,
  ) => Promise<z.output<S>>;
  /** The group's stored credentials — `undefined` when absent (internal seam for trade/enable). */
  readonly credentials: (group: AppGroup) => Promise<PolymarketCredentials | undefined>;
};

/**
 * The five `POLY_*` headers for one request — the oracle of vectors/chains/polymarket-l2.json:
 * `POLY_SIGNATURE` is the url-safe base64 (padding kept) HMAC-SHA256 over
 * `${timestamp}${method}${path}${body ?? ""}` keyed by the decoded secret.
 */
export function l2Headers(
  credentials: PolymarketCredentials,
  input: {
    readonly method: string;
    readonly path: string;
    readonly body?: string;
    readonly timestamp: number;
  },
): PolymarketL2Headers {
  const key = decodeSecret(credentials.secret);
  if (key === undefined) {
    throw new PolymarketError("malformed", "the stored credential secret does not decode");
  }
  return {
    POLY_ADDRESS: credentials.owner,
    POLY_SIGNATURE: base64url.encode(
      hmac(
        sha256,
        key,
        utf8ToBytes(`${input.timestamp}${input.method}${input.path}${input.body ?? ""}`),
      ),
    ),
    POLY_TIMESTAMP: `${input.timestamp}`,
    POLY_API_KEY: credentials.apiKey,
    POLY_PASSPHRASE: credentials.passphrase,
  };
}

/**
 * A hostile CLOB can reflect the issued credentials back inside an error — the thrown error is
 * re-derived with every occurrence of the three values in the message/body/cause chain replaced or
 * dropped, preserving category and status. Errors free of them pass through untouched.
 */
const scrub = (error: unknown, credentials: PolymarketCredentials): unknown => {
  const secrets = [credentials.apiKey, credentials.secret, credentials.passphrase].filter(
    (value) => value !== "",
  );
  const texts: string[] = [];
  let cause: unknown = error;
  while (cause instanceof Error) {
    texts.push(cause.message);
    ({ cause } = cause);
  }
  if (error instanceof PolymarketError && error.body !== undefined) {
    texts.push(JSON.stringify(error.body));
  }
  const leaks = (text: string): boolean => secrets.some((secret) => text.includes(secret));
  if (!texts.some(leaks)) {
    return error;
  }
  const redact = (text: string): string => {
    let next = text;
    for (const secret of secrets) {
      next = next.replaceAll(secret, "[redacted]");
    }
    return next;
  };
  if (error instanceof PolymarketError) {
    const options = error.status === undefined ? {} : { status: error.status };
    return new PolymarketError(error.category, redact(error.message), options);
  }
  return new PolymarketError(
    "unavailable",
    redact(error instanceof Error ? error.message : String(error)),
  );
};

export function createPolymarketL2(options: {
  readonly http: PolymarketHttp;
  /** The group's credential records in the apps store. */
  readonly credentials: PolymarketCredentialStore;
  /** The group's current `evm.bip44` signer — must equal the stored `owner`. */
  readonly signerOf: (group: AppGroup) => Promise<`0x${string}`>;
  readonly now: () => number;
}): PolymarketL2 {
  /** Last `now()` a skew check passed — one `/time` per session plus a refresh every 10 min. */
  let checkedAt: number | undefined;

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
      /* Fail cheap, in order: missing credentials or an owner that no longer matches the group's
         signer refuse before any request leaves the process — never another account's headers. */
      const credentials = await options.credentials.get(group);
      if (credentials === undefined) {
        throw new PolymarketError("not-enabled", "the group has no Polymarket credentials");
      }
      const signer = await options.signerOf(group);
      if (signer.toLowerCase() !== credentials.owner.toLowerCase()) {
        throw new PolymarketError(
          "not-enabled",
          "the group's signer no longer matches its credentials",
        );
      }
      await assertClock();
      const timestamp = Math.floor(options.now() / 1000);
      const headers = l2Headers(credentials, {
        method: input.method,
        path: input.path,
        ...(input.body === undefined ? {} : { body: input.body }),
        timestamp,
      });
      try {
        return await options.http.request(
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
      } catch (error) {
        throw scrub(error, credentials);
      }
    },
    credentials: async (group) => options.credentials.get(group),
  };
}
