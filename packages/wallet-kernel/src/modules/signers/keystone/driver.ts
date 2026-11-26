import type { ChainTemplate } from "@qntx/wallet/protocol";

import { pathToString } from "../../../derive/pinned.ts";
/**
 * The Keystone driver: QR air-gapped pairing, compare-style address checks, and QR signing. `pair`
 * scans the device's `crypto-multi-accounts` sync and pins the public material `sync.ts` admits;
 * `verifyAddress` asks the host to show the kernel's address for the user to compare against the
 * device menu (Keystone has no host-initiated address display). `sign` shows the registry request
 * `sign.ts` builds and admits only the answer to that exchange; `accounts` runs the
 * `qr-hardware-call` key-derivation exchange `derive.ts` pins.
 */
import { KernelError } from "../../../errors.ts";
import type { Driver } from "../driver.ts";
import { derive } from "./derive.ts";
import { display, sign } from "./sign.ts";
import { parseSync } from "./sync.ts";

const H = 0x80000000;
/**
 * The address index Keystone's own menus accept — `GENERAL_ADDRESS_INDEX_MAX` and
 * `ADDRESS_INDEX_MAX` are 999 999 999 and an input `>=` it is rejected, so the largest showable
 * index is 999 999 998 (keystone3-firmware@7da0b941,
 * src/ui/gui_widgets/multi/gui_standard_receive_widgets.c:27,306 and
 * src/ui/gui_widgets/gui_utxo_receive_widgets.c:32,1570).
 */
const KEYSTONE_INDEX_MAX = 999_999_998;

/**
 * The Solana sub-account groups the Keystone's Web3 menu renders — much narrower than the generic
 * index bound: `SOL_BIP44_ADDRESS_INDEX_MAX` is 49, `GetSOLMaxAddressIndex` returns it for the
 * `m/44'/501'/X'/0'` path, `GetSolXpub` returns NULL past `XPUB_TYPE_SOL_BIP44_49`, and only
 * `XPUB_TYPE_SOL_BIP44_CHANGE_0…49` are pre-derived at all (keystone3-firmware@7da0b941,
 * src/ui/gui_widgets/multi/web3/gui_multi_path_coin_receive_widgets.c:26,962-973,1292 and
 * src/crypto/account_public_info.c:432-481).
 */
const KEYSTONE_SOLANA_GROUP_MAX = 49;

/**
 * The paths the Keystone's own Receive menu can render — the only paths a `compare` check can prove
 * against (keystone3-firmware@7da0b941):
 *
 * - `evm.bip44` "BIP44 Standard" `m/44'/60'/0'/0/X`
 *   (src/ui/gui_widgets/multi/web3/gui_multi_path_coin_receive_widgets.c:158,1167)
 * - `tron.bip44` `m/44'/195'/0'/0/X` (src/ui/gui_widgets/multi/gui_standard_receive_widgets.c:971)
 * - `solana.bip44-change` "Sub-account Path" `m/44'/501'/X'/0'` for `X ≤ 49`
 *   (src/ui/gui_widgets/multi/web3/gui_multi_path_coin_receive_widgets.c:165,1190 and
 *   `KEYSTONE_SOLANA_GROUP_MAX`)
 * - `btc.*` mainnet account 0, receive chain `m/{44,49,84,86}'/0'/0'/0/i`
 *   (src/ui/gui_widgets/gui_utxo_receive_widgets.c:151-170,1735) Everything else — BTC
 *   testnet/signet (the Web3 firmware derives from coin type 0'), any non-zero account — gets
 *   `unsupported` before any exchange: the host would ask the user to compare against a screen the
 *   device cannot produce.
 */
const confirmable = (target: {
  readonly path: ReadonlyArray<number>;
  readonly template: ChainTemplate;
  readonly network: string;
}): boolean => {
  const { path } = target;
  if (target.template === "solana.bip44-change") {
    const group = path.at(2);
    return (
      path.length === 4 &&
      path[0] === H + 44 &&
      path[1] === H + 501 &&
      group !== undefined &&
      group >= H &&
      group - H <= KEYSTONE_SOLANA_GROUP_MAX &&
      path[3] === H
    );
  }
  const index = path.at(-1);
  if (index === undefined || index < 0 || index > KEYSTONE_INDEX_MAX) {
    return false;
  }
  if (target.template === "evm.bip44") {
    return (
      path.length === 5 &&
      path[0] === H + 44 &&
      path[1] === H + 60 &&
      path[2] === H &&
      path[3] === 0
    );
  }
  if (target.template === "tron.bip44") {
    return (
      path.length === 5 &&
      path[0] === H + 44 &&
      path[1] === H + 195 &&
      path[2] === H &&
      path[3] === 0
    );
  }
  // btc.* — the account path's hardened coin type must be mainnet 0', group 0', receive chain 0.
  return (
    path.length === 5 &&
    path[0] !== undefined &&
    [H + 44, H + 49, H + 84, H + 86].includes(path[0]) &&
    path[1] === H &&
    path[2] === H &&
    path[3] === 0 &&
    index < H
  );
};

export const KEYSTONE_DRIVER: Driver = {
  pair: async (link) =>
    parseSync(await link.exchange({ kind: "qr", scan: ["crypto-multi-accounts"] })),
  display,
  sign,
  accounts: derive,
  verifyAddress: async (link, target) => {
    if (!confirmable(target)) {
      throw new KernelError(
        "unsupported",
        "the device cannot show this address — it is outside its Receive menu",
      );
    }
    const response = await link.exchange({
      kind: "compare",
      address: target.address,
      path: pathToString(target.path),
    });
    if (response.kind !== "compare") {
      throw new KernelError("integrity", "the compare answer is not a compare verdict");
    }
    return { method: "compare", matched: response.matched };
  },
};
