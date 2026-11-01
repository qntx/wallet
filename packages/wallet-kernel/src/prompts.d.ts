/**
 * Kernel-owned verification prompt text (WD-065). The keystore shows these strings in the system
 * verification UI; the main runtime can neither choose nor alter them. The language follows the
 * platform's preferred locale, read natively — `zh*` selects Simplified Chinese, anything else
 * English.
 */
import type { KeystorePrompt } from "./platform.ts";
export type PromptLocale = "zh-Hans" | "en";
export declare function promptLocale(tag: string): PromptLocale;
export type CorePromptKind = "unlock" | "create" | "export-mnemonic" | "export-key" | "delete-wallet" | "remove-key" | "backup" | "manage-factors" | "reset";
export declare function corePrompt(locale: PromptLocale, kind: CorePromptKind): KeystorePrompt;
/** A prompt thunk for a core operation — the keystore locale is read only when it runs. */
export declare const corePromptFor: (keystore: {
    readonly locale: string;
} | undefined, kind: CorePromptKind) => () => KeystorePrompt;
/**
 * An integer amount in smallest units rendered at `decimals` places with bigint arithmetic — no
 * float rounding — and trailing fractional zeros trimmed. `amount` is a canonical decimal string.
 */
export declare function formatUnits(amount: string, decimals: number): string;
/** The prompt lines joined for the system UI: one fact per line. */
export declare function joinLines(lines: ReadonlyArray<string>): string;
