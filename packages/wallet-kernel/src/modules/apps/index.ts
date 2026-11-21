/**
 * The apps module: the `hl-agent` record kind and the hyperliquid.* commands. Wired once in
 * kernel.ts — the VaultHooks give the core the explicit seams (record ownership, reconcile
 * claim/forget, wallet-delete ops) without the core knowing what an agent key is.
 *
 * There is no live state: like imported keys, the agent's private key stays sealed and is opened
 * per signature, so `lock`/`forget` have nothing to dispose.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";

import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import type { APPS_METHODS, MethodName } from "@qntx/wallet/protocol";

import type { Handler, VaultHooks } from "../../commands/context.ts";
import { KernelError } from "../../errors.ts";
import { wipe } from "../../secret/secret.ts";
import type { StoreOp } from "../../vault/store.ts";
import type { OpenedRecord } from "../../vault/vault.ts";
import { createAgent, deleteAgent, listAgents, signL1 } from "./agents.ts";
import { HL_AGENT_KIND, parseAgentHeader } from "./record.ts";

export type AppsModule = {
  readonly vault: VaultHooks;
  readonly handlers: { [M in keyof typeof APPS_METHODS & MethodName]: Handler<M> };
};

export function createAppsModule(): AppsModule {
  const vault: VaultHooks = {
    ownsRecord: (kind) => kind === HL_AGENT_KIND,

    /* An agent key is claimed only to authenticate it, then wiped — nothing stays live. A key
       whose address is not the record id proves the vault was tampered: latch corrupted. */
    claimUnlocked: (records) => {
      const unclaimed: OpenedRecord[] = [];
      for (const record of records) {
        if (record.kind !== HL_AGENT_KIND) {
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
            "agent key does not match its record",
            undefined,
            true,
          );
        }
      }
      return unclaimed;
    },

    forget: () => undefined,
    lock: () => undefined,

    walletDeleteOps: (image, walletId) => {
      const ops: StoreOp[] = [];
      for (const record of image.records) {
        if (
          record.kind === HL_AGENT_KIND &&
          parseAgentHeader(record.header).walletId === walletId
        ) {
          ops.push({ op: "delete-record", kind: HL_AGENT_KIND, id: record.id });
        }
      }
      return ops;
    },
  };

  const handlers: { [M in keyof typeof APPS_METHODS & MethodName]: Handler<M> } = {
    "hyperliquid.createAgent": createAgent,
    "hyperliquid.listAgents": listAgents,
    "hyperliquid.deleteAgent": deleteAgent,
    "hyperliquid.signL1": signL1,
  };

  return { vault, handlers };
}
