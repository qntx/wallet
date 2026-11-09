import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * The family byte that namespaces an imported key's keyId: 0x01 evm, 0x02 solana, 0x03 bitcoin. The
 * same secret on two families maps to different keyIds.
 */
export const KEY_FAMILY_BYTE = { evm: 0x01, solana: 0x02, bitcoin: 0x03 } as const;
export type KeyFamily = keyof typeof KEY_FAMILY_BYTE;

/**
 * Stable imported-key identifier: lowercase hex of the first 8 bytes of
 * SHA-256(UTF-8("qntx-wallet/key-id/v1") ‖ familyByte ‖ publicKey). Derived from public data only —
 * safe to use as a record id.
 */
export function keyIdOf(family: KeyFamily, publicKey: Uint8Array): string {
  return bytesToHex(
    sha256(
      concatBytes(
        utf8ToBytes("qntx-wallet/key-id/v1"),
        Uint8Array.of(KEY_FAMILY_BYTE[family]),
        publicKey,
      ),
    ).slice(0, 8),
  );
}
