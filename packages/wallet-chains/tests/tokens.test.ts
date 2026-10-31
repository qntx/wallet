import { describe, expect, it } from "vite-plus/test";

import { checksumEvmAddress } from "../src/evm/address.ts";
import { evmTokenTable } from "../src/evm/tokens.ts";
import { isSolanaAddress } from "../src/solana/index.ts";
import { solanaTokenTable } from "../src/solana/tokens.ts";

const evmEntries = Object.entries(evmTokenTable).flatMap(([chainId, tokens]) =>
  Object.entries(tokens).map(([address, token]) => ({ chainId, address, token })),
);
const solanaEntries = Object.entries(solanaTokenTable).flatMap(([network, tokens]) =>
  Object.entries(tokens).map(([mint, token]) => ({ network, mint, token })),
);

describe("built-in token tables", () => {
  it.each(evmEntries)("EVM $chainId $address is keyed by its EIP-55 form", ({ address }) => {
    expect(checksumEvmAddress(address)).toBe(address);
  });

  it.each(evmEntries)("EVM $chainId $address has sane metadata", ({ token }) => {
    expect(token.symbol).toMatch(/^[A-Z0-9.]{2,11}$/);
    expect(Number.isInteger(token.decimals)).toBe(true);
    expect(token.decimals).toBeGreaterThanOrEqual(0);
    expect(token.decimals).toBeLessThanOrEqual(36);
  });

  it.each(solanaEntries)("Solana $network $mint is a valid address", ({ mint, token }) => {
    expect(isSolanaAddress(mint)).toBe(true);
    expect(Number.isInteger(token.decimals)).toBe(true);
    expect(token.decimals).toBeLessThanOrEqual(18);
  });

  it("tables are frozen", () => {
    expect(Object.isFrozen(evmTokenTable)).toBe(true);
    expect(Object.isFrozen(solanaTokenTable)).toBe(true);
    expect(evmEntries.every(({ chainId }) => Object.isFrozen(evmTokenTable[chainId]))).toBe(true);
  });
});
