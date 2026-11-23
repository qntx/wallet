/**
 * The `hardware-wallet` record: a hardware wallet under external custody. The kernel keeps no
 * secret for it — the public header carries what the device claims to be, the sealed body the
 * public material pairing pinned (BIP-32 account nodes and SLIP-10 ed25519 keys). Every device
 * answer is checked against the pin before it can influence a request.
 *
 * Header `{ device, fingerprint, model?, firmware?, createdAt }` is stored as fixed-order JSON and
 * enters the envelope AAD verbatim; the body is strict JSON `{ nodes, ed25519 }` keyed by `m/…`
 * paths. Parsing validates fully: a malformed row is `integrity`, never silently ignored.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import type { KeyPath } from "@qntx/wallet-chains";
import type { HardwareDevice } from "@qntx/wallet/protocol";
import { HARDWARE_DEVICES } from "@qntx/wallet/types";
import type { HardwareWalletInfo } from "@qntx/wallet/types";

import { KernelError } from "../../errors.ts";
import { asCreatedAt, expectKeys, headerFailure, headerObject } from "../../vault/header-codec.ts";
import type { StoredRecord, VaultImage } from "../../vault/store.ts";
import type { HardwarePin, PinnedEd25519, PinnedKeys, PinnedNode } from "./driver.ts";

export const HARDWARE_WALLET_KIND = "hardware-wallet";

const HARDENED = 0x80000000;
/** The device's own strings are untrusted — only printable ASCII under 64 chars survives. */
const DEVICE_TEXT = /^[\u0020-\u007E]{1,64}$/;
const HEX = /^[0-9a-f]+$/;
const MAX_NODES = 512;
const MAX_ED25519 = 256;

export type HardwareHeader = {
  readonly device: HardwareDevice;
  /** The BIP-32 master fingerprint the device claimed at pairing, 4 bytes. */
  readonly fingerprint: Uint8Array;
  readonly model?: string;
  readonly firmware?: string;
  readonly createdAt: number;
};

/**
 * Stable hardware-wallet identifier, domain-separated from the software wallet id:
 * SHA-256(UTF-8("qntx-wallet/hardware-wallet-id/v1") ‖ UTF-8(device) ‖ 0x00 ‖ fingerprint4)[0..8].
 * The same device re-paired maps to the same id — the pair handler answers `already-exists`.
 */
export function hardwareWalletId(device: HardwareDevice, fingerprint: Uint8Array): string {
  return bytesToHex(
    sha256(
      concatBytes(
        utf8ToBytes("qntx-wallet/hardware-wallet-id/v1"),
        utf8ToBytes(device),
        new Uint8Array([0]),
        fingerprint,
      ),
    ).slice(0, 8),
  );
}

/** The `hardware-wallet` record for `walletId`, when the vault has one. */
export function hardwareWallet(image: VaultImage, walletId: string): StoredRecord | undefined {
  return image.records.find((r) => r.kind === HARDWARE_WALLET_KIND && r.id === walletId);
}

const asDevice = (value: unknown): HardwareDevice => {
  if (typeof value !== "string") {
    throw headerFailure();
  }
  const device = HARDWARE_DEVICES.find((d) => d === value);
  if (device === undefined) {
    throw headerFailure();
  }
  return device;
};

const asFingerprint = (value: unknown): Uint8Array => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}$/.test(value)) {
    throw headerFailure();
  }
  return hexToBytes(value);
};

const asDeviceText = (value: unknown): string => {
  if (typeof value !== "string" || !DEVICE_TEXT.test(value)) {
    throw headerFailure();
  }
  return value;
};

export function encodeHardwareHeader(header: HardwareHeader): string {
  const fields: Record<string, string | number> = {
    device: header.device,
    fingerprint: bytesToHex(header.fingerprint),
  };
  if (header.model !== undefined) {
    fields["model"] = header.model;
  }
  if (header.firmware !== undefined) {
    fields["firmware"] = header.firmware;
  }
  fields["createdAt"] = header.createdAt;
  return JSON.stringify(fields);
}

/** Strict header parse; every failure is `integrity` — status marks the vault corrupted. */
export function parseHardwareHeader(text: string): HardwareHeader {
  const object = headerObject(text);
  const optional = ["model", "firmware"].filter((key) => Object.hasOwn(object, key));
  expectKeys(object, ["device", "fingerprint", "createdAt", ...optional]);
  const header: {
    -readonly [K in keyof HardwareHeader]: HardwareHeader[K];
  } = {
    device: asDevice(object["device"]),
    fingerprint: asFingerprint(object["fingerprint"]),
    createdAt: asCreatedAt(object["createdAt"]),
  };
  if (object["model"] !== undefined) {
    header.model = asDeviceText(object["model"]);
  }
  if (object["firmware"] !== undefined) {
    header.firmware = asDeviceText(object["firmware"]);
  }
  return header;
}

/** The `HardwareWalletInfo` a hardware-wallet record's public header reports. */
export function hardwareWalletInfo(header: HardwareHeader): HardwareWalletInfo {
  const info: {
    -readonly [K in keyof HardwareWalletInfo]: HardwareWalletInfo[K];
  } = {
    custody: "hardware",
    walletId: hardwareWalletId(header.device, header.fingerprint),
    device: header.device,
    fingerprint: bytesToHex(header.fingerprint),
    createdAt: header.createdAt,
  };
  if (header.model !== undefined) {
    info.model = header.model;
  }
  if (header.firmware !== undefined) {
    info.firmware = header.firmware;
  }
  return info;
}

