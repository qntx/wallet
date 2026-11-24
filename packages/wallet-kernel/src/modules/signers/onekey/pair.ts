/**
 * Pairing and account fetch. `pair` initializes the session, pins the four bitcoin purposes at
 * mainnet coin 0' plus the EVM and TRON account nodes through GetPublicKey — every answer carries
 * root_fingerprint and they must all agree on one master — and the SLIP-10 Solana leaf, then
 * cross-checks one derived leaf address per family against the pinned nodes locally. `accounts`
 * fetches the paths the caller still needs; every secp256k1 node must carry the pin's master
 * fingerprint, and an ed25519-only fetch re-probes a pinned secp256k1 node so a foreign device
 * cannot slip its keys into the pin (`wrong-device` on any mismatch).
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { HDKey } from "@scure/bip32";

import type { KeyPath } from "@qntx/wallet-chains";
import { bitcoinAddressFromXpub, bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import { tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";

import type { PinnedNode } from "../../../derive/pinned.ts";
import { fingerprintNumber, samePath } from "../../../derive/pinned.ts";
import type { DeviceLink, Driver, HardwarePin, PairingResult } from "../driver.ts";
import { SPENDADDRESS, SPENDP2SHWITNESS, SPENDTAPROOT, SPENDWITNESS } from "./bitcoin.ts";
import { integrity, kernelError, wrongDevice } from "./errors.ts";
import { exchangeOf } from "./link.ts";
import { address, initialize, publicNode, solanaPublicKey } from "./protocol/index.ts";

const HARDENED = 0x80_00_00_00;

/**
 * The account paths pairing pins: the four bitcoin purposes at mainnet coin 0', the EVM and TRON
 * account nodes (all through GetPublicKey — it accepts any path), and the SLIP-10 Solana leaf.
 * Every GetPublicKey answer carries root_fingerprint; they must all agree on one device identity.
 */
const BIP84_ACCOUNT: KeyPath = [84 + HARDENED, HARDENED, HARDENED];
const EVM_ACCOUNT: KeyPath = [44 + HARDENED, 60 + HARDENED, HARDENED];
const TRON_ACCOUNT: KeyPath = [44 + HARDENED, 195 + HARDENED, HARDENED];
const PAIR_SECP256K1: ReadonlyArray<{ readonly path: KeyPath; readonly scriptType?: number }> = [
  { path: [44 + HARDENED, HARDENED, HARDENED], scriptType: SPENDADDRESS },
  { path: [49 + HARDENED, HARDENED, HARDENED], scriptType: SPENDP2SHWITNESS },
  { path: BIP84_ACCOUNT, scriptType: SPENDWITNESS },
  { path: [86 + HARDENED, HARDENED, HARDENED], scriptType: SPENDTAPROOT },
  { path: EVM_ACCOUNT },
  { path: TRON_ACCOUNT },
];
const PAIR_SOLANA: KeyPath = [44 + HARDENED, 501 + HARDENED, HARDENED, HARDENED];
const BTC_MAINNET = "bip122:000000000019d6689c085ae165831e93";

/** `m/44'/{coin}'/0'/0/0` — the leaf pairing cross-checks on. */
const leafPath0 = (family: "evm" | "tron"): KeyPath => [
  44 + HARDENED,
  (family === "tron" ? 195 : 60) + HARDENED,
  HARDENED,
  0,
  0,
];

/** Public-derive `tail` under `node` — the local half of the pairing cross-checks. */
const deriveLeaf = (node: PinnedNode, tail: ReadonlyArray<number>): Uint8Array => {
  const root = new HDKey({ publicKey: node.publicKey, chainCode: node.chainCode });
  const child = tail.length === 0 ? root : root.derive(`m/${tail.join("/")}`);
  if (child.publicKey === null) {
    integrity("public derivation under the account node failed");
  }
  return child.publicKey;
};

/** The account node's serialized xpub — the same fields the pinned material serializes. */
const xpubOf = (node: PinnedNode, versions: { public: number; private: number }): string => {
  if (node.parent === undefined) {
    integrity("the pinned node carries no parent fingerprint");
  }
  return new HDKey({
    versions,
    depth: node.path.length,
    index: node.path.at(-1) ?? 0,
    parentFingerprint: fingerprintNumber(node.parent),
    chainCode: node.chainCode,
    publicKey: node.publicKey,
  }).publicExtendedKey;
};

