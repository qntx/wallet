/**
 * Proof of concept (asserts the current, flawed behaviour): the hyperliquid-l1-agent meter charges
 * every order at its own limit price `p × s`, whatever its side. A sell's limit price is a floor,
 * not what it executes at — it fills against resting bids at or above `p` — so a sell priced far
 * below the market is charged almost nothing while it moves a position worth `mark × s`. The
 * approved notional therefore bounds buys only; it is not a bound on loss for sells.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { createHarness } from "../harness.ts";
import type { Harness, KernelResponse } from "../harness.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSKEY = () => ({
  kind: "passkey" as const,
  credentialId: utf8ToBytes("credential-1"),
  prf: new Uint8Array(32).fill(1),
});
const T0 = Date.parse("2026-06-01T00:00:00Z");
const DAY = 86_400_000;
const SCHEME = "hyperliquid-l1-agent";
/* A one-dollar budget on the BTC perp (asset 0). */
const LIMITS = { notional: "1", maxLeverage: 1, assets: [0] };

const record = (value: ProtocolValue): Record<string, ProtocolValue> => {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  return value;
};
const ok = (response: KernelResponse): ProtocolValue => {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
};
const codeOf = (response: KernelResponse): string => ("err" in response ? response.err.code : "ok");

async function agent(): Promise<{ h: Harness; session: string; address: string }> {
  const h = createHarness({ start: T0 });
  await h.settle();
  const imported = record(
    ok(
      await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: PASSKEY() }),
    ),
  );
  const session = imported["session"] as string;
  const walletId = record(imported["wallet"] as ProtocolValue)["walletId"] as string;
  const created = record(
    ok(
      await h.call(
        "sessions.create",
        {
          scheme: SCHEME,
          owner: { walletId, groupIndex: 0 },
          scope: "Mainnet",
          name: "bot-1",
          validUntil: T0 + DAY,
          limits: LIMITS,
          verify: PASSKEY(),
        },
        session,
      ),
    ),
  );
  return { h, session, address: created["address"] as string };
}

const order = (b: boolean, p: string, s: string) => ({
  type: "order",
  orders: [{ a: 0, b, p, s, r: false, t: { limit: { tif: "Ioc" } } }],
  grouping: "na",
});

const sign = async (
  w: { h: Harness; session: string; address: string },
  action: Record<string, unknown>,
): Promise<KernelResponse> =>
  w.h.call(
    "sessions.sign",
    {
      scheme: SCHEME,
      address: w.address,
      params: { action, nonce: T0, expiresAfter: T0 + 15_000 },
    },
    w.session,
  );

const spent = async (w: { h: Harness; session: string }): Promise<string> => {
  const list = ok(await w.h.call("sessions.list", null, w.session)) as ReadonlyArray<ProtocolValue>;
  return record(list[0] as ProtocolValue)["spent"] as string;
};

describe("hyperliquid-l1-agent: sells escape the notional budget", () => {
  it("a 10 BTC market-crossing sell signs under a $1 budget; the same buy is refused", async () => {
    const w = await agent();
    /* At a ~100 000 USDC mark, 10 BTC is ~1 000 000 USDC of position. The buy at the mark is
       charged 1e6 and refused — the budget works for buys. */
    expect(codeOf(await sign(w, order(true, "100000", "10")))).toBe("limit-exceeded");
    /* The sell of the same 10 BTC with a 0.1 USDC limit fills at the best bids (or is clamped by
       the venue's price band) yet is charged 0.1 × 10 = 1 — exactly the budget. */
    const signed = record(ok(await sign(w, order(false, "0.1", "10"))));
    expect(signed["signature"]).toBeInstanceOf(Uint8Array);
    await expect(spent(w)).resolves.toBe("1");
  });

  it("the charged amount shrinks without bound as the sell price falls", async () => {
    const w = await agent();
    /* 1e8 units at the grammar's smallest price: charged 1, a size no budget was meant to allow. */
    ok(await sign(w, order(false, "0.00000001", "100000000")));
    await expect(spent(w)).resolves.toBe("1");
  });

  it("a stop-market sell is charged at max(p, triggerPx), both chosen by the caller", async () => {
    const w = await agent();
    ok(
      await sign(w, {
        type: "order",
        orders: [
          {
            a: 0,
            b: false,
            p: "0.1",
            s: "10",
            r: false,
            t: { trigger: { isMarket: true, triggerPx: "0.1", tpsl: "sl" } },
          },
        ],
        grouping: "na",
      }),
    );
    await expect(spent(w)).resolves.toBe("1");
  });
});
