/**
 * EIP-3009 authorization documents from the ERC-7730 registry test corpus: docs at listed USDC
 * deployments are claimed and near-miss blind; the same shapes on unlisted tokens decode as
 * unclaimed leaves whose bytes32 nonce makes them a blind commitment.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../../src/evm/index.ts";
import type { SignRequest } from "../../src/index.ts";

const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;

type FixtureDoc = {
  origin: string;
  description: string;
  data: {
    domain: { chainId: number };
    message: Record<string, unknown>;
  };
};

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/eip3009.json"), "utf8"),
) as { source: string; docs: FixtureDoc[] };

const LISTED_USDC = new Set([
  "8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831",
]);

const listedUsdc = (entry: FixtureDoc): boolean => {
  const domain = entry.data.domain as { chainId: number; verifyingContract?: string };
  return LISTED_USDC.has(`${domain.chainId}:${String(domain.verifyingContract).toLowerCase()}`);
};

const cases = fixture.docs.map((entry) => ({
  entry,
  signer: String(entry.data.message["from"] ?? entry.data.message["authorizer"]),
  expectedBlind: listedUsdc(entry) ? "typed-data-variant" : "typed-data-commitment",
}));

describe("EIP-3009 documents from the ERC-7730 registry corpus", () => {
  it.each(cases)(
    "$entry.description ($entry.data.primaryType)",
    ({ entry, signer, expectedBlind }) => {
      const request: SignRequest = {
        kind: "evm.typed-data",
        network: `eip155:${entry.data.domain.chainId}`,
        account: ACCOUNT,
        typedData: JSON.stringify(entry.data),
      };
      const intent = decodeEvm(request, signer);
      expect(intent.blind).toBe(expectedBlind);
      expect(intent.verifiability).toBe("opaque");
      expect(intent.summary).toBe("message");
    },
  );
});
