/**
 * The hyperliquid-l1-agent session scheme: Hyperliquid L1 trading, scoped to a network, signed as
 * the phantom-agent `Agent(string source,bytes32 connectionId)` typed data the kernel builds.
 */
import { KernelError } from "../../../../errors.ts";
import type { SessionScheme } from "../../scheme.ts";
import { defineSessionScheme } from "../../scheme.ts";
import { l1ConnectionId, phantomAgentTypedData } from "./l1.ts";
import { hyperliquidL1Params, hyperliquidNetwork } from "./params.ts";

/**
 * Hyperliquid allows an agent name's `valid_until` at most 180 days out (docs exchange-endpoint
 * §Approve an API wallet).
 */
const AGENT_MAX_TTL_MS = 180 * 86_400_000;
/** At most 16 live agents per vault — the protocol's sessions.list cap is 64. */
const MAX_AGENTS = 16;
/**
 * The kernel accepts a nonce within ±5 minutes of wall time. Hyperliquid itself accepts nonces in
 * (T−2d, T+1d) (docs nonces-and-api-wallets); the tighter window bounds how far ahead a compromised
 * runtime can pre-sign while the vault happens to be unlocked.
 */
const NONCE_WINDOW_MS = 300_000;

export const hyperliquidL1Agent: SessionScheme = defineSessionScheme({
  id: "hyperliquid-l1-agent",
  maxTtlMs: AGENT_MAX_TTL_MS,
  maxPerVault: MAX_AGENTS,
  parseScope: hyperliquidNetwork,
  params: hyperliquidL1Params,
  document: (params, _header, scope, now) => {
    if (Math.abs(params.nonce - now) > NONCE_WINDOW_MS) {
      throw new KernelError("invalid-input", "nonce outside the signing window");
    }
    return phantomAgentTypedData(
      l1ConnectionId({
        action: params.action,
        nonce: params.nonce,
        ...(params.vaultAddress === undefined ? {} : { vaultAddress: params.vaultAddress }),
        ...(params.expiresAfter === undefined ? {} : { expiresAfter: params.expiresAfter }),
      }),
      scope,
    );
  },
});
