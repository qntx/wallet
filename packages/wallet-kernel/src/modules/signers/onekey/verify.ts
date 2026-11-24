/**
 * On-device address verification: the device shows the address and the kernel compares its answer
 * against the request. Every check first proves the answering device holds the pin — the pinned
 * secp256k1 account node re-fetched byte-for-byte, or for Solana the pinned leaf key itself
 * (SolanaGetAddress shows the address and returns the key, so one exchange both proves the device
 * and displays the check). A user rejection on the device surfaces as `device-rejected`; only a
 * shown address that differs is a negative verdict — `matched: false`.
 */
import { equalBytes } from "@noble/ciphers/utils.js";

import { networkChainId } from "@qntx/wallet-chains/evm";
import { solanaAddressFromPublicKey } from "@qntx/wallet-chains/solana";

import { samePath } from "../../../derive/pinned.ts";
import type { Driver } from "../driver.ts";
import { btcCoinName, SCRIPT_TYPE } from "./bitcoin.ts";
import { integrity, kernelError, wrongDevice } from "./errors.ts";
import { exchangeOf } from "./link.ts";
import { ancestorOf } from "./pair.ts";
import { address, initialize, publicNode, solanaPublicKey } from "./protocol/index.ts";
import type { AddressFamily } from "./protocol/index.ts";

export const verifyAddress: Driver["verifyAddress"] = async (link, target, pin) => {
  const exchange = exchangeOf(link);
  try {
    await initialize(exchange);
    const family: AddressFamily =
      target.template === "evm.bip44"
        ? "evm"
        : target.template === "tron.bip44"
          ? "tron"
          : target.template === "solana.bip44-change"
            ? "solana"
            : "bitcoin";
    if (family === "solana") {
      // The pinned key sits at the leaf itself; SolanaGetAddress shows the address and returns
      // the key, so one exchange both proves the device and displays the check.
      const key = pin.ed25519.find((k) => samePath(k.path, target.path));
      if (key === undefined) {
        integrity("no pinned ed25519 key covers the verify path");
      }
      const shown = await solanaPublicKey(exchange, target.path, true);
      if (!equalBytes(shown, key.publicKey)) {
        wrongDevice();
      }
      return { method: "device", matched: solanaAddressFromPublicKey(shown) === target.address };
    }
    const scriptType = SCRIPT_TYPE[target.template];
    if (family === "bitcoin" && scriptType === undefined) {
      integrity(`unknown bitcoin template ${target.template}`);
    }
    const ancestor = ancestorOf(pin, target.path);
    if (ancestor === undefined) {
      integrity("no pinned account node covers the verify path");
    }
    const node = await publicNode(exchange, ancestor.path);
    if (
      !equalBytes(node.publicKey, ancestor.publicKey) ||
      !equalBytes(node.chainCode, ancestor.chainCode)
    ) {
      wrongDevice();
    }
    const shown = await address(exchange, family, target.path, {
      showDisplay: true,
      ...(scriptType === undefined ? {} : { scriptType }),
      ...(family === "bitcoin" ? { network: btcCoinName(target.network) } : {}),
      ...(family === "evm" ? { chainId: BigInt(networkChainId(target.network)) } : {}),
    });
    return { method: "device", matched: shown === target.address };
  } catch (error) {
    throw kernelError(error);
  }
};
