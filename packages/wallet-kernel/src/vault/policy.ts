/**
 * Vault policy records: settings that change what the kernel will sign, sealed under the DEK like
 * the secrets they guard. A setting is on when its record exists; changing one takes a fresh
 * verification. The record's presence is public (status reports it), but only a record that opens
 * under the DEK counts as consent — a row written by anything else is an integrity failure.
 */
import type { KernelPlatform } from "../platform.ts";
import type { Secret } from "../secret/secret.ts";
import { wipe } from "../secret/secret.ts";
import { encodePolicyHeader } from "./headers.ts";
import type { StoredRecord, VaultImage } from "./store.ts";
import { openRecord, sealRecord } from "./vault.ts";

export const POLICY_KIND = "policy";
export const BLIND_SIGNING = "blind-signing";

const MARKER = 0x01;

export const policyRecord = (image: VaultImage, id: string): StoredRecord | undefined =>
  image.records.find((record) => record.kind === POLICY_KIND && record.id === id);

export const sealPolicy = (platform: KernelPlatform, dek: Secret, id: string): StoredRecord =>
  sealRecord(
    platform,
    dek,
    POLICY_KIND,
    id,
    encodePolicyHeader(platform.now()),
    new Uint8Array([MARKER]),
  );

/** Whether the vault's owner turned the policy `id` on. */
export function policyEnabled(image: VaultImage, dek: Secret, id: string): boolean {
  const record = policyRecord(image, id);
  if (record === undefined) {
    return false;
  }
  wipe(openRecord(dek, record));
  return true;
}
