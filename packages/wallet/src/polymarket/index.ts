/**
 * The polymarket module of @qntx/wallet: `polymarket(wallet)` returns the wallet's Polymarket API —
 * management of the kernel-held CLOB L2 credentials and the per-request L2 headers the kernel HMACs
 * inside the enclave. The api secret enters once through `importCredentials` and can never be read
 * back: `listCredentials` shows only the public header fields and `signL2` returns the five headers
 * for one request. The API is memoized per wallet so repeated calls return the same object (stable
 * React identity); a foreign object is rejected because only a Wallet from this package holds a
 * registered channel.
 */
import { internalsOf } from "../internal.ts";
import type { WalletInternals } from "../internal.ts";
import type {
  PolymarketCredentialsInfo,
  PolymarketL2Headers,
  PolymarketL2Method,
} from "../protocol/index.ts";
import type { Wallet } from "../types.ts";

export type {
  PolymarketCredentialsInfo,
  PolymarketL2Headers,
  PolymarketL2Method,
} from "../protocol/index.ts";

export type PolymarketApi = {
  /**
   * Seals a CLOB L2 credential set (`apiKey`, `secret`, `passphrase`) for one HD account and
   * returns the kernel-derived EIP-55 owner address at m/44'/60'/0'/0/groupIndex. Importing again
   * for the same group replaces the previous set in one commit.
   */
  readonly importCredentials: (params: {
    readonly owner: { readonly walletId: string; readonly groupIndex: number };
    readonly apiKey: string;
    readonly secret: string;
    readonly passphrase: string;
  }) => Promise<string>;
  /** Every credential set the vault holds — public header fields only, never secret/passphrase. */
  readonly listCredentials: () => Promise<ReadonlyArray<PolymarketCredentialsInfo>>;
  /** Destroys the credential set for `owner` — nothing can sign with it again. */
  readonly deleteCredentials: (owner: {
    readonly walletId: string;
    readonly groupIndex: number;
  }) => Promise<void>;
  /**
   * Signs one allow-listed L2 request with the group's credentials and returns the five `POLY_*`
   * headers to send: `POLY_ADDRESS` is the kernel-derived owner, `POLY_TIMESTAMP` the given
   * `timestamp` (integer seconds, within ±30 s of the kernel's wall clock), `POLY_SIGNATURE` the
   * url-safe base64 HMAC over `${timestamp}${method}${path}${body ?? ""}`. The kernel refuses a
   * path outside the allow-list, a GET with a body, or a locked vault.
   */
  readonly signL2: (params: {
    readonly owner: { readonly walletId: string; readonly groupIndex: number };
    readonly method: PolymarketL2Method;
    readonly path: string;
    readonly body?: string;
    readonly timestamp: number;
  }) => Promise<PolymarketL2Headers>;
};

function createPolymarketApi(internals: WalletInternals): PolymarketApi {
  return {
    importCredentials: async (params) => {
      // Params name `secret`/`passphrase` — the wire classification routes this through the
      // secret call even though every field is a string (no byte buffers transfer).
      const { owner } = await internals.secretCall("polymarket.importCredentials", () => params);
      return owner;
    },
    listCredentials: async () => internals.call("polymarket.listCredentials", null),
    deleteCredentials: async (owner) => {
      await internals.call("polymarket.deleteCredentials", owner);
    },
    signL2: async (params) => {
      const { headers } = await internals.call("polymarket.signL2", params);
      return headers;
    },
  };
}

const apis = new WeakMap<Wallet, PolymarketApi>();

export function polymarket(wallet: Wallet): PolymarketApi {
  const internals = internalsOf(wallet);
  let api = apis.get(wallet);
  if (api === undefined) {
    api = createPolymarketApi(internals);
    apis.set(wallet, api);
  }
  return api;
}
