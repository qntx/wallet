/**
 * Review PoC R15-05: excluding unconfirmed addresses from the known set removed a warning the user
 * actually needs. A restored or imported entry is `confirmed: false` until the owner checks the
 * address on the device — precisely the window in which a lookalike wearing the user's own (still
 * unverified) address is most dangerous, since the user has no trusted rendering of it yet.
 * `resolveOwn` drops the entry from the known set while unconfirmed, so the address-poisoning
 * assessment never sees it and `lookalike-counterparty` is withheld from the one transfer that most
 * resembles it.
 *
 * Each test asserts today's behaviour — it passes now and fails once an unconfirmed own address is
 * itself protected against its lookalikes.
 */
import { describe, expect, it } from "vite-plus/test";

import { flagsOf, GROUP2, historyRig } from "./history-rig.ts";

describe("R15-05: the unconfirmed own address loses its lookalike flag", () => {
  it("group unconfirmed: the lookalike of the own address is not flagged", async () => {
    const { controller } = historyRig({ current: false });
    await controller.init();
    await controller.load(GROUP2);
    // Same page, same lookalike — the only difference is that the own address it impersonates
    // has not been confirmed on the device yet.
    expect(flagsOf(controller)).not.toContain("lookalike-counterparty");
    controller.lock();
  });

  it("control: the identical page flags the lookalike once the entry reads confirmed", async () => {
    const { controller } = historyRig({ current: true });
    await controller.init();
    await controller.load(GROUP2);
    expect(flagsOf(controller)).toContain("lookalike-counterparty");
    controller.lock();
  });
});
