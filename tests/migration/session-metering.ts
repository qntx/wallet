/**
 * Value-moving session keys are approved and metered (section 31): `sessions.create` and the new
 * `sessions.open` take a `verify` factor, `create` takes the scheme's `limits` (a notional budget,
 * a leverage cap and per-asset `{ asset, size }` caps), `SessionInfo` reports `limits`/`spent` —
 * `spent` is the scheme's `HyperliquidAgentSpent` as opaque `ProtocolValue`, there is no
 * `SESSION_SPENT` grammar. Out-of-bounds use answers `limit-exceeded`, a third live metered session
 * per owner and scope `conflict`, an approval text that cannot fit the dialog `invalid-input`, and
 * app-lock-less use `app-lock-required`; on iOS the limits are confirmed by a 4-digit code on the
 * secure-input hub (`cancelled` / `unsupported`). Only allow-listed actions sign — `scheduleCancel`
 * is not among them. The engine's Hyperliquid `enable`/`renew` take `{ limits, verify }` and
 * `provider.reopen(group, verify)` re-approves the agent after a lock; `trade.twap` /
 * `actions.twap` are gone. Compiled only.
 */
import type { VerifyFactor, Wallet } from "@qntx/wallet";
import { WalletError } from "@qntx/wallet";
import type { AppsController } from "@qntx/wallet-engine/apps";
import type {
  HyperliquidGroup,
  HyperliquidGroupState,
  HyperliquidProvider,
} from "@qntx/wallet-engine/apps/hyperliquid";
import { HyperliquidError } from "@qntx/wallet-engine/apps/hyperliquid";
import type { HyperliquidAgentLimits, SessionInfo } from "@qntx/wallet/sessions";
import { sessions } from "@qntx/wallet/sessions";

const LIMITS: HyperliquidAgentLimits = {
  notional: "1000",
  maxLeverage: 10,
  assets: [
    { asset: 0, size: "10" },
    { asset: 10_001, size: "100" },
  ],
};

/** Create approves the limits once; open re-approves the same limits after every lock. */
export async function agentSession(wallet: Wallet, walletId: string): Promise<SessionInfo> {
  const api = sessions(wallet);
  const address = await api.create({
    scheme: "hyperliquid-l1-agent",
    owner: { walletId, groupIndex: 0 },
    scope: "Mainnet",
    name: "bot-1",
    validUntil: Date.now() + 180 * 86_400_000,
    limits: LIMITS,
    verify: { kind: "hardware" },
  });
  // After a lock the opened set is empty: sign answers `approval-required` until `open`.
  await api.open(address, { kind: "hardware" });
  const all = await api.list();
  const info = all.find((s) => s.supported && s.address === address);
  if (info === undefined) {
    throw new Error("the session is gone");
  }
  return info; // info.limits restates LIMITS; info.spent is the charged metering so far.
}

/** Map the metering refusals to UX. */
export async function signWithinBudget(
  wallet: Wallet,
  address: string,
  params: Parameters<ReturnType<typeof sessions>["sign"]>[0]["params"],
): Promise<"signed" | "reopen" | "over" | "app-lock"> {
  try {
    await sessions(wallet).sign({ scheme: "hyperliquid-l1-agent", address, params });
    return "signed";
  } catch (error) {
    if (error instanceof WalletError) {
      if (error.code === "approval-required") {
        return "reopen";
      }
      if (error.code === "limit-exceeded") {
        return "over"; // renew with higher limits — never silently retry
      }
      if (error.code === "app-lock-required") {
        return "app-lock"; // a `device`-factor vault cannot hold a metered session
      }
    }
    throw error;
  }
}

/**
 * `spent` is opaque `ProtocolValue` — the scheme's `{ notional, size }` JSON — and `conflict` means
 * a third live metered session for the same owner and scope; delete one, then retry.
 */
export async function createOrReuse(
  wallet: Wallet,
  input: Parameters<ReturnType<typeof sessions>["create"]>[0],
): Promise<{ created: boolean; spent: SessionInfo["spent"] | undefined }> {
  const api = sessions(wallet);
  try {
    await api.create(input);
    return { created: true, spent: undefined };
  } catch (error) {
    if (error instanceof WalletError && error.code === "conflict") {
      const all = await api.list();
      const live = all.find(
        (s) =>
          s.supported &&
          s.walletId === input.owner.walletId &&
          s.groupIndex === input.owner.groupIndex &&
          s.scope === input.scope,
      );
      return { created: false, spent: live?.spent };
    }
    throw error;
  }
}

/**
 * The engine path: `enable`/`renew` take the same `{ limits, verify }`, and `reopen` re-approves
 * the agent in the kernel — the kernel's prompt restates the limits and the remaining budget.
 */
export async function enableAndReopen(
  apps: AppsController<{ readonly hyperliquid: HyperliquidGroupState }>,
  provider: HyperliquidProvider,
  group: HyperliquidGroup,
  verify: VerifyFactor,
): Promise<void> {
  await apps.enable(group, "hyperliquid", { limits: LIMITS, verify });
  try {
    await provider.reopen(group, verify);
  } catch (error) {
    if (error instanceof HyperliquidError && error.category === "app-lock-required") {
      throw new Error("turn the app lock on first", { cause: error });
    }
    throw error;
  }
}

/** Trading answers `reopen-required` while the session is unopened — call `reopen`, not enable. */
export function isReopen(error: unknown): boolean {
  return error instanceof HyperliquidError && error.category === "reopen-required";
}
