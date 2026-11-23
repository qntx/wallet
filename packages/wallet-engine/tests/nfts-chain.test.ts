import { readFileSync } from "node:fs";

import { base64 } from "@scure/base";
/**
 * Solana chain-side NFT reads against the real mainnet accounts recorded in
 * fixtures/nfts/solana-mainnet-accounts.json: mint, Metaplex metadata and ATA bytes as
 * getAccountInfo answered them.
 */
import { describe, expect, it } from "vite-plus/test";

import { associatedTokenAddress, PROGRAM_IDS } from "@qntx/wallet-chains/solana";

import {
  metaplexTokenStandard,
  parseMint,
  parseTokenAccount,
  solanaNftBalance,
} from "../src/chains/nfts.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";

type Section = {
  readonly mint: { readonly address: string; readonly response: { readonly value: unknown } };
  readonly metadata: { readonly address: string; readonly response: { readonly value: unknown } };
  readonly ata: { readonly address: string; readonly response: { readonly value: unknown } };
};

const fixture = JSON.parse(
  readFileSync(new URL("fixtures/nfts/solana-mainnet-accounts.json", import.meta.url), "utf8"),
) as {
  readonly owner: string;
  readonly rpc: string;
  readonly plain: Section;
  readonly programmable: Section;
  readonly frozen: Section;
};

const OWNER = fixture.owner;
const TOKEN = PROGRAM_IDS.token;

const bytes = (response: { readonly value: unknown }): Uint8Array => {
  const value = response.value as { readonly data: [string, string] };
  return base64.decode(value.data[0]);
};

/** A fake SolanaRpc answering getAccountInfo from the fixture, anything else absent. */
const rpcFor = (sections: ReadonlyArray<Section>): SolanaRpc & { calls: string[] } => {
  const calls: string[] = [];
  const responses = new Map<string, unknown>();
  for (const section of sections) {
    responses.set(section.mint.address, section.mint.response);
    responses.set(section.ata.address, section.ata.response);
  }
  return {
    calls,
    call: async (method: string, params: unknown[]) => {
      calls.push(`${method} ${String(params[0])}`);
      if (method === "getAccountInfo") {
        return Promise.resolve(responses.get(String(params[0])) ?? { value: null });
      }
      return Promise.reject(new Error(`unmocked ${method}`));
    },
  };
};

describe("solana chain reads over real mainnet accounts", () => {
  it("parses the mint bytes: supply 1, decimals 0, initialized", () => {
    for (const section of [fixture.plain, fixture.programmable, fixture.frozen]) {
      expect(parseMint(bytes(section.mint.response))).toStrictEqual({
        supply: 1n,
        decimals: 0,
        initialized: true,
      });
    }
    expect(parseMint(new Uint8Array(81))).toBeUndefined();
  });

  it("walks the Metaplex metadata to its token_standard", () => {
    expect(
      metaplexTokenStandard(bytes(fixture.plain.metadata.response), fixture.plain.mint.address),
    ).toBe(0);
    expect(
      metaplexTokenStandard(
        bytes(fixture.programmable.metadata.response),
        fixture.programmable.mint.address,
      ),
    ).toBe(4);
    expect(
      metaplexTokenStandard(
        bytes(fixture.plain.metadata.response),
        fixture.programmable.mint.address,
      ),
    ).toBeUndefined();
    expect(metaplexTokenStandard(new Uint8Array(10), fixture.plain.mint.address)).toBeUndefined();
  });

  it("derives each mint's real ATA and parses it", () => {
    for (const [name, state] of [
      ["plain", "initialized"],
      ["programmable", "frozen"],
      ["frozen", "frozen"],
    ] as const) {
      const section = fixture[name];
      expect(associatedTokenAddress(OWNER, section.mint.address, TOKEN)).toBe(section.ata.address);
      const parsed = parseTokenAccount(bytes(section.ata.response), TOKEN);
      expect(parsed?.mint).toBe(section.mint.address);
      expect(parsed?.owner).toBe(OWNER);
      expect(parsed?.amount).toBe(1n);
      expect(parsed?.state).toBe(state);
    }
  });

  it("reads the holder's balance through mint + ATA, 0 for another owner", async () => {
    const rpc = rpcFor([fixture.plain, fixture.programmable, fixture.frozen]);
    for (const section of [fixture.plain, fixture.programmable, fixture.frozen]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each section's calls are asserted before the next read
      await expect(solanaNftBalance(rpc, section.mint.address, OWNER)).resolves.toBe(1n);
      // mint read + ATA read — nothing else.
      expect(rpc.calls.splice(-2).every((c) => c.startsWith("getAccountInfo"))).toBe(true);
    }
    await expect(
      solanaNftBalance(rpc, fixture.plain.mint.address, "11111111111111111111111111111111"),
    ).resolves.toBe(0n);
  });

  it("reads 0 for an asset that does not exist or sits under an unrelated program", async () => {
    const rpc = rpcFor([]);
    await expect(solanaNftBalance(rpc, fixture.plain.mint.address, OWNER)).resolves.toBe(0n);
  });
});
