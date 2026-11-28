// oxlint-disable vitest/no-conditional-in-test -- scripted endpoint answers vary by client
import { toCoinType } from "viem/ens";
import { describe, expect, it } from "vite-plus/test";

import { lookupEns, resolveEns } from "../src/names/ens.ts";
import type { EnsDeps } from "../src/names/ens.ts";
import type { NetworkInfo } from "../src/networks/registry.ts";

const ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const OTHER = "0x1111111111111111111111111111111111111111";
const DEFAULT_COIN = 0x80000000n;

const info = (
  testnet: boolean,
  chainId: number,
  family: NetworkInfo["family"] = "evm",
): NetworkInfo => ({
  id: `eip155:${chainId}`,
  chainId,
  name: "t",
  symbol: "ETH",
  decimals: 18,
  family,
  testnet,
});

type Networks = Parameters<typeof resolveEns>[0];
type GetAddress = NonNullable<EnsDeps["getEnsAddress"]>;
type GetName = NonNullable<EnsDeps["getEnsName"]>;
type Call = { readonly name: string; readonly coinType: bigint };

const stubNetworks = (options: {
  readonly testnet: boolean;
  readonly chainId?: number;
  readonly family?: NetworkInfo["family"];
  readonly independent?:
    | "available"
    | "unavailable"
    | "not-needed"
    | ReadonlyArray<"available" | "unavailable" | "not-needed">;
  readonly seen?: string[];
}): Networks => {
  let calls = 0;
  const independent = () => {
    const kind = Array.isArray(options.independent)
      ? (options.independent[calls] ?? "not-needed")
      : (options.independent ?? "not-needed");
    calls += 1;
    if (kind === "available") {
      return {
        kind: "available" as const,
        source: "host" as const,
        client: { tag: "independent" },
      };
    }
    return kind === "unavailable"
      ? { kind: "unavailable" as const }
      : { kind: "not-needed" as const };
  };
  return {
    info: () => info(options.testnet, options.chainId ?? 1, options.family ?? "evm"),
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

const tagOf = (client: unknown): string => (client as { tag: string }).tag;

/** A scripted `getEnsAddress`: `answers` maps the client and coin type to an address or null. */
const addresses =
  (answer: (client: unknown, coinType: bigint) => string | null, calls?: Call[]): GetAddress =>
  async (client, params) => {
    calls?.push({ name: params.name, coinType: params.coinType ?? 0n });
    return Promise.resolve(answer(client, params.coinType ?? 0n) as never);
  };

const names =
  (
    answer: (client: unknown) => string | null,
    calls?: Array<{ readonly address: string; readonly coinType: bigint }>,
  ): GetName =>
  async (client, params) => {
    calls?.push({ address: params.address, coinType: params.coinType ?? 0n });
    return Promise.resolve(answer(client));
  };

const constant = (address: string | null) => (): string | null => address;
const byTag = (table: Readonly<Record<string, string | null>>) => {
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
    const r = await resolveEns(stubNetworks({ testnet: false, seen }), "Vitalik.ETH", "eip155:1", {
      getEnsAddress: addresses(constant(ADDR), calls),
    });
    expect(r).toStrictEqual({ name: "vitalik.eth", address: ADDR, checks: [], risk: [] });
    expect(seen).toStrictEqual(["eip155:1", "independent:eip155:1"]);
    expect(calls[0]).toStrictEqual({ name: "vitalik.eth", coinType: 60n });

    const testSeen: string[] = [];
    await resolveEns(
      stubNetworks({ testnet: true, chainId: 11155111, seen: testSeen }),
      "a.eth",
      "eip155:11155111",
      { getEnsAddress: addresses(constant(ADDR)) },
    );
    expect(testSeen[0]).toBe("eip155:11155111");

    await expect(
      resolveEns(stubNetworks({ testnet: false }), "not a name", "eip155:1", {
        getEnsAddress: addresses(constant(ADDR)),
      }),
    ).rejects.toThrow("not a valid ENS name");
    await expect(
      resolveEns(stubNetworks({ testnet: false }), "nodot", "eip155:1", {
        getEnsAddress: addresses(constant(ADDR)),
      }),
    ).rejects.toThrow("not an ENS name");
  });

  it.each([
    { testnet: false, chainId: 1, first: 60n },
    { testnet: true, chainId: 11155111, first: 60n },
    { testnet: false, chainId: 8453, first: toCoinType(8453) },
  ])(
    "uses coin type $first on chain $chainId before the default",
    async ({ testnet, chainId, first }) => {
      const calls: Call[] = [];
      await resolveEns(stubNetworks({ testnet, chainId }), "coin.eth", `eip155:${chainId}`, {
        getEnsAddress: addresses(byCoin({ [String(DEFAULT_COIN)]: ADDR }), calls),
      });
      expect(calls.map((c) => c.coinType)).toStrictEqual([first, DEFAULT_COIN]);
    },
  );

  it("refuses a non-EVM network", async () => {
    await expect(
      resolveEns(
        stubNetworks({ testnet: false, family: "solana" }),
        "a.eth",
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        { getEnsAddress: addresses(constant(ADDR)) },
      ),
    ).rejects.toThrow("EVM");
  });

  it("falls back to the ENSIP-19 default coin type and errors on no record", async () => {
    const calls: Call[] = [];
    const r = await resolveEns(stubNetworks({ testnet: false }), "b.eth", "eip155:1", {
      getEnsAddress: addresses(byCoin({ [String(DEFAULT_COIN)]: ADDR }), calls),
    });
    expect(r.address).toBe(ADDR);
    expect(calls.map((c) => c.coinType)).toStrictEqual([60n, DEFAULT_COIN]);

    await expect(
      resolveEns(stubNetworks({ testnet: false }), "gone.eth", "eip155:1", {
        getEnsAddress: addresses(constant(null)),
      }),
    ).rejects.toThrow("does not resolve");
  });

  it("cross-checks the independent client: disagree refuses, unavailable flags", async () => {
    await expect(
      resolveEns(stubNetworks({ testnet: false, independent: "available" }), "c.eth", "eip155:1", {
        getEnsAddress: addresses(byTag({ primary: ADDR, independent: OTHER })),
      }),
    ).rejects.toThrow("differently");

    const unavailable = await resolveEns(
      stubNetworks({ testnet: false, independent: "unavailable" }),
      "c.eth",
      "eip155:1",
      { getEnsAddress: addresses(constant(ADDR)) },
    );
    expect(unavailable.checks).toStrictEqual(["reads-unverified"]);

    const failed = await resolveEns(
      stubNetworks({ testnet: false, independent: "available" }),
      "c.eth",
      "eip155:1",
      { getEnsAddress: addresses(failOn("independent", ADDR)) },
    );
    expect(failed.checks).toStrictEqual(["reads-unverified"]);
  });
});

