/**
 * Review PoC R16-04: a device-unconfirmed account's own change address becomes exempt — "a
 * recipient of a live tracked send" — the moment the account sends once.
 *
 * #468 split history's known set so that an unconfirmed own address U "never vouches for itself"
 * (MIGRATION §36.6, SECURITY "Deployment rules"). But for an unconfirmed Bitcoin entry the engine
 * records its change as a plain outflow to U (`own.unconfirmed`, `decodeBitcoinPsbt`), and both the
 * request pipeline (`knownAddresses` in requests/risk.ts) and history (`known()` in
 * history/controller.ts, the `RECIPIENT_STATES` loop) put every tracked outflow's `to` into the
 * EXEMPT set. So after the first send U is exempt in both, defeating the split for exactly the
 * address it was written for. Asserts today's behaviour.
 */
import { describe, expect, it } from "vite-plus/test";

import { assessRecipients, knownAddresses } from "../../src/requests/risk.ts";
import { CHANGE_ADDR, world } from "../support/btc-world.ts";

describe("R16-04 unconfirmed change becomes exempt after one send", () => {
  it("the tracked send lists the unconfirmed change as an outflow, and knownAddresses vouches for it", async () => {
    const w = world({ confirmed: false });
    w.fund(1, 50_000);
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-1");
    expect(tx.state).not.toBe("failed");
    // The change of a never-confirmed entry decodes as a send to CHANGE_ADDR.
    expect(tx.intent?.outflows.some((o) => o.to === CHANGE_ADDR)).toBe(true);

    const before = assessRecipients("bitcoin", [CHANGE_ADDR], []);
    expect(before.map((f) => f.code)).toContain("first-recipient");

    const known = knownAddresses([], Object.values(booted.ctl.getState().txs), "bitcoin");
    expect(known).toContain(CHANGE_ADDR);
    // U now vouches for itself: no finding at all — a contact it imitates would not be flagged.
    expect(assessRecipients("bitcoin", [CHANGE_ADDR], known)).toStrictEqual([]);
  }, 120_000);
});
