/**
 * The card module: owns the `card-wallet` record kind and the `card.*` method table. This layer
 * carries the record lifecycle — live public material is claimed at unlock, dropped at lock and on
 * forget — so `wallet.accounts` answers from card material and every seed-seeking caller refuses
 * card wallets cleanly. The tap engine and real `card.*` handlers land in the next layer; for now
 * every `card.*` call validates against the protocol table and answers `unsupported`.
 */
import type { CARD_METHODS, MethodName } from "@qntx/wallet/protocol";

import type { Handler, VaultHooks } from "../../commands/context.ts";
import type { PublicMaterial } from "../../derive/material.ts";
import { KernelError } from "../../errors.ts";
import type { KernelPlatform } from "../../platform.ts";
import { wipe } from "../../secret/secret.ts";
import type { OpenedRecord } from "../../vault/vault.ts";
import { cardMaterial } from "./material.ts";
import { CARD_WALLET_KIND, parseCardWalletBody, parseCardWalletHeader } from "./record.ts";

export type CardModule = {
  readonly vault: VaultHooks;
  readonly handlers: { [M in keyof typeof CARD_METHODS & MethodName]: Handler<M> };
  /** Live public material for an unlocked card wallet — `undefined` while locked or unknown. */
  readonly material: (walletId: string) => PublicMaterial | undefined;
};

export function createCardModule(platform: KernelPlatform): CardModule {
  const live = new Map<string, PublicMaterial>();

  const unsupported = (): never => {
    if (platform.card === undefined) {
      throw new KernelError("unsupported", "this host has no card reader");
    }
    throw new KernelError("unsupported", "card operations arrive in a later build");
  };

  const vault: VaultHooks = {
    ownsRecord: (kind) => kind === CARD_WALLET_KIND,
    claimUnlocked: (records) => {
      const unclaimed: OpenedRecord[] = [];
      for (const record of records) {
        if (record.kind !== CARD_WALLET_KIND) {
          unclaimed.push(record);
          continue;
        }
        try {
          const text = new TextDecoder().decode(record.plaintext);
          live.set(record.id, cardMaterial(parseCardWalletBody(text, record.id)));
        } finally {
          wipe(record.plaintext);
        }
      }
      return unclaimed;
    },
    forget: (kind, id) => {
      if (kind === CARD_WALLET_KIND) {
        live.delete(id);
      }
    },
    lock: () => {
      live.clear();
    },
    walletDeleteOps: () => [],
    parseHeader: (record) => {
      parseCardWalletHeader(record.header);
    },
  };

  const handlers: { [M in keyof typeof CARD_METHODS & MethodName]: Handler<M> } = {
    "card.begin": (ctx, _params, session) => {
      ctx.session.require(session);
      return unsupported();
    },
    "card.step": (ctx, _params, session) => {
      ctx.session.require(session);
      return unsupported();
    },
    "card.cancel": (ctx, _params, session) => {
      ctx.session.require(session);
      return unsupported();
    },
  };

  return {
    vault,
    handlers,
    material: (walletId) => live.get(walletId),
  };
}
