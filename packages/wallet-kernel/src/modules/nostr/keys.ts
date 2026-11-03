import { getPublicKey } from "@qntx/nostr";
import type { Factor, NostrExportFormat, NullValue } from "@qntx/wallet/protocol";
import type { NostrKeyInfo } from "@qntx/wallet/types";

import type { KernelContext } from "../../commands/context.ts";
import { withWalletSeed } from "../../commands/vault.ts";
import { masterKey } from "../../derive/hd.ts";
import { KernelError } from "../../errors.ts";
import { corePromptFor } from "../../prompts.ts";
import { wipe } from "../../secret/secret.ts";
import type { Secret } from "../../secret/secret.ts";
import type { StoredRecord } from "../../vault/store.ts";
import { findRecord, openRecord, sealRecord, verifyFactor } from "../../vault/vault.ts";
import { nostrKeyAt } from "./derive.ts";
import { ncryptsecFromSecretKey, nsecFromSecretKey } from "./pool.ts";
import type { NostrKeyHeader } from "./record.ts";
import { encodeNostrKeyHeader, NOSTR_KEY_KIND, nostrKeyInfo } from "./record.ts";

function keyRecord(
  ctx: KernelContext,
  dek: Secret,
  secretKey: Uint8Array,
  header: NostrKeyHeader,
): StoredRecord {
  return sealRecord(
    ctx.platform,
    dek,
    NOSTR_KEY_KIND,
    header.publicKey,
    encodeNostrKeyHeader(header),
    new Uint8Array(secretKey),
  );
}

function ensureNewKey(ctx: KernelContext, publicKey: string): void {
  if (ctx.image.records.some((r) => r.kind === NOSTR_KEY_KIND && r.id === publicKey)) {
    throw new KernelError("already-exists", "nostr key already exists");
  }
}

export async function deriveKey(
  ctx: KernelContext,
  params: { walletId: string; index: number },
  requestSession: string | undefined,
): Promise<NostrKeyInfo> {
  const { dek } = ctx.session.require(requestSession);
  const record = findRecord(ctx.image, "entropy", params.walletId);
  return withWalletSeed(ctx.platform.pbkdf2, dek, record, async (seed) => {
    const master = masterKey(seed);
    try {
      const secretKey = nostrKeyAt(master, params.index);
      try {
        const publicKey = getPublicKey(secretKey);
        ensureNewKey(ctx, publicKey);
        const header: NostrKeyHeader = {
          publicKey,
          walletId: params.walletId,
          index: params.index,
          createdAt: ctx.platform.now(),
        };
        await ctx.commit([{ op: "put-record", record: keyRecord(ctx, dek, secretKey, header) }]);
        return nostrKeyInfo(header);
      } finally {
        wipe(secretKey);
      }
    } finally {
      master.wipePrivateData();
    }
  });
}

export async function discover(
  ctx: KernelContext,
  params: { walletId: string; from: number; count: number },
  requestSession: string | undefined,
): Promise<{ keys: Array<{ index: number; publicKey: string }> }> {
  const { dek } = ctx.session.require(requestSession);
  const record = findRecord(ctx.image, "entropy", params.walletId);
  if (params.from + params.count - 1 > 0x7ffffffe) {
    throw new KernelError("invalid-input", "identity range exceeds 0x7ffffffe");
  }
  const keys: Array<{ index: number; publicKey: string }> = [];
  return withWalletSeed(ctx.platform.pbkdf2, dek, record, (seed) => {
    const master = masterKey(seed);
    try {
      for (let i = 0; i < params.count; i++) {
        const index = params.from + i;
        const secretKey = nostrKeyAt(master, index);
        keys.push({ index, publicKey: getPublicKey(secretKey) });
        wipe(secretKey);
      }
      return { keys };
    } finally {
      master.wipePrivateData();
    }
  });
}

export async function removeKey(
  ctx: KernelContext,
  params: { publicKey: string },
  requestSession: string | undefined,
): Promise<NullValue> {
  ctx.session.require(requestSession);
  findRecord(ctx.image, NOSTR_KEY_KIND, params.publicKey);
  // Reconciliation forgets the live signer once the delete lands.
  await ctx.commit([{ op: "delete-record", kind: NOSTR_KEY_KIND, id: params.publicKey }]);
  return null;
}

export async function exportKey(
  ctx: KernelContext,
  params: { verify: Factor; publicKey: string; format: NostrExportFormat },
  requestSession: string | undefined,
): Promise<Uint8Array> {
  const { dek } = ctx.session.require(requestSession);
  await verifyFactor(
    ctx.platform,
    ctx.image,
    params.verify,
    dek,
    corePromptFor(ctx.platform.keystore, "export-key"),
  );
  const record = findRecord(ctx.image, NOSTR_KEY_KIND, params.publicKey);
  const secretKey = openRecord(dek, record);
  try {
    const exported =
      params.format.kind === "nsec"
        ? nsecFromSecretKey(secretKey)
        : await ncryptsecFromSecretKey(secretKey, params.format.password);
    return exported;
  } finally {
    wipe(secretKey);
  }
}
