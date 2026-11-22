/**
 * The sessions module of @qntx/wallet: `sessions(wallet)` returns the wallet's session-key API —
 * management of the kernel-held secp256k1 session keys and their scheme-defined signatures. The API
 * is memoized per wallet so repeated calls return the same object (stable React identity); a
 * foreign object is rejected because only a Wallet from this package holds a registered channel.
 */
import { hyperliquidL1Document, recoverEvmSigner } from "@qntx/wallet-chains/evm";

import { integrity } from "../channel.ts";
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
   * locked. The host then verifies what came back: it rebuilds the document the record's scope
   * implies, recovers the signer, and answers `integrity` unless the signature is the session key's
   * over exactly that document.
   */
  readonly sign: <K extends SessionSchemeId>(params: {
    readonly scheme: K;
    readonly address: string;
    readonly params: SessionSchemes[K]["params"];
  }) => Promise<Uint8Array>;
};

/* The document each scheme signs for `params` under `scope` — `undefined` when the scope is not
   one the scheme admits, so a record whose scope no longer fits cannot smuggle a signature. */
const SCHEME_DOCUMENTS: {
  readonly [K in SessionSchemeId]: (
    params: SessionSchemes[K]["params"],
    scope: string,
  ) => string | undefined;
} = {
  "hyperliquid-l1-agent": (params, scope) =>
    scope === "Mainnet" || scope === "Testnet" ? hyperliquidL1Document(params, scope) : undefined,
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
      const records = await internals.call("sessions.list", null);
      const record = records.find((r) => r.address.toLowerCase() === params.address.toLowerCase());
      if (record === undefined) {
        throw integrity("sessions.sign answered for an address with no session");
      }
      if (record.scheme !== params.scheme) {
        throw integrity("sessions.sign answered under a different scheme");
      }
      const document = SCHEME_DOCUMENTS[params.scheme](params.params, record.scope);
      if (document === undefined) {
        throw integrity("sessions.sign answered for a scope the scheme rejects");
      }
      let signer: string;
      try {
        signer = recoverEvmSigner(
          {
            kind: "evm.typed-data",
            network: "eip155:1337",
            account: {
              kind: "hd",
              walletId: record.walletId,
              groupIndex: record.groupIndex,
              template: "evm.bip44",
            },
            typedData: document,
          },
          { signature },
        );
      } catch {
        throw integrity("sessions.sign signature does not verify");
      }
      if (signer.toLowerCase() !== params.address.toLowerCase()) {
        throw integrity("sessions.sign signature is not the session key's");
      }
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
