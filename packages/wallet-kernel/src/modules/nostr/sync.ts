import { getPublicKey } from "@qntx/nostr";
import type { SignedEvent, UnsignedEventInput } from "@qntx/wallet/protocol";

import type { KernelContext } from "../../commands/context.ts";
import { withWalletSeed } from "../../commands/vault.ts";
import { masterKey } from "../../derive/hd.ts";
import { KernelError } from "../../errors.ts";
import { wipe } from "../../secret/secret.ts";
import type { StoredRecord } from "../../vault/store.ts";
import { findRecord, sealRecord } from "../../vault/vault.ts";
import { nostrKeyAt } from "./derive.ts";
import { signEvent } from "./pool.ts";
import type { SignerPool } from "./pool.ts";
import { NOSTR_SYNC_KEY_KIND, encodeSyncKeyHeader, parseSyncKeyHeader } from "./record.ts";
import type { SyncKeyHeader } from "./record.ts";

/**
 * Wallet metadata sync — WD-076/WD-070. Every wallet owns one dedicated signing key at the NIP-06
 * segment `m/44'/1237'/2147483647'/0/0` — above every identity index — used only to author and
 * encrypt its kind-30078 metadata events. The record is seed-derived, so backups stay wallets-only
 * and the key is never exportable.
 */
const SYNC_INDEX = 0x7fffffff;

/** The vault's one sync-key record for `walletId`, or `not-found`. */
function syncRecord(ctx: KernelContext, walletId: string): StoredRecord {
  // Every wallet is an entropy record — an unknown walletId answers not-found here too.
  findRecord(ctx.image, "entropy", walletId);
  for (const record of ctx.image.records) {
    if (record.kind === NOSTR_SYNC_KEY_KIND) {
      const header = parseSyncKeyHeader(record.header);
      if (header.walletId === walletId) {
        return record;
      }
    }
  }
  throw new KernelError("not-found", "no sync key for this wallet");
}

/**
 * Returns the wallet's sync key, deriving and sealing it on first use. The guarded commit makes a
 * concurrent first use an `already-exists`, after which the re-read answers the winner's record.
 */
export async function syncKey(
  ctx: KernelContext,
  params: { walletId: string },
  requestSession: string | undefined,
): Promise<{ publicKey: string }> {
  const { dek } = ctx.session.require(requestSession);
  try {
    return { publicKey: parseSyncKeyHeader(syncRecord(ctx, params.walletId).header).publicKey };
  } catch (error) {
    if (!(error instanceof KernelError && error.code === "not-found")) {
      throw error;
    }
    // No record yet — derive and commit below.
  }
  const wallet = findRecord(ctx.image, "entropy", params.walletId);
  return withWalletSeed(ctx.platform.pbkdf2, dek, wallet, async (seed) => {
    const master = masterKey(seed);
    try {
      const secretKey = nostrKeyAt(master, SYNC_INDEX);
      try {
        const publicKey = getPublicKey(secretKey);
        const header: SyncKeyHeader = {
          publicKey,
          walletId: params.walletId,
          createdAt: ctx.platform.now(),
        };
        const record = sealRecord(
          ctx.platform,
          dek,
          NOSTR_SYNC_KEY_KIND,
          publicKey,
          encodeSyncKeyHeader(header),
          new Uint8Array(secretKey),
        );
        try {
          await ctx.commit([{ op: "put-record", record }]);
        } catch (error) {
          if (!(error instanceof KernelError && error.code === "conflict")) {
            throw error;
          }
          // Concurrent first use — the guarded commit lost; re-read the winner.
          return {
            publicKey: parseSyncKeyHeader(syncRecord(ctx, params.walletId).header).publicKey,
          };
        }
        return { publicKey };
      } finally {
        wipe(secretKey);
      }
    } finally {
      master.wipePrivateData();
    }
  });
}

function requireSyncSigner(ctx: KernelContext, pool: SignerPool, walletId: string) {
  const record = syncRecord(ctx, walletId);
  const { publicKey } = parseSyncKeyHeader(record.header);
  return pool.get(publicKey);
}

export async function syncSign(
  ctx: KernelContext,
  pool: SignerPool,
  params: { walletId: string; event: UnsignedEventInput },
  requestSession: string | undefined,
): Promise<SignedEvent> {
  ctx.session.require(requestSession);
  if (params.event.kind !== 30078) {
    throw new KernelError("invalid-input", "sync signer authors kind-30078 events only");
  }
  const signer = requireSyncSigner(ctx, pool, params.walletId);
  return signEvent(pool, signer.keys.publicKey, params.event);
}

export async function syncEncrypt(
  ctx: KernelContext,
  pool: SignerPool,
  params: { walletId: string; text: string },
  requestSession: string | undefined,
): Promise<string> {
  ctx.session.require(requestSession);
  const signer = requireSyncSigner(ctx, pool, params.walletId);
  const { publicKey } = signer.keys;
  return signer.nip44Encrypt(publicKey, params.text); // sealed to the key itself
}

export async function syncDecrypt(
  ctx: KernelContext,
  pool: SignerPool,
  params: { walletId: string; text: string },
  requestSession: string | undefined,
): Promise<string> {
  ctx.session.require(requestSession);
  const signer = requireSyncSigner(ctx, pool, params.walletId);
  const { publicKey } = signer.keys;
  return signer.nip44Decrypt(publicKey, params.text);
}
