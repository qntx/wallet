import type { HyperliquidNetwork, SessionInfo } from "@qntx/wallet/protocol";

import type { EngineLogger } from "../../events.ts";
import { HyperliquidError } from "./errors.ts";

/** The account identity every trade method takes first — a wallet group, nothing more. */
export type HyperliquidGroup = {
  readonly walletId: string;
  readonly groupIndex: number;
};

/** The agent `require` hands to the signer: the kernel-held agent address and its owner. */
export type HyperliquidAgent = {
  readonly address: string;
  readonly owner: string;
  readonly validUntil: number;
};

export type HyperliquidAgentRegistry = {
  /**
   * Reload kernel-listed sessions, keep only this scheme's on this network, and verify each agent's
   * `owner` against the group's `evm.bip44` address. Mismatched agents are logged and never usable
   * — they are not deleted, only excluded.
   */
  readonly refresh: () => Promise<void>;
  /** Mark a listed agent enabled — layer 3's enable flow calls this after HL confirmation. */
  readonly markEnabled: (address: string) => void;
  /** Mark an agent rejected by Hyperliquid (revoked / account unfunded) — fail fast next time. */
  readonly markRejected: (address: string) => void;
  /**
   * The single enabled, owner-verified, unexpired, unrejected agent of exactly this group — the one
   * with the latest `validUntil` when several qualify. Never falls back to another group's agent.
   * Throws `not-enabled` (no agent or none enabled) or `reauthorization-required` (expired or
   * rejected).
   */
  readonly require: (group: HyperliquidGroup) => HyperliquidAgent;
  /** The group's `evm.bip44` address on the signature chain, lowercased — derived once. */
  readonly owner: (group: HyperliquidGroup) => Promise<string>;
  /** True when the exchange path latched the agent as rejected — enablement must renew it. */
  readonly rejected: (address: string) => boolean;
  /** True when an enable flow marked the agent enabled this session. */
  readonly enabled: (address: string) => boolean;
  /** A lock clears the session marks and verified list — the next unlock re-derives them. */
  readonly reset: () => void;
};

const keyOf = (group: HyperliquidGroup): string => `${group.walletId}:${group.groupIndex}`;

export function createHyperliquidAgentRegistry(options: {
  /** `sessions(wallet)` — the kernel session list. */
  readonly agents: {
    readonly list: () => Promise<ReadonlyArray<SessionInfo>>;
  };
  /** The group's `evm.bip44` address on the signature chain — `chains(wallet).account`. */
  readonly evmAddress: (group: HyperliquidGroup) => Promise<string>;
  readonly network: HyperliquidNetwork;
  readonly now: () => number;
  readonly logger: EngineLogger;
}): HyperliquidAgentRegistry {
  /** Group key → the lowercase evm.bip44 address, derived once per group. */
  const owners = new Map<string, string>();
  /** Kernel-listed, scheme- and network-matched, owner-verified agents. */
  let verified: ReadonlyArray<SessionInfo> = [];
  const enabled = new Set<string>();
  const rejected = new Set<string>();

  const ownerOf = async (group: HyperliquidGroup): Promise<string> => {
    const key = keyOf(group);
    let owner = owners.get(key);
    if (owner === undefined) {
      const address = await options.evmAddress(group);
      owner = address.toLowerCase();
      owners.set(key, owner);
    }
    return owner;
  };

  return {
    owner: ownerOf,
    refresh: async () => {
      const listed = await options.agents.list();
      const next: SessionInfo[] = [];
      for (const agent of listed) {
        if (agent.scheme !== "hyperliquid-l1-agent" || agent.scope !== options.network) {
          continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- one owner lookup per distinct group.
        const owner = await ownerOf(agent);
        if (agent.owner.toLowerCase() !== owner) {
          options.logger.warn(
            `hyperliquid agent ${agent.address} skipped: owner ${agent.owner} is not the group account`,
          );
          continue;
        }
        next.push(agent);
      }
      verified = next;
    },
    markEnabled: (address) => {
      enabled.add(address.toLowerCase());
    },
    markRejected: (address) => {
      rejected.add(address.toLowerCase());
    },
    rejected: (address) => rejected.has(address.toLowerCase()),
    enabled: (address) => enabled.has(address.toLowerCase()),
    reset: () => {
      owners.clear();
      verified = [];
      enabled.clear();
      rejected.clear();
    },
    require: (group) => {
      const own = verified.filter(
        (agent) => agent.walletId === group.walletId && agent.groupIndex === group.groupIndex,
      );
      if (own.length === 0) {
        throw new HyperliquidError("not-enabled", "the account has no Hyperliquid agent");
      }
      const marked = own.filter((agent) => enabled.has(agent.address.toLowerCase()));
      const usable = marked.filter(
        (agent) => !rejected.has(agent.address.toLowerCase()) && agent.validUntil > options.now(),
      );
      let agent: SessionInfo | undefined;
      for (const candidate of usable) {
        if (agent === undefined || candidate.validUntil > agent.validUntil) {
          agent = candidate;
        }
      }
      if (agent === undefined) {
        throw new HyperliquidError(
          marked.length > 0 ? "reauthorization-required" : "not-enabled",
          marked.length > 0
            ? "the enabled Hyperliquid agent expired or was rejected"
            : "the account has no enabled Hyperliquid agent",
        );
      }
      return {
        address: agent.address,
        owner: agent.owner.toLowerCase(),
        validUntil: agent.validUntil,
      };
    },
  };
}
