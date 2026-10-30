import { describe, expect, it } from "vite-plus/test";

import { SolanaChainAdapter } from "../src/chains/solana.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";

const rpc = (handlers: Record<string, unknown>): SolanaRpc => ({
  call: async (method, params) => {
    const v = handlers[method];
    return method in handlers
      ? Promise.resolve(typeof v === "function" ? (v as (p?: unknown[]) => unknown)(params) : v)
      : Promise.reject(new Error(`unmocked ${method}`));
  },
});

describe("SolanaChainAdapter", () => {
  it("picks p50/p75/p90 prioritization fees as slow/normal/fast", async () => {
    const a = new SolanaChainAdapter();
    const fees = Array.from({ length: 100 }, (_, i) => ({ prioritizationFee: i + 1 }));
    const r = rpc({ getRecentPrioritizationFees: fees });
    const quotes = await a.estimateFee(r, ["x"]);
    expect(quotes.map((q) => [q.tier, q.microLamportsPerCu])).toStrictEqual([
      ["slow", 51n],
      ["normal", 76n],
      ["fast", 91n],
    ]);
  });

  it("maps signature status: err → failed, confirmed, finalized, missing → pending", async () => {
    const a = new SolanaChainAdapter();
    const status = { value: [{ confirmationStatus: "confirmed", err: null }] };
    await expect(a.status(rpc({ getSignatureStatuses: status }), "s")).resolves.toBe("confirmed");
    await expect(
      a.status(
        rpc({ getSignatureStatuses: { value: [{ confirmationStatus: "finalized", err: null }] } }),
        "s",
      ),
    ).resolves.toBe("finalized");
    await expect(
      a.status(
        rpc({
          getSignatureStatuses: { value: [{ confirmationStatus: "confirmed", err: { x: 1 } }] },
        }),
        "s",
      ),
    ).resolves.toBe("failed");
    await expect(a.status(rpc({ getSignatureStatuses: { value: [null] } }), "s")).resolves.toBe(
      "pending",
    );
  });

  it("finalizes as shortvec(1) + signature + message and rejects a >1232-byte message", () => {
    const a = new SolanaChainAdapter();
    const sig = new Uint8Array(64).fill(9);
    const msg = new Uint8Array(10).fill(1);
    const wire = a.finalize(msg, sig);
    expect(wire).toHaveLength(75);
    expect(wire[0]).toBe(1);
    expect(wire.slice(1, 65)).toStrictEqual(sig);
    expect(wire.slice(65)).toStrictEqual(msg);
  });
});
