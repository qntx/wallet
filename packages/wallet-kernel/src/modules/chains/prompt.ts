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
  StakeAction,
} from "@qntx/wallet-chains";

import type { KeystorePrompt } from "../../platform.ts";
import { formatUnits, joinLines } from "../../prompts.ts";
import type { PromptLocale } from "../../prompts.ts";

export type PromptIntent = Pick<
  DisplayIntent,
  | "summary"
  | "outflows"
  | "approvals"
  | "fee"
  | "verifiability"
  | "message"
  | "delegation"
  | "minimumReceived"
  | "bridge"
> & {
  readonly warnings?: DisplayIntent["warnings"];
  readonly staking?: DisplayIntent["staking"];
};

/** Off-chain messages carry no decodable value flow. */
export const MESSAGE_INTENT: PromptIntent = {
  summary: "message",
  outflows: [],
  approvals: [],
  fee: undefined,
  verifiability: "opaque",
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The prompt intent of a raw message: its UTF-8 text, or the bytes as hex for a blind sign. */
export const messageIntent = (message: Uint8Array): PromptIntent => {
  try {
    return { ...MESSAGE_INTENT, message: { kind: "text", text: utf8.decode(message) } };
  } catch {
    return {
      ...MESSAGE_INTENT,
      message: {
        kind: "bytes",
        hex: `0x${[...message].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      },
    };
  }
};

type Catalog = {
  readonly titles: Readonly<Record<IntentSummary, string>>;
  readonly blindTitle: string;
  readonly blindDescription: string;
  readonly generic: string;
  readonly otherOutflows: string;
  readonly send: (amount: string, to: string) => string;
  readonly allow: (spender: string, amount: string) => string;
  readonly unlimited: (asset: string) => string;
  readonly revoke: (spender: string, asset: string) => string;
  readonly increase: (spender: string, amount: string) => string;
  readonly decrease: (spender: string, amount: string) => string;
  readonly takeOnce: (spender: string, amount: string) => string;
  readonly viaPermit2: string;
  readonly viaAllowanceHolder: string;
  readonly receiveMin: (amount: string, to: string) => string;
  readonly until: (date: string) => string;
  readonly operatorAllow: (spender: string, asset: string) => string;
  readonly operatorRevoke: (spender: string, asset: string) => string;
  readonly maxFee: (fee: string) => string;
  readonly sighashSingle: string;
  readonly delegateTo: (name: string, version: string) => string;
  readonly revokeDelegation: string;
  readonly stakeLine: (action: StakeAction) => string;
  readonly platformFee: (message: string) => string;
  readonly bridgeLine: (
    network: string,
    amount: string,
    to: string,
    deadline: string,
    refundTo: string,
  ) => string;
  readonly stakeAuthority: (account: string, role: string, authority: string) => string;
  readonly stakeRole: Readonly<Record<"staker" | "withdrawer", string>>;
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
      stake: "确认质押",
      bridge: "确认跨链",
    },
    blindTitle: "确认盲签",
    blindDescription: "签署无法显示为文字的数据",
    generic: "签署来自应用的请求",
    otherOutflows: "可能还有其他转出",
    send: (amount, to) => `发送 ${amount} 到 ${to}`,
    allow: (spender, amount) => `授权 ${spender} 使用 ${amount}`,
    unlimited: (asset) => `全部 ${asset}`,
    revoke: (spender, asset) => `撤销 ${spender} 对 ${asset} 的授权`,
    increase: (spender, amount) => `授权 ${spender} 再使用 ${amount}`,
    decrease: (spender, amount) => `减少 ${spender} 的授权额度 ${amount}`,
    takeOnce: (spender, amount) => `授权 ${spender} 一次性转走 ${amount}`,
    viaPermit2: " 经 Permit2",
    viaAllowanceHolder: " 经 AllowanceHolder",
    receiveMin: (amount, to) => `至少收到 ${amount}，收款地址 ${to}`,
    until: (date) => ` 至 ${date}（UTC）`,
    operatorAllow: (spender, asset) => `授权 ${spender} 转走 ${asset} 的全部代币`,
    operatorRevoke: (spender, asset) => `撤销 ${spender} 对 ${asset} 全部代币的授权`,
    maxFee: (fee) => `最高手续费 ${fee}`,
    sighashSingle: "已签输入只绑定同序号输出，交易其余部分可被改动",
    platformFee: (message) => `Jupiter 收取平台费 ${message}`,
    bridgeLine: (network, amount, to, deadline, refundTo) =>
      `跨链到 ${network}：至少收到 ${amount}，收款地址 ${to}；${deadline} 前未成交则退回 ${refundTo}`,
    delegateTo: (name, version) => `将此账户委托给 ${name} v${version}；该合约可代其执行调用`,
    revokeDelegation: "撤销此账户的合约委托",
    stakeRole: { staker: "质押", withdrawer: "提取" },
    stakeAuthority: (account, role, authority) =>
      `将质押账户 ${account} 的${role}权限交给 ${authority}`,
    stakeLine: (a) =>
      a.kind === "create"
        ? `创建质押账户 ${a.account}，存入 ${a.lamports} lamports`
        : a.kind === "delegate"
          ? `委托质押账户 ${a.account} 给验证者 ${a.validator}`
          : a.kind === "deactivate"
            ? `解除质押 ${a.account}`
            : a.kind === "withdraw"
              ? `从 ${a.account} 提取 ${a.lamports} lamports 到 ${a.to}`
              : a.kind === "lido-submit"
                ? `通过 Lido 质押 ${formatAmount(a.amount)}，收到约 ${formatAmount(a.receive)}`
                : a.kind === "lido-request"
                  ? `申请提取 ${formatAmount(a.amount)}，提款凭证归 ${a.owner}`
                  : `领取 Lido 提款 ${a.requestIds.join(", ")}`,
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
      stake: "Confirm staking",
      bridge: "Confirm bridge",
    },
    blindTitle: "Confirm blind signing",
    blindDescription: "Sign data that cannot be shown as text",
    generic: "Sign a request from an app",
    otherOutflows: "There may be other outflows",
    send: (amount, to) => `Send ${amount} to ${to}`,
    allow: (spender, amount) => `Allow ${spender} to spend ${amount}`,
    unlimited: (asset) => `unlimited ${asset}`,
    revoke: (spender, asset) => `Revoke ${spender}'s allowance for ${asset}`,
    increase: (spender, amount) => `Allow ${spender} to spend ${amount} more`,
    decrease: (spender, amount) => `Reduce ${spender}'s allowance by ${amount}`,
    takeOnce: (spender, amount) => `Allow ${spender} to take ${amount} once`,
    viaPermit2: " via Permit2",
    viaAllowanceHolder: " via AllowanceHolder",
    receiveMin: (amount, to) => `Receive at least ${amount} at ${to}`,
    until: (date) => ` until ${date} (UTC)`,
    operatorAllow: (spender, asset) => `Allow ${spender} to transfer all tokens of ${asset}`,
    operatorRevoke: (spender, asset) => `Revoke ${spender}'s access to all tokens of ${asset}`,
    maxFee: (fee) => `Max fee ${fee}`,
    sighashSingle:
      "Signed inputs bind only their same-index outputs; the rest of the transaction can change",
    platformFee: (message) => `Jupiter platform fee: ${message}`,
    bridgeLine: (network, amount, to, deadline, refundTo) =>
      `Bridge to ${network}: receive at least ${amount} at ${to}; refunded to ${refundTo} if not filled by ${deadline} (UTC)`,
    delegateTo: (name, version) =>
      `Delegate this account to ${name} v${version}; the contract can execute calls on its behalf`,
    revokeDelegation: "Revoke this account's contract delegation",
    stakeRole: { staker: "staker", withdrawer: "withdrawer" },
    stakeAuthority: (account, role, authority) =>
      `Give ${authority} the ${role} authority over stake account ${account}`,
    stakeLine: (a) =>
      a.kind === "create"
        ? `Create stake account ${a.account} with ${a.lamports} lamports`
        : a.kind === "delegate"
          ? `Delegate stake account ${a.account} to validator ${a.validator}`
          : a.kind === "deactivate"
            ? `Deactivate stake ${a.account}`
            : a.kind === "withdraw"
              ? `Withdraw ${a.lamports} lamports from ${a.account} to ${a.to}`
              : a.kind === "lido-submit"
                ? `Stake ${formatAmount(a.amount)} with Lido, receive about ${formatAmount(a.receive)}`
                : a.kind === "lido-request"
                  ? `Request withdrawal of ${formatAmount(a.amount)}; the claim NFT goes to ${a.owner}`
                  : `Claim Lido withdrawals ${a.requestIds.join(", ")}`,
  },
};

/** `0.05 ETH` with known decimals (symbol, else the asset id); raw units and asset id otherwise. */
export function formatAmount(amount: AssetAmount): string {
  if (amount.tokenId !== undefined) {
    const base = `${amount.asset} #${amount.tokenId}`;
    return amount.amount === "1" ? base : `${base} ×${amount.amount}`;
  }
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
  if (change.kind === "stake-authority") {
    return catalog.stakeAuthority(change.account, catalog.stakeRole[change.role], change.authority);
  }
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
  } else if (change.change === "transfer") {
    line = catalog.takeOnce(
      change.spender,
      change.unlimited ? catalog.unlimited(name) : formatAmount(change.amount),
    );
  } else if (change.unlimited) {
    line = catalog.allow(change.spender, catalog.unlimited(name));
  } else if (change.amount.amount === "0") {
    line = catalog.revoke(change.spender, name);
  } else {
    line = catalog.allow(change.spender, formatAmount(change.amount));
  }
  const via =
    change.via === "permit2"
      ? catalog.viaPermit2
      : change.via === "allowance-holder"
        ? catalog.viaAllowanceHolder
        : "";
  const until =
    change.expiration === undefined || change.expiration === 0
      ? ""
      : catalog.until(utcDate(change.expiration));
  return `${line}${via}${until}`;
}

export function chainPrompt(locale: PromptLocale, intent: PromptIntent): KeystorePrompt {
  const catalog = CATALOGS[locale];
  if (intent.message?.kind === "bytes") {
    return { title: catalog.blindTitle, description: catalog.blindDescription };
  }
  const title = catalog.titles[intent.summary];
  const caution = intent.warnings?.some((w) => w.kind === "sighash-single-anyonecanpay") === true;
  const tail = caution ? [catalog.sighashSingle] : [];
  const delegation =
    intent.delegation === undefined
      ? []
      : [
          intent.delegation.kind === "set"
            ? catalog.delegateTo(intent.delegation.name, intent.delegation.version)
            : catalog.revokeDelegation,
        ];
  if (intent.verifiability === "opaque") {
    return { title, description: joinLines([...delegation, catalog.generic, ...tail]) };
  }
  const lines = [
    ...delegation,
    ...intent.outflows.map((flow) => catalog.send(formatAmount(flow.amount), flow.to)),
    ...(intent.staking ?? []).map((action) => catalog.stakeLine(action)),
    ...(intent.bridge === undefined
      ? (intent.minimumReceived ?? []).map((entry) =>
          catalog.receiveMin(formatAmount(entry.amount), entry.to),
        )
      : [
          catalog.bridgeLine(
            intent.bridge.destinationNetwork,
            intent.minimumReceived?.[0] === undefined
              ? "?"
              : formatAmount(intent.minimumReceived[0].amount),
            intent.minimumReceived?.[0]?.to ?? intent.bridge.refundTo,
            new Date(intent.bridge.fillDeadline * 1000).toISOString().slice(0, 16),
            intent.bridge.refundTo,
          ),
        ]),
    ...intent.approvals.map((change) => approvalLine(catalog, change)),
    ...(intent.fee === undefined ? [] : [catalog.maxFee(formatAmount(intent.fee.max))]),
    ...(intent.warnings ?? [])
      .filter((w) => w.kind === "platform-fee")
      .map((w) => catalog.platformFee(w.message)),
    ...tail,
  ];
  if (intent.verifiability === "partial") {
    return { title, description: joinLines([catalog.otherOutflows, ...lines]) };
  }
  return { title, description: joinLines(lines.length === 0 ? [catalog.generic] : lines) };
}
