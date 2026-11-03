/**
 * The NIP-07 (`window.nostr`) handler — the bridge routes `provider: "nostr"` messages here. A page
 * asks for the active identity's public key, signs Nostr events (policy-gated — some go through the
 * request pipeline for an explicit approval), and encrypts/decrypts NIP-04/NIP-44 payloads
 * (authorization- and `nostrPolicy`-gated).
 */

/** A NIP-07 method call from the page. */
export type Nip07Request = {
  readonly method: string;
  readonly params?: unknown;
};

export type Nip07Handler = {
  readonly handle: (origin: string, request: Nip07Request) => Promise<unknown>;
};
