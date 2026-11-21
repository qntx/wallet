/** Every entry of the built-in TRON token table is a valid address on a TRON network. */
import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_NETWORKS } from "../src/networks.ts";
import { isTronAddress } from "../src/tron/address.ts";
import { TRON_NETWORKS } from "../src/tron/index.ts";
import { lookupTronToken, tronTokenTable } from "../src/tron/tokens.ts";

const DECIMALS: Readonly<Record<string, number>> = {
  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: 6, // USDT
  TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz: 18, // USDD
  TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4: 18, // TUSD
  TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR: 6, // WTRX
  TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9: 18, // JST
  TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S: 18, // SUN
  TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4: 18, // BTT
  TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7: 6, // WIN
  TFczxzPhnThNSqr5by8tvxsdCFRRz6cPNq: 6, // NFT
  TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf: 6, // Nile USDT
};

describe("tronTokenTable", () => {
  it("every key is a TRON network in BUILT_IN_NETWORKS", () => {
    for (const network of Object.keys(tronTokenTable)) {
      expect(TRON_NETWORKS).toContain(network);
      expect(BUILT_IN_NETWORKS.find((n) => n.id === network)?.family).toBe("tron");
    }
  });

  it("every entry is a valid TRON address with the table's decimals", () => {
    for (const [network, tokens] of Object.entries(tronTokenTable)) {
      for (const [address, token] of Object.entries(tokens)) {
        expect(isTronAddress(address)).toBe(true);
        expect(token.decimals).toBe(DECIMALS[address]);
        expect(lookupTronToken(tronTokenTable, network, address)).toBe(token);
      }
    }
  });

  it("has no USDC entry", () => {
    const all = Object.values(tronTokenTable).flatMap((t) => Object.keys(t));
    expect(all).not.toContain("TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8");
  });
});
