/**
 * The proxy NostrSigner: the ref resolves against the CURRENT snapshot at every call, so the same
 * signer object keeps working across lock/unlock and worker respawns. Returned events are checked
 * against the request — a compromised kernel cannot make a valid signature over different content
 * pass as the requested event.
 */
import { signedMatchesUnsigned, verifyEvent } from "@qntx/nostr";
import type { UnsignedEvent } from "@qntx/nostr";
import type { Rumor } from "@qntx/nostr/nips/nip59";

import { integrity } from "../channel.ts";
import type { WalletInternals } from "../internal.ts";
import { MAX_BATCH } from "../protocol/core.ts";
import type { UnsignedEventInput } from "../protocol/index.ts";
import { WalletError } from "../types.ts";
import type { NostrKeyInfo, NostrKeyRef } from "../types.ts";
import type { WalletSigner, WalletSyncSigner } from "./types.ts";

/** Resolves a public ref to its stored key record; missing refs are `not-found`. */
export function keyInfoOf(internals: WalletInternals, ref: NostrKeyRef): NostrKeyInfo {
  const info = internals.snapshot().nostr.keys.find((key) => {
    const k = key.ref;
    return ref.kind === "derived" && k.walletId === ref.walletId && k.index === ref.index;
  });
  if (info === undefined) {
    throw new WalletError("not-found", "no such nostr key");
  }
  return info;
}

export function proxySigner(ref: NostrKeyRef, internals: WalletInternals): WalletSigner {
  const resolvePublicKey = (): string => keyInfoOf(internals, ref).publicKey;
  return {
    getPublicKey: async () => {
      await internals.ready();
      return resolvePublicKey();
    },
    signEvent: async (unsigned) => {
      const publicKey = resolvePublicKey();
      // An absent pubkey must stay absent: `pubkey: undefined` is not a ProtocolValue and the
      // kernel would reject the params outright.
      const event: UnsignedEventInput =
        unsigned.pubkey === undefined
          ? {
              kind: unsigned.kind,
              created_at: unsigned.created_at,
              tags: unsigned.tags,
              content: unsigned.content,
            }
          : {
              kind: unsigned.kind,
              created_at: unsigned.created_at,
              tags: unsigned.tags,
              content: unsigned.content,
              pubkey: unsigned.pubkey,
            };
      const signed = await internals.call("nostr.signEvent", { publicKey, event });
      // The kernel output must be the requested event, signed by the expected key.
      const requested: UnsignedEvent = {
        kind: unsigned.kind,
        created_at: unsigned.created_at,
        tags: unsigned.tags,
        content: unsigned.content,
        pubkey: publicKey,
      };
      if (
        signed.pubkey !== publicKey ||
        !signedMatchesUnsigned(signed, requested) ||
        !verifyEvent(signed)
      ) {
        throw integrity("the kernel returned a forged event");
      }
      return signed;
    },
    nip04Encrypt: async (peer, plaintext) =>
      internals.call("nostr.nip04Encrypt", {
        publicKey: resolvePublicKey(),
        peer,
        text: plaintext,
      }),
    nip04Decrypt: async (peer, ciphertext) =>
      internals.call("nostr.nip04Decrypt", {
        publicKey: resolvePublicKey(),
        peer,
        text: ciphertext,
      }),
    nip44Encrypt: async (peer, plaintext) =>
      internals.call("nostr.nip44Encrypt", {
        publicKey: resolvePublicKey(),
        peer,
        text: plaintext,
      }),
    nip44Decrypt: async (peer, payload) =>
      internals.call("nostr.nip44Decrypt", {
        publicKey: resolvePublicKey(),
        peer,
        text: payload,
      }),
    unwrapGiftWraps: async (events) => {
      if (events.length === 0) {
        return [];
      }
      const publicKey = resolvePublicKey();
      const results: Array<Rumor | Error> = [];
      // The wire caps one batch at MAX_BATCH; chunk sequentially and concatenate in order —
      // other requests can interleave between chunks.
      for (let start = 0; start < events.length; start += MAX_BATCH) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential on purpose: chunks round-trip in order
        const batch = await internals.call("nostr.unwrapGiftWraps", {
          publicKey,
          events: events.slice(start, start + MAX_BATCH),
        });
        for (const r of batch.results) {
          results.push("ok" in r ? r.ok : new Error(r.err));
        }
      }
      return results;
    },
  };
}

/**
 * The wallet metadata sync signer (WD-076): the key lives at the reserved NIP-06 segment and is
 * sealed by `nostr.syncKey` on first use, so `getPublicKey` both returns and creates it. Signed
 * events pass the same forged-event check as `proxySigner`.
 */
export function syncSigner(walletId: string, internals: WalletInternals): WalletSyncSigner {
  let cached: string | undefined;
  const publicKey = async (): Promise<string> => {
    if (cached === undefined) {
      const resolved = await internals.call("nostr.syncKey", { walletId });
      cached = resolved.publicKey;
    }
    return cached;
  };
  return {
    getPublicKey: publicKey,
    signEvent: async (unsigned) => {
      const expected = await publicKey();
      const event: UnsignedEventInput = {
        kind: unsigned.kind,
        created_at: unsigned.created_at,
        tags: unsigned.tags,
        content: unsigned.content,
      };
      const signed = await internals.call("nostr.syncSign", { walletId, event });
      const requested: UnsignedEvent = {
        kind: unsigned.kind,
        created_at: unsigned.created_at,
        tags: unsigned.tags,
        content: unsigned.content,
        pubkey: expected,
      };
      if (
        signed.pubkey !== expected ||
        !signedMatchesUnsigned(signed, requested) ||
        !verifyEvent(signed)
      ) {
        throw integrity("the kernel returned a forged event");
      }
      return signed;
    },
    encrypt: async (text) => internals.call("nostr.syncEncrypt", { walletId, text }),
    decrypt: async (payload) => internals.call("nostr.syncDecrypt", { walletId, text: payload }),
  };
}
