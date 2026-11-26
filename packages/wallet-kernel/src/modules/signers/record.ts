/**
 * The `hardware-wallet` record: a hardware wallet under external custody. The kernel keeps no
 * secret for it — the public header carries what the device claims to be, the sealed body the
 * public material pairing pinned (BIP-32 account nodes and SLIP-10 ed25519 keys). Every device
 * answer is checked against the pin before it can influence a request.
 *
 * Header `{ device, fingerprint, model?, firmware?, createdAt }` is stored as fixed-order JSON and
 * enters the envelope AAD verbatim; the body is strict JSON `{ nodes, ed25519, confirmed }` keyed
 * by `m/…` paths — the same pinned-material codec the card body uses (../../derive/pinned.ts) plus
 * the list of entries an on-device address check confirmed. `device` is any well-formed device
 * string: kinds this build does not know authenticate but stay inert — listed with `supported:
 * false`, never parsed for a body, never driven. Parsing validates fully: a malformed row is
 * `integrity`, never silently ignored.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import type { KeyPath } from "@qntx/wallet-chains";
import { HARDWARE_DEVICES } from "@qntx/wallet/types";
import type { HardwareWalletInfo } from "@qntx/wallet/types";

import {
  parsePinnedEd25519,
  parsePinnedNodes,
  pathFromString,
  pathToString,
} from "../../derive/pinned.ts";
import type { PinnedKeys } from "../../derive/pinned.ts";
import { KernelError } from "../../errors.ts";
import { asCreatedAt, expectKeys, headerFailure, headerObject } from "../../vault/header-codec.ts";
import type { StoredRecord, VaultImage } from "../../vault/store.ts";
import type { HardwarePin } from "./driver.ts";

export const HARDWARE_WALLET_KIND = "hardware-wallet";

const HARDENED = 0x80000000;
/** The device's own strings are untrusted — only printable ASCII under 64 chars survives. */
const DEVICE_TEXT = /^[ -~]{1,64}$/;
/** The device-kind shape: a lowercase slug — unknown kinds are authenticated but inert. */
// oxlint-disable-next-line no-inferrable-types -- isolatedDeclarations requires the annotation.
export const DEVICE_KIND: RegExp = /^[a-z][a-z0-9-]{1,31}$/;

export type HardwareHeader = {
  /** The device kind — possibly one this build does not know. */
  readonly device: string;
  /** The BIP-32 master fingerprint the device claimed at pairing, 4 bytes. */
  readonly fingerprint: Uint8Array;
  readonly model?: string;
  readonly firmware?: string;
  readonly createdAt: number;
};

/** Whether this build ships a driver for the header's device kind. */
export const deviceSupported = (device: string): boolean =>
  HARDWARE_DEVICES.some((known) => known === device);

/**
 * Stable hardware-wallet identifier, domain-separated from the software wallet id:
 * SHA-256(UTF-8("qntx-wallet/hardware-wallet-id/v1") ‖ UTF-8(device) ‖ 0x00 ‖ fingerprint4)[0..8].
 * The same device re-paired maps to the same id — the pair handler answers `already-exists`.
 */
export function hardwareWalletId(device: string, fingerprint: Uint8Array): string {
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

const asDevice = (value: unknown): string => {
  if (typeof value !== "string" || !DEVICE_KIND.test(value)) {
    throw headerFailure();
  }
  return value;
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
    supported: deviceSupported(header.device),
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

/** The sealed body: the pinned keys plus the entries an on-device check confirmed. */
export type HardwareBody = {
  readonly keys: PinnedKeys;
  /** Paths of pinned entries `verify-address` matched on the device, sorted `m/…` strings. */
  readonly confirmed: ReadonlyArray<KeyPath>;
};

/**
 * Parses the sealed body through the shared pinned-material codec: every node is a real secp256k1
 * point, every ed25519 entry a real point, every path well-formed, the caps (512 nodes, 256
 * ed25519) hold, and `confirmed` is canonical — sorted, unique, naming only pinned entries.
 * Hardware pins additionally require all-hardened ed25519 paths — SLIP-10 has no public derivation,
 * so a softer path could never be served. Anything less is `integrity`.
 */
export function parseHardwareBody(plaintext: Uint8Array): HardwareBody {
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
  if (Object.keys(body).length !== 3) {
    throw bodyFailure();
  }
  const keys: PinnedKeys = {
    nodes: parsePinnedNodes(body["nodes"]),
    ed25519: parsePinnedEd25519(body["ed25519"]),
  };
  for (const key of keys.ed25519) {
    if (key.path.some((i) => i < HARDENED)) {
      throw bodyFailure();
    }
  }
  const confirmed = parseConfirmed(body["confirmed"], keys);
  return { keys, confirmed };
}

/**
 * The `confirmed` list: `m/…` paths in canonical order — sorted as strings, unique, and every one
 * naming an entry the body actually pins. Anything less is `integrity`: a confirmed entry that is
 * not pinned would certify material the record does not carry.
 */
const parseConfirmed = (value: unknown, keys: PinnedKeys): KeyPath[] => {
  if (!Array.isArray(value)) {
    throw bodyFailure();
  }
  const texts: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw bodyFailure();
    }
    texts.push(entry);
  }
  const sorted = [...texts].sort();
  if (sorted.some((text, i) => text !== texts[i] || (i > 0 && text === sorted[i - 1]))) {
    throw bodyFailure();
  }
  const pinned = new Set([
    ...keys.nodes.map((node) => pathToString(node.path)),
    ...keys.ed25519.map((key) => pathToString(key.path)),
  ]);
  return texts.map((text) => {
    if (!pinned.has(text)) {
      throw bodyFailure();
    }
    return pathFromString(text);
  });
};

/** The body's canonical JSON — fixed key order, `m/…` paths, lowercase hex. */
export function encodeHardwareBody(body: HardwareBody): Uint8Array {
  const { keys } = body;
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
  const confirmed = body.confirmed.map(pathToString).sort();
  return utf8ToBytes(JSON.stringify({ nodes, ed25519: ed, confirmed }));
}

/** The pin a record seals: the claimed fingerprint plus the pinned keys. */
export function hardwarePin(header: HardwareHeader, keys: PinnedKeys): HardwarePin {
  return { fingerprint: header.fingerprint, nodes: keys.nodes, ed25519: keys.ed25519 };
}
