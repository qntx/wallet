/**
 * The protocol families the wallet decodes, and the request surfaces that claim to be one of them.
 * A request a family claims but the decoder did not decode is blind with the row's `nearMiss` — a
 * near miss must not be downgraded to a generic field dump or an opaque call.
 *
 * Deliberately NOT in the table: the protocol routers the owner calls by name (0x Settler, Across,
 * Lido, Jupiter, Metaplex Core), ComputeBudget, and every other contract or program — undecoded
 * calls into them stay opaque-described, naming the contract or program, the same as any contract
 * the owner chooses to trust.
 *
 * Data only: type-level imports, so the EVM bundle never pulls Solana code and vice versa
 * (scripts/size-check.ts budgets per family).
 */
import type { BlindReason } from "./index.ts";
import type { PROGRAM_IDS } from "./solana/ids.ts";

export type FamilyClaim =
  | { readonly surface: "evm.call"; readonly callee: "token-table" }
  | { readonly surface: "tron.call"; readonly callee: "token-table" }
  | { readonly surface: "evm.typed-data"; readonly primaryType: RegExp }
  | {
      readonly surface: "evm.typed-data";
      readonly domainName: string;
      readonly primaryType?: RegExp;
    }
  | {
      readonly surface: "evm.typed-data";
      readonly verifyingContract: "token-table" | "permit2" | "seaport";
    }
  /* An order protocol's domain name or any of its verifying contracts (either claims it). */
  | {
      readonly surface: "evm.typed-data";
      readonly domainName: string;
      readonly contracts: ReadonlyArray<string>;
    }
  | { readonly surface: "solana.instruction"; readonly program: keyof typeof PROGRAM_IDS };

export type RecognisedFamily = {
  readonly family: string;
  readonly claim: FamilyClaim;
  readonly nearMiss: BlindReason;
};

export const RECOGNISED_FAMILIES: ReadonlyArray<RecognisedFamily> = [
  /* The phantom agent's connectionId is a hash of the msgpack action, a commitment no prompt can
     bound; main and imported accounts never get it described (the kernel's agent key signs L1
     actions through its own command). First: an `Exchange`/`Agent` document must not fall through
     to a wider claim. */
  {
    family: "Hyperliquid L1",
    claim: { surface: "evm.typed-data", domainName: "Exchange", primaryType: /^Agent$/ },
    nearMiss: "typed-data-commitment",
  },
  /* Hyperliquid user-signed actions under the HyperliquidSignTransaction domain. */
  {
    family: "Hyperliquid",
    claim: { surface: "evm.typed-data", domainName: "HyperliquidSignTransaction" },
    nearMiss: "typed-data-variant",
  },
  /* Polymarket CLOB orders under the shared exchange domain (docs resources/contracts.md). */
  {
    family: "Polymarket exchange",
    claim: { surface: "evm.typed-data", domainName: "Polymarket CTF Exchange" },
    nearMiss: "typed-data-variant",
  },
  /* Polymarket CLOB L1 auth that derives API credentials (clob-client-v2 signing/eip712.ts). */
  {
    family: "Polymarket CLOB auth",
    claim: { surface: "evm.typed-data", domainName: "ClobAuthDomain" },
    nearMiss: "typed-data-variant",
  },
  /* Polymarket deposit-wallet envelopes: ERC-7739 order wrappers and call batches (docs
     trading/wallets-auth.md). */
  {
    family: "Polymarket deposit wallet",
    claim: { surface: "evm.typed-data", domainName: "DepositWallet" },
    nearMiss: "typed-data-variant",
  },
  /* ERC-20/721/1155 transfer, approve and setApprovalForAll selectors to a listed token. */
  {
    family: "built-in token",
    claim: { surface: "evm.call", callee: "token-table" },
    nearMiss: "token-function",
  },
  /* The same selectors in a TriggerSmartContract to a listed TRC-20 token. */
  {
    family: "built-in TRON token",
    claim: { surface: "tron.call", callee: "token-table" },
    nearMiss: "token-function",
  },
  /* EIP-2612 and DAI Permit on any contract, and the Permit2 forms when addressed to Permit2. */
  {
    family: "permit",
    claim: { surface: "evm.typed-data", primaryType: /^Permit/ },
    nearMiss: "typed-data-variant",
  },
  /* PermitSingle/PermitBatch and Permit[Batch][Witness]TransferFrom orders addressed to Permit2. */
  {
    family: "Permit2",
    claim: { surface: "evm.typed-data", verifyingContract: "permit2" },
    nearMiss: "typed-data-variant",
  },
  /* EIP-2612 and DAI Permits signed to a token in the built-in table (EIP-3009 is not decoded). */
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
  /* OrderComponents orders; BulkOrder and any other shape on this primary type is a near miss. */
  {
    family: "Seaport",
    claim: { surface: "evm.typed-data", primaryType: /^(?:OrderComponents|BulkOrder)$/ },
    nearMiss: "typed-data-variant",
  },
  /* The same orders — this row catches Seaport-addressed documents under other primary types. */
  {
    family: "Seaport",
    claim: { surface: "evm.typed-data", verifyingContract: "seaport" },
    nearMiss: "typed-data-variant",
  },
  /* Snapshot `Vote` documents under the snapshot 0.1.4 domain (snapshot.js
     src/sign/{index,types}.ts). */
  {
    family: "Snapshot",
    claim: {
      surface: "evm.typed-data",
      domainName: "snapshot",
      primaryType: /^Vote$/,
    },
    nearMiss: "typed-data-variant",
  },
  /* CoW GPv2 orders on the settlement contract (cow-contracts networks.json; research.md). */
  {
    family: "CoW",
    claim: {
      surface: "evm.typed-data",
      domainName: "Gnosis Protocol",
      contracts: ["0x9008D19f58AAbD9eD0D60971565AA8510560ab41"],
    },
    nearMiss: "typed-data-variant",
  },
  /* Transfer, CreateAccount, CreateAccountWithSeed and AdvanceNonceAccount of the System program. */
  {
    family: "System",
    claim: { surface: "solana.instruction", program: "system" },
    nearMiss: "core-instruction",
  },
  /* TransferChecked, Approve, SyncNative, self-close, InitializeAccount and Revoke. */
  {
    family: "Token",
    claim: { surface: "solana.instruction", program: "token" },
    nearMiss: "core-instruction",
  },
  /* The same instructions as Token — both programs share one decoder. */
  {
    family: "Token-2022",
    claim: { surface: "solana.instruction", program: "token2022" },
    nearMiss: "core-instruction",
  },
  /* Initialize(Checked), Authorize(Checked), DelegateStake, Withdraw and Deactivate. */
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
