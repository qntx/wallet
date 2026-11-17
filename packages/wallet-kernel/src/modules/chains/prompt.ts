/**
 * The system verification prompt for `chain.sign`, rendered from the kernel's own decode of the
 * request (WD-065). A transaction lists every fact the signed bytes prove — outflows, approvals,
 * the fee cap — and says so when other effects may exist (`partial`) or cannot be verified at all
 * (`opaque`). A message shows what is signed: its text, the sign-in it carries, or the typed data's
 * domain and recognised content. Addresses are never truncated — a shortened address is what
 * address poisoning relies on. Text chosen by the requester is shown as a bounded, sanitised
 * excerpt.
 */
import { displayExcerpt } from "@qntx/wallet-chains";
import type {
  ApprovalChange,
  AssetAmount,
  DisplayIntent,
  IntentSummary,
  MessageContent,
  SafeTransaction,
  SeaportOrder,
  SignInParse,
  StakeAction,
} from "@qntx/wallet-chains";
import { networkMeta } from "@qntx/wallet-chains/networks";

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
  | "contract"
  | "calls"
> & {
  /** Decoders always set it; a message without a chain of its own omits it. */
  readonly network?: string;
  readonly warnings?: DisplayIntent["warnings"];
  readonly staking?: DisplayIntent["staking"];
};

/** The prompt intent of an off-chain message: it moves no value and pays no fee. */
export const messagePromptIntent = (message: MessageContent): PromptIntent => ({
  summary: "message",
  outflows: [],
  approvals: [],
  fee: undefined,
  verifiability: "opaque",
  message,
});

/** How much requester-chosen text one prompt shows. */
const MESSAGE_LINES = 6;
const MESSAGE_CODE_POINTS = 320;
const FIELD_CODE_POINTS = 96;
const ORDER_ITEMS = 4;

