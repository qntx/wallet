import { toCoinType } from "viem/ens";
import { describe, expect, it } from "vite-plus/test";

import { resolveEns } from "../src/names/ens.ts";
import { ccipRequest } from "../src/networks/controller.ts";
import type { NetworkInfo } from "../src/networks/registry.ts";

const ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const OTHER = "0x1111111111111111111111111111111111111111";

const info = (testnet: boolean, chainId: number): NetworkInfo => ({
  id: `eip155:${chainId}`,
  chainId,
  name: "t",
  symbol: "ETH",
  decimals: 18,
  family: "evm",
  testnet,
});

type Networks = Parameters<typeof resolveEns>[0];
type Lookup = Parameters<typeof resolveEns>[3];
type Call = { readonly name: string; readonly coinType: bigint };

const stubNetworks = (options: {
  readonly testnet: boolean;
  readonly chainId?: number;
  readonly independent?: "available" | "unavailable" | "not-needed";
  readonly seen?: string[];
}): Networks => {
  const independent = () => {
    if (options.independent === "available") {
      return { kind: "available" as const, client: { tag: "independent" } };
    }
    return options.independent === "unavailable"
      ? { kind: "unavailable" as const }
      : { kind: "not-needed" as const };
  };
  return {
    info: () => info(options.testnet, options.chainId ?? 1),
    ensClient: (network: string) => {
      options.seen?.push(network);
      return { tag: "primary" };
    },
    independentEnsClient: (network: string) => {
      options.seen?.push(`independent:${network}`);
      return independent();
    },
  } as never;
};

/** A scripted `getEnsAddress`: `answers` maps client tag → address, or records the call. */
const lookup =
  (answers: (client: unknown, coinType: bigint) => string | null, calls?: Call[]): Lookup =>
  async (client, params) => {
    calls?.push({ name: params.name, coinType: params.coinType ?? 0n });
    const answer = answers(client, params.coinType ?? 0n);
    return Promise.resolve(answer === null ? null : (answer as `0x${string}`));
  };

const tagOf = (client: unknown): string => (client as { tag: string }).tag;

const constant = (address: string | null) => (): string | null => address;

const byTag = (table: Readonly<Record<string, string>>) => {
  return (client: unknown): string | null => table[tagOf(client)] ?? null;
};

const byCoin = (table: Readonly<Record<string, string>>) => {
  return (_client: unknown, coinType: bigint): string | null => table[String(coinType)] ?? null;
};

const failOn = (tag: string, answer: string) => {
  return (client: unknown): string => {
    if (tagOf(client) === tag) {
      throw new Error("down");
    }
    return answer;
  };
};

