/** Overwrites buffers with zeros. The only "zeroing" we can rely on. */
export declare function wipe(...buffers: Uint8Array[]): void;
/**
 * Fatal UTF-8 decode of a single-use secret input (passwords, nsec bytes, mnemonics): the input
 * buffer is wiped in every case, and invalid UTF-8 fails closed. Callers that still need the bytes
 * afterwards must decode without wiping — see `decodePassword` in the vault layer.
 */
export declare function decodeUtf8Secret(bytes: Uint8Array): string;
/**
 * Opaque holder for long-lived secrets (DEK, pending entropy). The bytes are reachable only inside
 * `use`; serialization and stringification throw so a secret cannot leak into logs or the wire by
 * accident.
 */
export declare class Secret {
    #private;
    private constructor();
    /** Takes ownership of `bytes` without copying; the caller must not reuse it. */
    static take(bytes: Uint8Array): Secret;
    get length(): number;
    get wiped(): boolean;
    use<T>(fn: (bytes: Uint8Array) => T): T;
    wipe(): void;
    toJSON(): never;
    toString(): never;
}
