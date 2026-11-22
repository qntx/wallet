/**
 * The sessions module: the `session-key` record kind and the sessions.* commands. Wired once in
 * kernel.ts — the VaultHooks give the core the explicit seams (record ownership, reconcile
 * claim/forget, wallet-delete ops, public-header parsing) without the core knowing what a session
 * key is. A record's scheme only decides what it signs: records of schemes this build does not know
 * are inert — listed as unsupported, unsignable, deletable — and never make the vault unsupported.
 *
 * There is no live state: like imported keys, the session's private key stays sealed and is opened
 * per signature, so `lock`/`forget` have nothing to dispose.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import type { MethodName, SESSIONS_METHODS } from "@qntx/wallet/protocol";

import type { Handler, VaultHooks } from "../../commands/context.ts";
import { KernelError } from "../../errors.ts";
import { wipe } from "../../secret/secret.ts";
import type { StoreOp } from "../../vault/store.ts";
import type { OpenedRecord } from "../../vault/vault.ts";
import { parseSessionHeader, SESSION_KIND } from "./record.ts";
import { schemeOf } from "./schemes/index.ts";
import { createSession, deleteSession, listSessions, signSession } from "./sessions.ts";

export type SessionsModule = {
  readonly vault: VaultHooks;
  readonly handlers: { [M in keyof typeof SESSIONS_METHODS & MethodName]: Handler<M> };
};

export function createSessionsModule(): SessionsModule {
  const vault: VaultHooks = {
    ownsRecord: (kind) => kind === SESSION_KIND,

    /* A session key is claimed only to authenticate it, then wiped — nothing stays live. A key
       whose address is not the record id proves the vault was tampered: latch corrupted. The check
       runs for every session-key record regardless of scheme — the record format fixes the key↔id
       binding even for schemes this build does not know. */
    claimUnlocked: (records) => {
      const unclaimed: OpenedRecord[] = [];
      for (const record of records) {
        if (record.kind !== SESSION_KIND) {
          unclaimed.push(record);
          continue;
        }
        const matches =
          record.plaintext.length === 32 &&
          secp256k1.utils.isValidSecretKey(record.plaintext) &&
          evmAddressFromPublicKey(secp256k1.getPublicKey(record.plaintext, true)).toLowerCase() ===
            record.id;
        wipe(record.plaintext);
        if (!matches) {
          throw new KernelError(
            "integrity",
            "session key does not match its record",
            undefined,
            true,
          );
        }
      }
      return unclaimed;
    },

    forget: () => undefined,
    lock: () => undefined,

    parseHeader: (record) => {
      const header = parseSessionHeader(record.header);
      /* A known scheme re-validates its scope — a stored scope the scheme rejects is as corrupt
         as a malformed header. An unknown scheme's header is only the generic shape. */
      schemeOf(header.scheme)?.parseScope(header.scope);
    },

    walletDeleteOps: (image, walletId) => {
      const ops: StoreOp[] = [];
      for (const record of image.records) {
        if (
          record.kind === SESSION_KIND &&
          parseSessionHeader(record.header).walletId === walletId
        ) {
          ops.push({ op: "delete-record", kind: SESSION_KIND, id: record.id });
        }
      }
      return ops;
    },
  };

  const handlers: { [M in keyof typeof SESSIONS_METHODS & MethodName]: Handler<M> } = {
    "sessions.create": createSession,
    "sessions.list": listSessions,
    "sessions.delete": deleteSession,
    "sessions.sign": signSession,
  };

  return { vault, handlers };
}
