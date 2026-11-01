/**
 * The system verification prompt for `chain.sign`, rendered from the kernel's own decode of the
 * request (WD-065): `full` lists every outflow, approval and the fee cap; `partial` leads with a
 * warning that other outflows may exist; `opaque` shows only the generic line. Addresses are never
 * truncated — a shortened address is what address poisoning relies on.
 */
import type { AssetAmount, DisplayIntent } from "@qntx/wallet-chains";
import type { KeystorePrompt } from "../../platform.ts";
import type { PromptLocale } from "../../prompts.ts";
export type PromptIntent = Pick<DisplayIntent, "summary" | "outflows" | "approvals" | "fee" | "verifiability">;
/** Off-chain messages carry no decodable value flow. */
export declare const MESSAGE_INTENT: PromptIntent;
/** `0.05 ETH` with known decimals (symbol, else the asset id); raw units and asset id otherwise. */
export declare function formatAmount(amount: AssetAmount): string;
export declare function chainPrompt(locale: PromptLocale, intent: PromptIntent): KeystorePrompt;
