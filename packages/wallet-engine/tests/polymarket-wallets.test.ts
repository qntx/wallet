import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

/**
 * Account-wallet derivation against the on-chain oracle vectors
 * (vectors/chains/polymarket-wallets.json — real proxy_wallets whose owners were read at a pinned
 * block and classified by which CREATE2 derivation reproduces them) and the relayer `/deployed`
 * locate priority via an injected fetch.
 */
import { PolymarketError } from "../src/apps/polymarket/errors.ts";
import { createPolymarketHttp } from "../src/apps/polymarket/http.ts";
import {
  createPolymarketWallets,
  derivePolymarketWallets,
  expectedPolymarketWalletRuntime,
} from "../src/apps/polymarket/wallets.ts";
import { networksStub, pmChainCode, rpcStub } from "./apps-helpers.ts";

type WalletVector = {
  readonly owner: `0x${string}`;
  readonly wallet: string;
  readonly kind: "beacon" | "uups" | "safe";
  readonly code: string;
  readonly codeLength: number;
  readonly block: number;
};

const ORACLE = JSON.parse(
  readFileSync(new URL("../../../vectors/chains/polymarket-wallets.json", import.meta.url), "utf8"),
) as { vectors: WalletVector[]; unmatched: ReadonlyArray<unknown>; block: number };

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const KINDS = ["beacon", "uups", "safe"] as const;

/** A value that must exist — throws a plain Error, failing the test. */
const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("required value is missing");
  }
  return value;
};

describe("polymarket wallet derivation", () => {
  it("has at least four oracle pairs per kind", () => {
    const counts = { beacon: 0, uups: 0, safe: 0 };
    for (const vector of ORACLE.vectors) {
      counts[vector.kind] += 1;
    }
    expect(counts.beacon).toBeGreaterThanOrEqual(4);
    expect(counts.uups).toBeGreaterThanOrEqual(4);
    expect(counts.safe).toBeGreaterThanOrEqual(4);
  });

  it("every oracle vector derives its wallet from its owner — and no other kind collides", () => {
    for (const vector of ORACLE.vectors) {
      const derived = derivePolymarketWallets(vector.owner);
      expect(eq(derived[vector.kind], vector.wallet)).toBe(true);
      const others = KINDS.filter((kind) => kind !== vector.kind);
      expect(others.map((kind) => derived[kind].toLowerCase())).not.toContain(
        vector.wallet.toLowerCase(),
      );
    }
  });

  it("the expected runtime reproduces each deposit-wallet vector's on-chain code exactly", () => {
    /* The oracle is the chain itself: locate's template check must accept exactly the bytes a
       real deposit wallet carries — and nothing else. */
    const deposit = ORACLE.vectors.filter(
      (vector): vector is WalletVector & { kind: "beacon" | "uups" } => vector.kind !== "safe",
    );
    expect(deposit.length).toBeGreaterThan(0);
    for (const vector of deposit) {
      expect(expectedPolymarketWalletRuntime(vector.kind, vector.owner).toLowerCase()).toBe(
        vector.code.toLowerCase(),
      );
    }
  });

  it("every Safe vector carries non-empty on-chain code", () => {
    for (const vector of ORACLE.vectors.filter((v) => v.kind === "safe")) {
      expect(vector.code.length).toBeGreaterThan(2);
    }
  });

  it("unmatched wallets stay unmatched — the formulas must not silently widen", () => {
    /* The unmatched list holds proxy/Magic wallets the BIP-44 derivations never cover. */
    for (const vector of ORACLE.unmatched) {
      expect(vector).toBeTypeOf("object");
    }
  });

  it("rejects a malformed signer", () => {
    for (const bad of ["0x1234", "not-an-address", `0x${"0".repeat(41)}`]) {
      let caught: unknown;
      try {
        derivePolymarketWallets(bad as `0x${string}`);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PolymarketError);
      expect(caught).toMatchObject({ category: "invalid-input" });
    }
  });
});

type Probe = { address: string; type: string };
type DeployedKey = readonly ["WALLET" | "SAFE", `0x${string}`];

/** A deployed set as "TYPE:address" entries — the locate predicates, declaratively. */
const deployedSet = (
  ...entries: ReadonlyArray<DeployedKey>
): ((address: string, type: string) => { deployed: boolean }) => {
  const set = new Set(entries.map(([type, address]) => `${type}:${address.toLowerCase()}`));
  return (address, type) => ({ deployed: set.has(`${type}:${address.toLowerCase()}`) });
};

/** A fetch that answers the relayer probe by lookup — records every (address, type) it sees. */
const relayerFetch =
  (
    answerFor: (address: string, type: string) => { deployed: boolean },
    probes: Probe[],
  ): typeof globalThis.fetch =>
  async (input) => {
    await Promise.resolve();
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.pathname !== "/deployed") {
      throw new Error(`unexpected request ${url.toString()}`);
    }
    const address = url.searchParams.get("address") ?? "";
    const type = url.searchParams.get("type") ?? "SAFE";
    probes.push({ address, type });
    return Response.json(answerFor(address, type));
  };

