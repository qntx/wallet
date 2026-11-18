/**
 * Channel internals shared between the core Wallet and the protocol subpath modules
 * (@qntx/wallet/nostr, later spark/chains). This file is NOT a package subpath — modules look a
 * Wallet up in the WeakMap, so a foreign object has no channel to reach.
 */
import type { PlainMethod, SecretMethod, SecretWire } from "./factors.ts";
import type {
  ParamsOf,
  ResultOf,
  SignedEvent,
  VerifyFactor as WireVerifyFactor,
} from "./protocol/index.ts";
import { WalletError } from "./types.ts";
import type { VerifyFactor, Wallet, WalletSnapshot } from "./types.ts";

export type WalletInternals = {
  /** One validated request whose params carry no secret bytes. */
  readonly call: <M extends PlainMethod>(method: M, params: ParamsOf<M>) => Promise<ResultOf<M>>;
  /**
   * One validated request whose params carry secret bytes: `build` places them on a fresh wire; the
   * wire is wiped when build throws and otherwise travels or is wiped inside the channel.
   */
  readonly secretCall: <M extends SecretMethod>(
    method: M,
    build: (wire: SecretWire) => ParamsOf<M> | Promise<ParamsOf<M>>,
  ) => Promise<ResultOf<M>>;
  /** The live kernel port's first-status gate — re-read per call (a respawn replaces it). */
  readonly ready: () => Promise<void>;
  readonly snapshot: () => WalletSnapshot;
  /** The host-injected event verifier: the wallet never binds a signing backend itself. */
  readonly verifyEvent: (event: SignedEvent) => boolean;
  /** Marks a user verification in flight on the snapshot (`verifying`). */
  readonly withVerifying: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Public VerifyFactor → wire factor material; a device factor is invalid-input. */
  readonly resolveVerifyFactor: (
    factor: VerifyFactor,
    wire: SecretWire,
  ) => Promise<WireVerifyFactor>;
};

const internals = new WeakMap<Wallet, WalletInternals>();

export function registerInternals(wallet: Wallet, value: WalletInternals): void {
  internals.set(wallet, value);
}

/**
 * The internals behind a Wallet from this package — or `invalid-input` for anything else. A foreign
 * object can imitate the Wallet shape but can never hold the channel: modules that look it up here
 * get a closed failure, not a crafted kernel.
 */
export function internalsOf(wallet: Wallet): WalletInternals {
  const found = internals.get(wallet);
  if (found === undefined) {
    throw new WalletError("invalid-input", "not a Wallet from @qntx/wallet");
  }
  return found;
}
