/**
 * The system verification prompt for `chain.sign`, rendered from the kernel's own decode of the
 * request (WD-065): `full` lists every outflow, approval and the fee cap; `partial` leads with a
 * warning that other outflows may exist; `opaque` shows only the generic line. Addresses are never
 * truncated — a shortened address is what address poisoning relies on.
 */
import type { AssetAmount, DisplayIntent, IntentSummary } from "@qntx/wallet-chains";

import type { KeystorePrompt } from "../../platform.ts";
import { formatUnits, joinLines } from "../../prompts.ts";
import type { PromptLocale } from "../../prompts.ts";

export type PromptIntent = Pick<
  DisplayIntent,
  "summary" | "outflows" | "approvals" | "fee" | "verifiability"
>;

/** Off-chain messages carry no decodable value flow. */
export const MESSAGE_INTENT: PromptIntent = {
  summary: "message",
  outflows: [],
  approvals: [],
  fee: undefined,
  verifiability: "opaque",
};

type Catalog = {
  readonly titles: Readonly<Record<IntentSummary, string>>;
  readonly generic: string;
  readonly otherOutflows: string;
  readonly send: (amount: string, to: string) => string;
  readonly allow: (spender: string, amount: string) => string;
  readonly unlimited: (asset: string) => string;
  readonly maxFee: (fee: string) => string;
};

const CATALOGS: Readonly<Record<PromptLocale, Catalog>> = {
  "zh-Hans": {
    titles: {
      transfer: "确认转账",
      approve: "确认授权",
      "contract-call": "确认合约调用",
      swap: "确认兑换",
      message: "确认签名",
      authorization: "确认账户授权",
      batch: "确认批量交易",
    },
    generic: "签署来自应用的请求",
    otherOutflows: "可能还有其他转出",
    send: (amount, to) => `发送 ${amount} 到 ${to}`,
    allow: (spender, amount) => `授权 ${spender} 使用 ${amount}`,
    unlimited: (asset) => `全部 ${asset}`,
    maxFee: (fee) => `最高手续费 ${fee}`,
  },
  en: {
    titles: {
      transfer: "Confirm transfer",
      approve: "Confirm approval",
      "contract-call": "Confirm contract call",
      swap: "Confirm swap",
      message: "Confirm signature",
      authorization: "Confirm account authorization",
      batch: "Confirm batch",
    },
    generic: "Sign a request from an app",
    otherOutflows: "There may be other outflows",
    send: (amount, to) => `Send ${amount} to ${to}`,
    allow: (spender, amount) => `Allow ${spender} to spend ${amount}`,
    unlimited: (asset) => `unlimited ${asset}`,
    maxFee: (fee) => `Max fee ${fee}`,
  },
};

/** `0.05 ETH` with known decimals (symbol, else the asset id); raw units and asset id otherwise. */
export function formatAmount(amount: AssetAmount): string {
  return amount.decimals === undefined
    ? `${amount.amount} ${amount.asset}`
    : `${formatUnits(amount.amount, amount.decimals)} ${amount.symbol ?? amount.asset}`;
}

export function chainPrompt(locale: PromptLocale, intent: PromptIntent): KeystorePrompt {
  const catalog = CATALOGS[locale];
  const title = catalog.titles[intent.summary];
  if (intent.verifiability === "opaque") {
    return { title, description: catalog.generic };
  }
  const lines = [
    ...intent.outflows.map((flow) => catalog.send(formatAmount(flow.amount), flow.to)),
    ...intent.approvals.map((change) =>
      catalog.allow(
        change.spender,
        change.unlimited ? catalog.unlimited(change.asset) : `${change.amount} ${change.asset}`,
      ),
    ),
    ...(intent.fee === undefined ? [] : [catalog.maxFee(formatAmount(intent.fee.max))]),
  ];
  if (intent.verifiability === "partial") {
    return { title, description: joinLines([catalog.otherOutflows, ...lines]) };
  }
  return { title, description: joinLines(lines.length === 0 ? [catalog.generic] : lines) };
}
