import { ChainError } from "../index.ts";
import { isEvmAddress } from "./address.ts";

/** MetaMask Delegation Framework v1.3.0 DelegationManager — the same address on every chain. */
export const DELEGATION_MANAGER = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";

/** ERC-4337 EntryPoint v0.8 — the same address on every chain. */
export const ENTRY_POINT_V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

/**
 * Typed data whose domain targets an execution context over the signer's account turns a signature
 * into execution rights: a Delegation the DelegationManager redeems, a PackedUserOperation the
 * EntryPoint runs for a delegated 7702 account, or an action the account's own EIP-712 domain
 * authorizes. A generic typed-data request must never produce such a signature.
 */
export const assertNoExecutionGrant = (domain: Record<string, unknown>, signer: string): void => {
  const target = domain["verifyingContract"];
  if (typeof target !== "string" || !isEvmAddress(target)) {
    return;
  }
  const lower = target.toLowerCase();
  if (lower === signer.toLowerCase()) {
    throw new ChainError("invalid-request", "typed data addressed to your own account is refused");
  }
  if (lower === DELEGATION_MANAGER.toLowerCase()) {
    throw new ChainError(
      "invalid-request",
      "typed data addressed to the DelegationManager is refused",
    );
  }
  if (lower === ENTRY_POINT_V08.toLowerCase()) {
    throw new ChainError("invalid-request", "typed data addressed to the EntryPoint is refused");
  }
};
