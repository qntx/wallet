/**
 * The Keystone driver's UR edge on `@qntx/ur`'s typed layer. Every wire format the driver speaks —
 * the pairing sync, the sign requests and signatures, `crypto-psbt` and the `qr-hardware-call`
 * key-derivation request — is a library registry or interop codec; this module only bounds and
 * types the exchange and builds the request keypaths.
 *
 * `decodeUr` is the only entry device bytes reach: it re-asserts the payload bound the protocol
 * already applies, then folds every decode failure — a dcbor `CborError`, a library `UrError`, the
 * host `RangeError` hostile nesting can raise — into `KernelError("integrity")`. An encode failure
 * means the request the kernel built was malformed and closes the same way; no untyped error ever
 * escapes this module.
 */
import { CborError } from "@blockchaincommons/dcbor";

import type { Keypath } from "@qntx/ur/registry";
import { Ur, fromUr, toUr } from "@qntx/ur/typed";
import type { UrCodec } from "@qntx/ur/typed";
import type { KeyPath } from "@qntx/wallet-chains";

import { KernelError } from "../../../errors.ts";

/** Device answers are QR payloads — the protocol already bounds them; the decode re-asserts. */
const MAX_BYTES = 262_144;

const HARDENED = 0x80000000;

function integrity(): never {
  throw new KernelError("integrity", "malformed device UR exchange");
}

/** DCBOR `bytes` carried by UR `type`, decoded by `codec`; every failure is `integrity`. */
export const decodeUr = <T>(type: string, bytes: Uint8Array, codec: UrCodec<T>): T => {
  try {
    if (bytes.length === 0 || bytes.length > MAX_BYTES) {
      throw CborError.outOfRange();
    }
    return fromUr(Ur.fromCborData(type, bytes), codec);
  } catch (error) {
    if (error instanceof KernelError) {
      throw error;
    }
    throw new KernelError("integrity", "malformed device UR exchange");
  }
};

/** `codec`'s untagged dCBOR body for `value`; a malformed request build is `integrity`. */
export const encodeUr = <T>(value: T, codec: UrCodec<T>): Uint8Array => {
  try {
    return toUr(value, codec).toCborData();
  } catch (error) {
    if (error instanceof KernelError) {
      throw error;
    }
    throw new KernelError("integrity", "malformed device UR exchange");
  }
};

/** A BIP-32 master fingerprint as its uint32 wire form (the registry's `sourceFingerprint`). */
export const fingerprintNumber = (fingerprint: Uint8Array): number => {
  if (fingerprint.length !== 4) {
    integrity();
  }
  return new DataView(fingerprint.buffer, fingerprint.byteOffset, 4).getUint32(0);
};

/** A uint32 wire fingerprint back to its four big-endian bytes. */
export const fingerprintBytes = (fingerprint: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, fingerprint);
  return out;
};

/** The `crypto-keypath` a sign or derivation request carries: index steps plus the fingerprint. */
export const requestKeypath = (path: KeyPath, fingerprint: Uint8Array): Keypath => ({
  components: path.map((component) => ({
    kind: "index" as const,
    index: component % HARDENED,
    hardened: component >= HARDENED,
  })),
  sourceFingerprint: fingerprintNumber(fingerprint),
});
