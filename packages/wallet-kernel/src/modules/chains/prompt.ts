import { hexToBytes } from "@noble/hashes/utils.js";

/**
 * The system verification prompt for `chain.sign`, rendered from the kernel's own decode of the
 * request (WD-065). A transaction lists every fact the signed bytes prove — outflows, approvals,
 * the fee cap — and says so when other effects may exist (`partial`) or cannot be verified at all
 * (`opaque`). A message shows what is signed: its text, the sign-in it carries, or the typed data's
 * domain and recognised content. Addresses are never truncated — a shortened address is what
 * address poisoning relies on. Text chosen by the requester is shown as a bounded, sanitised
 * excerpt.
 */
import { displayExcerpt, messageBlindReason } from "@qntx/wallet-chains";
import type {
  ApprovalChange,
  AssetAmount,
  ChainFamily,
  DisplayIntent,
  IntentSummary,
  MessageContent,
  SafeTransaction,
  SeaportOrder,
  SignInParse,
  StakeAction,
  TronPermission,
  TronResource,
} from "@qntx/wallet-chains";
import { SEAPORT_ORDER_ITEMS } from "@qntx/wallet-chains/evm";
import { networkMeta } from "@qntx/wallet-chains/networks";
import { tronContractType } from "@qntx/wallet-chains/tron";

import { KernelError } from "../../errors.ts";
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
  | "blind"
  | "programs"
  | "tron"
> & {
  /** Decoders always set it; a message without a chain of its own omits it. */
  readonly network?: string;
  readonly family?: ChainFamily;
  readonly warnings?: DisplayIntent["warnings"];
  readonly staking?: DisplayIntent["staking"];
};

/** The prompt intent of an off-chain message: it moves no value and pays no fee. */
export const messagePromptIntent = (message: MessageContent): PromptIntent => {
  const blind = messageBlindReason(message);
  return {
    summary: "message",
    outflows: [],
    approvals: [],
    fee: undefined,
    verifiability: "opaque",
    message,
    ...(blind === undefined ? {} : { blind }),
  };
};

/** How much requester-chosen text one prompt shows. */
const MESSAGE_LINES = 6;
const MESSAGE_CODE_POINTS = 320;
const FIELD_CODE_POINTS = 96;

