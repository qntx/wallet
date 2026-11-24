import type { HyperliquidAgentLimits } from "@qntx/wallet/protocol";

import { decimalToUnits, unitsToDecimal } from "../../../../decimal.ts";
/**
 * The hyperliquid-l1-agent approval prompt — the text the verification dialog shows when a session
 * is created and when it is reopened after a lock. It states the agent name and scope, the signing
 * deadline, the notional budget, the leverage cap and the asset allow-list; the reopening variant
 * adds the remaining budget. Spot ids are marked so the user sees the list is not perp-only. The
 * prompt-bound tests pin the worst case (16 five-digit ids, a ~1e15 budget).
 */
import type { KeystorePrompt } from "../../../../platform.ts";
import type { PromptLocale } from "../../../../prompts.ts";
import { utcDate } from "../../../../prompts.ts";
import type { SessionApproval } from "../../scheme.ts";

/* Spot asset ids start at this base — `10000 + spot index` (Hyperliquid asset-ids doc; the
   engine's resolver in apps/hyperliquid/actions.ts encodes the same convention). */
const SPOT_ASSET_BASE = 10_000;

const kindLines = (
  limits: HyperliquidAgentLimits,
  perp: string,
  spot: string,
): ReadonlyArray<string> => {
  const perps: number[] = [];
  const spots: number[] = [];
  for (const asset of limits.assets) {
    (asset < SPOT_ASSET_BASE ? perps : spots).push(asset);
  }
  const lines: string[] = [];
  if (perps.length > 0) {
    lines.push(`${perp}${perps.join(",")}`);
  }
  if (spots.length > 0) {
    lines.push(`${spot}${spots.join(",")}`);
  }
  return lines;
};

export function hyperliquidApproval(
  session: Omit<SessionApproval, "limits"> & { readonly limits: HyperliquidAgentLimits },
  open: boolean,
  locale: PromptLocale,
): KeystorePrompt {
  const { limits } = session;
  const day = utcDate(Math.floor(session.validUntil / 1000));
  const lines =
    locale === "zh-Hans"
      ? [
          `Hyperliquid 交易代理 "${session.name}"（${session.scope}）`,
          `有效期至 ${day}`,
          `预算：${limits.notional}（价格 × 数量之和，按各市场报价币计）`,
          `最大杠杆：${limits.maxLeverage}x`,
          ...kindLines(limits, "永续资产：", "现货资产："),
        ]
      : [
          `Hyperliquid trading agent "${session.name}" on ${session.scope}`,
          `Valid until ${day}`,
          `Budget: ${limits.notional} (sum of price × size, in each market's quote currency)`,
          `Max leverage: ${limits.maxLeverage}x`,
          ...kindLines(limits, "Perp assets: ", "Spot assets: "),
        ];
  if (open) {
    const left = unitsToDecimal(decimalToUnits(limits.notional) - decimalToUnits(session.spent));
    lines.push(locale === "zh-Hans" ? `剩余预算：${left}` : `Remaining: ${left}`);
  }
  return {
    title: locale === "zh-Hans" ? "批准 Hyperliquid 代理" : "Approve Hyperliquid agent",
    description: lines.join("\n"),
  };
}
