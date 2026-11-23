import { describe, expect, it } from "vite-plus/test";

/**
 * `AppsController.authorities` end to end: the Hyperliquid builder-fee approval surfaces as a
 * display-only `builder-fee` authority, an app without the member contributes nothing, and one
 * app's failed read lands as its own error row.
 */
import { chains } from "@qntx/wallet/chains";

import type { AppAuthorityRow } from "../src/apps/index.ts";
import { world } from "./apps-helpers.ts";
import type { World } from "./apps-helpers.ts";

const BUILDER = {
  address: "0xABCDEF0123456789abCDEf0123456789abcdef01",
  feeRateTenthsBps: 10,
};

/** The group's owner in the lowercase form Hyperliquid's account reads answer with. */
const ownerOf = async (w: World): Promise<string> => {
  const account = await chains(w.wallet).account({
    walletId: w.walletId,
    groupIndex: w.group.groupIndex,
    template: "evm.bip44",
    network: "eip155:421614",
  });
  const address = "address" in account ? account.address : "";
  return address.toLowerCase();
};

const rows = async (w: World): Promise<ReadonlyArray<AppAuthorityRow>> =>
  w.apps.authorities(w.group);

describe("apps.authorities", () => {
  it("lists the confirmed builder-fee approval as a builder-fee authority", async () => {
    const w = await world(70, {
      builder: BUILDER,
      hl: { maxBuilderFee: BUILDER.feeRateTenthsBps },
    });
    try {
      const owner = await ownerOf(w);
      const [row, ...rest] = await rows(w);
      expect(rest).toStrictEqual([]);
      expect(row).toStrictEqual({
        app: "hyperliquid",
        authority: {
          kind: "builder-fee",
          network: "eip155:421614",
          account: owner,
          holder: BUILDER.address,
          limit: String(BUILDER.feeRateTenthsBps),
          revoke: "none",
        },
      });
    } finally {
      await w.destroy();
    }
  });

  it("reports nothing while Hyperliquid confirms no fee", async () => {
    const w = await world(71, { builder: BUILDER, hl: { maxBuilderFee: 0 } });
    try {
      await expect(rows(w)).resolves.toStrictEqual([]);
    } finally {
      await w.destroy();
    }
  });

  it("reports nothing when no builder is configured", async () => {
    const w = await world(72, { hl: { maxBuilderFee: 10000 } });
    try {
      await expect(rows(w)).resolves.toStrictEqual([]);
    } finally {
      await w.destroy();
    }
  });

  it("contributes nothing for an app without the member", async () => {
    const w = await world(73, { hyperliquid: false, fiat24: true });
    try {
      await expect(rows(w)).resolves.toStrictEqual([]);
    } finally {
      await w.destroy();
    }
  });

  it("turns one app's failed read into its own error row", async () => {
    const w = await world(74, { builder: BUILDER });
    try {
      w.hl.info = () => {
        throw new Error("info endpoint down");
      };
      const [row, ...rest] = await rows(w);
      expect(rest).toStrictEqual([]);
      expect(row).toMatchObject({
        app: "hyperliquid",
        error: { category: "network" },
      });
    } finally {
      await w.destroy();
    }
  });

  it("refuses while locked with the app's own unlock-required error", async () => {
    const w = await world(75, { builder: BUILDER });
    try {
      await w.wallet.vault.lock();
      await expect(rows(w)).rejects.toMatchObject({
        category: "unlock-required",
      });
    } finally {
      await w.destroy();
    }
  });
});
