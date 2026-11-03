/**
 * `verifySolanaSignature` re-checks the kernel's ed25519 signature against the account address —
 * valid verifies, a wrong key, a tampered message or a wrong length fails closed.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { getAddressDecoder } from "@solana/addresses";
import { describe, expect, it } from "vite-plus/test";

import { signSolanaMessage } from "../src/solana/sign.ts";
import { verifySolanaSignature } from "../src/solana/verify.ts";

const SEED = new Uint8Array(32).fill(9);
const MESSAGE = new TextEncoder().encode("pay 21 sats");
const addressOf = (seed: Uint8Array): string =>
  getAddressDecoder().decode(ed25519.getPublicKey(seed));

describe("verifySolanaSignature", () => {
  it("verifies a signature made by the address's key", () => {
    const addr = addressOf(SEED);
    const sig = signSolanaMessage(MESSAGE, SEED);
    expect(verifySolanaSignature(MESSAGE, sig, addr)).toBe(true);
  });

  it("rejects a signature made by a different key", () => {
    const other = new Uint8Array(32).fill(4);
    const addr = addressOf(other);
    const sig = signSolanaMessage(MESSAGE, SEED);
    expect(verifySolanaSignature(MESSAGE, sig, addr)).toBe(false);
  });

  it("rejects a tampered message", () => {
    const addr = addressOf(SEED);
    const sig = signSolanaMessage(MESSAGE, SEED);
    expect(verifySolanaSignature(new TextEncoder().encode("pay 22 sats"), sig, addr)).toBe(false);
  });

  it("rejects wrong signature lengths and a malformed address", () => {
    const addr = addressOf(SEED);
    const sig = signSolanaMessage(MESSAGE, SEED);
    expect(verifySolanaSignature(MESSAGE, sig.slice(0, 63), addr)).toBe(false);
    expect(verifySolanaSignature(MESSAGE, new Uint8Array(65), addr)).toBe(false);
    expect(verifySolanaSignature(MESSAGE, sig, "not-an-address")).toBe(false);
  });
});
