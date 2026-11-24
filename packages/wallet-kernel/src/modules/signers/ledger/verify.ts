/**
 * On-device address verification: the device renders the address and the kernel compares its answer
 * against the request. Bitcoin builds the default wallet policy for the pinned account node (same
 * xpub serialization `pinnedMaterial` uses) and asks for the receive address at change 0; EVM, Tron
 * and Solana ask for the address at the leaf path directly. A user rejection on the device surfaces
 * as `device-rejected`; only a device answer that is a different address is a negative verdict —
 * `matched: false`. Every other Ledger failure maps by the standard table.
 */
import type { KeyPath, BitcoinTemplate } from "@qntx/wallet-chains";
import { bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import { solanaAddressFromPublicKey } from "@qntx/wallet-chains/solana";
import type { ChainTemplate } from "@qntx/wallet/protocol";

import { pinnedMaterial } from "../../../derive/pinned.ts";
import { KernelError } from "../../../errors.ts";
import type { DeviceLink, HardwarePin, VerifyVerdict } from "../driver.ts";
import { call } from "./errors.ts";
import { apduExchange, requiredApp } from "./link.ts";
import type { Exchange } from "./protocol/apdu.ts";
import { btcWalletAddress } from "./protocol/bitcoin/index.ts";
import { defaultPolicy } from "./protocol/bitcoin/policy.ts";
import { ethAddress } from "./protocol/ethereum.ts";
import { solanaAddress } from "./protocol/solana.ts";
import { tronAddress } from "./protocol/tron.ts";

const BTC_TEMPLATE = new Set<string>(["btc.bip44", "btc.bip49", "btc.bip84", "btc.bip86"]);

const isBitcoinTemplate = (template: ChainTemplate): template is BitcoinTemplate =>
  BTC_TEMPLATE.has(template);

const bitcoin = async (
  exchange: Exchange,
  target: { readonly path: KeyPath; readonly template: BitcoinTemplate; readonly network: string },
  pin: HardwarePin,
): Promise<string> => {
  const [purpose, coin, group, change, index] = target.path;
  if (
    index === undefined ||
    purpose === undefined ||
    coin === undefined ||
    group === undefined ||
    target.path.length !== 5 ||
    (change !== 0 && change !== 1)
  ) {
    throw new KernelError("integrity", "a bitcoin address path is m/purpose'/coin'/account'/*/i");
  }
  const account = [purpose, coin, group];
  const net = bitcoinNetwork(target.network);
  const xpub = await pinnedMaterial({ fingerprint: pin.fingerprint, keys: pin }).extendedPublicKey(
    account,
    net.bip32,
  );
  const policy = defaultPolicy(target.template, pin.fingerprint, account, xpub);
  return call(async () => btcWalletAddress(exchange, policy, change, index, true));
};

export const verifyAddress = async (
  link: DeviceLink,
  target: {
    readonly path: KeyPath;
    readonly address: string;
    readonly template: ChainTemplate;
    readonly network: string;
  },
  pin: HardwarePin,
): Promise<VerifyVerdict> => {
  const exchange = apduExchange(link);
  // EVM address text is case-insensitive; every other chain's encoding is canonical.
  const expected = target.template === "evm.bip44" ? target.address.toLowerCase() : target.address;
  let deviceAddress: string;
  if (isBitcoinTemplate(target.template)) {
    await requiredApp(exchange, "bitcoin");
    deviceAddress = await bitcoin(exchange, { ...target, template: target.template }, pin);
  } else if (target.template === "evm.bip44") {
    await requiredApp(exchange, "ethereum");
    deviceAddress = await call(async () => {
      const answer = await ethAddress(exchange, target.path, true);
      return answer.address.toLowerCase();
    });
  } else if (target.template === "tron.bip44") {
    await requiredApp(exchange, "tron");
    deviceAddress = await call(async () => {
      const answer = await tronAddress(exchange, target.path, true);
      return answer.address;
    });
  } else if (target.template === "solana.bip44-change") {
    await requiredApp(exchange, "solana");
    deviceAddress = await call(async () =>
      solanaAddressFromPublicKey(await solanaAddress(exchange, target.path, true)),
    );
  } else {
    throw new KernelError("unsupported", "the device cannot check this address");
  }
  return { method: "device", matched: deviceAddress === expected };
};
