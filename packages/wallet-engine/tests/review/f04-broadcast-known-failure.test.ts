/**
 * F-04 a failed `known()` lookup turns an ambiguous refusal into a definite failure.
 *
 * When `send` rejects with a refused verdict, `broadcastOutcome` asks `known()` whether the network
 * already holds the bytes — a retry whose first copy landed looks identical to a real rejection. If
 * that lookup fails, the catch treats the tx as unknown-to-the-network and the outcome is a
 * definite `refused`: a broadcast that may have succeeded is reported as failed.
 */
import { describe, expect, it } from "vite-plus/test";

import { broadcastOutcome } from "../../src/transactions/broadcast.ts";

describe("F-04 a failed known() lookup turns an ambiguous refusal into a definite failure", () => {
  const attempt = (known: () => Promise<boolean>) => ({
    id: "0xabc",
    send: async () => Promise.reject(new Error("nonce too low")),
    verdict: () => "refused" as const,
    known,
  });

  it("a failed known() lookup reports the broadcast refused", async () => {
    const outcome = await broadcastOutcome(
      attempt(async () => Promise.reject(new Error("network down"))),
    );
    expect(outcome.kind).toBe("refused");
  });

  it("control: the same refusal is accepted once known() confirms the bytes landed", async () => {
    const outcome = await broadcastOutcome(attempt(async () => Promise.resolve(true)));
    expect(outcome.kind).toBe("accepted");
  });
});
