/**
 * The Hyperliquid-specific agent facade and its dedicated vault record kind are gone: session keys
 * are generic — one `session-key` record kind, `sessions.*` kernel commands and the
 * `sessions(wallet)` facade. `create`/`sign` name the scheme; `list` reports records this build
 * does not know as `supported: false` (inert, still deletable). Signing a `hyperliquid-l1-agent`
 * action now requires `expiresAfter` at most 60 s after the kernel signs. Request origins gained `{
 * kind: "app", id }` and `/v1/eligibility` answers a record keyed by app id — an absent app is
 * unknown, not available. Compiled only.
 */
import type { Wallet } from "@qntx/wallet";
import type { PendingRequest } from "@qntx/wallet-engine";
import type { EligibilityResponse } from "@qntx/wallet-engine/gateway/contract";
import type { SessionInfo } from "@qntx/wallet/sessions";
import { sessions } from "@qntx/wallet/sessions";

/** Create, list, sign with and delete a `hyperliquid-l1-agent` session key. */
export async function sessionKeys(wallet: Wallet, walletId: string): Promise<SessionInfo[]> {
  const api = sessions(wallet);
  const address = await api.create({
    scheme: "hyperliquid-l1-agent",
    owner: { walletId, groupIndex: 0 },
    scope: "Mainnet",
    name: "bot-1",
    validUntil: Date.now() + 180 * 86_400_000,
  });
  const listed = await api.list();
  const agents = listed.filter((s) => s.supported && s.scheme === "hyperliquid-l1-agent");
  await api.sign({
    scheme: "hyperliquid-l1-agent",
    address,
    params: {
      action: { type: "scheduleCancel" },
      nonce: Date.now(),
      expiresAfter: Date.now() + 15_000,
    },
  });
  await api.delete(address);
  return agents;
}

/** `PendingRequest.origin` gained `{ kind: "app", id }` — a renderer covers all four shapes. */
export function requestOriginLabel(origin: PendingRequest["origin"]): string {
  if (origin.kind === "internal") {
    return "this app";
  }
  if (origin.kind === "app") {
    return `app: ${origin.id}`;
  }
  if (origin.kind === "browser") {
    return origin.origin;
  }
  // kind === "walletconnect" — a future origin kind stops compiling here until it is rendered.
  return `${origin.name} <${origin.url}>`;
}

/** `apps` is keyed by app id — the gateway's config decides which appear; absent is unknown. */
export function appAvailability(
  answer: EligibilityResponse,
  app: string,
): "available" | "close-only" | "blocked" | "unknown" {
  return answer.apps[app] ?? "unknown";
}
