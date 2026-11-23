import type { VerifyFactor, Wallet } from "@qntx/wallet";
import type { BlindReason, Fiat24Action, IntentSummary, SignRequest } from "@qntx/wallet-chains";
import type { AccountRef } from "@qntx/wallet-engine";
import { chains } from "@qntx/wallet/chains";
import type { ChainSignResult } from "@qntx/wallet/protocol";

/**
 * The sign-request union is closed — a host switch must name every kind, including
 * `evm.fiat24-session`, the Fiat24 access grant the wallet builds from structured fields.
 */
export function describeSignRequest(request: SignRequest): string {
  switch (request.kind) {
    case "evm.transaction":
      return "an EVM transaction";
    case "evm.personal-message":
      return "an EVM personal message";
    case "evm.fiat24-session":
      return `a Fiat24 account access grant for account #${request.tokenId}`;
    case "evm.typed-data":
      return "EIP-712 typed data";
    case "solana.transaction":
      return "a Solana transaction";
    case "solana.message":
      return "a Solana message";
    case "bitcoin.psbt":
      return "a Bitcoin PSBT";
    case "bitcoin.message":
      return "a Bitcoin message";
    case "tron.transaction":
      return "a TRON transaction";
    case "tron.message":
      return "a TRON message";
    case "tron.typed-data":
      return "TRON typed data";
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the never assignment is the exhaustiveness proof
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

/** The sign-result union is closed — a host switch must name every result kind. */
export function describeSignResult(result: ChainSignResult): string {
  switch (result.kind) {
    case "evm.transaction":
      return "a signed transaction";
    case "evm.personal-message":
    case "evm.fiat24-session":
    case "evm.typed-data":
      return "a signature";
    case "solana.transaction":
    case "solana.message":
      return "a signature";
    case "bitcoin.psbt":
      return "a signed PSBT";
    case "bitcoin.message":
      return "a signature";
    case "tron.transaction":
    case "tron.message":
    case "tron.typed-data":
      return "a signature";
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the never assignment is the exhaustiveness proof
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

/** A host names every decoded summary, including the Fiat24 bank `payout`. */
export function describeSummary(summary: IntentSummary): string {
  switch (summary) {
    case "transfer":
      return "a transfer";
    case "approve":
      return "an approval";
    case "contract-call":
      return "a contract call";
    case "swap":
      return "a swap";
    case "message":
      return "a message";
    case "authorization":
      return "an account authorization";
    case "batch":
      return "a batch";
    case "stake":
      return "staking";
    case "bridge":
      return "a bridge";
    case "payout":
      return "a bank payout";
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the never assignment is the exhaustiveness proof
    default: {
      const exhaustive: never = summary;
      return exhaustive;
    }
  }
}

/** A host names every blind reason, including the raw Fiat24 access grant. */
export function describeBlind(reason: BlindReason): string {
  switch (reason) {
    case "message-bytes":
      return "unreadable message bytes";
    case "typed-data-commitment":
      return "a typed-data commitment";
    case "typed-data-variant":
      return "a typed-data variant";
    case "typed-data-oversize":
      return "oversize typed data";
    case "token-function":
      return "an unrecognised token function";
    case "account-code":
      return "code of the signing account";
    case "safe-delegatecall":
      return "a Safe delegatecall";
    case "safe-refund-unbounded":
      return "an unbounded Safe refund";
    case "core-instruction":
      return "a core Solana instruction";
    case "program-authority":
      return "a Solana program authority";
    case "tron-contract":
      return "a TRON contract";
    case "tron-field":
      return "an unbounded TRON field";
    case "tron-permission-update":
      return "a TRON permission update";
    case "cctp-destination":
      return "an unverified CCTP destination";
    case "fiat24-function":
      return "an undescribed Fiat24 call";
    case "fiat24-session-grant":
      return "a raw Fiat24 account access grant";
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the never assignment is the exhaustiveness proof
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** A host renders every Fiat24 action the decoder can describe. */
export function describeFiat24Action(action: Fiat24Action): string {
  switch (action.kind) {
    case "exchange":
      return action.side === "exact-in"
        ? "a Fiat24 exchange paying a fixed amount"
        : "a Fiat24 exchange paying whatever the issuer's rate asks";
    case "payout":
      return "a Fiat24 bank payout";
    case "top-up":
      return "a Fiat24 account top-up";
    case "open-account":
      return `opening Fiat24 account #${action.account}`;
    case "session-grant":
      return `a Fiat24 access grant for account #${action.account}`;
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the never assignment is the exhaustiveness proof
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/**
 * Grant Fiat24 API access for an account: the wallet builds the grant message itself and the
 * signature verifies against `account` before `chain.sign` returns. `hash` is the session label the
 * API hashes the grant under; `sign` is the 0x-hex signature to send with it — until `deadline` it
 * authorises profile and card reads plus card, payee and email changes.
 */
export async function grantFiat24Session(
  wallet: Wallet,
  account: AccountRef,
  tokenId: string,
  deadline: number,
  verify: VerifyFactor,
): Promise<{ readonly hash: string; readonly sign: string }> {
  const result = await chains(wallet).sign({
    request: {
      kind: "evm.fiat24-session",
      network: "eip155:42161",
      account,
      tokenId,
      deadline,
    },
    verify,
  });
  if (result.kind !== "evm.fiat24-session") {
    throw new Error(`unexpected chain.sign result kind: ${result.kind}`);
  }
  const sign = `0x${[...result.signature].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return { hash: `fiat24-session-v1:42161:${tokenId}:${deadline};`, sign };
}
