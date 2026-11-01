/**
 * Passkey wallet entropy is the first 16 bytes of the WebAuthn PRF output (qntx/wallet's own
 * convention). Wipes `prf` in every case.
 */
export declare function entropyFromPrf(prf: Uint8Array): Uint8Array;