const bodyFailure = (): KernelError =>
  new KernelError("integrity", "invalid hardware wallet record");

/** `m/…` → `KeyPath`; depth 1–10, hardened segments carry `'`, indices stay under 2^31. */
export function pathFromString(text: string): KeyPath {
  if (!/^m(\/[0-9]+'?){1,10}$/.test(text)) {
    throw bodyFailure();
  }
  return text
    .slice(2)
    .split("/")
    .map((segment) => {
      const hardened = segment.endsWith("'");
      const digits = hardened ? segment.slice(0, -1) : segment;
      // Canonical decimal only — a leading zero would re-encode differently.
      if (digits.length > 1 && digits.startsWith("0")) {
        throw bodyFailure();
      }
      const index = Number(digits);
      if (!Number.isSafeInteger(index) || index > 0x7fffffff) {
        throw bodyFailure();
      }
      return hardened ? index + HARDENED : index;
    });
}

/** `KeyPath` → `m/…` — the inverse of {@link pathFromString}; empty paths are `m`. */
export function pathToString(path: KeyPath): string {
  return `m${path.map((i) => (i >= HARDENED ? `/${i - HARDENED}'` : `/${i}`)).join("")}`;
}

const asHexBytes = (value: unknown, length: number): Uint8Array => {
  if (typeof value !== "string" || value.length !== length * 2 || !HEX.test(value)) {
    throw bodyFailure();
  }
  return hexToBytes(value);
};

const parseNode = (
  value: unknown,
): { key: Uint8Array; chainCode: Uint8Array; parent?: Uint8Array } => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw bodyFailure();
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to an object above
  const node = value as Record<string, unknown>;
  const hasParent = Object.hasOwn(node, "parent");
  if (Object.keys(node).length !== (hasParent ? 3 : 2)) {
    throw bodyFailure();
  }
  const publicKey = asHexBytes(node["key"], 33);
  if (!secp256k1.utils.isValidPublicKey(publicKey)) {
    throw bodyFailure();
  }
  const parsed: { key: Uint8Array; chainCode: Uint8Array; parent?: Uint8Array } = {
    key: publicKey,
    chainCode: asHexBytes(node["chainCode"], 32),
  };
  if (hasParent) {
    parsed.parent = asHexBytes(node["parent"], 4);
  }
  return parsed;
};

/**
 * Parses the sealed body: every node is a real secp256k1 point, every ed25519 entry a real point,
 * every path well-formed, and the caps (512 nodes, 256 ed25519) hold. Anything less is
 * `integrity`.
 */
export function parseHardwareBody(plaintext: Uint8Array): PinnedKeys {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw bodyFailure();
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw bodyFailure();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw bodyFailure();
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to an object above
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 2) {
    throw bodyFailure();
  }
  const { nodes } = body;
  const ed = body["ed25519"];
  if (
    typeof nodes !== "object" ||
    nodes === null ||
    Array.isArray(nodes) ||
    typeof ed !== "object" ||
    ed === null ||
    Array.isArray(ed)
  ) {
    throw bodyFailure();
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to objects above
  const nodeEntries = Object.entries(nodes as Record<string, unknown>);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to objects above
  const edEntries = Object.entries(ed as Record<string, unknown>);
  if (nodeEntries.length > MAX_NODES || edEntries.length > MAX_ED25519) {
    throw bodyFailure();
  }
  const pinnedNodes: PinnedNode[] = nodeEntries.map(([path, entry]) => {
    const parsed = parseNode(entry);
    const node: {
      path: KeyPath;
      publicKey: Uint8Array;
      chainCode: Uint8Array;
      parent?: Uint8Array;
    } = { path: pathFromString(path), publicKey: parsed.key, chainCode: parsed.chainCode };
    if (parsed.parent !== undefined) {
      node.parent = parsed.parent;
    }
    return node;
  });
  const pinnedEd25519: PinnedEd25519[] = edEntries.map(([path, entry]) => {
    const publicKey = asHexBytes(entry, 32);
    if (!ed25519.utils.isValidPublicKey(publicKey)) {
      throw bodyFailure();
    }
    const parsedPath = pathFromString(path);
    // SLIP-10 has no public derivation: a pinned ed25519 key only serves its own all-hardened path.
    if (parsedPath.some((i) => i < HARDENED)) {
      throw bodyFailure();
    }
    return { path: parsedPath, publicKey };
  });
  return { nodes: pinnedNodes, ed25519: pinnedEd25519 };
}

/** The body's canonical JSON — fixed key order, `m/…` paths, lowercase hex. */
export function encodeHardwareBody(keys: PinnedKeys): Uint8Array {
  const nodes: Record<string, { key: string; chainCode: string; parent?: string }> = {};
  for (const node of keys.nodes) {
    const entry: { key: string; chainCode: string; parent?: string } = {
      key: bytesToHex(node.publicKey),
      chainCode: bytesToHex(node.chainCode),
    };
    if (node.parent !== undefined) {
      entry.parent = bytesToHex(node.parent);
    }
    nodes[pathToString(node.path)] = entry;
  }
  const ed: Record<string, string> = {};
  for (const key of keys.ed25519) {
    ed[pathToString(key.path)] = bytesToHex(key.publicKey);
  }
  return utf8ToBytes(JSON.stringify({ nodes, ed25519: ed }));
}

/** The pin a record seals: the claimed fingerprint plus the pinned keys. */
export function hardwarePin(header: HardwareHeader, keys: PinnedKeys): HardwarePin {
  return { fingerprint: header.fingerprint, nodes: keys.nodes, ed25519: keys.ed25519 };
}
