// oxlint-disable vitest/no-conditional-in-test -- scripted endpoint behavior is inherently conditional
import { describe, expect, it } from "vite-plus/test";

import {
  CCIP_MAX_BYTES,
  CCIP_MAX_FETCHES,
  CCIP_TIMEOUT_MS,
  ccipRequest,
} from "../src/names/ccip.ts";
import type { SetTimer } from "../src/timer.ts";

const params = {
  data: "0xdeadbeef" as const,
  sender: "0xABcDef0000000000000000000000000000000000" as const,
  requestOptions: undefined,
};

type FetchCall = { readonly method: string; readonly url: string; readonly init?: RequestInit };

const harness = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: FetchCall[] = [];
  const timers: Array<{ readonly ms: number; readonly fire: () => void }> = [];
  const setTimer: SetTimer = (ms, fn) => {
    const timer = { ms, fire: () => void fn() };
    timers.push(timer);
    return () => undefined;
  };
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ method: init?.method ?? "GET", url, ...(init === undefined ? {} : { init }) });
    return handler(url, init);
  };
  return {
    calls,
    timers,
    request: ccipRequest({ fetch: fetchFn, setTimer }),
  };
};

const jsonHex = (hex: string, headers?: Record<string, string>): Response =>
  Response.json({ data: hex }, headers === undefined ? undefined : { headers });

describe("ccipRequest", () => {
  it("never fetches non-https or unparseable URLs and falls through to a later https URL", async () => {
    const h = harness(() => jsonHex("0xabcd"));
    await expect(
      h.request({
        ...params,
        urls: [
          "http://gw/{data}",
          "data:text/plain,0xabcd",
          "file:///etc/passwd",
          // oxlint-disable-next-line eslint/no-script-url -- a hostile gateway scheme under test
          "javascript:alert(1)",
          "relative/{data}",
          "https://good/{data}",
        ],
      }),
    ).resolves.toBe("0xabcd");
    expect(h.calls.map((c) => c.url)).toStrictEqual(["https://good/0xdeadbeef"]);
  });

  it("GETs a {data} template and POSTs the rest, lowercasting {sender} only in the URL", async () => {
    const h = harness(() => jsonHex("0xabcd"));
    await h.request({ ...params, urls: ["https://gw/{sender}/{data}"] });
    expect(h.calls[0]?.method).toBe("GET");
    expect(h.calls[0]?.url).toBe(
      "https://gw/0xabcdef0000000000000000000000000000000000/0xdeadbeef",
    );
    expect(h.timers[0]?.ms).toBe(CCIP_TIMEOUT_MS);

    const post = harness((_url, init) => {
      expect(JSON.parse(String(init?.body))).toStrictEqual({
        data: params.data,
        sender: params.sender,
      });
      return jsonHex("0x99");
    });
    await expect(post.request({ ...params, urls: ["https://post"] })).resolves.toBe("0x99");
    expect(post.calls[0]?.method).toBe("POST");
  });

  it("rejects an oversized content-length without reading the body", async () => {
    const h = harness(() =>
      Response.json(
        { data: "0xabcd" },
        { headers: { "content-length": String(CCIP_MAX_BYTES + 1) } },
      ),
    );
    await expect(h.request({ ...params, urls: ["https://big", "https://next"] })).rejects.toThrow(
      "size limit",
    );
    expect(h.calls).toHaveLength(2);
  });

  it("rejects an oversized streamed body", async () => {
    const h = harness(() => new Response("x".repeat(CCIP_MAX_BYTES + 1)));
    await expect(h.request({ ...params, urls: ["https://big"] })).rejects.toThrow("size limit");
  });

  it("rejects an oversized text body when no body stream exists", async () => {
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      body: null,
      text: async () => Promise.resolve(`0x${"aa".repeat(CCIP_MAX_BYTES)}`),
    } as Response;
    const h = harness(() => response);
    await expect(h.request({ ...params, urls: ["https://big"] })).rejects.toThrow("size limit");
  });

  it("aborts a hung fetch on the injected timer", async () => {
    const h = harness(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = h.request({ ...params, urls: ["https://hung"] });
    await Promise.resolve();
    h.timers[0]?.fire();
    await expect(pending).rejects.toThrow("aborted");
  });

  it("stops when the incoming request signal aborts", async () => {
    const controller = new AbortController();
    const h = harness(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = h.request({
      ...params,
      urls: ["https://hung"],
      requestOptions: { signal: controller.signal },
    });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });

  it("throws the ninth fetch attempt without fetching", async () => {
    const h = harness(() => jsonHex("0x01"));
    for (let i = 0; i < CCIP_MAX_FETCHES; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the budget is explicitly sequential
      await expect(h.request({ ...params, urls: ["https://one"] })).resolves.toBe("0x01");
    }
    await expect(h.request({ ...params, urls: ["https://nine"] })).rejects.toThrow("budget");
    expect(h.calls).toHaveLength(CCIP_MAX_FETCHES);
  });

  it("skips non-2xx and non-hex answers and accepts a plain 0x text body", async () => {
    const h = harness((url) => {
      if (url === "https://a/") {
        return new Response("oops", { status: 500 });
      }
      if (url === "https://b/") {
        return Response.json({ data: "not-hex" });
      }
      return new Response("0xcafe", { headers: { "content-type": "text/plain" } });
    });
    await expect(
      h.request({ ...params, urls: ["https://a", "https://b", "https://c"] }),
    ).resolves.toBe("0xcafe");
    expect(h.calls).toHaveLength(3);

    const failing = harness((url) =>
      url === "https://a/" ? new Response("oops", { status: 500 }) : Response.json({ data: "no" }),
    );
    await expect(failing.request({ ...params, urls: ["https://a", "https://b"] })).rejects.toThrow(
      "malformed",
    );
  });
});
