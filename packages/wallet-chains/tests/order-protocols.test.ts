/**
 * Order-protocols.json is probed live by scripts/vectors/order-protocols.ts: for every contract the
 * EVM decoders recognise it records on-chain code presence, the EIP-712 domain or domain separator
 * the contract exposes, and — for UniswapX reactors — its `permit2()` address. This suite asserts
 * every address in the decoder tables has a record with code present, and that any exposed domain
 * or separator equals the viem `hashDomain` of the domain the decoder checks.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hashDomain } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { GPV2_CHAINS, GPV2_SETTLEMENT } from "../src/evm/cow.ts";
import { V6_CHAINS, V6_ROUTER, V6_ZKSYNC_ROUTER } from "../src/evm/oneinch.ts";
import { REACTORS } from "../src/evm/uniswapx.ts";
import { RECOGNISED_FAMILIES } from "../src/families.ts";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

type Vector = {
  readonly label: string;
  readonly chainId: number;
  readonly address: string;
  readonly codePresent: boolean;
  readonly eip712Domain?: {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
    readonly verifyingContract: string;
  };
  readonly separator?: string;
  readonly permit2?: string;
  readonly permit2MatchesCanonical?: boolean;
};

const vectors = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../vectors/chains/order-protocols.json"),
    "utf8",
  ),
) as Vector[];

const record = (chainId: number, address: string): Vector | undefined =>
  vectors.find((v) => v.chainId === chainId && v.address.toLowerCase() === address.toLowerCase());

type ContractRow = {
  readonly family: string;
  readonly domainName?: string;
  readonly address: string;
};

const contractRows: ContractRow[] = [];
for (const family of RECOGNISED_FAMILIES) {
  if ("contracts" in family.claim) {
    for (const address of family.claim.contracts) {
      contractRows.push({ family: family.family, domainName: family.claim.domainName, address });
    }
  }
}

type ReactorRow = {
  readonly chainId: number;
  readonly witnessType: string;
  readonly address: string;
};
const reactorRows: ReactorRow[] = [];
for (const [chain, byType] of Object.entries(REACTORS)) {
  for (const [witnessType, address] of Object.entries(byType)) {
    reactorRows.push({ chainId: Number(chain), witnessType, address });
  }
}

const DOMAIN_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
} as const;

const v6Domain = (chainId: number, router: string) =>
  hashDomain({
    domain: {
      name: "1inch Aggregation Router",
      version: "6",
      chainId: BigInt(chainId),
      verifyingContract: router as `0x${string}`,
    },
    types: DOMAIN_TYPES,
  });

const cowDomain = (chainId: number) =>
  hashDomain({
    domain: {
      name: "Gnosis Protocol",
      version: "v2",
      chainId: BigInt(chainId),
      verifyingContract: GPV2_SETTLEMENT,
    },
    types: DOMAIN_TYPES,
  });

const missingContracts = contractRows
  .filter(
    (row) =>
      !vectors.some((v) => v.address.toLowerCase() === row.address.toLowerCase() && v.codePresent),
  )
  .map((row) => `${row.family} ${row.address}`);

const badV6Separators = vectors
  .filter((v) => v.address.toLowerCase() === V6_ROUTER.toLowerCase() && v.separator !== undefined)
  .filter((v) => v.separator !== v6Domain(v.chainId, V6_ROUTER));

const badCowSeparators = vectors
  .filter(
    (v) => v.address.toLowerCase() === GPV2_SETTLEMENT.toLowerCase() && v.separator !== undefined,
  )
  .filter((v) => v.separator !== cowDomain(v.chainId));

const badReactors = reactorRows
  .filter((row) => {
    const v = record(row.chainId, row.address);
    return v === undefined || !v.codePresent || v.permit2?.toLowerCase() !== PERMIT2.toLowerCase();
  })
  .map((row) => `${row.chainId} ${row.witnessType} ${row.address}`);

const mismatchedDomains = contractRows
  .filter((row) => row.domainName !== undefined)
  .flatMap((row) =>
    vectors
      .filter(
        (v) =>
          v.address.toLowerCase() === row.address.toLowerCase() &&
          v.eip712Domain !== undefined &&
          v.eip712Domain.name !== row.domainName,
      )
      .map((v) => `${row.family} ${v.address} on ${v.chainId} is "${v.eip712Domain?.name}"`),
  );

describe("order-protocols vectors", () => {
  it("every claim contracts address has a deployment with code present", () => {
    expect(missingContracts).toStrictEqual([]);
  });

  it.each([...V6_CHAINS])("the 1inch v6 router has code on chain %i", (chainId) => {
    expect(record(chainId, V6_ROUTER)?.codePresent).toBe(true);
  });

  it("the 1inch v6 zkSync router has code on chain 324", () => {
    expect(record(324, V6_ZKSYNC_ROUTER)?.codePresent).toBe(true);
  });

  it("every separator a v6 router exposes hashes its decoder domain", () => {
    expect(badV6Separators).toStrictEqual([]);
  });

  it.each([...GPV2_CHAINS])("the CoW settlement has code on chain %i", (chainId) => {
    expect(record(chainId, GPV2_SETTLEMENT)?.codePresent).toBe(true);
  });

  it("every separator the CoW settlement exposes hashes its decoder domain", () => {
    expect(badCowSeparators).toStrictEqual([]);
  });

  it("every reactor has code and the canonical Permit2", () => {
    expect(badReactors).toStrictEqual([]);
  });

  it("an exposed eip712Domain names the family's domain name", () => {
    expect(mismatchedDomains).toStrictEqual([]);
  });
});
