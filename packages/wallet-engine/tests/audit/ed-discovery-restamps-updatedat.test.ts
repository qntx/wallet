/**
 * ED-PoC-10 — `discoverGroups` restamps `updatedAt: now` on EVERY scanned group even when only the
 * non-synced `used`/`errors` fields changed; that makes a stale name look newer than a rename on
 * another device, so the next meta merge silently reverts the rename.
 *
 * Exercises src/accounts/controller.ts `discoverGroups` (≈706-851): the existing-group branch
 * (≈824-830) writes `{ ...g, used, errors, updatedAt: now }` unconditionally — `updatedAt` is the
 * LWW field `mergeMeta` (≈578-627) compares on, but it is restamped by a scan that never touched
 * `name`/`hidden`. (Probed-and-unused indices are appended to the tree too, but with all families
 * unused the stop rule fires after index 1, so no append happens here.)
 *
 * Demonstrated: A and B share wallet w with group 1 named "Old" @t0. A renames it "New" @t1. B
 * (never pulled) runs discoverGroups @t2 with all families unused → B.exportMeta carries {name
 * "Old", updatedAt t2}. A.mergeMeta(B's doc) → remote t2 > local t1 → A's group 1 reverts to
 * "Old".
 */
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import { AccountTreeController } from "../../src/accounts/controller.ts";
import type { EngineLogger } from "../../src/events.ts";
import type { SparkController } from "../../src/spark/controller.ts";

const W = "w";
const LOGGER: EngineLogger = { warn: () => {} };
const T0 = 1_000_000;
const T1 = 2_000_000;
const T2 = 3_000_000;

const walletStub = (): Wallet =>
  ({
    getSnapshot: () => ({ wallets: [{ walletId: W }], nostr: { keys: [] } }),
  }) as unknown as Wallet;

const device = (clock: { t: number }): AccountTreeController =>
  new AccountTreeController({
    setTimer: () => () => undefined,
    wallet: walletStub(),
    spark: {
      store: { subscribe: () => () => {} },
      inspect: async () => Promise.resolve({ balanceSats: 0, used: false }),
      setAccounts: () => {},
      setStore: () => {},
    } as unknown as SparkController,
    sparkNetwork: "regtest",
    // All chain probes short-circuit to "unused" when no networks object is injected; the
    // chains stub is only there so `?? chains(wallet)` never builds real API closures.
    chains: { account: async () => Promise.resolve({}) },
    logger: LOGGER,
    now: () => clock.t,
  });

const seed = async (clock: { t: number }): Promise<AccountTreeController> => {
  const ctl = device(clock);
  clock.t = T0;
  await ctl.init();
  ctl.addGroups(W, [1]);
  ctl.renameGroup(W, 1, "Old");
  return ctl;
};

const group = (ctl: AccountTreeController, index: number) =>
  ctl.getState().groups[W]?.find((g) => g.index === index);

describe("ED-PoC-10 discovery restamps updatedAt and overwrites a newer rename", () => {
  it("ED-PoC-10: a scan-only pass on B reverts A's rename via per-group LWW", async () => {
    const clock = { t: T0 };
    const a = await seed(clock);
    const b = await seed(clock);
    expect(group(a, 1)).toMatchObject({ name: "Old", updatedAt: T0 });

    // Device A renames the group — the only real user edit in the whole scenario.
    clock.t = T1;
    a.renameGroup(W, 1, "New");
    expect(group(a, 1)).toMatchObject({ name: "New", updatedAt: T1 });

    // Device B never pulled A's metadata. A scan-only discovery pass (nothing used on any
    // family) still rewrites updatedAt on every group it probed. With everything unused the
    // stop rule fires after index 1 — no trailing group is appended in this scenario.
    clock.t = T2;
    const found = await b.discoverGroups(W);
    expect(found).toStrictEqual([0]);
    expect(b.getState().groups[W]?.map((g) => g.index)).toStrictEqual([0, 1]);

    const doc = b.exportMeta(W);
    expect(doc.groups.find((g) => g.index === 1)).toMatchObject({
      name: "Old",
      updatedAt: T2,
    });

    // The next sync direction B→A treats B's stale name as newer: A's rename is lost.
    const res = a.mergeMeta(W, doc);
    expect(res.changed).toBe(true);
    expect(group(a, 1)).toMatchObject({ name: "Old", updatedAt: T2 });
  });
});
