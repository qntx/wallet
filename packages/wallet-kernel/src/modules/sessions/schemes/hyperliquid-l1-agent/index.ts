/**
 * The hyperliquid-l1-agent session scheme: Hyperliquid L1 trading, scoped to a network, signed as
 * the phantom-agent `Agent(string source,bytes32 connectionId)` typed data the kernel builds.
 */
import { hyperliquidL1Document } from "@qntx/wallet-chains/evm";

import { KernelError } from "../../../../errors.ts";
import type { SessionScheme } from "../../scheme.ts";
import { defineSessionScheme } from "../../scheme.ts";
import { hyperliquidL1Params, hyperliquidNetwork } from "./params.ts";

/**
 * Hyperliquid allows an agent name's `valid_until` at most 180 days out (docs exchange-endpoint
 * §Approve an API wallet).
 */
const AGENT_MAX_TTL_MS = 180 * 86_400_000;
/** At most 16 live agents per vault — the protocol's sessions.list cap is 64. */
const MAX_AGENTS = 16;
/**
 * Every signature carries `expiresAfter` at most 60 s after it was made and Hyperliquid rejects an
 * action after its `expiresAfter` (docs exchange-endpoint §Expires After), so a signature can be
 * submitted at most 60 s after it was made — the post-lock exposure. The nonce keeps the same 60 s
 * symmetric window so a compromised runtime cannot pre-sign far ahead.
 *
 * Both are on the device clock — the kernel has no trusted time: a clock S ahead makes it S + 60 s
 * of real time (Hyperliquid takes nonces up to a day ahead). The engine's `assertClock()` is the
 * mitigation; a compromised main runtime can skip it (SECURITY.md).
 */
const EXPIRES_AFTER_MS = 60_000;
const NONCE_WINDOW_MS = 60_000;
/**
 * A scheduled cancel must land at least 5 s out (docs exchange-endpoint §Schedule cancel) and no
 * later than the session's own validUntil — the protocol publishes no maximum, so the kernel signs
 * no scheduled effect past the authorisation the user approved.
 */
const SCHEDULE_CANCEL_MIN_MS = 5000;

export const hyperliquidL1Agent: SessionScheme = defineSessionScheme({
  id: "hyperliquid-l1-agent",
  maxTtlMs: AGENT_MAX_TTL_MS,
  maxPerVault: MAX_AGENTS,
  parseScope: hyperliquidNetwork,
  params: hyperliquidL1Params,
  document: (params, header, scope, now) => {
    if (!(now < params.expiresAfter && params.expiresAfter <= now + EXPIRES_AFTER_MS)) {
      throw new KernelError("invalid-input", "expiresAfter outside the signing window");
    }
    if (Math.abs(params.nonce - now) > NONCE_WINDOW_MS) {
      throw new KernelError("invalid-input", "nonce outside the signing window");
    }
    if (
      params.action.type === "scheduleCancel" &&
      params.action.time !== undefined &&
      !(
        params.action.time >= now + SCHEDULE_CANCEL_MIN_MS &&
        params.action.time <= header.validUntil
      )
    ) {
      throw new KernelError("invalid-input", "schedule time outside the session");
    }
    return hyperliquidL1Document(params, scope);
  },
});
