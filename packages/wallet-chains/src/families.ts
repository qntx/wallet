/**
 * The protocol families the wallet decodes, and the request surfaces that claim to be one of
 * them. A request a family claims but the decoder did not decode is blind with the row's
 * `nearMiss` — a near miss must not be downgraded to a generic field dump or an opaque call.
 *
 * Deliberately NOT in the table: the protocol routers the owner calls by name (0x Settler,
 * Across, Lido, Jupiter, Metaplex Core), ComputeBudget, and every other contract or program —
 * undecoded calls into them stay opaque-described, naming the contract or program, the same as
 * any contract the owner chooses to trust.
 *
 * Data only: type-level imports, so the EVM bundle never pulls Solana code and vice versa
 * (scripts/size-check.ts budgets per family).
 */
import type { BlindReason } from "./index.ts";
import type { PROGRAM_IDS } from "./solana/ids.ts";

export type FamilyClaim =
  | { readonly surface: "evm.call"; readonly callee: "token-table" }
  | { readonly surface: "evm.typed-data"; readonly primaryType: RegExp }
  | {
      readonly surface: "evm.typed-data";
      readonly verifyingContract: "token-table" | "permit2" | "seaport";
    }
  | { readonly surface: "solana.instruction"; readonly program: keyof typeof PROGRAM_IDS };

export type RecognisedFamily = {
  readonly family: string;
  readonly claim: FamilyClaim;
  readonly nearMiss: BlindReason;
};

export const RECOGNISED_FAMILIES: ReadonlyArray<RecognisedFamily> = [
  /* ERC-20/721/1155 transfer/approve selectors and Permit2 approve/lockdown. */
  {
    family: "built-in token",
    claim: { surface: "evm.call", callee: "token-table" },
    nearMiss: "token-function",
  },
  /* EIP-2612 Permit and the Permit2-witness Permit* primary types. */
  {
    family: "permit",
    claim: { surface: "evm.typed-data", primaryType: /^Permit/ },
    nearMiss: "typed-data-variant",
  },
  {
    family: "Permit2",
    claim: { surface: "evm.typed-data", verifyingContract: "permit2" },
    nearMiss: "typed-data-variant",
  },
  /* EIP-3009 and friends signed to a token in the built-in table. */
  {
    family: "built-in token signature",
    claim: { surface: "evm.typed-data", verifyingContract: "token-table" },
    nearMiss: "typed-data-variant",
  },
  /* SafeTx with calls decoded under the transaction rules and the multisend/refund checks. */
  {
    family: "Safe",
    claim: { surface: "evm.typed-data", primaryType: /^SafeTx$/ },
    nearMiss: "typed-data-variant",
  },
  {
    family: "Seaport",
    claim: { surface: "evm.typed-data", primaryType: /^(?:OrderComponents|BulkOrder)$/ },
    nearMiss: "typed-data-variant",
  },
  {
    family: "Seaport",
    claim: { surface: "evm.typed-data", verifyingContract: "seaport" },
    nearMiss: "typed-data-variant",
  },
  /* Transfer/create/allocate/nonce-account instructions of the System program. */
  {
    family: "System",
    claim: { surface: "solana.instruction", program: "system" },
    nearMiss: "core-instruction",
  },
  /* TransferChecked, Approve, SyncNative and self-close of the SPL Token program. */
  {
    family: "Token",
    claim: { surface: "solana.instruction", program: "token" },
    nearMiss: "core-instruction",
  },
  {
    family: "Token-2022",
    claim: { surface: "solana.instruction", program: "token2022" },
    nearMiss: "core-instruction",
  },
  /* Initialize/delegate/deactivate/withdraw/authorize of the Stake program. */
  {
    family: "Stake",
    claim: { surface: "solana.instruction", program: "stake" },
    nearMiss: "core-instruction",
  },
  /* Create/CreateIdempotent of the Associated Token program. */
  {
    family: "Associated Token",
    claim: { surface: "solana.instruction", program: "associatedToken" },
    nearMiss: "core-instruction",
  },
];
