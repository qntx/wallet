/**
 * The `config.fetch` fake for api.fiat24.com: routes the SDK's recorded fixtures under
 * `tests/fixtures/api` (provenance in each SOURCE.json — public bodies are byte-frozen, secured
 * bodies are the `{source, doc, body}` envelope whose `body` field is served). `/timestamp` is
 * answered with the injected clock since a recorded ms would fail the session's skew check. Writes
 * answer the `write-ok` body; an unstubbed or unmatched request throws so a stray call surfaces as
 * `network-error`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API_BASE_URL = "https://api.fiat24.com";

export function fixtureBody(relative: string): string {
  const text = readFileSync(
    fileURLToPath(new URL(`../fixtures/fiat24/api/${relative}`, import.meta.url)),
    "utf8",
  );
  if (!relative.startsWith("secured/")) {
    return text;
  }
  const envelope: unknown = JSON.parse(text);
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new Error(`bad secured fixture ${relative}`);
  }
  if ("raw" in envelope && typeof envelope["raw"] === "string") {
    return envelope["raw"];
  }
  return JSON.stringify("body" in envelope ? envelope["body"] : envelope);
}

export type RecordedApiCall = { readonly url: string; readonly init: RequestInit };

const json = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

/** The static `path+query` → fixture routes; `/timestamp` is generated per call. */
const ROUTES: ReadonlyArray<readonly [string, () => string]> = [
  ["/countries", () => fixtureBody("public/countries.json")],
  ["/rates", () => fixtureBody("public/rates.json")],
  ["/payment-purposes", () => fixtureBody("public/payment-purposes.json")],
  ["/country-cities", () => fixtureBody("public/country-cities.json")],
  ["/banks", () => fixtureBody("public/banks.json")],
  ["/br", () => fixtureBody("secured/br.json")],
  ["/cards", () => fixtureBody("secured/cards-ok.json")],
  ["/transactions", () => fixtureBody("secured/transactions.json")],
  ["/status-kyc", () => fixtureBody("public/status-kyc-9102.json")],
];

export function makeFiat24ApiFetch(
  options: {
    readonly now?: () => number;
    /**
     * `path` → body (or `{ status, body, headers }` response) overrides — hostile fixtures slot in
     * per test.
     */
    readonly routes?: Readonly<
      Record<
        string,
        | string
        | {
            readonly status?: number;
            readonly body: string;
            readonly headers?: Readonly<Record<string, string>>;
          }
      >
    >;
    /** The `write` answer — `secured/write-ok.json` by default. */
    readonly write?: string;
  } = {},
): { fetch: typeof globalThis.fetch; calls: RecordedApiCall[] } {
  const calls: RecordedApiCall[] = [];
  const overrides = new Map(Object.entries(options.routes ?? {}));
  // oxlint-disable-next-line typescript/require-await -- the fixture answers synchronously; fetch's seam is a promise
  const fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const path = url.startsWith(API_BASE_URL) ? url.slice(API_BASE_URL.length) : url;
    const pathname = path.split("?")[0] ?? path;
    const override = overrides.get(pathname) ?? overrides.get(path);
    if (override !== undefined) {
      if (typeof override === "string") {
        return json(override);
      }
      return new Response(override.body, {
        status: override.status ?? 200,
        headers: { "content-type": "application/json", ...override.headers },
      });
    }
    if (pathname === "/timestamp") {
      return json(JSON.stringify({ timestamp: options.now?.() ?? Date.now() }));
    }
    for (const [route, body] of ROUTES) {
      if (pathname === route) {
        return json(body());
      }
    }
    if (pathname.startsWith("/banks/iban/")) {
      return json(fixtureBody("public/banks-iban.json"));
    }
    if (pathname === "/verify") {
      return json(
        fixtureBody(path.includes("qr=") ? "secured/verify-qr.json" : "secured/verify-sp.json"),
      );
    }
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" || method === "PUT") {
      return json(fixtureBody(options.write ?? "secured/write-ok.json"));
    }
    throw new Error(`unstubbed api route ${path}`);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