/** The deepest pinned node that prefixes `path` — the account node the leaf derives under. */
export const ancestorOf = (pin: HardwarePin, path: KeyPath): PinnedNode | undefined =>
  pin.nodes
    .filter((node) => node.path.length < path.length && node.path.every((v, i) => path[i] === v))
    .sort((a, b) => b.path.length - a.path.length)[0];

export const pair = async (link: DeviceLink): Promise<PairingResult> => {
  const exchange = exchangeOf(link);
  try {
    const info = await initialize(exchange);
    const nodes: PinnedNode[] = [];
    let fingerprint: Uint8Array | undefined;
    for (const { path, scriptType } of PAIR_SECP256K1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
      const node = await publicNode(exchange, path, scriptType === undefined ? {} : { scriptType });
      if (node.rootFingerprint === undefined) {
        integrity("the device reports no master fingerprint");
      }
      if (fingerprint === undefined) {
        fingerprint = node.rootFingerprint;
      } else if (!equalBytes(fingerprint, node.rootFingerprint)) {
        integrity("the device reports inconsistent master fingerprints");
      }
      nodes.push({
        path: node.path,
        publicKey: node.publicKey,
        chainCode: node.chainCode,
        parent: node.parent,
      });
    }
    const solana = await solanaPublicKey(exchange, PAIR_SOLANA, false);
    // Cross-checks with showDisplay false: the addresses the device derives must equal what the
    // pinned nodes derive locally — a device that lies about its nodes is caught here.
    const evmLeaf = await address(exchange, "evm", leafPath0("evm"), { showDisplay: false });
    const tronLeaf = await address(exchange, "tron", leafPath0("tron"), { showDisplay: false });
    const btcLeaf = await address(exchange, "bitcoin", [84 + HARDENED, HARDENED, HARDENED, 0, 0], {
      showDisplay: false,
      scriptType: SPENDWITNESS,
    });
    if (fingerprint === undefined) {
      integrity("pairing collected no account nodes");
    }
    const nodeFor = (path: KeyPath): PinnedNode =>
      nodes.find((n) => samePath(n.path, path)) ??
      integrity("pairing collected too few account nodes");
    if (evmLeaf !== evmAddressFromPublicKey(deriveLeaf(nodeFor(EVM_ACCOUNT), [0, 0]))) {
      integrity("the device derives a different evm address than its node");
    }
    if (tronLeaf !== tronAddressFromPublicKey(deriveLeaf(nodeFor(TRON_ACCOUNT), [0, 0]))) {
      integrity("the device derives a different tron address than its node");
    }
    const net = bitcoinNetwork(BTC_MAINNET);
    if (
      btcLeaf !==
      bitcoinAddressFromXpub(
        xpubOf(nodeFor(BIP84_ACCOUNT), net.bip32),
        "btc.bip84",
        BTC_MAINNET,
        0,
        0,
      )
    ) {
      integrity("the device derives a different bitcoin address than its node");
    }
    return {
      fingerprint,
      model: info.model,
      firmware: info.firmware.join("."),
      nodes,
      ed25519: [{ path: PAIR_SOLANA, publicKey: solana }],
    };
  } catch (error) {
    throw kernelError(error);
  }
};

export const accounts: Driver["accounts"] = async (link, need, pin) => {
  const exchange = exchangeOf(link);
  try {
    await initialize(exchange);
    const nodes: PinnedNode[] = [];
    for (const path of need.secp256k1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
      const node = await publicNode(exchange, path);
      if (
        node.rootFingerprint === undefined ||
        !equalBytes(node.rootFingerprint, pin.fingerprint)
      ) {
        wrongDevice();
      }
      nodes.push({
        path: node.path,
        publicKey: node.publicKey,
        chainCode: node.chainCode,
        parent: node.parent,
      });
    }
    const ed25519: Array<PairingResult["ed25519"][number]> = [];
    for (const path of need.ed25519) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the device serializes exchanges
      ed25519.push({ path: [...path], publicKey: await solanaPublicKey(exchange, path, false) });
    }
    // An ed25519-only fetch carries no fingerprint: probe a pinned secp node so a foreign device
    // cannot slip its keys into the pin.
    if (need.secp256k1.length === 0 && need.ed25519.length > 0) {
      const [first] = pin.nodes;
      if (first === undefined) {
        integrity("the pin carries no node to verify the device against");
      }
      const node = await publicNode(exchange, first.path);
      if (
        !equalBytes(node.publicKey, first.publicKey) ||
        !equalBytes(node.chainCode, first.chainCode)
      ) {
        wrongDevice();
      }
    }
    return { fingerprint: pin.fingerprint, nodes, ed25519 };
  } catch (error) {
    throw kernelError(error);
  }
};
