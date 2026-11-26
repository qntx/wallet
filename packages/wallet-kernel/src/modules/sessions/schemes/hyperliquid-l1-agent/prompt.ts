import type { HyperliquidAgentLimits, HyperliquidAgentSpent } from "@qntx/wallet/protocol";

import { decimalToUnits, unitsToDecimal } from "../../../../decimal.ts";
/* The approval prompt the verification dialog shows at create and on reopen after a lock: agent
   name and scope, deadline, buy budget, leverage cap, per-asset size caps split perp/spot (ids
   below 10000 are perps — rendered as `#id`, the kernel has no trusted id→name table and the host
   must show the id next to the market name), and that a sell fills at whatever the exchange
   accepts; the reopen variant adds the remaining buy budget. Limits whose text exceeds the
   platform dialog are refused at create, so this rendering is never cut. */
import type { KeystorePrompt } from "../../../../platform.ts";
import type { PromptLocale } from "../../../../prompts.ts";
import { utcDate } from "../../../../prompts.ts";
import type { SessionApproval } from "../../scheme.ts";

/* Spot asset ids start at this base — `10000 + spot index` (Hyperliquid asset-ids doc; the
   engine's resolver in apps/hyperliquid/actions.ts encodes the same convention). */
const SPOT_ASSET_BASE = 10_000;

const capLines = (
  limits: HyperliquidAgentLimits,
  perp: string,
  spot: string,
): ReadonlyArray<string> => {
  let perps = "";
  let spots = "";
  for (const entry of limits.assets) {
    const item = `#${entry.asset} ≤ ${entry.size}`;
    if (entry.asset < SPOT_ASSET_BASE) {
      perps += perps === "" ? item : `, ${item}`;
    } else {
      spots += spots === "" ? item : `, ${item}`;
    }
  }
  const lines: string[] = [];
  if (perps !== "") {
    lines.push(`${perp}${perps}`);
  }
  if (spots !== "") {
    lines.push(`${spot}${spots}`);
  }
  return lines;
};

export function hyperliquidApproval(
  session: Omit<SessionApproval, "limits" | "spent"> & {
    readonly limits: HyperliquidAgentLimits;
    readonly spent: HyperliquidAgentSpent;
  },
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
          `买入预算：${limits.notional}（买单价格 × 数量之和，按各市场报价币计）`,
          `最大杠杆：${limits.maxLeverage}x`,
          ...capLines(limits, "最大数量，买与卖——永续：", "最大数量，买与卖——现货："),
          "卖单可按交易所接受的任意价格成交",
        ]
      : [
          `Hyperliquid trading agent "${session.name}" on ${session.scope}`,
          `Valid until ${day}`,
          `Buy budget: ${limits.notional} (sum of price × size of buys, quote currency)`,
          `Max leverage: ${limits.maxLeverage}x`,
          ...capLines(
            limits,
            "Max size, buys and sells — perp: ",
            "Max size, buys and sells — spot: ",
          ),
          "Sells may fill at any price the exchange accepts",
        ];
  if (open) {
    const left = unitsToDecimal(
      decimalToUnits(limits.notional) - decimalToUnits(session.spent.notional),
    );
    lines.push(locale === "zh-Hans" ? `剩余买入预算：${left}` : `Remaining buy budget: ${left}`);
  }
  return {
    title: locale === "zh-Hans" ? "批准 Hyperliquid 代理" : "Approve Hyperliquid agent",
    description: lines.join("\n"),
  };
}
