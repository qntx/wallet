/**
 * Pairing and account fetch. The Bitcoin app is the identity source: it is the only Ledger app that
 * reveals the BIP-32 master fingerprint (the ETH/Tron/Solana apps are path-locked to their coin
 * type — the pinned Makefiles' PATH_APP_LOAD_PARAMS), so `pair` requires it and pins the four
 * group-0 account xpubs it serves. `accounts` serves one chain family per call — coin type 0' →
 * bitcoin (re-checking the master fingerprint against the pin), 60' → ethereum, 195' → tron, 501' →
 * solana; any other type or a mix is `unsupported`.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { HDKey } from "@scure/bip32";

import type { KeyPath } from "@qntx/wallet-chains";

import type { PinnedNode } from "../../../derive/pinned.ts";
import { KernelError } from "../../../errors.ts";
import type { DeviceLink, HardwarePin, PairingResult } from "../driver.ts";
import { call } from "./errors.ts";
import { apduExchange, requiredApp } from "./link.ts";
import { btcExtendedPublicKey, btcMasterFingerprint } from "./protocol/bitcoin/index.ts";
import type { LedgerApp } from "./protocol/device.ts";
import { ethPublicNode } from "./protocol/ethereum.ts";
import { solanaAddress } from "./protocol/solana.ts";
import { tronPublicNode } from "./protocol/tron.ts";

const HARDENED = 0x80_00_00_00;
const PAIR_PURPOSES = [44, 49, 84, 86] as const;

const unsupported = (message: string): never => {
  throw new KernelError("unsupported", message);
};

/** The pinned node the xpub at `path` carries — public key, chain code and parent fingerprint. */
const nodeAt = (path: KeyPath, xpub: string): PinnedNode => {
  const key = HDKey.fromExtendedKey(xpub);
  if (key.publicKey === null || key.chainCode === null) {
    throw new KernelError("integrity", "the account xpub carries no public material");
  }
  const parent = new Uint8Array(4);
  new DataView(parent.buffer).setUint32(0, key.parentFingerprint);
  return { path, publicKey: key.publicKey, chainCode: key.chainCode, parent };
};

/**
 * The pairing ceremony: the Bitcoin app must be open — only it reveals the master fingerprint. The
 * pinned nodes are the four group-0 account xpubs m/{44,49,84,86}'/0'/0'.
 */
export const pair = async (link: DeviceLink): Promise<PairingResult> =>
  call(async () => {
    const exchange = apduExchange(link);
    const info = await requiredApp(exchange, "bitcoin");
    const fingerprint = await btcMasterFingerprint(exchange);
    const nodes: PinnedNode[] = [];
    for (const purpose of PAIR_PURPOSES) {
      const path = [purpose + HARDENED, HARDENED, HARDENED];
      // oxlint-disable-next-line eslint/no-await-in-loop -- account fetches are sequential on one link
      nodes.push(nodeAt(path, await btcExtendedPublicKey(exchange, path, false)));
    }
    return {
      fingerprint,
      firmware: `Bitcoin ${info.version}`,
      nodes,
      ed25519: [],
    };
  });

/** The coin type a BIP-44-style account path names — `undefined` when the path has no second step. */
const coinType = (path: KeyPath): number | undefined => {
  const [, coin] = path;
  return coin === undefined || coin < HARDENED ? undefined : coin - HARDENED;
};

const SECP_FAMILY: Readonly<Record<number, LedgerApp>> = {
  0: "bitcoin",
  60: "ethereum",
  195: "tron",
};

/**
 * Fetches the pinned material for `need` — one chain family per call. Bitcoin re-checks the master
 * fingerprint (`wrong-device` on a different seed); ethereum/tron take the chain-code public-node
 * variant; solana reads the ed25519 keys directly.
 */
export const accounts = async (
  link: DeviceLink,
  need: { readonly secp256k1: ReadonlyArray<KeyPath>; readonly ed25519: ReadonlyArray<KeyPath> },
  pin: HardwarePin,
): Promise<PairingResult> => {
  const families = new Set<LedgerApp>();
  for (const path of need.secp256k1) {
    const coin = coinType(path);
    const app = coin === undefined ? undefined : SECP_FAMILY[coin];
    if (app === undefined) {
      throw new KernelError("unsupported", "the account path is not a supported ledger family");
    }
    families.add(app);
  }
  for (const path of need.ed25519) {
    if (coinType(path) !== 501) {
      unsupported("the ed25519 path is not the solana family");
    }
    families.add("solana");
  }
  if (families.size > 1) {
    unsupported("fetch one chain family at a time");
  }
  const [app] = families;
  if (app === undefined) {
    return { fingerprint: pin.fingerprint, nodes: [], ed25519: [] };
  }
  return call(async () => {
    const exchange = apduExchange(link);
    await requiredApp(exchange, app);
    if (app === "bitcoin") {
      if (!equalBytes(await btcMasterFingerprint(exchange), pin.fingerprint)) {
        throw new KernelError("wrong-device", "the device is not the paired one");
      }
      const nodes: PinnedNode[] = [];
      for (const path of need.secp256k1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one exchange at a time on one link
        nodes.push(nodeAt(path, await btcExtendedPublicKey(exchange, path, false)));
      }
      return { fingerprint: pin.fingerprint, nodes, ed25519: [] };
    }
    if (app === "ethereum" || app === "tron") {
      const get = app === "ethereum" ? ethPublicNode : tronPublicNode;
      const nodes: PinnedNode[] = [];
      for (const path of need.secp256k1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one exchange at a time on one link
        const node = await get(exchange, path);
        nodes.push({ path, publicKey: node.publicKey, chainCode: node.chainCode });
      }
      return { fingerprint: pin.fingerprint, nodes, ed25519: [] };
    }
    const ed25519 = [];
    for (const path of need.ed25519) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one exchange at a time on one link
      ed25519.push({ path, publicKey: await solanaAddress(exchange, path, false) });
    }
    return { fingerprint: pin.fingerprint, nodes: [], ed25519 };
  });
};