const SIGNER = "0x385da51bc3cb1a0b0be7a2f5ea04b7b2ec5f4f8d" as `0x${string}`;

const locate = async (
  answerFor: (address: string, type: string) => { deployed: boolean },
  networks: ReturnType<typeof networksStub> = networksStub(
    pmChainCode((a, t) => answerFor(a, t).deployed, SIGNER),
  ),
): Promise<{
  account: Awaited<ReturnType<ReturnType<typeof createPolymarketWallets>["locate"]>>;
  probes: Array<{ address: string; type: string }>;
  candidates: ReturnType<typeof derivePolymarketWallets>;
}> => {
  const probes: Array<{ address: string; type: string }> = [];
  const http = createPolymarketHttp({
    fetch: relayerFetch(answerFor, probes),
    setTimer: () => () => undefined,
    now: () => 1_800_000_000_000,
  });
  const wallets = createPolymarketWallets(http, networks);
  return {
    account: await wallets.locate(SIGNER),
    probes,
    candidates: wallets.derive(SIGNER),
  };
};

describe("polymarket locate", () => {
  it("a deployed UUPS wins over beacon and Safe — legacySafe recorded", async () => {
    const candidates = derivePolymarketWallets(SIGNER);
    const { account } = await locate(
      deployedSet(
        ["WALLET", candidates.uups],
        ["WALLET", candidates.beacon],
        ["SAFE", candidates.safe],
      ),
    );
    expect(account.wallet).toBe(candidates.uups);
    expect(account.kind).toBe("deposit-wallet");
    expect(account.deployed).toBe(true);
    expect(account.legacySafe).toBe(candidates.safe);
  });

  it("a deployed beacon wins when no UUPS exists — legacySafe recorded", async () => {
    const candidates = derivePolymarketWallets(SIGNER);
    const { account } = await locate(
      deployedSet(["WALLET", candidates.beacon], ["SAFE", candidates.safe]),
    );
    expect(account.wallet).toBe(candidates.beacon);
    expect(account.kind).toBe("deposit-wallet");
    expect(account.deployed).toBe(true);
    expect(account.legacySafe).toBe(candidates.safe);
  });

  it("a deployed UUPS without a Safe carries no legacySafe", async () => {
    const candidates = derivePolymarketWallets(SIGNER);
    const { account } = await locate(deployedSet(["WALLET", candidates.uups]));
    expect(account.wallet).toBe(candidates.uups);
    expect(account.deployed).toBe(true);
    expect(account.legacySafe).toBeUndefined();
  });

  it("a deployed beacon alone wins with no legacySafe", async () => {
    const candidates = derivePolymarketWallets(SIGNER);
    const { account } = await locate(deployedSet(["WALLET", candidates.beacon]));
    expect(account.wallet).toBe(candidates.beacon);
    expect(account.legacySafe).toBeUndefined();
  });

  it("only a deployed Safe resolves to kind safe", async () => {
    const candidates = derivePolymarketWallets(SIGNER);
    const { account } = await locate(deployedSet(["SAFE", candidates.safe]));
    expect(account.wallet).toBe(candidates.safe);
    expect(account.kind).toBe("safe");
    expect(account.deployed).toBe(true);
  });

  it("nothing deployed resolves to the undeployed beacon address", async () => {
    const { account, candidates } = await locate(deployedSet());
    expect(account.wallet).toBe(candidates.beacon);
    expect(account.kind).toBe("deposit-wallet");
    expect(account.deployed).toBe(false);
    expect(account.legacySafe).toBeUndefined();
  });

  it("the probes are exactly the two WALLET candidates and the SAFE", async () => {
    const { probes, candidates } = await locate(deployedSet());
    expect(probes).toStrictEqual([
      { address: candidates.uups, type: "WALLET" },
      { address: candidates.beacon, type: "WALLET" },
      { address: candidates.safe, type: "SAFE" },
    ]);
  });

  it("replays the recorded relayer answers", async () => {
    const fixture = (name: string): { response: { deployed: boolean } } =>
      JSON.parse(
        readFileSync(new URL(`fixtures/polymarket/${name}.json`, import.meta.url), "utf8"),
      ) as { response: { deployed: boolean } };
    const deployed = fixture("relayer-deployed");
    const undeployed = fixture("relayer-undeployed");
    const candidates = derivePolymarketWallets(SIGNER);
    const replay = new Map([
      [`WALLET:${candidates.uups.toLowerCase()}`, undeployed.response],
      [`WALLET:${candidates.beacon.toLowerCase()}`, deployed.response],
      [`SAFE:${candidates.safe.toLowerCase()}`, undeployed.response],
    ]);
    const { account } = await locate((address, type) =>
      required(replay.get(`${type}:${address.toLowerCase()}`)),
    );
    expect(account.wallet).toBe(candidates.beacon);
    expect(account.deployed).toBe(true);
  });
});

