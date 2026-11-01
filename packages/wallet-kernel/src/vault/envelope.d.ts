import type { Random } from "../platform.ts";
export declare function recordContext(kind: string, id: string): string;
export declare function factorContext(kind: string, id: string): string;
export declare function aadOf(context: string, header: string): Uint8Array;
export declare function seal(key: Uint8Array, plaintext: Uint8Array, context: string, header: string, random: Random): Uint8Array;
export declare function open(key: Uint8Array, sealed: Uint8Array, context: string, header: string): Uint8Array;
