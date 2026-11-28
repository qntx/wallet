// oxlint-disable typescript/require-await -- fetch and source contracts are async even when the stub answers synchronously
// oxlint-disable vitest/no-conditional-in-test -- input normalization tables are deterministic test data
/**
 * Host-side Ledger descriptor sources: CAL fetching is strict about URL, headers, timeout, body
 * size and response shape, while bundle sources are pure offline lookups. A source only supplies
 * candidate bytes — binding stays in the kernel.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  bundleDescriptorSource,
  calDescriptorSource,
  LEDGER_CAL_URL,
} from "../src/hardware/descriptors.ts";
import type { ChainSignRequest } from "../src/protocol/index.ts";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DATA = `0xa9059cbb${"0".repeat(24)}${"00".repeat(20)}${"0".repeat(64)}`;
const request: ChainSignRequest = {
  kind: "evm.transaction",
  network: "eip155:1",
  account: {
    kind: "hd",
    walletId: "ab".repeat(8),
    groupIndex: 0,
    template: "evm.bip44",
  },
  tx: {
    type: "eip1559",
    chainId: 1,
    nonce: 0,
    to: USDC,
    value: "0x0",
    data: DATA,
    gas: "0x5208",
    maxFeePerGas: "0x77359400",
    maxPriorityFeePerGas: "0x3b9aca00",
    accessList: [],
  },
};

const dataHex = `55534443${USDC.slice(2)}0000000600000001`;
const prodHex =
  "3045022100b2e358726e4e6a6752cf344017c0e9d45b9a904120758d45f61b2804f9ad5299022015161ef28d8c4481bd9432c13562def9cce688bcfec896ef244c9a213f106cdd";
const payloadHex = `04${dataHex}${prodHex}`;
const calBody = [
  {
    descriptor: {
      data: dataHex,
      descriptorType: "token",
      signatures: { prod: prodHex, test: `3044${"00".repeat(68)}` },
    },
  },
];

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const fetchJson =
  (body: unknown, init?: ResponseInit): typeof globalThis.fetch =>
  async () =>
    Response.json(body, init);

describe("calDescriptorSource", () => {
  it("queries the token contract on the request chain and builds the DMK legacy payload", async () => {
    let seenUrl = "";
    let seenOrigin: string | null = null;
    const fetchStub = (async (input: unknown, init?: RequestInit) => {
      seenUrl = input instanceof URL ? input.href : String(input);
      seenOrigin = new Headers(init?.headers).get("x-ledger-client-origin");
      return Response.json(calBody);
    }) as typeof globalThis.fetch;
    const source = calDescriptorSource({
      fetch: fetchStub,
      url: "https://cal.example/cal/v1",
      originToken: "origin-token",
    });
    const descriptors = await source(request);
    expect(descriptors?.tokens?.map(hex)).toStrictEqual([payloadHex]);
    const url = new URL(seenUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://cal.example/cal/v1/tokens");
    expect(url.searchParams.get("contract_address")).toBe(USDC);
    expect(url.searchParams.get("chain_id")).toBe("1");
    expect(url.searchParams.get("output")).toBe("descriptor");
    expect(url.searchParams.get("ref")).toBe("branch:main");
    expect(seenOrigin).toBe("origin-token");
  });

  it("uses Ledger's public CAL URL by default and omits the origin header without a token", async () => {
    let seenUrl = "";
    let seenOrigin: string | null = null;
    const fetchStub = (async (input: unknown, init?: RequestInit) => {
      seenUrl = input instanceof URL ? input.href : String(input);
      seenOrigin = new Headers(init?.headers).get("x-ledger-client-origin");
      return new Response("[]");
    }) as typeof globalThis.fetch;
    await expect(calDescriptorSource({ fetch: fetchStub })(request)).resolves.toBeUndefined();
    expect(seenUrl.startsWith(`${LEDGER_CAL_URL}/tokens?`)).toBe(true);
    expect(seenOrigin).toBeNull();
  });

  it("returns undefined for requests that need no ERC-20 token and for an empty CAL answer", async () => {
    let fetches = 0;
    const fetchStub = (async () => {
      fetches += 1;
      return new Response("[]");
    }) as typeof globalThis.fetch;
    const source = calDescriptorSource({ fetch: fetchStub });
    const native = {
      ...request,
      tx: { ...request.tx, to: "0x00000000000000000000000000000000deadbeef", data: "0x" },
    } as ChainSignRequest;
    await expect(source(native)).resolves.toBeUndefined();
    expect(fetches).toBe(0);
    await expect(source(request)).resolves.toBeUndefined();
    expect(fetches).toBe(1);
  });

  it("rejects malformed answers, HTTP failures and malformed payload hex", async () => {
    for (const body of [
      "not-json",
      {},
      [{ descriptor: { data: dataHex, descriptorType: "token", signatures: {} } }],
      [
        {
          descriptor: {
            data: "zz",
            descriptorType: "token",
            signatures: { prod: prodHex, test: "00" },
          },
        },
      ],
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- malformed bodies are checked one at a time
      await expect(calDescriptorSource({ fetch: fetchJson(body) })(request)).rejects.toThrow(/.+/);
    }
    const httpFailure = (async () =>
      new Response("[]", { status: 503 })) as typeof globalThis.fetch;
    await expect(calDescriptorSource({ fetch: httpFailure })(request)).rejects.toThrow("HTTP 503");
  });

  it("ignores unknown CAL fields", async () => {
    const body = [
      {
        extra: true,
        descriptor: {
          data: dataHex,
          descriptorType: "token",
          signatures: { prod: prodHex, test: "00", future: "aa" },
          future: 1,
        },
      },
    ];
    await expect(calDescriptorSource({ fetch: fetchJson(body) })(request)).resolves.toEqual({
      tokens: [expect.any(Uint8Array)],
    });
  });

  it("enforces maxBytes from Content-Length before reading", async () => {
    const fetchStub = (async () =>
      new Response("[]", { headers: { "content-length": "100" } })) as typeof globalThis.fetch;
    await expect(calDescriptorSource({ fetch: fetchStub, maxBytes: 99 })(request)).rejects.toThrow(
      "byte bound",
    );
  });

  it("enforces maxBytes while reading a streamed body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(60));
        controller.enqueue(new Uint8Array(60));
        controller.close();
      },
    });
    const fetchStub = (async () => new Response(body)) as typeof globalThis.fetch;
    await expect(calDescriptorSource({ fetch: fetchStub, maxBytes: 100 })(request)).rejects.toThrow(
      "byte bound",
    );
  });

  it("aborts a fetch that outlives the total timeout", async () => {
    const fetchStub = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as typeof globalThis.fetch;
    await expect(calDescriptorSource({ fetch: fetchStub, timeoutMs: 5 })(request)).rejects.toThrow(
      "timed out",
    );
  });
});

describe("bundleDescriptorSource", () => {
  it("serves every exact chain/address payload and nothing else", async () => {
    const source = bundleDescriptorSource({
      tokens: [{ chainId: 1, address: USDC, descriptor: payloadHex }],
    });
    const descriptors = await source(request);
    expect(descriptors?.tokens?.map(hex)).toStrictEqual([payloadHex]);
    const otherChain = { ...request, network: "eip155:8453" } as ChainSignRequest;
    await expect(source(otherChain)).resolves.toBeUndefined();
  });

  it("rejects non-hex bundle entries at construction", () => {
    expect(() =>
      bundleDescriptorSource({
        tokens: [{ chainId: 1, address: USDC, descriptor: "zz" }],
      }),
    ).toThrow("not hex");
  });
});
