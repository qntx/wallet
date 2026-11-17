/**
 * The nostr module of @qntx/wallet: `nostr(wallet)` returns the wallet's Nostr API — signer
 * proxies, key discovery/derivation/derivation, guarded export and removal. The API is memoized per
 * wallet so repeated calls return the same object (stable React identity); a foreign object is
 * rejected because only a Wallet from this package holds a registered channel.
 */
import { internalsOf } from "../internal.ts";
import type { WalletInternals } from "../internal.ts";
import { SingleUseSecret } from "../secret.ts";
import type {
  DerivedNostrKey,
  ExportedSecret,
  NostrKeyInfo,
  NostrKeyRef,
  VerifyFactor,
  Wallet,
} from "../types.ts";
import { keyInfoOf, proxySigner, syncSigner } from "./signer.ts";
import type { NostrApi, NostrExportKeyFormat, WalletSigner, WalletSyncSigner } from "./types.ts";

export type {
  DerivedNostrKey,
  NostrApi,
  NostrExportKeyFormat,
  NostrKeyInfo,
  NostrKeyRef,
  NostrUnwrapResult,
  WalletSigner,
  WalletSyncSigner,
} from "./types.ts";

function createNostrApi(internals: WalletInternals): NostrApi {
  return {
    signer: (ref: NostrKeyRef): WalletSigner => proxySigner(ref, internals),

    syncSigner: (walletId: string): WalletSyncSigner => syncSigner(walletId, internals),

    discover: async (
      walletId: string,
      from: number,
      count: number,
    ): Promise<ReadonlyArray<DerivedNostrKey>> => {
      const result = await internals.call("nostr.discover", { walletId, from, count });
      return result.keys;
    },

    deriveKey: async (walletId: string, index: number): Promise<NostrKeyInfo> =>
      internals.call("nostr.deriveKey", { walletId, index }),

    removeKey: async (ref: NostrKeyRef): Promise<void> => {
      await internals.call("nostr.removeKey", {
        publicKey: keyInfoOf(internals, ref).publicKey,
      });
    },

    exportKey: async (
      ref: NostrKeyRef,
      format: NostrExportKeyFormat,
      verify: VerifyFactor,
    ): Promise<ExportedSecret> =>
      internals.withVerifying(async () => {
        const { publicKey } = keyInfoOf(internals, ref);
        const bytes = await internals.secretCall("nostr.exportKey", async (wire) => {
          const wireFormat =
            format.kind === "nsec"
              ? { kind: "nsec" as const }
              : {
                  kind: "ncryptsec" as const,
                  password: wire.text(format.password),
                };
          return {
            verify: await internals.resolveVerifyFactor(verify, wire),
            publicKey,
            format: wireFormat,
          };
        });
        return new SingleUseSecret(bytes);
      }),
  };
}

const apis = new WeakMap<Wallet, NostrApi>();

export function nostr(wallet: Wallet): NostrApi {
  const internals = internalsOf(wallet);
  let api = apis.get(wallet);
  if (api === undefined) {
    api = createNostrApi(internals);
    apis.set(wallet, api);
  }
  return api;
}
