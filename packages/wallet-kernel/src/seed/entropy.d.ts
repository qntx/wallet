import type { Random } from "../platform.ts";
/** 12 words → 16 bytes, 24 words → 32 bytes of fresh entropy. */
export declare function randomEntropy(words: 12 | 24, random: Random): Uint8Array;
