/**
 * The hyperliquid module of @qntx/wallet: `hyperliquid(wallet)` returns the wallet's Hyperliquid
 * API — management of the kernel-held L1 agent keys and agent signatures over allow-listed L1
 * actions. The API is memoized per wallet so repeated calls return the same object (stable React
 * identity); a foreign object is rejected because only a Wallet from this package holds a
 * registered channel.
 */
import { internalsOf } from "../internal.ts";
import type { WalletInternals } from "../internal.ts";
import type {
  HyperliquidAgentInfo,
  HyperliquidL1Action,
  HyperliquidNetwork,
} from "../protocol/index.ts";
import type { Wallet } from "../types.ts";

export type {
  HyperliquidAgentInfo,
  HyperliquidL1Action,
  HyperliquidL1Order,
  HyperliquidNetwork,
} from "../protocol/index.ts";

export type HyperliquidApi = {
  /**
   * Creates a secp256k1 agent key inside the enclave for one HD account on one network and returns
   * its EIP-55 address. The agent only becomes valid once the owner signs an `ApproveAgent` typed
   * data naming it — the kernel binds that signature's `agentName` to `${name} valid_until
   * ${validUntil}`.
   */
  readonly createAgent: (params: {
    readonly owner: { readonly walletId: string; readonly groupIndex: number };
    readonly network: HyperliquidNetwork;
    readonly name: string;
    readonly validUntil: number;
  }) => Promise<string>;
  /** Every agent key the vault holds, across wallets, groups and networks. */
  readonly listAgents: () => Promise<ReadonlyArray<HyperliquidAgentInfo>>;
  /** Destroys the agent key at `address` — nothing can sign with it again. */
  readonly deleteAgent: (address: string) => Promise<void>;
  /**
   * Signs a frozen L1 action with the agent at `agent` and returns the 65-byte r‖s‖v signature.
   * `action` must equal — field for field — the object posted to `/exchange`: addresses lowercase,
   * canonical decimals, `grouping` present. The kernel refuses once `validUntil` has passed or the
   * vault is locked.
   */
  readonly signL1: (params: {
    readonly agent: string;
    readonly action: HyperliquidL1Action;
    readonly nonce: number;
    readonly vaultAddress?: string;
    readonly expiresAfter?: number;
  }) => Promise<Uint8Array>;
};

function createHyperliquidApi(internals: WalletInternals): HyperliquidApi {
  return {
    createAgent: async (params) => {
      const { address } = await internals.call("hyperliquid.createAgent", params);
      return address;
    },
    listAgents: async () => internals.call("hyperliquid.listAgents", null),
    deleteAgent: async (address) => {
      await internals.call("hyperliquid.deleteAgent", { address });
    },
    signL1: async (params) => {
      const { signature } = await internals.call("hyperliquid.signL1", params);
      return signature;
    },
  };
}

const apis = new WeakMap<Wallet, HyperliquidApi>();

export function hyperliquid(wallet: Wallet): HyperliquidApi {
  const internals = internalsOf(wallet);
  let api = apis.get(wallet);
  if (api === undefined) {
    api = createHyperliquidApi(internals);
    apis.set(wallet, api);
  }
  return api;
}
