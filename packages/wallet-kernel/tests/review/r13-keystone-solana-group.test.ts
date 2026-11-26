/**
 * Review PoC R13-03: `confirmable` in src/modules/signers/keystone/driver.ts bounds the Solana
 * sub-account path `m/44'/501'/X'/0'` by the generic `KEYSTONE_INDEX_MAX` = 999 999 998, but
 * Keystone firmware 7da0b941 only renders Solana sub-account paths for X ≤ 49 — GetSolXpub
 * refuses an index past XPUB_TYPE_SOL_BIP44_49
 * (keystone3-firmware@7da0b941, src/crypto/account_public_info.c, which pre-derives exactly the
 * 50 XPUB_TYPE_SOL_BIP44_CHANGE_0..49 keys, and
 * src/ui/gui_widgets/multi/web3/gui_multi_path_coin_receive_widgets.c, where
 * SOL_BIP44_ADDRESS_INDEX_MAX is 49). A `verify-address` for group 50 or higher issues a compare
 * exchange asking the user to check an address the device cannot produce anywhere in its menus —
 * a `matched` verdict confirms nothing. These tests assert today's faulty behaviour so they pass
 * on the current tree and fail once the allow-list is tightened to the firmware bound.
 */
import { describe, expect, it } from "vite-plus/test";

import type { DeviceRequest, DeviceResponse } from "@qntx/wallet/protocol";

import { KernelError } from "../../src/errors.ts";
import type { DeviceLink } from "../../src/modules/signers/driver.ts";
import { KEYSTONE_DRIVER } from "../../src/modules/signers/keystone/driver.ts";
import { masterFingerprint } from "../signers-fake.ts";
import { SEED } from "../signers-ledger-fake.ts";

const H = 0x80_00_00_00;
const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const pin = { fingerprint: masterFingerprint(SEED), nodes: [], ed25519: [] };

const stubLink = (response: DeviceResponse): { link: DeviceLink; requests: DeviceRequest[] } => {
  const requests: DeviceRequest[] = [];
  const link: DeviceLink = {
    exchange: async (request: DeviceRequest): Promise<DeviceResponse> => {
      requests.push(request);
      await Promise.resolve();
      return response;
    },
  };
  return { link, requests };
};

const solanaTarget = (group: number) => ({
  path: [H + 44, H + 501, H + group, H],
  template: "solana.bip44-change" as const,
  network: SOLANA_NETWORK,
  address: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk",
});

describe("keystone verifyAddress admits Solana groups the firmware cannot show", () => {
  it.each([49, 50, 999_999_998])(
    "group %i issues a compare exchange and relays a matched verdict",
    async (group) => {
      const { link, requests } = stubLink({ kind: "compare", matched: true });
      const verdict = await KEYSTONE_DRIVER.verifyAddress(link, solanaTarget(group), pin);
      expect(requests).toStrictEqual([
        {
          kind: "compare",
          address: "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk",
          path: `m/44'/501'/${group}'/0'`,
        },
      ]);
      expect(verdict).toStrictEqual({ method: "compare", matched: true });
    },
  );

  it("control: a BTC testnet path stays unsupported with zero exchanges", async () => {
    const { link, requests } = stubLink({ kind: "compare", matched: true });
    await expect(
      KEYSTONE_DRIVER.verifyAddress(
        link,
        {
          path: [H + 84, H + 1, H, 0, 0],
          address: "tb1qexample",
          template: "btc.bip84",
          network: "bip122:000000000933ea01ad0ee984209779ba",
        },
        pin,
      ),
    ).rejects.toThrow(KernelError);
    expect(requests).toHaveLength(0);
  });
});
