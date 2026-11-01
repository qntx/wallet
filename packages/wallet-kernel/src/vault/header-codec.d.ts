import { KernelError } from "../errors.ts";
/**
 * The strict-JSON helpers every vault header parser shares. Public headers are stored as raw JSON
 * text and enter the envelope AAD verbatim, so encoders fix the key order and parsers are strict:
 * exact key set, exact types and ranges; anything else is `integrity`.
 */
export declare function headerFailure(): KernelError;
export declare function headerObject(text: string): Record<string, unknown>;
/** Exact key set: every expected key present, nothing else. */
export declare function expectKeys(object: Record<string, unknown>, keys: ReadonlyArray<string>): void;
export declare function asWalletId(value: unknown): string;
export declare function asPublicKey(value: unknown): string;
export declare function asGroupIndex(value: unknown): number;
export declare function asBoolean(value: unknown): boolean;
export declare function asCreatedAt(value: unknown): number;
/** Canonical unpadded base64url that decodes to `min`–`max` bytes. */
export declare function asBase64url(value: unknown, min: number, max: number): string;