type Catalog = {
  readonly titles: Readonly<Record<IntentSummary, string>>;
  readonly blindTitle: string;
  readonly blindBytes: string;
  readonly bytesData: (hex: string) => string;
  readonly bytesLength: (bytes: number) => string;
  readonly otherOutflows: string;
  readonly unverifiedEffects: string;
  readonly externalInputs: string;
  readonly solanaPrograms: (ids: string) => string;
  readonly solanaProgramsWarning: string;
  readonly tokenFunction: (symbol: string, address: string) => string;
  readonly accountCode: string;
  readonly callContract: (address: string, selector: string) => string;
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
  readonly typedUnverified: string;
  readonly typedField: (path: string, value: string) => string;
  readonly typedCommitment: string;
  readonly typedVariant: string;
  readonly typedOversize: string;
  readonly orderGive: (amount: string) => string;
  readonly orderReceive: (recipient: string, amount: string) => string;
  readonly anyTokenOf: (token: string) => string;
  readonly tokenInSet: (token: string, root: string) => string;
  readonly zoneRestriction: (zone: string) => string;
  readonly moreItems: (count: number) => string;
  readonly safeTransaction: (safe: string, nonce: string) => string;
  readonly safeDelegatecall: (target: string) => string;
  readonly safeRefund: (receiver: string | undefined, amount: string, price: string) => string;
  readonly send: (amount: string, to: string) => string;
  readonly burn: (amount: string) => string;
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
  readonly stakeLines: (action: StakeAction, sol: (lamports: string) => string) => string[];
  readonly tronTakeover: (addresses: ReadonlyArray<string>) => string;
  readonly tronContract: (name: string) => string;
  readonly tronField: string;
  readonly tronPermissionKind: Readonly<Record<"owner" | "witness" | "active", string>>;
  readonly tronPermission: (
    kind: string,
    name: string,
    threshold: string,
    keys: ReadonlyArray<{ readonly address: string; readonly weight: string }>,
    operations?: ReadonlyArray<string>,
  ) => string;
  readonly tronPermissionId: (id: number) => string;
  readonly tronMemoHeading: string;
  readonly tronMemoData: (hex: string) => string;
  readonly tronMemoLength: (n: number) => string;
  readonly tronExpires: (datetime: string) => string;
  readonly tronFeeLimit: (fee: string) => string;
  readonly tronBandwidthFee: string;
  readonly tronResource: Readonly<Record<TronResource, string>>;
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
  blindBytes: "钱包无法显示签署的内容。仅在完全信任该应用时签署。",
  bytesData: (hex) => `数据 ${hex}`,
  bytesLength: (bytes) => `${bytes} 字节`,
  otherOutflows: "可能还有其他转出",
  unverifiedEffects: "钱包无法核实此调用会做什么",
  externalInputs: "包含其他签名者的输入；无法核实手续费",
  solanaPrograms: (ids) => `钱包无法解码的程序调用：${ids}`,
  solanaProgramsWarning: "这些程序可以转移本交易涉及账户中的资产",
  tokenFunction: (symbol, address) => `代币 ${symbol} ${address} 的未知函数，可能转走该代币`,
  accountCode: "以本账户的全部权限执行其自身代码",
  callContract: (address, selector) => `调用合约 ${address}，函数 ${selector}`,
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
  typedUnverified: "钱包无法核实此签名授权的内容",
  typedField: (path, value) => `${path}：${value}`,
  typedCommitment: "只签署哈希或原始字节；钱包无法看到它们所承诺的内容",
  typedVariant: "钱包认识这类签名，但不认识这种形式；它可能授权转移资产",
  typedOversize: "此类型数据过大，无法完整显示",
  orderGive: (amount) => `付出 ${amount}`,
  orderReceive: (recipient, amount) => `${recipient} 收到 ${amount}`,
  anyTokenOf: (token) => `${token} 中的任意代币`,
  tokenInSet: (token, root) => `${token} 中 Merkle 根 ${root} 所列的代币`,
  zoneRestriction: (zone) => `区域合约 ${zone} 可限制或取消此订单`,
  moreItems: (count) => `… 还有 ${count} 项未显示`,
  safeTransaction: (safe, nonce) => `Safe ${safe} 的第 ${nonce} 笔交易`,
  safeDelegatecall: (target) => `以 Safe 的全部权限执行 ${target} 的代码（delegatecall）`,
  safeRefund: (receiver, amount, price) =>
    `向 ${receiver ?? "执行者"} 支付 gas 退款：最多 ${amount}，另按每单位 gas ${price} 支付调用开销`,
  send: (amount, to) => `发送 ${amount} 到 ${to}`,
  burn: (amount) => `销毁 ${amount}：转入无法花费的输出，永久丢失`,
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
  stakeLines: (a, sol) => {
    if (a.kind === "create") {
      return [`创建质押账户 ${a.account}，存入 ${sol(a.lamports)}`];
    }
    if (a.kind === "delegate") {
      return [`委托质押账户 ${a.account} 给验证者 ${a.validator}`];
    }
    if (a.kind === "deactivate") {
      return [`解除质押 ${a.account}`];
    }
    if (a.kind === "withdraw") {
      return [`从 ${a.account} 提取 ${sol(a.lamports)} 到 ${a.to}`];
    }
    if (a.kind === "lido-submit") {
      return [
        `通过 Lido 质押 ${formatAmount(zh, a.amount)}，收到约 ${formatAmount(zh, a.receive)}`,
      ];
    }
    if (a.kind === "lido-request") {
      return [`申请提取 ${formatAmount(zh, a.amount)}，提款凭证归 ${a.owner}`];
    }
    if (a.kind === "lido-claim") {
      return [`领取 Lido 提款 ${a.requestIds.join(", ")}`];
    }
    if (a.kind === "tron-freeze") {
      return [`质押 ${formatAmount(zh, a.amount)} 获取${zh.tronResource[a.resource]}`];
    }
    if (a.kind === "tron-unfreeze") {
      return [
        `解除质押${zh.tronResource[a.resource]}的 ${formatAmount(zh, a.amount)}，等待期结束后可提取`,
      ];
    }
    if (a.kind === "tron-delegate") {
      const lock =
        a.lock === undefined
          ? ""
          : a.lock.blocks === "0"
            ? "，锁定默认的 86400 个区块（约 72 小时）"
            : `，锁定 ${a.lock.blocks} 个区块（约 ${(BigInt(a.lock.blocks) * 3n) / 3600n} 小时）`;
      return [
        `将 ${formatAmount(zh, a.amount)} 质押产生的${zh.tronResource[a.resource]}代理给 ${a.receiver}${lock}`,
      ];
    }
    if (a.kind === "tron-undelegate") {
      return [
        `收回代理给 ${a.receiver} 的 ${formatAmount(zh, a.amount)} 质押所产生的${zh.tronResource[a.resource]}`,
      ];
    }
    if (a.kind === "tron-withdraw-unfrozen") {
      return ["提取所有等待期已结束的解除质押 TRX"];
    }
    if (a.kind === "tron-cancel-unfreeze") {
      return ["取消所有未完成的解除质押（重新质押），并提取已到期的部分"];
    }
    if (a.kind === "tron-claim-rewards") {
      return ["领取投票奖励到本账户"];
    }
    if (a.kind === "tron-vote") {
      return [
        "以下列投票替换本账户当前的全部投票：",
        ...a.votes.map((vote) => `为超级代表 ${vote.witness} 投 ${vote.count} 票`),
      ];
    }
    throw new KernelError("integrity", "unreachable stake action");
  },
  tronTakeover: (addresses) =>
    `账户接管：此交易把本账户的控制权交给 ${addresses.join("、")}，持有这些密钥的人可以转走全部资产。`,
  tronContract: (name) => `钱包不支持 TRON 合约类型 ${name}，无法显示它的作用`,
  tronField: "交易含有钱包无法显示的字段",
  tronPermissionKind: { owner: "所有者", witness: "见证人", active: "活跃" },
  tronPermission: (kind, name, threshold, keys, operations) =>
    `${kind}权限「${name}」：阈值 ${threshold}；密钥 ${keys.map((k) => `${k.address}（权重 ${k.weight}）`).join("、")}${operations === undefined ? "" : operations.length === 0 ? "；不允许任何交易" : `；允许 ${operations.join("、")}`}`,
  tronPermissionId: (id) => `以本账户的权限 ${id} 签署`,
  tronMemoHeading: "备注：",
  tronMemoData: (hex) => `备注数据 ${hex}`,
  tronMemoLength: (n) => `备注 ${n} 字节`,
  tronExpires: (datetime) => `${datetime}（UTC）后失效`,
  tronFeeLimit: (fee) => `能量费上限 ${fee}；另可能扣除带宽费`,
  tronBandwidthFee: "可能扣除带宽费或账户激活费",
  tronResource: { bandwidth: "带宽", energy: "能量", "tron-power": "TRON Power" },
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
  blindBytes: "The wallet cannot show what this signs. Sign only if you fully trust the app.",
  bytesData: (hex) => `Data ${hex}`,
  bytesLength: (bytes) => `${bytes} bytes`,
  otherOutflows: "There may be other outflows",
  unverifiedEffects: "The wallet cannot verify what this call does",
  externalInputs: "Includes inputs from other signers; the fee cannot be verified",
  solanaPrograms: (ids) => `Program calls the wallet cannot decode: ${ids}`,
  solanaProgramsWarning: "These programs can move assets from the accounts in this transaction",
  tokenFunction: (symbol, address) =>
    `An unrecognised function of token ${symbol} ${address} can move this token`,
  accountCode: "Runs this account's own code with full authority",
  callContract: (address, selector) => `Call contract ${address}, function ${selector}`,
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
  typedUnverified: "The wallet cannot verify what this signature authorises",
  typedField: (path, value) => `${path}: ${value}`,
  typedCommitment: "It signs only hashes or raw bytes; the wallet cannot see what they commit to",
  typedVariant:
    "The wallet recognises this kind of signature but not this form of it; it may authorise moving assets",
  typedOversize: "This typed data is too large to show in full",
  orderGive: (amount) => `Give ${amount}`,
  orderReceive: (recipient, amount) => `${recipient} receives ${amount}`,
  anyTokenOf: (token) => `any token of ${token}`,
  tokenInSet: (token, root) => `a token of ${token} from the set with Merkle root ${root}`,
  zoneRestriction: (zone) => `Zone ${zone} can restrict or cancel this order`,
  moreItems: (count) => `… ${count} more items not shown`,
  safeTransaction: (safe, nonce) => `Safe ${safe}, transaction ${nonce}`,
  safeDelegatecall: (target) =>
    `Runs the code of ${target} with the Safe's full authority (delegatecall)`,
  safeRefund: (receiver, amount, price) =>
    `Pays ${receiver ?? "whoever executes it"} a gas refund of up to ${amount}, plus ${price} per gas of call overhead`,
  send: (amount, to) => `Send ${amount} to ${to}`,
  burn: (amount) => `Burn ${amount}: it goes to an unspendable output and is lost`,
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
  stakeLines: (a, sol) => {
    if (a.kind === "create") {
      return [`Create stake account ${a.account} with ${sol(a.lamports)}`];
    }
    if (a.kind === "delegate") {
      return [`Delegate stake account ${a.account} to validator ${a.validator}`];
    }
    if (a.kind === "deactivate") {
      return [`Deactivate stake ${a.account}`];
    }
    if (a.kind === "withdraw") {
      return [`Withdraw ${sol(a.lamports)} from ${a.account} to ${a.to}`];
    }
    if (a.kind === "lido-submit") {
      return [
        `Stake ${formatAmount(en, a.amount)} with Lido, receive about ${formatAmount(en, a.receive)}`,
      ];
    }
    if (a.kind === "lido-request") {
      return [
        `Request withdrawal of ${formatAmount(en, a.amount)}; the claim NFT goes to ${a.owner}`,
      ];
    }
    if (a.kind === "lido-claim") {
      return [`Claim Lido withdrawals ${a.requestIds.join(", ")}`];
    }
    if (a.kind === "tron-freeze") {
      return [`Stake ${formatAmount(en, a.amount)} for ${en.tronResource[a.resource]}`];
    }
    if (a.kind === "tron-unfreeze") {
      return [
        `Unstake ${formatAmount(en, a.amount)} of ${en.tronResource[a.resource]}; it can be withdrawn after the network's waiting period`,
      ];
    }
    if (a.kind === "tron-delegate") {
      const lock =
        a.lock === undefined
          ? ""
          : a.lock.blocks === "0"
            ? ", locked for the default 86400 blocks (about 72 h)"
            : `, locked for ${a.lock.blocks} blocks (about ${(BigInt(a.lock.blocks) * 3n) / 3600n} h)`;
      return [
        `Delegate the ${en.tronResource[a.resource]} of ${formatAmount(en, a.amount)} staked to ${a.receiver}${lock}`,
      ];
    }
    if (a.kind === "tron-undelegate") {
      return [
        `Reclaim the ${en.tronResource[a.resource]} of ${formatAmount(en, a.amount)} staked from ${a.receiver}`,
      ];
    }
    if (a.kind === "tron-withdraw-unfrozen") {
      return ["Withdraw all unstaked TRX whose waiting period has ended"];
    }
    if (a.kind === "tron-cancel-unfreeze") {
      return ["Cancel all pending unstakes, re-staking them, and withdraw those already expired"];
    }
    if (a.kind === "tron-claim-rewards") {
      return ["Claim voting rewards to this account"];
    }
    if (a.kind === "tron-vote") {
      return [
        "Replace all current votes of this account with:",
        ...a.votes.map((vote) => `${vote.count} votes for super representative ${vote.witness}`),
      ];
    }
    throw new KernelError("integrity", "unreachable stake action");
  },
  tronTakeover: (addresses) =>
    `Account takeover: this gives control of this account to ${addresses.join(", ")}. Whoever holds these keys can move all of its assets.`,
  tronContract: (name) =>
    `The wallet does not support the TRON contract ${name} and cannot show what it does`,
  tronField: "This transaction carries fields the wallet cannot show",
  tronPermissionKind: { owner: "Owner", witness: "Witness", active: "Active" },
  tronPermission: (kind, name, threshold, keys, operations) =>
    `${kind} permission "${name}": threshold ${threshold}; keys ${keys.map((k) => `${k.address} (weight ${k.weight})`).join(", ")}${operations === undefined ? "" : operations.length === 0 ? "; allows no transactions" : `; allows ${operations.join(", ")}`}`,
  tronPermissionId: (id) => `Signs under permission ${id} of this account`,
  tronMemoHeading: "Memo:",
  tronMemoData: (hex) => `Memo data ${hex}`,
  tronMemoLength: (n) => `Memo of ${n} bytes`,
  tronExpires: (datetime) => `Expires ${datetime} (UTC)`,
  tronFeeLimit: (fee) => `Max fee ${fee} for energy; bandwidth fees may be charged in addition`,
  tronBandwidthFee: "Bandwidth or account-activation fees may be charged",
  tronResource: { bandwidth: "Bandwidth", energy: "Energy", "tron-power": "TRON Power" },
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

/** The "… N more" trailing line when a text memo exceeds the excerpt budget, else none. */
const displayOmitted = (catalog: Catalog, text: string): ReadonlyArray<string> => {
  const { omitted } = displayExcerpt(text, MESSAGE_LINES, MESSAGE_CODE_POINTS);
  return omitted === 0 ? [] : [catalog.omitted(omitted)];
};

/** Contract names for the set bits of a TRON permission operations bitmap (hex string). */
function tronOperationNames(operations: string): ReadonlyArray<string> {
  const bytes = hexToBytes(operations.replace(/^0x/i, ""));
  const names: string[] = [];
  for (let i = 0; i < 256; i += 1) {
    // oxlint-disable-next-line no-bitwise -- the operations bitmap is bit-indexed by contract id
    if (((bytes[i >> 3] ?? 0) & (1 << (i & 7))) !== 0) {
      names.push(tronContractType(i)?.name ?? `ContractType ${i}`);
    }
  }
  return names;
}

const tronPermissionLine = (catalog: Catalog, permission: TronPermission): string =>
  catalog.tronPermission(
    catalog.tronPermissionKind[permission.type],
    field(permission.name),
    permission.threshold,
    permission.keys,
    permission.operations === undefined ? undefined : tronOperationNames(permission.operations),
  );

/** Every distinct key address across owner, witness and active permissions, in that order. */
function tronNewKeyAddresses(update: {
  owner: TronPermission;
  witness?: TronPermission;
  actives: ReadonlyArray<TronPermission>;
}): ReadonlyArray<string> {
  const all = [
    update.owner,
    ...(update.witness === undefined ? [] : [update.witness]),
    ...update.actives,
  ];
  return [...new Set(all.flatMap((p) => p.keys.map((k) => k.address)))];
}

/**
 * The contracts an unverifiable transaction runs: its own, or each opaque call of a batch. A blind
 * call leads with why it is blind; the call line itself follows either way.
 */
function contractLines(catalog: Catalog, intent: PromptIntent): ReadonlyArray<string> {
  const calls = intent.calls ?? [intent];
  const lines: string[] = [];
  for (const { contract, verifiability, blind } of calls) {
    if (contract === undefined || verifiability !== "opaque") {
      continue;
    }
    if (blind === "token-function") {
      lines.push(catalog.tokenFunction(contract.symbol ?? contract.address, contract.address));
    }
    if (blind === "account-code") {
      lines.push(catalog.accountCode);
    }
    lines.push(
      contract.selector === undefined
        ? catalog.deployContract(contract.address)
        : catalog.callContract(contract.address, contract.selector),
    );
  }
  return lines;
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
    ...intent.outflows.map((flow) =>
      flow.burn === true
        ? catalog.burn(formatAmount(catalog, flow.amount))
        : catalog.send(formatAmount(catalog, flow.amount), flow.to),
    ),
    ...(intent.staking ?? []).flatMap((action) => catalog.stakeLines(action, sol)),
    ...received,
    ...intent.approvals.map((change) => approvalLine(catalog, change)),
  ];
}