describe("lookupEns", () => {
  const deps = (options: {
    readonly reverse?: (client: unknown) => string | null;
    readonly forward?: (client: unknown, coinType: bigint) => string | null;
  }): EnsDeps => ({
    getEnsAddress: addresses(options.forward ?? constant(ADDR)),
    getEnsName: names(options.reverse ?? constant("vitalik.eth")),
  });

  it("returns undefined when both endpoints answer null", async () => {
    await expect(
      lookupEns(stubNetworks({ testnet: false, independent: "available" }), ADDR, "eip155:1", {
        getEnsAddress: addresses(constant(OTHER)),
        getEnsName: names(constant(null)),
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when the independent reverse answer disagrees", async () => {
    await expect(
      lookupEns(
        stubNetworks({ testnet: false, independent: "available" }),
        ADDR,
        "eip155:1",
        deps({ reverse: byTag({ primary: "vitalik.eth", independent: "other.eth" }) }),
      ),
    ).rejects.toThrow("differs");
  });

  it("flags an independent reverse failure or unavailability and needs nothing when not-needed", async () => {
    const failed = await lookupEns(
      stubNetworks({ testnet: false, independent: "available" }),
      ADDR,
      "eip155:1",
      deps({
        reverse: (client) =>
          tagOf(client) === "independent"
            ? (() => {
                throw new Error("down");
              })()
            : "vitalik.eth",
      }),
    );
    expect(failed?.checks).toStrictEqual(["reads-unverified"]);

    const unavailable = await lookupEns(
      stubNetworks({ testnet: false, independent: "unavailable" }),
      ADDR,
      "eip155:1",
      deps({}),
    );
    expect(unavailable?.checks).toStrictEqual(["reads-unverified"]);

    const hostOnly = await lookupEns(stubNetworks({ testnet: false }), ADDR, "eip155:1", deps({}));
    expect(hostOnly?.checks).toStrictEqual([]);
  });

  it("does not show an unnormalized primary name", async () => {
    await expect(
      lookupEns(
        stubNetworks({ testnet: false }),
        ADDR,
        "eip155:1",
        deps({ reverse: constant("Vitalik.eth") }),
      ),
    ).resolves.toBeUndefined();
  });

  it("rethrows a forward-check endpoint disagreement", async () => {
    await expect(
      lookupEns(
        stubNetworks({ testnet: false, independent: ["available", "available"] }),
        ADDR,
        "eip155:1",
        deps({ forward: byTag({ primary: ADDR, independent: OTHER }) }),
      ),
    ).rejects.toThrow("differently");
  });

  it("does not show a name whose forward resolution mismatches or fails", async () => {
    await expect(
      lookupEns(
        stubNetworks({ testnet: false }),
        ADDR,
        "eip155:1",
        deps({ forward: constant(OTHER) }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      lookupEns(stubNetworks({ testnet: false }), ADDR, "eip155:1", {
        getEnsName: names(constant("vitalik.eth")),
        getEnsAddress: async () => Promise.reject(new Error("forward down")),
      }),
    ).resolves.toBeUndefined();
  });

  it("returns the EIP-55 input address with the union of reverse and forward checks", async () => {
    const r = await lookupEns(
      stubNetworks({ testnet: false, independent: ["available", "not-needed"] }),
      ADDR.toLowerCase(),
      "eip155:1",
      deps({
        reverse: (client) => {
          if (tagOf(client) === "independent") {
            throw new Error("down");
          }
          return "vitalik.eth";
        },
      }),
    );
    expect(r).toStrictEqual({
      name: "vitalik.eth",
      address: ADDR,
      checks: ["reads-unverified"],
      risk: [],
    });
  });
});

describe("assessName through resolution", () => {
  const resolve = async (name: string) =>
    resolveEns(stubNetworks({ testnet: false }), name, "eip155:1", {
      getEnsAddress: addresses(constant(ADDR)),
    });

  it("returns no findings for an ASCII name", async () => {
    const resolution = await resolve("vitalik.eth");
    expect(resolution.risk).toStrictEqual([]);
  });

  it("warns for a valid Unicode name", async () => {
    const resolution = await resolve("café.eth");
    expect(resolution.risk).toStrictEqual([{ code: "name-unicode", level: "warning" }]);
  });

  it("marks labels of two scripts as danger before the unicode warning", async () => {
    const resolution = await resolve("ξχ.д.eth");
    expect(resolution.risk).toStrictEqual([
      { code: "name-mixed-script", level: "danger" },
      { code: "name-unicode", level: "warning" },
    ]);
  });

  it("warns only once for an emoji name without a mixed script", async () => {
    const resolution = await resolve("😀.eth");
    expect(resolution.risk).toStrictEqual([{ code: "name-unicode", level: "warning" }]);
  });
});
