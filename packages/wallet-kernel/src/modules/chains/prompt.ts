/**
 * The system verification prompt for `chain.sign`, rendered from the kernel's own decode of the
 * request (WD-065): `full` lists every outflow, approval and the fee cap; `partial` leads with a
 * warning that other outflows may exist; `opaque` shows only the generic line. Addresses are never
 * truncated — a shortened address is what address poisoning relies on.
 */
import type {
  ApprovalChange,
  AssetAmount,
  DisplayIntent,
  IntentSummary,
} from "@qntx/wallet-chains";

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
  readonly revoke: (spender: string, asset: string) => string;
  readonly increase: (spender: string, amount: string) => string;
  readonly decrease: (spender: string, amount: string) => string;
  readonly viaPermit2: string;
  readonly until: (date: string) => string;
  readonly operatorAllow: (spender: string, asset: string) => string;
  readonly operatorRevoke: (spender: string, asset: string) => string;
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
    revoke: (spender, asset) => `撤销 ${spender} 对 ${asset} 的授权`,
    increase: (spender, amount) => `授权 ${spender} 再使用 ${amount}`,
    decrease: (spender, amount) => `减少 ${spender} 的授权额度 ${amount}`,
    viaPermit2: " 经 Permit2",
    until: (date) => ` 至 ${date}（UTC）`,
    operatorAllow: (spender, asset) => `授权 ${spender} 转走 ${asset} 的全部代币`,
    operatorRevoke: (spender, asset) => `撤销 ${spender} 对 ${asset} 全部代币的授权`,
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
    revoke: (spender, asset) => `Revoke ${spender}'s allowance for ${asset}`,
    increase: (spender, amount) => `Allow ${spender} to spend ${amount} more`,
    decrease: (spender, amount) => `Reduce ${spender}'s allowance by ${amount}`,
    viaPermit2: " via Permit2",
    until: (date) => ` until ${date} (UTC)`,
    operatorAllow: (spender, asset) => `Allow ${spender} to transfer all tokens of ${asset}`,
    operatorRevoke: (spender, asset) => `Revoke ${spender}'s access to all tokens of ${asset}`,
    maxFee: (fee) => `Max fee ${fee}`,
  },
};

/** `0.05 ETH` with known decimals (symbol, else the asset id); raw units and asset id otherwise. */
export function formatAmount(amount: AssetAmount): string {
  return amount.decimals === undefined
    ? `${amount.amount} ${amount.asset}`
    : `${formatUnits(amount.amount, amount.decimals)} ${amount.symbol ?? amount.asset}`;
}

/** `YYYY-MM-DD` of a Unix-seconds instant in UTC (civil-from-days; no `Date` in the enclave). */
function utcDate(seconds: number): string {
  const z = Math.floor(seconds / 86_400) + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function approvalLine(catalog: Catalog, change: ApprovalChange): string {
  if (change.kind === "operator") {
    return change.approved
      ? catalog.operatorAllow(change.spender, change.asset)
      : catalog.operatorRevoke(change.spender, change.asset);
  }
  const name = change.amount.symbol ?? change.amount.asset;
  let line: string;
  if (change.change === "increase") {
    line = catalog.increase(change.spender, formatAmount(change.amount));
  } else if (change.change === "decrease") {
    line = catalog.decrease(change.spender, formatAmount(change.amount));
  } else if (change.unlimited) {
    line = catalog.allow(change.spender, catalog.unlimited(name));
  } else if (change.amount.amount === "0") {
    line = catalog.revoke(change.spender, name);
  } else {
    line = catalog.allow(change.spender, formatAmount(change.amount));
  }
  const via = change.via === undefined ? "" : catalog.viaPermit2;
  const until =
    change.expiration === undefined || change.expiration === 0
      ? ""
      : catalog.until(utcDate(change.expiration));
  return `${line}${via}${until}`;
}

export function chainPrompt(locale: PromptLocale, intent: PromptIntent): KeystorePrompt {
  const catalog = CATALOGS[locale];
  const title = catalog.titles[intent.summary];
  if (intent.verifiability === "opaque") {
    return { title, description: catalog.generic };
  }
  const lines = [
    ...intent.outflows.map((flow) => catalog.send(formatAmount(flow.amount), flow.to)),
    ...intent.approvals.map((change) => approvalLine(catalog, change)),
    ...(intent.fee === undefined ? [] : [catalog.maxFee(formatAmount(intent.fee.max))]),
  ];
  if (intent.verifiability === "partial") {
    return { title, description: joinLines([catalog.otherOutflows, ...lines]) };
  }
  return { title, description: joinLines(lines.length === 0 ? [catalog.generic] : lines) };
}
