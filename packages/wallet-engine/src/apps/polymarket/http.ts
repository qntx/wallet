/**
 * The Polymarket read/post transport: injected `fetch` only, a deadline on the injected timer, JSON
 * parse and a zod/mini schema on every answer (design.md 不变量 7). `body` is the exact string sent —
 * later layers HMAC it, so the client never re-serializes.
 *
 * Mapping: a fetch that throws is `network`, a deadline miss `timeout`, a non-2xx `unavailable`
 * (the error carries the HTTP `status`, the server's parsed JSON error body when it was an object,
 * and its `error` string in the message when it carries one), a non-JSON or schema-failing body
 * `malformed`. The injected-timer abort is the only deadline.
 */
import * as z from "zod/mini";

import { timeoutSignal } from "../../timer.ts";
import type { SetTimer } from "../../timer.ts";
import { CLOB_HOST } from "./constants.ts";
import { PolymarketError } from "./errors.ts";

export const REQUEST_TIMEOUT_MS = 10_000;

export type PolymarketHttpOptions = {
  readonly fetch: typeof globalThis.fetch;
  readonly setTimer: SetTimer;
  readonly now: () => number;
  readonly timeoutMs?: number;
};

export type PolymarketHttpRequest = {
  /** One of the constants.ts hosts. */
  readonly host: string;
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** The exact body string — callers that sign it pass the same bytes they HMAC'd. */
  readonly body?: string;
};

export type PolymarketServerTime = {
  /** CLOB server unix seconds. */
  readonly serverSeconds: number;
  /** `serverSeconds * 1000` minus the request's local midpoint — positive means the server is ahead. */
  readonly skewMs: number;
};

export type PolymarketHttp = {
  readonly request: <S extends z.ZodMiniType>(
    request: PolymarketHttpRequest,
    schema: S,
  ) => Promise<z.output<S>>;
  readonly time: () => Promise<PolymarketServerTime>;
};

/** `path` may be absolute-joined only onto `host` — the URL keeps the host's origin+path. */
const buildUrl = (request: PolymarketHttpRequest): string => {
  const url = new URL(`${request.host}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The server's parsed error body when it is a JSON object — a non-JSON body carries none. */
const errorBody = async (
  response: Response,
): Promise<Readonly<Record<string, unknown>> | undefined> => {
  try {
    const body: unknown = await response.json();
    if (isRecord(body)) {
      return body;
    }
  } catch {
    /* A non-JSON error body carries no detail. */
  }
  return undefined;
};

export function createPolymarketHttp(options: PolymarketHttpOptions): PolymarketHttp {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const request = async <S extends z.ZodMiniType>(
    input: PolymarketHttpRequest,
    schema: S,
  ): Promise<z.output<S>> => {
    const bound = timeoutSignal(timeoutMs, options.setTimer);
    const url = buildUrl(input);
    try {
      const response = await options.fetch(url, {
        method: input.method,
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        ...(input.body === undefined ? {} : { body: input.body }),
        signal: bound.signal,
      });
      if (!response.ok) {
        const body = await errorBody(response);
        const detail = body?.["error"];
        throw new PolymarketError(
          "unavailable",
          `${input.method} ${input.path} answered ${response.status}${
            typeof detail === "string" ? `: ${detail.slice(0, 200)}` : ""
          }`,
          {
            status: response.status,
            ...(body === undefined ? {} : { body }),
          },
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new PolymarketError("malformed", `${input.method} ${input.path} answered non-JSON`, {
          cause: error,
        });
      }
      const parsed = z.safeParse(schema, body);
      if (!parsed.success) {
        throw new PolymarketError("malformed", `${input.method} ${input.path} failed its schema`, {
          cause: parsed.error,
        });
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof PolymarketError) {
        throw error;
      }
      if (bound.signal.aborted) {
        throw new PolymarketError("timeout", `${input.method} ${input.path} timed out`, {
          cause: error,
        });
      }
      throw new PolymarketError(
        "network",
        `${input.method} ${input.path} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      bound.cancel();
    }
  };

  return {
    request,
    time: async () => {
      const start = options.now();
      const seconds = await request({ host: CLOB_HOST, method: "GET", path: "/time" }, z.int());
      const midpoint = (start + options.now()) / 2;
      return { serverSeconds: seconds, skewMs: seconds * 1000 - midpoint };
    },
  };
}