function transactionPrompt(catalog: Catalog, intent: PromptIntent): KeystorePrompt {
  const { tron } = intent;
  const network =
    intent.network === undefined
      ? []
      : [catalog.networkLine(networkLabel(catalog, intent.network))];
  const caveat =
    intent.blind === "tron-contract" && tron !== undefined
      ? [catalog.tronContract(tron.contractType)]
      : intent.blind === "tron-field"
        ? [catalog.tronField]
        : intent.blind === undefined
          ? intent.verifiability === "opaque"
            ? intent.family === "solana"
              ? [
                  catalog.solanaPrograms((intent.programs ?? []).join(", ")),
                  catalog.solanaProgramsWarning,
                ]
              : intent.family === "bitcoin"
                ? [catalog.externalInputs]
                : [catalog.unverifiedEffects]
            : intent.verifiability === "partial"
              ? [catalog.otherOutflows]
              : []
          : /* A blind Solana transaction still names the programs it cannot decode — the blind
               title carries the refusal reason, the program list is what the signature reaches. */
            intent.family === "solana" && intent.verifiability === "opaque"
            ? [
                catalog.solanaPrograms((intent.programs ?? []).join(", ")),
                catalog.solanaProgramsWarning,
              ]
            : [];
  const warnings = intent.warnings ?? [];
  const permissions =
    tron?.permissionUpdate === undefined
      ? []
      : [
          tronPermissionLine(catalog, tron.permissionUpdate.owner),
          ...(tron.permissionUpdate.witness === undefined
            ? []
            : [tronPermissionLine(catalog, tron.permissionUpdate.witness)]),
          ...tron.permissionUpdate.actives.map((p) => tronPermissionLine(catalog, p)),
        ];
  const memo =
    tron?.memo === undefined
      ? []
      : tron.memo.kind === "text"
        ? [
            catalog.tronMemoHeading,
            ...displayExcerpt(tron.memo.text, MESSAGE_LINES, MESSAGE_CODE_POINTS).lines,
            ...displayOmitted(catalog, tron.memo.text),
          ]
        : tron.memo.hex.length - "0x".length <= 128
          ? [catalog.tronMemoData(tron.memo.hex)]
          : [catalog.tronMemoLength((tron.memo.hex.length - "0x".length) / 2)];
  return {
    title: intent.blind === undefined ? catalog.titles[intent.summary] : catalog.blindTitle,
    description: joinLines([
      ...(tron?.permissionUpdate === undefined
        ? []
        : [catalog.tronTakeover(tronNewKeyAddresses(tron.permissionUpdate))]),
      ...network,
      ...caveat,
      ...effectLines(catalog, intent),
      ...permissions,
      ...(tron?.permissionId === undefined ? [] : [catalog.tronPermissionId(tron.permissionId)]),
      ...memo,
      ...(tron === undefined
        ? []
        : [catalog.tronExpires(utcDateTime(Math.floor(tron.expiration / 1000)))]),
      intent.family === "tron"
        ? intent.fee === undefined
          ? catalog.tronBandwidthFee
          : catalog.tronFeeLimit(formatAmount(catalog, intent.fee.max))
        : intent.fee === undefined
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

/** The zero address in an order's `zone`: no zone contract gates fulfilment. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function orderLines(catalog: Catalog, order: SeaportOrder): ReadonlyArray<string> {
  const amount = (item: SeaportOrder["offer"][number]): string => {
    if (item.kind === "erc721-criteria" || item.kind === "erc1155-criteria") {
      // A criteria identifier of 0 means any token of the collection; otherwise it is the Merkle
      // root of the allowed set. The count is a number of tokens, not an asset amount.
      const base =
        item.identifier === "0"
          ? catalog.anyTokenOf(item.token)
          : catalog.tokenInSet(
              item.token,
              `0x${BigInt(item.identifier).toString(16).padStart(64, "0")}`,
            );
      const count =
        item.startAmount.amount === item.endAmount.amount
          ? item.startAmount.amount
          : `${item.startAmount.amount} → ${item.endAmount.amount}`;
      return count === "1" ? base : `${base} ×${count}`;
    }
    const start = formatAmount(catalog, item.startAmount);
    const end = formatAmount(catalog, item.endAmount);
    return start === end ? start : `${start} → ${end}`;
  };
  const capped = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
    lines.length > SEAPORT_ORDER_ITEMS
      ? [
          ...lines.slice(0, SEAPORT_ORDER_ITEMS),
          catalog.moreItems(lines.length - SEAPORT_ORDER_ITEMS),
        ]
      : lines;
  return [
    ...capped(order.offer.map((item) => catalog.orderGive(amount(item)))),
    ...capped(
      order.consideration.map((item) => catalog.orderReceive(item.recipient, amount(item))),
    ),
    ...(order.zone === ZERO_ADDRESS ? [] : [catalog.zoneRestriction(order.zone)]),
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
    ...(safe.refund === undefined
      ? []
      : [
          catalog.safeRefund(
            safe.refund.receiver,
            formatAmount(catalog, safe.refund.amount),
            formatAmount(catalog, safe.refund.gasPrice),
          ),
        ]),
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
  if (intent.approvals.length > 0) {
    return [catalog.otherOutflows, ...effectLines(catalog, intent)];
  }
  if (message.fields !== undefined) {
    return [
      ...(intent.blind === "typed-data-variant" ? [catalog.typedVariant] : []),
      ...(intent.blind === "typed-data-commitment" ? [catalog.typedCommitment] : []),
      catalog.typedUnverified,
      ...message.fields.map((leaf) => catalog.typedField(leaf.path, leaf.value)),
    ];
  }
  if (intent.blind === "typed-data-variant") {
    return [catalog.typedVariant, catalog.typedOversize];
  }
  if (intent.blind === "typed-data-oversize") {
    return [catalog.typedOversize];
  }
  throw new KernelError(
    "integrity",
    "unreachable: typed data is neither recognised, shown nor blind",
  );
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
    const bytes = (message.hex.length - "0x".length) / 2;
    return {
      title: catalog.blindTitle,
      description: joinLines([
        catalog.blindBytes,
        bytes <= 64 ? catalog.bytesData(message.hex) : catalog.bytesLength(bytes),
      ]),
    };
  }
  if (message.kind === "typed-data") {
    return {
      title: intent.blind === undefined ? catalog.titles[intent.summary] : catalog.blindTitle,
      description: joinLines(typedDataLines(catalog, intent, message)),
    };
  }
  if (intent.blind === undefined && message.signIn?.status === "valid") {
    return {
      title: catalog.signInTitle,
      description: joinLines(signInLines(catalog, message.signIn)),
    };
  }
  return {
    title: intent.blind === undefined ? catalog.titles.message : catalog.blindTitle,
    description: joinLines([
      /* Blind text still shows its sanitised excerpt under the warning — never a sign-in
         rendering, whose chrome would present the request as legitimate. */
      ...(intent.blind === undefined
        ? message.signIn === undefined
          ? []
          : signInLines(catalog, message.signIn)
        : [catalog.blindBytes]),
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
