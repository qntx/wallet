/* The hyperliquid-l1-agent scheme: L1 trading scoped to a network, signed as the phantom-agent
   `Agent(string source,bytes32 connectionId)` typed data the kernel builds. */
import { hyperliquidL1Document } from "@qntx/wallet-chains/evm";

import { KernelError } from "../../../../errors.ts";
import type { SessionScheme } from "../../scheme.ts";
import { defineSessionScheme } from "../../scheme.ts";
import { meterHyperliquid } from "./meter.ts";
import { hyperliquidL1Limits, hyperliquidL1Params, hyperliquidNetwork } from "./params.ts";
import { hyperliquidApproval } from "./prompt.ts";

/* Hyperliquid caps an agent name's `valid_until` at 180 days out (docs exchange-endpoint §Approve
   an API wallet) and allows at most 16 live agents per vault. */
const AGENT_MAX_TTL_MS = 180 * 86_400_000;
const MAX_AGENTS = 16;
/* Hyperliquid rejects an action past its `expiresAfter` (docs §Expires After), so a signature is
   submit-able at most 60 s after it was made — the post-lock exposure. The nonce keeps the same
   60 s window so a compromised runtime cannot pre-sign far ahead. Both are on the device clock —
   the kernel has no trusted time: a clock S ahead makes it S + 60 s of real time (Hyperliquid
   takes nonces up to a day ahead; the engine's `assertClock()` is the mitigation). */
const EXPIRES_AFTER_MS = 60_000;
const NONCE_WINDOW_MS = 60_000;

export const hyperliquidL1Agent: SessionScheme = defineSessionScheme({
  id: "hyperliquid-l1-agent",
  maxTtlMs: AGENT_MAX_TTL_MS,
  maxPerVault: MAX_AGENTS,
  parseScope: hyperliquidNetwork,
  params: hyperliquidL1Params,
  document: (params, _header, scope, now) => {
    if (!(now < params.expiresAfter && params.expiresAfter <= now + EXPIRES_AFTER_MS)) {
      throw new KernelError("invalid-input", "expiresAfter outside the signing window");
    }
    if (Math.abs(params.nonce - now) > NONCE_WINDOW_MS) {
      throw new KernelError("invalid-input", "nonce outside the signing window");
    }
    return hyperliquidL1Document(params, scope);
  },
  metering: {
    limits: hyperliquidL1Limits,
    meter: meterHyperliquid,
    prompt: hyperliquidApproval,
  },
});
