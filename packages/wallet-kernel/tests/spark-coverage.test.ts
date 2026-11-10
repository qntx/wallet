/**
 * Spark approval coverage: an approved receiver amount bounds the sum of every output paid to that
 * receiver, never each output on its own.
 */
import { describe, expect, it } from "vite-plus/test";

import { tokenOutputsCovered, transferCovered } from "../src/modules/spark/index.ts";

const key = (fill: number): Uint8Array => new Uint8Array(33).fill(fill);
const SELF = key(1);
const BOB = key(2);
const CAROL = key(3);
const TOKEN = new Uint8Array(32).fill(9);
const OTHER_TOKEN = new Uint8Array(32).fill(8);

const intent = (amount: string) => ({
  kind: "token" as const,
  tokenIdentifier: TOKEN,
  receivers: [{ ownerPublicKey: BOB, amount }],
});

const output = (owner: Uint8Array, amount: bigint, tokenIdentifier = TOKEN) => ({
  ownerPublicKey: owner,
  tokenIdentifier,
  amount,
});

describe("tokenOutputsCovered", () => {
  it("covers outputs whose per-receiver sum stays within the approval", () => {
    const outputs = [output(BOB, 60n), output(BOB, 40n), output(SELF, 500n)];
    expect(tokenOutputsCovered(outputs, SELF, intent("100"))).toBe(true);
  });

  it("does not let one approval cover several outputs to the same receiver", () => {
    expect(tokenOutputsCovered([output(BOB, 100n), output(BOB, 100n)], SELF, intent("100"))).toBe(
      false,
    );
  });

  it("rejects an unapproved receiver, another token and an empty outflow", () => {
    expect(tokenOutputsCovered([output(CAROL, 1n)], SELF, intent("100"))).toBe(false);
    expect(tokenOutputsCovered([output(BOB, 1n, OTHER_TOKEN)], SELF, intent("100"))).toBe(false);
    expect(tokenOutputsCovered([], SELF, intent("100"))).toBe(false);
  });
});

describe("transferCovered", () => {
  it("rejects an outflow with no receivers", () => {
    expect(
      transferCovered(
        { kind: "transfer", transferId: "t", totalSats: 0, receivers: [] },
        { kind: "transfer", receivers: [{ identityPublicKey: BOB, amountSats: 1 }] },
      ),
    ).toBe(false);
  });
});
