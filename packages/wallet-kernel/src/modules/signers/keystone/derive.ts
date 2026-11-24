/**
 * The Keystone `qr-hardware-call` key-derivation exchange: the wallet asks the device to derive
 * hardened nodes the sync could not pin (per-group account xpubs, solana change leaves). The
 * request paths are checked against the firmware's `check_hardware_call_path` allow-list before
 * anything is shown, and the `crypto-multi-accounts` answer must cover exactly the requested paths
 * — anything missing, extra or duplicated fails closed (`integrity`). The claimed master
 * fingerprint is returned unchanged; the module compares it against the pin and maps a mismatch to
 * `wrong-device`.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { cryptoMultiAccountsCodec } from "@qntx/ur/interop";
import type { KeyPath } from "@qntx/wallet-chains";

import { KernelError } from "../../../errors.ts";
import type { DeviceLink, PairingResult, PinnedEd25519, PinnedNode } from "../driver.ts";
import { pathToString } from "../record.ts";
import { pathOf, samePath } from "./sync.ts";
import { decodeUr, encodeUr, fingerprintBytes, qrHardwareCallCodec, requestKeypath } from "./ur.ts";

const HARDENED = 0x80000000;
const ORIGIN = "qntx";

const h = (...indices: number[]): KeyPath => indices.map((i) => i + HARDENED);

/**
 * The path prefixes firmware 3.2.2 derives on request (`is_supported_hardware_call_path`): a prefix
 * matches the path itself or any extension of it.
 */
const DERIVABLE_PREFIXES: ReadonlyArray<KeyPath> = [
  h(44, 0),
  h(49),
  h(84),
  h(86),
  h(44, 60),
  h(44, 501),
  h(44, 144),
  h(1852, 1815),
  h(1853, 1815),
  h(1854, 1815),
  h(44, 195),
  h(44, 145),
  h(44, 637),
  h(44, 784),
  h(44, 5),
  h(44, 472),
  h(44, 148),
  h(44, 118),
  h(44, 394),
  h(44, 459),
  h(44, 330),
  h(44, 529),
  h(44, 564),
  h(44, 234),
  h(44, 931),
  h(44, 4218),
  h(44, 9000),
];

const under = (prefix: KeyPath, path: KeyPath): boolean =>
  path.length >= prefix.length && prefix.every((v, i) => path[i] === v);

function integrity(): never {
  throw new KernelError("integrity", "malformed key-derivation answer");
}

/** `accounts` driver op: refuse underivable paths, then exchange and pin exactly what was asked. */
export const derive = async (
  link: DeviceLink,
  need: { readonly secp256k1: ReadonlyArray<KeyPath>; readonly ed25519: ReadonlyArray<KeyPath> },
  pin: { readonly fingerprint: Uint8Array },
): Promise<PairingResult> => {
  for (const path of [...need.secp256k1, ...need.ed25519]) {
    if (!DERIVABLE_PREFIXES.some((prefix) => under(prefix, path))) {
      throw new KernelError("unsupported", `keystone cannot derive ${pathToString(path)} over QR`);
    }
  }
  const response = await link.exchange({
    kind: "qr",
    show: {
      type: "qr-hardware-call",
      cbor: encodeUr(
        {
          schemas: [
            ...need.secp256k1.map((path) => ({
              path: requestKeypath(path, pin.fingerprint),
              curve: "secp256k1" as const,
            })),
            ...need.ed25519.map((path) => ({
              path: requestKeypath(path, pin.fingerprint),
              curve: "ed25519" as const,
            })),
          ],
          origin: ORIGIN,
        },
        qrHardwareCallCodec,
      ),
    },
    scan: ["crypto-multi-accounts"],
  });
  if (response.kind !== "qr" || response.ur.type !== "crypto-multi-accounts") {
    integrity();
  }
  const accounts = decodeUr("crypto-multi-accounts", response.ur.cbor, cryptoMultiAccountsCodec);
  const nodes: PinnedNode[] = [];
  const ed25519: PinnedEd25519[] = [];
  const answered: KeyPath[] = [];
  for (const key of accounts.keys) {
    const { origin } = key.key;
    const path = origin === undefined ? undefined : pathOf(origin);
    if (
      origin?.sourceFingerprint !== undefined &&
      origin.sourceFingerprint !== accounts.masterFingerprint
    ) {
      integrity();
    }
    if (path === undefined) {
      integrity();
    }
    if (need.secp256k1.some((wanted) => samePath(path, wanted))) {
      if (key.curve !== "secp256k1") {
        integrity();
      }
      const node = key.key;
      if (
        node.chainCode === undefined ||
        node.chainCode.length !== 32 ||
        !secp256k1.utils.isValidPublicKey(node.keyData)
      ) {
        integrity();
      }
      nodes.push({
        path,
        publicKey: new Uint8Array(node.keyData),
        chainCode: new Uint8Array(node.chainCode),
        ...(node.parentFingerprint === undefined
          ? {}
          : { parent: fingerprintBytes(node.parentFingerprint) }),
      });
    } else if (need.ed25519.some((wanted) => samePath(path, wanted))) {
      if (key.curve !== "ed25519") {
        integrity();
      }
      ed25519.push({ path, publicKey: new Uint8Array(key.key.keyData) });
    }
    answered.push(path);
  }
  // The answer must name exactly the requested paths — an extra, duplicated or missing key fails.
  const wanted = [...need.secp256k1, ...need.ed25519];
  if (
    answered.length !== wanted.length ||
    !wanted.every((w) => answered.some((a) => samePath(a, w)))
  ) {
    integrity();
  }
  return {
    fingerprint: fingerprintBytes(accounts.masterFingerprint),
    ...(accounts.device === undefined ? {} : { model: accounts.device }),
    ...(accounts.version === undefined ? {} : { firmware: accounts.version }),
    nodes,
    ed25519,
  };
};
