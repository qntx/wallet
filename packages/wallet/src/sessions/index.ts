/**
 * The sessions module of @qntx/wallet: `sessions(wallet)` returns the wallet's session-key API —
 * management of the kernel-held secp256k1 session keys and their scheme-defined signatures. The API
 * is memoized per wallet so repeated calls return the same object (stable React identity); a
 * foreign object is rejected because only a Wallet from this package holds a registered channel.
 */
import { internalsOf } from "../internal.ts";
import type { WalletInternals } from "../internal.ts";
import type { SessionInfo, SessionSchemeId, SessionSchemes } from "../protocol/index.ts";
import type { Wallet } from "../types.ts";

export type {
  HyperliquidL1Action,
  HyperliquidL1Order,
  HyperliquidL1Params,
  HyperliquidNetwork,
  SessionInfo,
  SessionSchemeId,
  SessionSchemes,
} from "../protocol/index.ts";

export type SessionsApi = {
  /**
   * Creates a secp256k1 session key inside the enclave for one HD account and returns its EIP-55
   * address. The kernel refuses an unknown scheme (`unsupported`), a validity window past the
   * scheme's maximum TTL (`invalid-input`) and a scope the scheme rejects (`invalid-input`).
   */
  readonly create: <K extends SessionSchemeId>(params: {
    readonly scheme: K;
    readonly owner: { readonly walletId: string; readonly groupIndex: number };
    readonly scope: SessionSchemes[K]["scope"];
    readonly name: string;
    readonly validUntil: number;
  }) => Promise<string>;
  /** Every session key the vault holds, across wallets, groups and schemes. */
  readonly list: () => Promise<ReadonlyArray<SessionInfo>>;
  /** Destroys the session key at `address` — nothing can sign with it again. */
  readonly delete: (address: string) => Promise<void>;
  /**
   * Signs the scheme's document with the session key at `address` and returns the 65-byte r‖s‖v
   * signature. The kernel builds the exact document from `params` — the host never supplies one —
   * and refuses once `validUntil` has passed, when the scheme is not the record's, or the vault is
   * locked.
   */
  readonly sign: <K extends SessionSchemeId>(params: {
    readonly scheme: K;
    readonly address: string;
    readonly params: SessionSchemes[K]["params"];
  }) => Promise<Uint8Array>;
};

function createSessionsApi(internals: WalletInternals): SessionsApi {
  return {
    create: async (params) => {
      const { address } = await internals.call("sessions.create", params);
      return address;
    },
    list: async () => internals.call("sessions.list", null),
    delete: async (address) => {
      await internals.call("sessions.delete", { address });
    },
    sign: async (params) => {
      const { signature } = await internals.call("sessions.sign", params);
      return signature;
    },
  };
}

const apis = new WeakMap<Wallet, SessionsApi>();

export function sessions(wallet: Wallet): SessionsApi {
  const internals = internalsOf(wallet);
  let api = apis.get(wallet);
  if (api === undefined) {
    api = createSessionsApi(internals);
    apis.set(wallet, api);
  }
  return api;
}
