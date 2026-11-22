/**
 * PoC for finding F-1: the Fiat24 grant preimage `label + deadline` is re-splittable. The label
 * already ends in the deadline digits, so the server-side concat of the client-chosen `hash` and
 * `deadline` headers yields the same bytes for many (hash, deadline) pairs — the signature cannot
 * be bound to one deadline. Asserts the CURRENT permissive construction; a fix that hashes the
 * boundary (e.g. a length prefix) makes these unequal and fails this test.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { fiat24SessionMessage } from "../../src/evm/index.ts";

/* The verifier's reconstruction: "I agree to access my profile. " + hex keccak of the
   concatenation of the two client-chosen header values. */
const serverMessage = (hash: string, deadline: string): string =>
  `I agree to access my profile. 0x${bytesToHex(keccak_256(utf8ToBytes(hash + deadline)))}`;

const CHAIN = 42161;

describe("Fiat24 session deadline split", () => {
  const TOKEN = "123456";
  const DEADLINE = 1795278000;
  const LABEL = `fiat24-session-v1:${String(CHAIN)}:${TOKEN}:${String(DEADLINE)}`;

  it("the signed message is identical under arbitrary (hash, deadline) splits", () => {
    const message = fiat24SessionMessage(CHAIN, TOKEN, DEADLINE);
    /* The honest reading: `hash` carries the full label, `deadline` is the real one. */
    expect(message).toBe(serverMessage(LABEL, String(DEADLINE)));
    /* Re-split inside the duplicated digits: `deadline` is now ~7.95e18 — inside a signed
       64-bit integer but ~2.5e11 years out — while `hash` looks truncated. Same bytes. */
    const shifted = "7952780001795278000";
    expect(BigInt(shifted)).toBeGreaterThan(2n ** 62n);
    expect(BigInt(shifted)).toBeLessThan(2n ** 63n);
    expect(message).toBe(serverMessage(`fiat24-session-v1:${String(CHAIN)}:${TOKEN}:1`, shifted));
    /* Split all the way: an empty-tail `hash` and a doubled `deadline`. Same bytes again. */
    expect(message).toBe(
      serverMessage(`fiat24-session-v1:${String(CHAIN)}:${TOKEN}:`, "17952780001795278000"),
    );
  });

  it("a second account reproduces the same ambiguity", () => {
    const deadline = 1795305600;
    const message = fiat24SessionMessage(CHAIN, "1", deadline);
    expect(message).toBe(
      serverMessage(`fiat24-session-v1:${String(CHAIN)}:1:1`, "7953056001795305600"),
    );
    expect(message).toBe(
      serverMessage(`fiat24-session-v1:${String(CHAIN)}:1:${String(deadline)}`, String(deadline)),
    );
  });
});