type Catalog = {
  readonly titles: Readonly<Record<IntentSummary, string>>;
  readonly blindTitle: string;
  readonly blindDescription: string;
  readonly otherOutflows: string;
  readonly unverifiedEffects: string;
  readonly callContract: (address: string) => string;
  readonly deployContract: (address: string) => string;
  readonly signInTitle: string;
  readonly signInTo: (domain: string) => string;
  readonly signInAccount: (address: string) => string;
  readonly signInUri: (uri: string) => string;
  readonly signInMalformed: string;
  readonly messageHeading: string;
  readonly omitted: (count: number) => string;
  readonly typedApp: (name: string) => string;
  readonly typedContract: (address: string) => string;
  readonly typedType: (name: string) => string;
  readonly typedUnshown: string;
  readonly orderGive: (amount: string) => string;
  readonly orderReceive: (recipient: string, amount: string) => string;
  readonly moreItems: (count: number) => string;
  readonly safeTransaction: (safe: string, nonce: string) => string;
  readonly safeDelegatecall: (target: string) => string;
  readonly safeRefund: (receiver: string) => string;
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
  readonly feeUnknown: string;
  readonly networkLine: (label: string) => string;
  readonly unknownEvmChain: (chainId: number) => string;
  readonly unverifiedToken: (amount: string, asset: string) => string;
  readonly sighashSingle: string;
  readonly delegateTo: (name: string, version: string) => string;
  readonly revokeDelegation: string;
  readonly stakeLine: (action: StakeAction, sol: (lamports: string) => string) => string;
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

const zh: Catalog = {
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
  otherOutflows: "可能还有其他转出",
  unverifiedEffects: "无法核实此调用的效果",
  callContract: (address) => `调用合约 ${address}`,
  deployContract: (address) => `部署合约 ${address}`,
  signInTitle: "确认登录",
  signInTo: (domain) => `登录 ${domain}`,
  signInAccount: (address) => `账户 ${address}`,
  signInUri: (uri) => `地址 ${uri}`,
  signInMalformed: "内容像登录请求，但格式不合规",
  messageHeading: "消息：",
  omitted: (count) => `… 还有 ${count} 个字符未显示`,
  typedApp: (name) => `应用：${name}`,
  typedContract: (address) => `验证合约 ${address}`,
  typedType: (name) => `类型：${name}`,
  typedUnshown: "无法显示此请求的内容",
  orderGive: (amount) => `付出 ${amount}`,
  orderReceive: (recipient, amount) => `${recipient} 收到 ${amount}`,
  moreItems: (count) => `… 还有 ${count} 项未显示`,
  safeTransaction: (safe, nonce) => `Safe ${safe} 的第 ${nonce} 笔交易`,
  safeDelegatecall: (target) => `以 Safe 的全部权限执行 ${target} 的代码（delegatecall）`,
  safeRefund: (receiver) => `向 ${receiver} 退还 gas 费`,
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
  feeUnknown: "手续费未知",
  networkLine: (label) => `网络：${label}`,
  unknownEvmChain: (chainId) => `EVM 链 ${chainId}`,
  unverifiedToken: (amount, asset) => `${amount} 个最小单位（未验证代币 ${asset}）`,
  sighashSingle: "已签输入只绑定同序号输出，交易其余部分可被改动",
  platformFee: (message) => `Jupiter 收取平台费 ${message}`,
  bridgeLine: (network, amount, to, deadline, refundTo) =>
    `跨链到 ${network}：至少收到 ${amount}，收款地址 ${to}；${deadline} 前未成交则退回 ${refundTo}`,
  delegateTo: (name, version) => `将此账户委托给 ${name} v${version}；该合约可代其执行调用`,
  revokeDelegation: "撤销此账户的合约委托",
  stakeRole: { staker: "质押", withdrawer: "提取" },
  stakeAuthority: (account, role, authority) =>
    `将质押账户 ${account} 的${role}权限交给 ${authority}`,
  stakeLine: (a, sol) =>
    a.kind === "create"
      ? `创建质押账户 ${a.account}，存入 ${sol(a.lamports)}`
      : a.kind === "delegate"
        ? `委托质押账户 ${a.account} 给验证者 ${a.validator}`
        : a.kind === "deactivate"
          ? `解除质押 ${a.account}`
          : a.kind === "withdraw"
            ? `从 ${a.account} 提取 ${sol(a.lamports)} 到 ${a.to}`
            : a.kind === "lido-submit"
              ? `通过 Lido 质押 ${formatAmount(zh, a.amount)}，收到约 ${formatAmount(zh, a.receive)}`
              : a.kind === "lido-request"
                ? `申请提取 ${formatAmount(zh, a.amount)}，提款凭证归 ${a.owner}`
                : `领取 Lido 提款 ${a.requestIds.join(", ")}`,
};

const en: Catalog = {
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
  otherOutflows: "There may be other outflows",
  unverifiedEffects: "The effects of this call cannot be verified",
  callContract: (address) => `Call contract ${address}`,
  deployContract: (address) => `Deploy contract ${address}`,
  signInTitle: "Confirm sign-in",
  signInTo: (domain) => `Sign in to ${domain}`,
  signInAccount: (address) => `Account ${address}`,
  signInUri: (uri) => `URI ${uri}`,
  signInMalformed: "This looks like a sign-in request but is not a valid one",
  messageHeading: "Message:",
  omitted: (count) => `… ${count} more characters not shown`,
  typedApp: (name) => `App: ${name}`,
  typedContract: (address) => `Verifying contract ${address}`,
  typedType: (name) => `Type: ${name}`,
  typedUnshown: "The content of this request cannot be shown",
  orderGive: (amount) => `Give ${amount}`,
  orderReceive: (recipient, amount) => `${recipient} receives ${amount}`,
  moreItems: (count) => `… ${count} more items not shown`,
  safeTransaction: (safe, nonce) => `Safe ${safe}, transaction ${nonce}`,
  safeDelegatecall: (target) =>
    `Runs the code of ${target} with the Safe's full authority (delegatecall)`,
  safeRefund: (receiver) => `Refunds gas to ${receiver}`,
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
  feeUnknown: "Fee unknown",
  networkLine: (label) => `Network: ${label}`,
  unknownEvmChain: (chainId) => `EVM chain ${chainId}`,
  unverifiedToken: (amount, asset) => `${amount} base units of unverified token ${asset}`,
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
  stakeLine: (a, sol) =>
    a.kind === "create"
      ? `Create stake account ${a.account} with ${sol(a.lamports)}`
      : a.kind === "delegate"
        ? `Delegate stake account ${a.account} to validator ${a.validator}`
        : a.kind === "deactivate"
          ? `Deactivate stake ${a.account}`
          : a.kind === "withdraw"
            ? `Withdraw ${sol(a.lamports)} from ${a.account} to ${a.to}`
            : a.kind === "lido-submit"
              ? `Stake ${formatAmount(en, a.amount)} with Lido, receive about ${formatAmount(en, a.receive)}`
              : a.kind === "lido-request"
                ? `Request withdrawal of ${formatAmount(en, a.amount)}; the claim NFT goes to ${a.owner}`
                : `Claim Lido withdrawals ${a.requestIds.join(", ")}`,
};

const CATALOGS: Readonly<Record<PromptLocale, Catalog>> = { "zh-Hans": zh, en };

/**
 * `0.05 ETH` with known decimals (symbol, else the asset id); an amount with no decimals and no
 * tokenId is a token the table did not review, so the raw units are named unverified.
 */
export function formatAmount(catalog: Catalog, amount: AssetAmount): string {
  if (amount.tokenId !== undefined) {
    const base = `${amount.asset} #${amount.tokenId}`;
    return amount.amount === "1" ? base : `${base} ×${amount.amount}`;
  }
  return amount.decimals === undefined
    ? catalog.unverifiedToken(amount.amount, amount.asset)
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

/** `YYYY-MM-DD HH:MM` of a Unix-seconds instant in UTC (no `Date` in the enclave). */
const utcDateTime = (seconds: number): string =>
  `${utcDate(seconds)} ${String(Math.floor(seconds / 3600) % 24).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}`;

/** The network's display name: the registry name, a generic EVM label, or the raw CAIP-2 id. */
const networkLabel = (catalog: Catalog, id: string): string => {
  const meta = networkMeta(id);
  if (meta !== undefined) {
    return meta.name;
  }
  const evm = /^eip155:(\d+)$/.exec(id);
  return evm === null ? id : catalog.unknownEvmChain(Number(evm[1]));
};

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
    line = catalog.increase(change.spender, formatAmount(catalog, change.amount));
  } else if (change.change === "decrease") {
    line = catalog.decrease(change.spender, formatAmount(catalog, change.amount));
  } else if (change.change === "transfer") {
    line = catalog.takeOnce(
      change.spender,
      change.unlimited ? catalog.unlimited(name) : formatAmount(catalog, change.amount),
    );
  } else if (change.unlimited) {
    line = catalog.allow(change.spender, catalog.unlimited(name));
  } else if (change.amount.amount === "0") {
    line = catalog.revoke(change.spender, name);
  } else {
    line = catalog.allow(change.spender, formatAmount(catalog, change.amount));
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

/** One requester-chosen value on a single line. */
const field = (raw: string): string => displayExcerpt(raw, 1, FIELD_CODE_POINTS).lines[0] ?? "";

/** The contracts an unverifiable transaction runs: its own, or each opaque call of a batch. */
function contractLines(catalog: Catalog, intent: PromptIntent): ReadonlyArray<string> {
  const calls = intent.calls ?? [intent];
  return calls.flatMap(({ contract, verifiability }) =>
    contract === undefined || verifiability !== "opaque"
      ? []
      : [
          contract.created
            ? catalog.deployContract(contract.address)
            : catalog.callContract(contract.address),
        ],
  );
}

/** What the decoded content does: contracts run, delegation, outflows, receipts, approvals. */
function effectLines(catalog: Catalog, intent: PromptIntent): ReadonlyArray<string> {
  const sol = (lamports: string): string =>
    `${formatUnits(lamports, 9)} ${networkMeta(intent.network ?? "")?.symbol ?? "SOL"}`;
  const delegation =
    intent.delegation === undefined
      ? []
      : [
          intent.delegation.kind === "set"
            ? catalog.delegateTo(intent.delegation.name, intent.delegation.version)
            : catalog.revokeDelegation,
        ];
  const received =
    intent.bridge === undefined
      ? (intent.minimumReceived ?? []).map((entry) =>
          catalog.receiveMin(formatAmount(catalog, entry.amount), entry.to),
        )
      : [
          catalog.bridgeLine(
            networkLabel(catalog, intent.bridge.destinationNetwork),
            intent.minimumReceived?.[0] === undefined
              ? "?"
              : formatAmount(catalog, intent.minimumReceived[0].amount),
            intent.minimumReceived?.[0]?.to ?? intent.bridge.refundTo,
            utcDateTime(intent.bridge.fillDeadline),
            intent.bridge.refundTo,
          ),
        ];
  return [
    ...delegation,
    ...contractLines(catalog, intent),
    ...intent.outflows.map((flow) => catalog.send(formatAmount(catalog, flow.amount), flow.to)),
    ...(intent.staking ?? []).map((action) => catalog.stakeLine(action, sol)),
    ...received,
    ...intent.approvals.map((change) => approvalLine(catalog, change)),
  ];
}

function transactionPrompt(catalog: Catalog, intent: PromptIntent): KeystorePrompt {
  const network =
    intent.network === undefined
      ? []
      : [catalog.networkLine(networkLabel(catalog, intent.network))];
  const caveat =
    intent.verifiability === "opaque"
      ? [catalog.unverifiedEffects]
      : intent.verifiability === "partial"
        ? [catalog.otherOutflows]
        : [];
  const warnings = intent.warnings ?? [];
  return {
    title: catalog.titles[intent.summary],
    description: joinLines([
      ...network,
      ...caveat,
      ...effectLines(catalog, intent),
      intent.fee === undefined
        ? catalog.feeUnknown
        : catalog.maxFee(formatAmount(catalog, intent.fee.max)),
      ...warnings
        .filter((w) => w.kind === "platform-fee")
        .map((w) => catalog.platformFee(w.message)),
      ...(warnings.some((w) => w.kind === "sighash-single-anyonecanpay")
        ? [catalog.sighashSingle]
        : []),
    ]),
  };
}

function signInLines(catalog: Catalog, signIn: SignInParse): ReadonlyArray<string> {
  if (signIn.status === "malformed") {
    return [catalog.signInMalformed];
  }
  const { domain, address, chainId, uri } = signIn.fields;
  return [
    catalog.signInTo(field(domain)),
    catalog.signInAccount(field(address)),
    catalog.networkLine(
      /^\d+$/.test(chainId) ? networkLabel(catalog, `eip155:${chainId}`) : field(chainId),
    ),
    catalog.signInUri(field(uri)),
  ];
}

function textLines(catalog: Catalog, text: string): ReadonlyArray<string> {
  const { lines, omitted } = displayExcerpt(text, MESSAGE_LINES, MESSAGE_CODE_POINTS);
  return [catalog.messageHeading, ...lines, ...(omitted === 0 ? [] : [catalog.omitted(omitted)])];
}

function orderLines(catalog: Catalog, order: SeaportOrder): ReadonlyArray<string> {
  const amount = (item: SeaportOrder["offer"][number]): string => {
    const start = formatAmount(catalog, item.startAmount);
    const end = formatAmount(catalog, item.endAmount);
    return start === end ? start : `${start} → ${end}`;
  };
  const capped = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
    lines.length > ORDER_ITEMS
      ? [...lines.slice(0, ORDER_ITEMS), catalog.moreItems(lines.length - ORDER_ITEMS)]
      : lines;
  return [
    ...capped(order.offer.map((item) => catalog.orderGive(amount(item)))),
    ...capped(
      order.consideration.map((item) => catalog.orderReceive(item.recipient, amount(item))),
    ),
  ];
}

function safeLines(catalog: Catalog, safe: SafeTransaction): ReadonlyArray<string> {
  return [
    catalog.safeTransaction(safe.safe, safe.nonce),
    ...(safe.operation === "delegatecall" ? [catalog.safeDelegatecall(safe.to)] : []),
    ...safe.calls.flatMap((call) => [
      ...(call.verifiability === "opaque" ? [catalog.unverifiedEffects] : []),
      ...effectLines(catalog, call),
    ]),
    ...(safe.refund === undefined ? [] : [catalog.safeRefund(safe.refund.refundReceiver)]),
  ];
}

/** What recognised typed data does; unrecognised content is named as not shown. */
function typedContentLines(
  catalog: Catalog,
  intent: PromptIntent,
  message: Extract<MessageContent, { kind: "typed-data" }>,
): ReadonlyArray<string> {
  if (message.seaport !== undefined) {
    return orderLines(catalog, message.seaport);
  }
  if (message.safe !== undefined) {
    return safeLines(catalog, message.safe);
  }
  return intent.approvals.length > 0
    ? [catalog.otherOutflows, ...effectLines(catalog, intent)]
    : [catalog.typedUnshown];
}

function typedDataLines(
  catalog: Catalog,
  intent: PromptIntent,
  message: Extract<MessageContent, { kind: "typed-data" }>,
): ReadonlyArray<string> {
  const { name, chainId, verifyingContract } = message.domain;
  const network = chainId === undefined ? intent.network : `eip155:${chainId}`;
  return [
    ...(name === undefined ? [] : [catalog.typedApp(field(name))]),
    ...(network === undefined ? [] : [catalog.networkLine(networkLabel(catalog, network))]),
    ...(verifyingContract === undefined ? [] : [catalog.typedContract(verifyingContract)]),
    catalog.typedType(field(message.primaryType)),
    ...typedContentLines(catalog, intent, message),
  ];
}

function messagePrompt(
  catalog: Catalog,
  intent: PromptIntent,
  message: MessageContent,
): KeystorePrompt {
  if (message.kind === "bytes") {
    return { title: catalog.blindTitle, description: catalog.blindDescription };
  }
  if (message.kind === "typed-data") {
    return {
      title: catalog.titles[intent.summary],
      description: joinLines(typedDataLines(catalog, intent, message)),
    };
  }
  if (message.signIn?.status === "valid") {
    return {
      title: catalog.signInTitle,
      description: joinLines(signInLines(catalog, message.signIn)),
    };
  }
  return {
    title: catalog.titles.message,
    description: joinLines([
      ...(message.signIn === undefined ? [] : signInLines(catalog, message.signIn)),
      ...textLines(catalog, message.text),
    ]),
  };
}

export function chainPrompt(locale: PromptLocale, intent: PromptIntent): KeystorePrompt {
  const catalog = CATALOGS[locale];
  return intent.message === undefined
    ? transactionPrompt(catalog, intent)
    : messagePrompt(catalog, intent, intent.message);
}
