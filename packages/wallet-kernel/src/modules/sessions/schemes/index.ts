/**
 * The compile-time scheme table: its key set is exactly `SessionSchemeId` — a missing or extra
 * scheme fails declaration emit. There is no runtime registry; a new scheme adds an entry here.
 */
import type { SessionSchemeId } from "@qntx/wallet/protocol";

import type { SessionScheme } from "../scheme.ts";
import { hyperliquidL1Agent } from "./hyperliquid-l1-agent/index.ts";

export const SESSION_SCHEMES: Readonly<Record<SessionSchemeId, SessionScheme>> = {
  "hyperliquid-l1-agent": hyperliquidL1Agent,
};

export function isSchemeId(id: string): id is SessionSchemeId {
  return Object.hasOwn(SESSION_SCHEMES, id);
}

export function schemeOf(id: string): SessionScheme | undefined {
  return isSchemeId(id) ? SESSION_SCHEMES[id] : undefined;
}
