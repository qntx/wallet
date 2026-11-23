import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

/**
 * `AppsController.authorities` end to end: the Hyperliquid builder-fee approval surfaces as a
 * display-only `builder-fee` authority, Polymarket's trading approvals as `token-allowance` and
 * `operator` rows, an app without the member contributes nothing, and one app's failed read lands
 * as its own error row.
 */
import { chains } from "@qntx/wallet/chains";

import {
  CLOB_HOST,
  CTF_EXCHANGE_V3,
  DATA_HOST,
  POSITION_MANAGER,
  PUSD,
  RELAYER_HOST,
} from "../src/apps/polymarket/constants.ts";
import { derivePolymarketWallets } from "../src/apps/polymarket/wallets.ts";
import type { AppAuthorityRow } from "../src/apps/index.ts";
import { MNEMONIC, pmChainCode, world } from "./apps-helpers.ts";
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
          network: "Testnet",
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

const PM_GROUP_INDEX = 80;
const PM_SIGNER = mnemonicToAccount(MNEMONIC, { addressIndex: PM_GROUP_INDEX }).address;
const PM_WALLETS = derivePolymarketWallets(PM_SIGNER);

const pmApprovalRow = (token: string, spender: string, approved = true, amount = "max") => ({
  id: `${token}-${spender}`,
  feature: "allowance",
  token,
  spender,
  standard: token === PUSD ? "ERC20" : "ERC1155",
  amount: approved ? amount : "0",
  approved,
});

/** Serves only what an `authorities` read needs: eligibility, `/deployed`, `/v2/approvals`. */
const pmFetch =
  (feed: { contracts: ReadonlyArray<ReturnType<typeof pmApprovalRow>> }) =>
  async (input: string | URL | Request): Promise<Response> => {
    await Promise.resolve();
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (url.pathname === "/v1/eligibility") {
      return Response.json({
        country: "US",
        region: null,
        apps: { hyperliquid: "available", polymarket: "available" },
      });
    }
    if (url.origin === RELAYER_HOST && url.pathname === "/deployed") {
      return Response.json({ deployed: pmDeployed(url.searchParams.get("address") ?? "") });
    }
    if (url.origin === CLOB_HOST && url.pathname === "/time") {
      return Response.json(Math.floor(Date.now() / 1000));
    }
    if (url.origin === DATA_HOST && url.pathname === "/v2/approvals") {
      return Response.json({
        data: {
          address: url.searchParams.get("user"),
          chain_id: 137,
          checked_at: "2026-11-23T00:00:00Z",
          contracts: feed.contracts,
        },
      });
    }
    throw new Error(`unrecorded request: ${url.toString()}`);
  };

const pmDeployed = (address: string): boolean =>
  address.toLowerCase() === PM_WALLETS.beacon.toLowerCase();

const pmWorld = (contracts: ReadonlyArray<ReturnType<typeof pmApprovalRow>>) =>
  world(PM_GROUP_INDEX, {
    hyperliquid: false,
    polymarket: {},
    fetch: pmFetch({ contracts }),
    /* The chain read mirrors the relayer feed — locate refuses a target they disagree on. */
    polyCode: pmChainCode((a, t) => t === "WALLET" && pmDeployed(a), PM_SIGNER),
  });

describe("apps.authorities — polymarket", () => {
  it("lists the trading approvals the located deposit wallet holds", async () => {
    const w = await pmWorld([
      pmApprovalRow(PUSD, CTF_EXCHANGE_V3),
      pmApprovalRow(POSITION_MANAGER, CTF_EXCHANGE_V3),
    ]);
    try {
      const result = await rows(w);
      expect(result).toStrictEqual([
        {
          app: "polymarket",
          authority: {
            kind: "token-allowance",
            network: "eip155:137",
            account: PM_WALLETS.beacon,
            holder: CTF_EXCHANGE_V3,
            asset: PUSD,
            revoke: "none",
          },
        },
        {
          app: "polymarket",
          authority: {
            kind: "operator",
            network: "eip155:137",
            account: PM_WALLETS.beacon,
            holder: CTF_EXCHANGE_V3,
            asset: POSITION_MANAGER,
            revoke: "none",
          },
        },
      ]);
    } finally {
      await w.destroy();
    }
  });

  it("reports nothing the table does not know — a hostile answer injects no row", async () => {
    const w = await pmWorld([
      pmApprovalRow("0xdead00000000000000000000000000000000beef", CTF_EXCHANGE_V3),
      pmApprovalRow(PUSD, "0xdead00000000000000000000000000000000beef"),
    ]);
    try {
      await expect(rows(w)).resolves.toStrictEqual([]);
    } finally {
      await w.destroy();
    }
  });

  it("reports nothing while the API confirms no approval and nothing is deployed", async () => {
    const w = await world(81, {
      hyperliquid: false,
      polymarket: {},
      fetch: pmFetch({ contracts: [] }),
      polyCode: pmChainCode(
        () => false,
        mnemonicToAccount(MNEMONIC, { addressIndex: 81 }).address,
      ),
    });
    try {
      await expect(rows(w)).resolves.toStrictEqual([]);
    } finally {
      await w.destroy();
    }
  });
});