describe("resolveEns", () => {
  it("normalizes, rejects invalid/dotless names, and picks the resolution network", async () => {
    const seen: string[] = [];
    const calls: Call[] = [];
    const r = await resolveEns(
      stubNetworks({ testnet: false, seen }),
      "Vitalik.ETH",
      "eip155:1",
      lookup(constant(ADDR), calls),
    );
    expect(r).toStrictEqual({ name: "vitalik.eth", address: ADDR, checks: [] });
    expect(seen).toStrictEqual(["eip155:1", "independent:eip155:1"]);
    const [first] = calls;
    expect(first).toStrictEqual({ name: "vitalik.eth", coinType: 60n });

    const testSeen: string[] = [];
    const tc: Call[] = [];
    await resolveEns(
      stubNetworks({ testnet: true, chainId: 11155111, seen: testSeen }),
      "a.eth",
      "eip155:11155111",
      lookup(constant(ADDR), tc),
    );
    const [firstSeen, firstCall] = [testSeen[0], tc[0]];
    expect(firstSeen).toBe("eip155:11155111");
    expect(firstCall?.coinType).toBe(toCoinType(11155111));

    await expect(
      resolveEns(
        stubNetworks({ testnet: false }),
        "not a name",
        "eip155:1",
        lookup(constant(ADDR)),
      ),
    ).rejects.toThrow("not a valid ENS name");
    await expect(
      resolveEns(stubNetworks({ testnet: false }), "nodot", "eip155:1", lookup(constant(ADDR))),
    ).rejects.toThrow("not an ENS name");
  });

  it("falls back to the ENSIP-19 default coin type and errors on no record", async () => {
    const calls: Call[] = [];
    const r = await resolveEns(
      stubNetworks({ testnet: false }),
      "b.eth",
      "eip155:1",
      lookup(byCoin({ "2147483648": ADDR }), calls),
    );
    expect(r.address).toBe(ADDR);
    expect(calls.map((c) => c.coinType)).toStrictEqual([60n, 0x80000000n]);

    await expect(
      resolveEns(stubNetworks({ testnet: false }), "gone.eth", "eip155:1", lookup(constant(null))),
    ).rejects.toThrow("does not resolve");
  });

  it("cross-checks the independent client: disagree refuses, unavailable flags", async () => {
    await expect(
      resolveEns(
        stubNetworks({ testnet: false, independent: "available" }),
        "c.eth",
        "eip155:1",
        lookup(byTag({ primary: ADDR, independent: OTHER })),
      ),
    ).rejects.toThrow("differently");

    const r = await resolveEns(
      stubNetworks({ testnet: false, independent: "unavailable" }),
      "c.eth",
      "eip155:1",
      lookup(constant(ADDR)),
    );
    expect(r.checks).toStrictEqual(["reads-unverified"]);

    const failed = await resolveEns(
      stubNetworks({ testnet: false, independent: "available" }),
      "c.eth",
      "eip155:1",
      lookup(failOn("independent", ADDR)),
    );
    expect(failed.checks).toStrictEqual(["reads-unverified"]);
  });
});

describe("ccipRequest", () => {
  const params = {
    data: "0xdeadbeef" as const,
    sender: "0xABcDef0000000000000000000000000000000000" as const,
    requestOptions: undefined,
  };
  const injected = (handler: (url: string, init?: RequestInit) => Response) => {
    const calls: string[] = [];
    const fetchFn = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return Promise.resolve(handler(url, init));
    };
    return { fetchFn, calls };
  };

  const mixedResponses = (url: string): Response => {
    if (url === "https://a") {
      return new Response("oops", { status: 500 });
    }
    if (url === "https://b") {
      return Response.json({ data: "not-hex" });
    }
    return new Response("0xcafe", { headers: { "content-type": "text/plain" } });
  };

  it("GETs a {data} template and POSTs the rest, lowercasing {sender}", async () => {
    const { fetchFn, calls } = injected(() => Response.json({ data: "0xabcd" }));
    const result = await ccipRequest(fetchFn)({
      ...params,
      urls: ["https://gw/{sender}/{data}", "https://post"],
    });
    expect(result).toBe("0xabcd");
    expect(calls).toStrictEqual([
      "GET https://gw/0xabcdef0000000000000000000000000000000000/0xdeadbeef",
    ]);

    const post = injected((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { data: string; sender: string };
      expect(body).toStrictEqual({
        data: "0xdeadbeef",
        sender: "0xABcDef0000000000000000000000000000000000",
      });
      return Response.json({ data: "0x99" });
    });
    await expect(ccipRequest(post.fetchFn)({ ...params, urls: ["https://post"] })).resolves.toBe(
      "0x99",
    );
  });

  it("accepts a 0x text body, skips non-2xx and non-hex answers, throws when all fail", async () => {
    const { fetchFn, calls } = injected(mixedResponses);
    await expect(
      ccipRequest(fetchFn)({ ...params, urls: ["https://a", "https://b", "https://c"] }),
    ).resolves.toBe("0xcafe");
    expect(calls).toHaveLength(3);

    await expect(
      ccipRequest(fetchFn)({ ...params, urls: ["https://a", "https://b"] }),
    ).rejects.toThrow("malformed");
  });

  it("uses the injected fetch only — the global fetch is never called", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => Promise.reject(new Error("global fetch must not be used"));
    try {
      await expect(
        ccipRequest(async (input) => Promise.resolve(Response.json({ data: "0x1", echo: input })))({
          ...params,
          urls: ["https://only-injected"],
        }),
      ).resolves.toBe("0x1");
    } finally {
      globalThis.fetch = original;
    }
  });
});