/** An address → code table as a lookup fn — "0x" for any address not listed. */
const codeTable = (
  ...entries: ReadonlyArray<readonly [`0x${string}`, string]>
): ((address: string) => string) => {
  const map = new Map(entries.map(([a, c]) => [a.toLowerCase(), c]));
  return (address) => map.get(address.toLowerCase()) ?? "0x";
};

/* locate must not let the unauthenticated relayer choose the deposit target: it proves each
   candidate's deployment on-chain (eth_getCode, cross-checked with the host endpoint when one
   is configured) and refuses to pick anything when the evidence disagrees. */
describe("polymarket locate chain verification", () => {
  it("a relayer-deployed UUPS with no code on-chain is a mismatch, not a target", async () => {
    const candidates = derivePolymarketWallets(SIGNER);
    await expect(
      locate(
        deployedSet(["WALLET", candidates.uups]),
        networksStub(() => "0x"),
      ),
    ).rejects.toMatchObject({ category: "deployment-mismatch" });
  });

  it("code at the UUPS candidate that is not the expected template is a mismatch", async () => {
    const candidates = derivePolymarketWallets(SIGNER);
    await expect(
      locate(
        deployedSet(["WALLET", candidates.uups]),
        networksStub(codeTable([candidates.uups, "0x6001600155"])),
      ),
    ).rejects.toMatchObject({ category: "deployment-mismatch" });
  });

  it("code at the beacon candidate that is not the expected template is a mismatch", async () => {
    const candidates = derivePolymarketWallets(SIGNER);
    await expect(
      locate(
        deployedSet(["WALLET", candidates.beacon]),
        networksStub(codeTable([candidates.beacon, "0xdeadbeef"])),
      ),
    ).rejects.toMatchObject({ category: "deployment-mismatch" });
  });

  it("chain-deployed but relayer-undeployed is a mismatch", async () => {
    const candidates = derivePolymarketWallets(SIGNER);
    await expect(
      locate(
        deployedSet(),
        networksStub(codeTable([candidates.uups, expectedPolymarketWalletRuntime("uups", SIGNER)])),
      ),
    ).rejects.toMatchObject({ category: "deployment-mismatch" });
  });

  it("a host endpoint answering different code is a mismatch", async () => {
    const candidates = derivePolymarketWallets(SIGNER);
    const primary = pmChainCode((a) => a === candidates.beacon.toLowerCase(), SIGNER);
    await expect(
      locate(
        deployedSet(["WALLET", candidates.beacon]),
        networksStub(primary, { kind: "available", source: "host", client: rpcStub(() => "0x") }),
      ),
    ).rejects.toMatchObject({ category: "deployment-mismatch" });
  });

  it("a host endpoint answering the same bytes in another case is not a mismatch", async () => {
    const candidates = derivePolymarketWallets(SIGNER);
    const primary = pmChainCode((a) => a === candidates.beacon.toLowerCase(), SIGNER);
    const upper = codeTable([
      candidates.beacon,
      expectedPolymarketWalletRuntime("beacon", SIGNER).toUpperCase().replace("0X", "0x"),
    ]);
    const { account } = await locate(
      deployedSet(["WALLET", candidates.beacon]),
      networksStub(primary, { kind: "available", source: "host", client: rpcStub(upper) }),
    );
    expect(account.wallet).toBe(candidates.beacon);
  });

  it("a host read that throws fails closed as unavailable", async () => {
    const candidates = derivePolymarketWallets(SIGNER);
    const primary = pmChainCode((a) => a === candidates.beacon.toLowerCase(), SIGNER);
    const throwing = {
      transport: {
        request: async () => {
          await Promise.resolve();
          throw new Error("host down");
        },
      },
    };
    await expect(
      locate(
        deployedSet(["WALLET", candidates.beacon]),
        networksStub(primary, { kind: "available", source: "host", client: throwing as never }),
      ),
    ).rejects.toMatchObject({ category: "unavailable" });
  });

  it.each([{ kind: "not-needed" as const }, { kind: "unavailable" as const }])(
    "a host endpoint that is $kind leaves the primary chain read authoritative",
    async (independent) => {
      const candidates = derivePolymarketWallets(SIGNER);
      const { account } = await locate(
        deployedSet(["WALLET", candidates.beacon]),
        networksStub(
          pmChainCode((a) => a === candidates.beacon.toLowerCase(), SIGNER),
          independent,
        ),
      );
      expect(account.wallet).toBe(candidates.beacon);
      expect(account.deployed).toBe(true);
    },
  );

  it("uppercase chain code still matches the expected runtime", async () => {
    const candidates = derivePolymarketWallets(SIGNER);
    const { account } = await locate(
      deployedSet(["WALLET", candidates.uups]),
      networksStub(
        codeTable([
          candidates.uups,
          expectedPolymarketWalletRuntime("uups", SIGNER).toUpperCase().replace("0X", "0x"),
        ]),
      ),
    );
    expect(account.wallet).toBe(candidates.uups);
    expect(account.deployed).toBe(true);
  });
});
