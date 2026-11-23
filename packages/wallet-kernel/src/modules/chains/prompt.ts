import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * The system verification prompt for `chain.sign`, rendered from the kernel's own decode of the
 * request (WD-065). A transaction lists every fact the signed bytes prove — outflows, approvals,
 * the fee cap — and says so when other effects may exist (`partial`) or cannot be verified at all
 * (`opaque`). A message shows what is signed: its text, the sign-in it carries, or the typed data's
 * domain and recognised content. Addresses are never truncated — a shortened address is what
 * address poisoning relies on. Text chosen by the requester is shown as a bounded, sanitised
 * excerpt.
 */
import {
  displayExcerpt,
  hasHiddenCharacters,
  messageBlindReason,
  messageTextHazard,
} from "@qntx/wallet-chains";
import type {
  ApprovalChange,
  AssetAmount,
  AccountAuthority,
  TokenAuthorization,
  ChainFamily,
  DisplayIntent,
  Fiat24Action,
  HyperliquidAction,
  IntentSummary,
  IntentWarningKind,
  MessageContent,
  MessageTextHazard,
  SafeTransaction,
  PolymarketContent,
  OffchainOrder,
  SeaportOrder,
  SignInParse,
  StakeAction,
  TronPermission,
  TronResource,
} from "@qntx/wallet-chains";
import { ORDER_ITEMS } from "@qntx/wallet-chains/evm";
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
  | "hyperliquidDeposit"
  | "fiat24"
  | "contract"
  | "calls"
  | "blind"
  | "programs"
  | "programAuthority"
  | "tron"
> & {
  /** Decoders always set it; a message without a chain of its own omits it. */
  readonly network?: string;
  readonly family?: ChainFamily;
  readonly warnings?: DisplayIntent["warnings"];
  readonly staking?: DisplayIntent["staking"];
  /** Set only by the chain.sign approve-agent binding: whether this vault holds the agent key. */
  readonly agentHeld?: boolean;
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
  readonly textHazard: Readonly<Record<MessageTextHazard, string>>;
  readonly bytesData: (hex: string) => string;
  readonly bytesLength: (bytes: number) => string;
  readonly otherOutflows: string;
  readonly unverifiedEffects: string;
  readonly externalInputs: string;
  readonly solanaPrograms: (ids: string) => string;
  readonly solanaProgramsWarning: string;
  readonly programAuthority: (program: string, sol: boolean) => string;
  readonly programAuthorityAccounts: (program: string, items: ReadonlyArray<string>) => string;
  readonly programAuthorityYours: (symbol: string, address: string) => string;
  readonly programAuthorityMaybeYours: (address: string) => string;
  readonly programAuthorityUnbounded: (program: string) => string;
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
  readonly orderHeader: (name: string, maker: string) => string;
  readonly orderGiveAtMost: (amount: string) => string;
  readonly orderReceiveAtLeast: (recipient: string, amount: string) => string;
  readonly orderExpiry: (date: string) => string;
  readonly orderNoExpiry: string;
  readonly orderPartialFill: string;
  readonly orderAllowedSender: (suffix: string) => string;
  readonly orderExclusiveFiller: (filler: string) => string;
  readonly safeTransaction: (safe: string, nonce: string) => string;
  readonly safeDelegatecall: (target: string) => string;
  readonly safeRefund: (receiver: string | undefined, amount: string, price: string) => string;
  readonly send: (amount: string, to: string) => string;
  readonly sendTokenAccount: (amount: string, tokenAccount: string, to: string) => string;
  readonly burn: (amount: string) => string;
  readonly burnTokenAccount: (amount: string, account: string) => string;
  readonly allow: (spender: string, amount: string) => string;
  readonly unlimited: (asset: string) => string;
  readonly revoke: (spender: string, asset: string) => string;
  readonly increase: (spender: string, amount: string) => string;
  readonly decrease: (spender: string, amount: string) => string;
  readonly takeOnce: (spender: string, amount: string) => string;
  readonly viaPermit2: string;
  readonly viaAllowanceHolder: string;
  readonly receiveMin: (amount: string, to: string) => string;
  readonly receiveMinTokenAccount: (amount: string, tokenAccount: string) => string;
  readonly hyperliquidDeposit: (amount: string, dex: string, recipient: string) => string;
  readonly hyperliquidFee: (amount: string) => string;
  readonly until: (date: string) => string;
  readonly operatorAllow: (spender: string, asset: string) => string;
  readonly operatorRevoke: (spender: string, asset: string) => string;
  readonly maxFee: (fee: string) => string;
  readonly feeUnknown: string;
  readonly networkLine: (label: string) => string;
  readonly unknownEvmChain: (chainId: number) => string;
  readonly unverifiedToken: (amount: string, asset: string) => string;
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
  readonly warnings: Readonly<Record<IntentWarningKind, (message: string) => string>>;
  readonly bridgeLine: (
    network: string,
    amount: string,
    to: string,
    deadline: string,
    refundTo: string,
  ) => string;
  readonly stakeAuthority: (account: string, role: string, authority: string) => string;
  readonly stakeRole: Readonly<Record<"staker" | "withdrawer", string>>;
  readonly hlChain: Readonly<Record<"Mainnet" | "Testnet", string>>;
  readonly hlUsdSend: (amount: string, destination: string) => string;
  readonly hlWithdraw: (amount: string, destination: string) => string;
  readonly hlWithdrawFee: string;
  readonly hlSpotSend: (amount: string, token: string, destination: string) => string;
  readonly hlTokenId: string;
  readonly hlClassTransfer: (amount: string, toPerp: boolean) => string;
  readonly hlDex: (dex: string) => string;
  readonly hlSendAsset: (
    amount: string,
    token: string,
    sourceDex: string,
    destination: string,
    destinationDex: string,
  ) => string;
  readonly hlSubAccount: (address: string) => string;
  readonly hlStakeDeposit: (hype: string) => string;
  readonly hlStakeWithdraw: (hype: string) => string;
  readonly hlDelegate: (hype: string, validator: string) => string;
  readonly hlUndelegate: (hype: string, validator: string) => string;
  readonly hlApproveAgent: (agent: string, name: string | undefined) => string;
  readonly hlAgentExpiry: (date: string) => string;
  readonly hlAgentNoExpiry: string;
  readonly hlAgentHeld: string;
  readonly hlAgentNotHeld: string;
  readonly hlAgentPowers: string;
  readonly hlBuilderFee: (builder: string, rate: string) => string;
  readonly pmOrderTitle: string;
  readonly pmExchange: (name: string, address: string) => string;
  readonly pmProxyFunds: (maker: string) => string;
  readonly pmSafeFunds: (maker: string) => string;
  readonly pmDepositFunds: (maker: string) => string;
  readonly pmBuyShares: (shares: string, tokenId: string) => string;
  readonly pmPayMax: (pusd: string, price: string) => string;
  readonly pmSellShares: (shares: string, tokenId: string) => string;
  readonly pmReceiveMin: (pusd: string, price: string) => string;
  readonly pmFeeSetAtMatch: string;
  readonly pmBuilder: (hex: string) => string;
  readonly pmMetadata: (hex: string) => string;
  readonly pmAuthFor: (address: string) => string;
  readonly pmAuthTime: (date: string) => string;
  readonly pmAuthNonce: (nonce: string) => string;
  readonly pmAuthScope: string;
  readonly pmBatchHeader: (wallet: string, nonce: string, deadline: string) => string;
  readonly authAnyone: string;
  readonly authOnlyRecipient: (to: string) => string;
  readonly authWindow: (after?: string, before?: string) => string;
  readonly authCancel: (nonce: string) => string;
  readonly morphoGrant: (x: string) => string;
  readonly morphoRevoke: (x: string) => string;
  readonly aaveCredit: (x: string, amount: string) => string;
  readonly aaveRevoke: (x: string, asset: string) => string;
  readonly authorityUnverified: (c: string) => string;
  readonly snapshotAlias: (x: string) => string;
  readonly signatureDeadline: (date: string) => string;
  readonly fcAddKey: (key: string, fid: string) => string;
  readonly fcKeyRequest: (fid: string, key: string) => string;
  readonly fiat24SendToAccount: (amount: string, account: string) => string;
  readonly fiat24Spender: Readonly<Record<"card" | "deposit", string>>;
  readonly fiat24Function: string;
  readonly fiat24ReceiveAtRate: (symbol: string) => string;
  readonly fiat24ExactOut: (amount: string, pay: string) => string;
  readonly fiat24Payout: (amount: string) => string;
  readonly fiat24PayoutPayee: (payee: string) => string;
  readonly fiat24PayoutPurpose: (purposeId: string) => string;
  readonly fiat24PayoutReference: (ref: string) => string;
  readonly fiat24OpenAccount: (account: string) => string;
  readonly fiat24Grant: string;
  readonly fiat24SessionTitle: string;
  readonly fiat24SessionBearer: (date: string) => string;
  readonly fiat24SessionPower: string;
  readonly fiat24SessionSigns: (message: string) => string;
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
    payout: "确认出金",
  },
  blindTitle: "确认盲签",
  blindBytes: "钱包无法显示签署的内容。仅在完全信任该应用时签署。",
  textHazard: {
    "digest-length": "这条 32 字节的消息可能是哈希：签署它可能授权该哈希所承诺的任何内容",
    "hidden-characters":
      "文本含有隐藏或改变显示顺序的字符（显示为 �）；你看到的可能与签署的内容不同",
    "encoded-bytes": "文本是原始字节的编码；钱包无法看到它们授权的内容",
  },
  bytesData: (hex) => `数据 ${hex}`,
  bytesLength: (bytes) => `${bytes} 字节`,
  otherOutflows: "可能还有其他转出",
  unverifiedEffects: "钱包无法核实此调用会做什么",
  externalInputs: "包含其他签名者的输入；无法核实手续费",
  solanaPrograms: (ids) => `钱包无法解码的程序调用：${ids}`,
  solanaProgramsWarning: "这些程序可以转移本交易涉及账户中的资产",
  programAuthority: (program, sol) =>
    sol
      ? `程序 ${program} 获得本账户的签名：可以转走本账户的全部 SOL`
      : `程序 ${program} 获得本账户的签名`,
  programAuthorityAccounts: (program, items) =>
    `程序 ${program} 可以以本账户的权限操作：${items.join("；")}`,
  programAuthorityYours: (symbol, address) => `你的 ${symbol} 账户 ${address}`,
  programAuthorityMaybeYours: (address) => `${address}（可能属于你）`,
  programAuthorityUnbounded: (program) =>
    `程序 ${program} 获得本账户的签名，并可操作钱包无法列出的账户`,
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
  typedField: (path, value) => `${path} = ${value}`,
  typedCommitment: "它签署了哈希或原始字节；钱包无法看到它们所承诺的内容",
  typedVariant: "钱包认识这类签名，但不认识这种形式；它可能授权转移资产",
  typedOversize: "此类型数据过大，无法完整显示",
  orderGive: (amount) => `付出 ${amount}`,
  orderReceive: (recipient, amount) => `${recipient} 收到 ${amount}`,
  anyTokenOf: (token) => `${token} 中的任意代币`,
  tokenInSet: (token, root) => `${token} 中 Merkle 根 ${root} 所列的代币`,
  zoneRestriction: (zone) => `区域合约 ${zone} 可限制或取消此订单`,
  moreItems: (count) => `… 还有 ${count} 项未显示`,
  orderHeader: (name, maker) => `${name} 订单，挂单方 ${maker}`,
  orderGiveAtMost: (amount) => `最多付出 ${amount}`,
  orderReceiveAtLeast: (recipient, amount) => `${recipient} 至少收到 ${amount}`,
  orderExpiry: (date) => `有效期至 ${date}（UTC）`,
  orderNoExpiry: "无到期时间",
  orderPartialFill: "可按同一价格分批成交",
  orderAllowedSender: (suffix) => `只有地址以 ${suffix} 结尾的吃单方可以成交`,
  orderExclusiveFiller: (filler) => `${filler} 拥有优先成交的独占权`,
  safeTransaction: (safe, nonce) => `Safe ${safe} 的第 ${nonce} 笔交易`,
  safeDelegatecall: (target) => `以 Safe 的全部权限执行 ${target} 的代码（delegatecall）`,
  safeRefund: (receiver, amount, price) =>
    `向 ${receiver ?? "执行者"} 支付 gas 退款：最多 ${amount}，另按每单位 gas ${price} 支付调用开销`,
  send: (amount, to) => `发送 ${amount} 到 ${to}`,
  sendTokenAccount: (amount, tokenAccount, to) =>
    `从代币账户 ${tokenAccount} 发送 ${amount} 个最小单位到 ${to}`,
  burn: (amount) => `销毁 ${amount}：转入无法花费的输出，永久丢失`,
  burnTokenAccount: (amount, account) => `从代币账户 ${account} 销毁 ${amount}，永久消失`,
  allow: (spender, amount) => `授权 ${spender} 使用 ${amount}`,
  unlimited: (asset) => `全部 ${asset}`,
  revoke: (spender, asset) => `撤销 ${spender} 对 ${asset} 的授权`,
  increase: (spender, amount) => `授权 ${spender} 再使用 ${amount}`,
  decrease: (spender, amount) => `减少 ${spender} 的授权额度 ${amount}`,
  takeOnce: (spender, amount) => `授权 ${spender} 一次性转走 ${amount}`,
  viaPermit2: " 经 Permit2",
  viaAllowanceHolder: " 经 AllowanceHolder",
  receiveMin: (amount, to) => `至少收到 ${amount}，收款地址 ${to}`,
  receiveMinTokenAccount: (amount, tokenAccount) =>
    `至少收到 ${amount} 个代币账户 ${tokenAccount} 所持代币的基本单位`,
  hyperliquidDeposit: (amount, dex, recipient) =>
    `向你的 Hyperliquid ${dex === "perps" ? "合约" : "现货"}账户 ${recipient} 存入 ${amount}`,
  hyperliquidFee: (amount) => `Circle 手续费至多 ${amount}`,
  until: (date) => ` 至 ${date}（UTC）`,
  operatorAllow: (spender, asset) => `授权 ${spender} 转走 ${asset} 的全部代币`,
  operatorRevoke: (spender, asset) => `撤销 ${spender} 对 ${asset} 全部代币的授权`,
  maxFee: (fee) => `最高手续费 ${fee}`,
  feeUnknown: "手续费未知",
  networkLine: (label) => `网络：${label}`,
  unknownEvmChain: (chainId) => `EVM 链 ${chainId}`,
  unverifiedToken: (amount, asset) => `${amount} 个最小单位（未验证代币 ${asset}）`,
  warnings: {
    "platform-fee": (message) => `Jupiter 收取平台费 ${message}`,
    "stake-lockup": () => "该质押账户已锁定：锁定期结束前资金无法转出",
    "sighash-single-anyonecanpay": () => "已签输入只绑定同序号输出，交易其余部分可被改动",
    "permit2-witness": () => "此许可附带附加条款（witness）",
    "delegation-replaced": (message) => message,
    "token-2022-transfer-fee": (message) => message,
    "token-2022-extension": (message) => message,
    "fiat24-internal-account": (message) =>
      `Fiat24 账户 #${message} 是只有发行方能开设的账户（首位为 9），不是客户账户——这不是向个人付款`,
    "fiat24-card-pull": () => "Fiat24 卡合约可以在发行方授权卡支付时随时按此额度扣款，无需再询问你",
    "fiat24-unlimited-approval": (role) =>
      `危险：无限额度授权允许 Fiat24 ${role === "card" ? "卡" : "充值与兑换"}合约转走你此代币的全部余额`,
    "fiat24-issuer-rate": () => "交易执行时由 Fiat24 设定汇率；没有保证你会收到的最低额度",
    "fiat24-exact-out-unbounded": () => "你的支付仅以你对 Fiat24 充值与兑换合约的授权额度为上限",
    "fiat24-payee-offchain": () =>
      "Fiat24 在链下为该收款人选择收款银行账户；钱包无法核实谁收到出金",
    "fiat24-swap-quote": () => "到 USDC 的兑换在交易内部定价；你没有设置滑点上限",
    "fiat24-account-link": () => "开通账户会将此地址与你向 Fiat24 验证的身份永久关联",
    "fiat24-account-move": (message) =>
      `危险：这将转移 Fiat24 账户 ${message} 的控制权——包括其中的资金与已验证身份`,
    "fiat24-account-burn": () =>
      "开通账户会按 Fiat24 为此账号设定的价格燃烧 F24——最多为你对 Fiat24 账户合约的 F24 授权额度",
  },
  bridgeLine: (network, amount, to, deadline, refundTo) =>
    `跨链到 ${network}：至少收到 ${amount}，收款地址 ${to}；${deadline} 前未成交则退回 ${refundTo}`,
  delegateTo: (name, version) => `将此账户委托给 ${name} v${version}；该合约可代其执行调用`,
  revokeDelegation: "撤销此账户的合约委托",
  stakeRole: { staker: "质押", withdrawer: "提取" },
  stakeAuthority: (account, role, authority) =>
    `将质押账户 ${account} 的${role}权限交给 ${authority}`,
  hlChain: { Mainnet: "Hyperliquid 主网", Testnet: "Hyperliquid 测试网" },
  hlUsdSend: (amount, destination) => `在 Hyperliquid 上发送 ${amount} USDC 到 ${destination}`,
  hlWithdraw: (amount, destination) => `经 Hyperliquid 跨链桥提现 ${amount} USDC 到 ${destination}`,
  hlWithdrawFee: "Hyperliquid 会收取提现手续费",
  hlSpotSend: (amount, token, destination) =>
    `在 Hyperliquid 上发送 ${amount} 代币 ${token} 到 ${destination}`,
  hlTokenId: "钱包无法核实代币名称，请核对其 id",
  hlClassTransfer: (amount, toPerp) =>
    toPerp
      ? `将 ${amount} USDC 从 Hyperliquid 现货账户转入永续账户`
      : `将 ${amount} USDC 从 Hyperliquid 永续账户转入现货账户`,
  hlDex: (dex) => (dex === "" ? "永续账户" : dex === "spot" ? "现货账户" : `DEX ${dex}`),
  hlSendAsset: (amount, token, sourceDex, destination, destinationDex) =>
    `发送 ${amount} 代币 ${token}：从${sourceDex}到 ${destination} 的${destinationDex}`,
  hlSubAccount: (address) => `来自子账户 ${address}`,
  hlStakeDeposit: (hype) => `将 ${hype} HYPE 从现货账户转入质押账户`,
  hlStakeWithdraw: (hype) =>
    `将 ${hype} HYPE 从质押账户转回现货账户，经 Hyperliquid 的 7 天解除质押队列后到账`,
  hlDelegate: (hype, validator) => `将 ${hype} HYPE 委托给验证者 ${validator}`,
  hlUndelegate: (hype, validator) => `从验证者 ${validator} 取消委托 ${hype} HYPE`,
  hlApproveAgent: (agent, name) =>
    name === undefined ? `授权代理 ${agent}（未命名）` : `授权代理 ${agent}，名称“${name}”`,
  hlAgentExpiry: (date) => `有效期至 ${date}（UTC）`,
  hlAgentNoExpiry: "名称中没有有效期：适用 Hyperliquid 的默认期限",
  hlAgentHeld: "代理密钥由本钱包持有",
  hlAgentNotHeld: "代理密钥不在本钱包中：持有者可以替此账户交易",
  hlAgentPowers:
    "该代理无需你确认即可替此账户及其子账户交易，并在 Hyperliquid 内转移资金（包括存入金库）；它不能提现或向其他账户转账。",
  hlBuilderFee: (builder, rate) => `允许 builder ${builder} 对每笔订单收取最多 ${rate} 的费用`,
  pmOrderTitle: "确认订单",
  pmExchange: (name, address) => `Polymarket ${name} ${address}`,
  pmProxyFunds: (maker) => `资金来自你的 Polymarket 代理钱包 ${maker}`,
  pmSafeFunds: (maker) => `资金来自你的 Polymarket Safe ${maker}`,
  pmDepositFunds: (maker) => `资金来自存款钱包 ${maker}；只有其所有者的签名才能使此订单生效`,
  pmBuyShares: (shares, tokenId) => `买入至少 ${shares} 份结果代币 ${tokenId}`,
  pmPayMax: (pusd, price) => `最多支付 ${pusd} pUSD（价格 ${price} pUSD/份）`,
  pmSellShares: (shares, tokenId) => `卖出 ${shares} 份结果代币 ${tokenId}`,
  pmReceiveMin: (pusd, price) => `扣费前至少收到 ${pusd} pUSD（价格 ${price} pUSD/份）`,
  pmFeeSetAtMatch: "交易手续费由 Polymarket 在撮合时设定；此签名不限制其金额",
  pmBuilder: (hex) => `Builder 代码 ${hex}`,
  pmMetadata: (hex) => `订单元数据 ${hex}`,
  pmAuthFor: (address) => `为 ${address} 创建或派生 Polymarket API 凭证`,
  pmAuthTime: (date) => `时间 ${date}（UTC）`,
  pmAuthNonce: (nonce) => `凭证序号 ${nonce}`,
  pmAuthScope: "凭证用于验证撤单等账户请求；每笔订单仍需你的签名",
  pmBatchHeader: (wallet, nonce, deadline) =>
    `Polymarket 存款钱包 ${wallet} 的第 ${nonce} 批调用，有效期至 ${deadline}（UTC）`,
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
    if (a.kind === "split") {
      return [`从质押账户 ${a.account} 拆分 ${sol(a.lamports)} 到 ${a.to}`];
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
  authAnyone: "任何持有此签名的人都可以提交这笔转账",
  authOnlyRecipient: (to) => `只有 ${to} 可以提交这笔转账`,
  authWindow: (after, before) =>
    after !== undefined && before !== undefined
      ? `${after} 之后、${before} 之前有效（UTC）`
      : before === undefined
        ? after === undefined
          ? "无到期时间"
          : `${after} 之后有效（UTC），无到期时间`
        : `${before} 之前有效（UTC）`,
  authCancel: (nonce) => `取消未使用的转账授权 ${nonce}；不转移资金`,
  morphoGrant: (x) =>
    `允许 ${x} 管理你在 Morpho 的仓位：它可以提走你存入的资产和抵押品，并以你的抵押品借款，资金可转到任何地址`,
  morphoRevoke: (x) => `撤销 ${x} 管理你 Morpho 仓位的权限`,
  aaveCredit: (x, amount) =>
    `允许 ${x} 以你的 Aave 信用借入最多 ${amount}：债务由你承担，以你的抵押品担保`,
  aaveRevoke: (x, asset) => `撤销 ${x} 在 Aave 借入 ${asset} 的额度`,
  authorityUnverified: (c) => `钱包不认识合约 ${c}；它可能授予其他权限`,
  snapshotAlias: (x) => `允许 ${x} 以你的身份在 Snapshot 投票、发起提案和执行其他操作`,
  signatureDeadline: (date) => `此签名在 ${date}（UTC）前可被使用`,
  fcAddKey: (key, fid) =>
    `向你的 Farcaster 账户添加签名密钥 ${key}（应用 fid ${fid} 请求）；在你移除前，它可以以你的身份发帖、点赞和关注`,
  fcKeyRequest: (fid, key) => `以应用 fid ${fid} 的身份为 Farcaster 用户请求签名密钥 ${key}`,
  fiat24SendToAccount: (amount, account) =>
    `发送 ${amount} 到 Fiat24 账户 #${account}（收款人是交易执行时该账户的持有者）`,
  fiat24Spender: { card: "（Fiat24 卡）", deposit: "（Fiat24 充值与兑换）" },
  fiat24Function:
    "钱包无法描述此 Fiat24 调用：Fiat24 合约的未识别函数，或发送到其他合约或网络的 Fiat24 函数",
  fiat24ReceiveAtRate: (symbol) => `按交易执行时 Fiat24 设定的汇率收到 ${symbol}——没有最低到手额`,
  fiat24ExactOut: (amount, pay) => `收到 ${amount}；按 Fiat24 设定的汇率支付 ${pay}`,
  fiat24Payout: (amount) => `以银行转账出金 ${amount} 给 Fiat24 收款人`,
  fiat24PayoutPayee: (payee) => `Fiat24 收款人 ${payee}`,
  fiat24PayoutPurpose: (purposeId) => `用途 ${purposeId}`,
  fiat24PayoutReference: (ref) => `Fiat24 参考 ${ref}`,
  fiat24OpenAccount: (account) => `为此地址开通 Fiat24 账户 #${account}`,
  fiat24Grant:
    "这是一条 Fiat24 账户访问授权：过期前，任何持有此签名的人都能读取你的资料和卡信息，并修改卡、收款人和你的邮箱。钱包只对自行构造的授权签名。",
  fiat24SessionTitle: "授权访问 Fiat24 账户",
  fiat24SessionBearer: (date) => `对签名地址的 Fiat24 账户的持有人授权，有效期至 ${date}（UTC）`,
  fiat24SessionPower:
    "在此之前，任何持有此签名的人都能读取你的 Fiat24 资料和联系方式、查看你的卡信息、创建和修改卡与收款人，以及修改你的邮箱——银行卡一次性验证码的送达渠道",
  fiat24SessionSigns: (message) => `签名消息：${message}`,
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
    payout: "Confirm payout",
  },
  blindTitle: "Confirm blind signing",
  blindBytes: "The wallet cannot show what this signs. Sign only if you fully trust the app.",
  textHazard: {
    "digest-length":
      "This 32-byte message could be a hash: signing it may authorise whatever the hash commits to",
    "hidden-characters":
      "This text contains hidden or reordering characters (shown as �); what you read may differ from what is signed",
    "encoded-bytes": "This text encodes raw bytes; the wallet cannot see what they authorise",
  },
  bytesData: (hex) => `Data ${hex}`,
  bytesLength: (bytes) => `${bytes} bytes`,
  otherOutflows: "There may be other outflows",
  unverifiedEffects: "The wallet cannot verify what this call does",
  externalInputs: "Includes inputs from other signers; the fee cannot be verified",
  solanaPrograms: (ids) => `Program calls the wallet cannot decode: ${ids}`,
  solanaProgramsWarning: "These programs can move assets from the accounts in this transaction",
  programAuthority: (program, sol) =>
    sol
      ? `Program ${program} receives this account's signature: it can move ALL SOL in this account`
      : `Program ${program} receives this account's signature`,
  programAuthorityAccounts: (program, items) =>
    `Program ${program} can act with this account's authority on: ${items.join("; ")}`,
  programAuthorityYours: (symbol, address) => `your ${symbol} account ${address}`,
  programAuthorityMaybeYours: (address) => `${address} (may be yours)`,
  programAuthorityUnbounded: (program) =>
    `Program ${program} receives this account's signature and can reach accounts the wallet cannot list`,
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
  typedField: (path, value) => `${path} = ${value}`,
  typedCommitment: "It signs a hash or raw bytes; the wallet cannot see what they commit to",
  typedVariant:
    "The wallet recognises this kind of signature but not this form of it; it may authorise moving assets",
  typedOversize: "This typed data is too large to show in full",
  orderGive: (amount) => `Give ${amount}`,
  orderReceive: (recipient, amount) => `${recipient} receives ${amount}`,
  anyTokenOf: (token) => `any token of ${token}`,
  tokenInSet: (token, root) => `a token of ${token} from the set with Merkle root ${root}`,
  zoneRestriction: (zone) => `Zone ${zone} can restrict or cancel this order`,
  moreItems: (count) => `… ${count} more items not shown`,
  orderHeader: (name, maker) => `${name} order by ${maker}`,
  orderGiveAtMost: (amount) => `Give at most ${amount}`,
  orderReceiveAtLeast: (recipient, amount) => `${recipient} receives at least ${amount}`,
  orderExpiry: (date) => `Valid until ${date} (UTC)`,
  orderNoExpiry: "No expiry",
  orderPartialFill: "Can be filled in parts at the same rate",
  orderAllowedSender: (suffix) => `Only a taker whose address ends in ${suffix} can fill it`,
  orderExclusiveFiller: (filler) => `${filler} has the exclusive right to fill it first`,
  safeTransaction: (safe, nonce) => `Safe ${safe}, transaction ${nonce}`,
  safeDelegatecall: (target) =>
    `Runs the code of ${target} with the Safe's full authority (delegatecall)`,
  safeRefund: (receiver, amount, price) =>
    `Pays ${receiver ?? "whoever executes it"} a gas refund of up to ${amount}, plus ${price} per gas of call overhead`,
  send: (amount, to) => `Send ${amount} to ${to}`,
  sendTokenAccount: (amount, tokenAccount, to) =>
    `Send ${amount} base units of the token in account ${tokenAccount} to ${to}`,
  burn: (amount) => `Burn ${amount}: it goes to an unspendable output and is lost`,
  burnTokenAccount: (amount, account) =>
    `Burn ${amount} from token account ${account}; it is destroyed`,
  allow: (spender, amount) => `Allow ${spender} to spend ${amount}`,
  unlimited: (asset) => `unlimited ${asset}`,
  revoke: (spender, asset) => `Revoke ${spender}'s allowance for ${asset}`,
  increase: (spender, amount) => `Allow ${spender} to spend ${amount} more`,
  decrease: (spender, amount) => `Reduce ${spender}'s allowance by ${amount}`,
  takeOnce: (spender, amount) => `Allow ${spender} to take ${amount} once`,
  viaPermit2: " via Permit2",
  viaAllowanceHolder: " via AllowanceHolder",
  receiveMin: (amount, to) => `Receive at least ${amount} at ${to}`,
  receiveMinTokenAccount: (amount, tokenAccount) =>
    `Receive at least ${amount} base units of the token in account ${tokenAccount}`,
  hyperliquidDeposit: (amount, dex, recipient) =>
    `Deposit ${amount} to your Hyperliquid ${dex} account ${recipient}`,
  hyperliquidFee: (amount) => `Circle fee at most ${amount}`,
  until: (date) => ` until ${date} (UTC)`,
  operatorAllow: (spender, asset) => `Allow ${spender} to transfer all tokens of ${asset}`,
  operatorRevoke: (spender, asset) => `Revoke ${spender}'s access to all tokens of ${asset}`,
  maxFee: (fee) => `Max fee ${fee}`,
  feeUnknown: "Fee unknown",
  networkLine: (label) => `Network: ${label}`,
  unknownEvmChain: (chainId) => `EVM chain ${chainId}`,
  unverifiedToken: (amount, asset) => `${amount} base units of unverified token ${asset}`,
  warnings: {
    "platform-fee": (message) => `Jupiter platform fee: ${message}`,
    "stake-lockup": () =>
      "The stake account is locked: its funds cannot move until the lockup expires",
    "sighash-single-anyonecanpay": () =>
      "Signed inputs bind only their same-index outputs; the rest of the transaction can change",
    "permit2-witness": () => "This permit carries further terms (a witness)",
    "delegation-replaced": (message) => message,
    "token-2022-transfer-fee": (message) => message,
    "token-2022-extension": (message) => message,
    "fiat24-internal-account": (message) =>
      `Fiat24 account #${message} is an issuer-only account (first digit 9), not a client account — this is not a payment to a person`,
    "fiat24-card-pull": () =>
      "The Fiat24 card contract can take up to this allowance at any time, without asking you, whenever the issuer authorises a card payment",
    "fiat24-unlimited-approval": (role) =>
      `Danger: an unlimited allowance lets the Fiat24 ${role === "card" ? "card" : "top-up and exchange"} contract take your entire balance of this token`,
    "fiat24-issuer-rate": () =>
      "Fiat24 sets the rate when the transaction runs; there is no minimum you will receive",
    "fiat24-exact-out-unbounded": () =>
      "What you pay is bounded only by your allowance for the Fiat24 top-up and exchange contract",
    "fiat24-payee-offchain": () =>
      "Fiat24 picks the receiving bank account off-chain from this payee; the wallet cannot verify who receives the payout",
    "fiat24-swap-quote": () =>
      "The swap to USDC is priced inside the transaction itself; you set no slippage limit",
    "fiat24-account-link": () =>
      "Opening the account permanently links this address to the identity you verify with Fiat24",
    "fiat24-account-move": (message) =>
      `Danger: this moves control of Fiat24 account ${message} — its money and the identity verified for it`,
    "fiat24-account-burn": () =>
      "Opening the account burns F24 at the price Fiat24 sets for this account number — up to your F24 allowance for the Fiat24 account contract",
  },
  bridgeLine: (network, amount, to, deadline, refundTo) =>
    `Bridge to ${network}: receive at least ${amount} at ${to}; refunded to ${refundTo} if not filled by ${deadline} (UTC)`,
  delegateTo: (name, version) =>
    `Delegate this account to ${name} v${version}; the contract can execute calls on its behalf`,
  revokeDelegation: "Revoke this account's contract delegation",
  stakeRole: { staker: "staker", withdrawer: "withdrawer" },
  stakeAuthority: (account, role, authority) =>
    `Give ${authority} the ${role} authority over stake account ${account}`,
  hlChain: { Mainnet: "Hyperliquid Mainnet", Testnet: "Hyperliquid Testnet" },
  hlUsdSend: (amount, destination) => `Send ${amount} USDC to ${destination} on Hyperliquid`,
  hlWithdraw: (amount, destination) =>
    `Withdraw ${amount} USDC from Hyperliquid to ${destination} through the Hyperliquid bridge`,
  hlWithdrawFee: "Hyperliquid charges a withdrawal fee",
  hlSpotSend: (amount, token, destination) =>
    `Send ${amount} of token ${token} to ${destination} on Hyperliquid`,
  hlTokenId: "The wallet cannot verify the token's name; check its id",
  hlClassTransfer: (amount, toPerp) =>
    toPerp
      ? `Move ${amount} USDC from your Hyperliquid spot balance to perps`
      : `Move ${amount} USDC from your Hyperliquid perps balance to spot`,
  hlDex: (dex) => (dex === "" ? "perps" : dex === "spot" ? "spot" : `DEX ${dex}`),
  hlSendAsset: (amount, token, sourceDex, destination, destinationDex) =>
    `Send ${amount} of token ${token} from ${sourceDex} to ${destinationDex} of ${destination}`,
  hlSubAccount: (address) => `From sub-account ${address}`,
  hlStakeDeposit: (hype) => `Move ${hype} HYPE from your spot balance into staking`,
  hlStakeWithdraw: (hype) =>
    `Move ${hype} HYPE from staking to your spot balance; it arrives after Hyperliquid's 7-day unstaking queue`,
  hlDelegate: (hype, validator) => `Delegate ${hype} HYPE to validator ${validator}`,
  hlUndelegate: (hype, validator) => `Undelegate ${hype} HYPE from validator ${validator}`,
  hlApproveAgent: (agent, name) =>
    name === undefined
      ? `Approve agent ${agent} (unnamed)`
      : `Approve agent ${agent} named "${name}"`,
  hlAgentExpiry: (date) => `Valid until ${date} (UTC)`,
  hlAgentNoExpiry: "No expiry in the name: Hyperliquid's default applies",
  hlAgentHeld: "The agent key is held by this wallet",
  hlAgentNotHeld:
    "The agent key is not held by this wallet: whoever holds it can trade this account",
  hlAgentPowers:
    "The agent can trade for this account and its sub-accounts and move funds inside Hyperliquid, including into vaults, without asking you. It cannot withdraw or send funds to other accounts.",
  hlBuilderFee: (builder, rate) =>
    `Allow builder ${builder} to charge up to ${rate} of each order's value`,
  pmOrderTitle: "Confirm order",
  pmExchange: (name, address) => `Polymarket ${name} ${address}`,
  pmProxyFunds: (maker) => `Funds from your Polymarket proxy wallet ${maker}`,
  pmSafeFunds: (maker) => `Funds from your Polymarket Safe ${maker}`,
  pmDepositFunds: (maker) =>
    `Funds from deposit wallet ${maker}; only its owner's signature makes this order valid`,
  pmBuyShares: (shares, tokenId) => `Buy at least ${shares} shares of outcome token ${tokenId}`,
  pmPayMax: (pusd, price) => `Pay at most ${pusd} pUSD (price ${price} pUSD per share)`,
  pmSellShares: (shares, tokenId) => `Sell ${shares} shares of outcome token ${tokenId}`,
  pmReceiveMin: (pusd, price) =>
    `Receive at least ${pusd} pUSD before fees (price ${price} pUSD per share)`,
  pmFeeSetAtMatch:
    "Polymarket sets the trading fee when the order is matched; this signature does not cap it",
  pmBuilder: (hex) => `Builder code ${hex}`,
  pmMetadata: (hex) => `Order metadata ${hex}`,
  pmAuthFor: (address) => `Create or derive Polymarket API credentials for ${address}`,
  pmAuthTime: (date) => `Time ${date} (UTC)`,
  pmAuthNonce: (nonce) => `Credential nonce ${nonce}`,
  pmAuthScope:
    "The credentials authenticate account requests such as cancelling orders; every order still needs your signature",
  pmBatchHeader: (wallet, nonce, deadline) =>
    `Polymarket deposit wallet ${wallet}, batch ${nonce}, valid until ${deadline} (UTC)`,
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
    if (a.kind === "split") {
      return [`Split ${sol(a.lamports)} from stake account ${a.account} into ${a.to}`];
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
  authAnyone: "Anyone holding this signature can submit the transfer",
  authOnlyRecipient: (to) => `Only ${to} can submit the transfer`,
  authWindow: (after, before) =>
    after !== undefined && before !== undefined
      ? `Valid after ${after} and before ${before} (UTC)`
      : before === undefined
        ? after === undefined
          ? "No expiry"
          : `Valid after ${after} (UTC); no expiry`
        : `Valid before ${before} (UTC)`,
  authCancel: (nonce) => `Cancel the unused transfer authorization ${nonce}; no funds move`,
  morphoGrant: (x) =>
    `Let ${x} manage your Morpho positions: it can withdraw your supplied assets and collateral and borrow against your collateral, sending the funds anywhere`,
  morphoRevoke: (x) => `Revoke ${x}'s authority over your Morpho positions`,
  aaveCredit: (x, amount) =>
    `Let ${x} borrow up to ${amount} on your Aave credit: you owe the debt and your collateral backs it`,
  aaveRevoke: (x, asset) => `Revoke ${x}'s Aave borrowing allowance for ${asset}`,
  authorityUnverified: (c) => `The wallet does not know contract ${c}; it may grant other powers`,
  snapshotAlias: (x) => `Let ${x} vote, create proposals and act on Snapshot as you`,
  signatureDeadline: (date) => `This signature can be used until ${date} (UTC)`,
  fcAddKey: (key, fid) =>
    `Add signer key ${key} to your Farcaster account, requested by app fid ${fid}; until you remove it, it can publish posts, reactions and follows as you`,
  fcKeyRequest: (fid, key) => `As app fid ${fid}, request signer key ${key} for a Farcaster user`,
  fiat24SendToAccount: (amount, account) =>
    `Send ${amount} to Fiat24 account #${account} (whoever holds it when the transaction runs)`,
  fiat24Spender: { card: " (Fiat24 card)", deposit: " (Fiat24 top-up and exchange)" },
  fiat24Function:
    "The wallet cannot describe this Fiat24 call: an unrecognised function of a Fiat24 contract, or a Fiat24 function sent to another contract or network",
  fiat24ReceiveAtRate: (symbol) =>
    `Receive ${symbol} at the rate Fiat24 sets when the transaction runs — no minimum`,
  fiat24ExactOut: (amount, pay) => `Receive ${amount}; pay ${pay} at the rate Fiat24 sets`,
  fiat24Payout: (amount) => `Pay out ${amount} by bank transfer to a Fiat24 payee`,
  fiat24PayoutPayee: (payee) => `Fiat24 payee ${payee}`,
  fiat24PayoutPurpose: (purposeId) => `Purpose ${purposeId}`,
  fiat24PayoutReference: (ref) => `Fiat24 reference ${ref}`,
  fiat24OpenAccount: (account) => `Open Fiat24 account #${account} for this address`,
  fiat24Grant:
    "This is a Fiat24 account access grant: until it expires, anyone holding the signature can read your profile and card details and change cards, payees and your email. The wallet signs Fiat24 grants only when it builds them itself.",
  fiat24SessionTitle: "Allow Fiat24 account access",
  fiat24SessionBearer: (date) =>
    `A bearer grant for the Fiat24 account of the signing address, valid until ${date} (UTC)`,
  fiat24SessionPower:
    "Until then, anyone holding this signature can read your Fiat24 profile and contact data, view your card details, create and change cards and payees, and change your email — the channel for card one-time passwords",
  fiat24SessionSigns: (message) => `Signs: ${message}`,
};

export const CATALOGS: Readonly<Record<PromptLocale, Catalog>> = { "zh-Hans": zh, en };

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
  const fiat24 =
    change.fiat24Spender === undefined ? "" : catalog.fiat24Spender[change.fiat24Spender];
  return `${line}${via}${until}${fiat24}`;
}

/**
 * Every line of requester-supplied text carries this prefix — a kernel-generated line never does,
 * so a forged "Network:" or fee line inside a message or memo can never read as the prompt's own.
 */
const REQUESTER_LINE = "· ";

/** A line of requester-supplied text marked as such. */
const quoted = (line: string): string => `${REQUESTER_LINE}${line}`;

/**
 * The requester text of a message or memo: each displayed line quoted, plus the kernel's own "… N
 * more" line (unquoted) when the excerpt does not fit.
 */
const requesterText = (catalog: Catalog, text: string): ReadonlyArray<string> => {
  const { lines, omitted } = displayExcerpt(text, MESSAGE_LINES, MESSAGE_CODE_POINTS);
  return [...lines.map(quoted), ...(omitted === 0 ? [] : [catalog.omitted(omitted)])];
};

/**
 * One requester-chosen value on a single line; a dropped remainder is marked with an ellipsis so a
 * second line or tail can never hide inside it.
 */
const field = (raw: string): string => {
  const { lines, omitted } = displayExcerpt(raw, 1, FIELD_CODE_POINTS);
  return `${lines[0] ?? ""}${omitted === 0 ? "" : "…"}`;
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
    if (blind === "fiat24-function") {
      lines.push(catalog.fiat24Function);
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

/** What each signer-taking undecoded program can reach; unbounded reaches read as blind lines. */
const programAuthorityLines = (catalog: Catalog, intent: PromptIntent): ReadonlyArray<string> =>
  (intent.programAuthority ?? []).flatMap((entry) => {
    if (intent.blind === "program-authority") {
      return [catalog.programAuthorityUnbounded(entry.program)];
    }
    const items = entry.accounts.map((a) =>
      a.token === undefined
        ? catalog.programAuthorityMaybeYours(a.address)
        : catalog.programAuthorityYours(a.token.symbol, a.address),
    );
    const lines = [catalog.programAuthority(entry.program, entry.sol)];
    if (items.length > 0) {
      lines.push(catalog.programAuthorityAccounts(entry.program, items));
    }
    return lines;
  });

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
          entry.tokenAccount === undefined
            ? catalog.receiveMin(formatAmount(catalog, entry.amount), entry.to)
            : catalog.receiveMinTokenAccount(entry.amount.amount, entry.tokenAccount),
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
      flow.fiat24 === undefined
        ? flow.tokenAccount === undefined
          ? flow.burn === true && intent.family === "solana"
            ? catalog.burnTokenAccount(formatAmount(catalog, flow.amount), flow.to)
            : flow.burn === true
              ? catalog.burn(formatAmount(catalog, flow.amount))
              : catalog.send(formatAmount(catalog, flow.amount), flow.to)
          : catalog.sendTokenAccount(flow.amount.amount, flow.tokenAccount, flow.to)
        : "account" in flow.fiat24
          ? catalog.fiat24SendToAccount(formatAmount(catalog, flow.amount), flow.fiat24.account)
          : catalog.fiat24Payout(formatAmount(catalog, flow.amount)),
    ),
    /* Batch inner calls carry their own Fiat24 action — render each one's lines, not only the
       batch intent's. */
    ...(intent.calls ?? [intent]).flatMap((call) =>
      call.fiat24 === undefined ? [] : fiat24Lines(catalog, call.fiat24),
    ),
    ...(intent.staking ?? []).flatMap((action) => catalog.stakeLines(action, sol)),
    ...received,
    ...(intent.hyperliquidDeposit === undefined
      ? []
      : [
          catalog.hyperliquidDeposit(
            intent.outflows[0] === undefined
              ? "?"
              : formatAmount(catalog, intent.outflows[0].amount),
            intent.hyperliquidDeposit.dex,
            intent.hyperliquidDeposit.recipient,
          ),
          catalog.hyperliquidFee(formatAmount(catalog, intent.hyperliquidDeposit.maxFee)),
        ]),
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
        ? [catalog.tronMemoHeading, ...requesterText(catalog, tron.memo.text)]
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
      ...programAuthorityLines(catalog, intent),
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
      ...warningLines(catalog, warnings),
    ]),
  };
}

/** The lines a recognized Fiat24 action adds to a call's effects. */
const fiat24Lines = (catalog: Catalog, action: Fiat24Action): ReadonlyArray<string> => {
  if (action.kind === "exchange") {
    return action.side === "exact-in"
      ? [catalog.fiat24ReceiveAtRate(action.receive.symbol)]
      : [catalog.fiat24ExactOut(formatAmount(catalog, action.receive), action.pay.symbol)];
  }
  /* The payout's requester-supplied strings only display through field(), requester-marked —
     the payee id and the bank-transfer reference are text, never a person. */
  if (action.kind === "payout") {
    return [
      quoted(catalog.fiat24PayoutPayee(field(action.contactId))),
      ...(action.purposeId === undefined
        ? []
        : [quoted(catalog.fiat24PayoutPurpose(field(action.purposeId)))]),
      ...(action.ref === undefined
        ? []
        : [quoted(catalog.fiat24PayoutReference(field(action.ref)))]),
    ];
  }
  /* A top-up receives the cash token at the issuer's rate — the same fact an exact-in swap
     states; opening an account links the address to the verified identity. */
  if (action.kind === "top-up") {
    return [catalog.fiat24ReceiveAtRate(action.receive.symbol)];
  }
  if (action.kind === "open-account") {
    return [catalog.fiat24OpenAccount(action.account)];
  }
  return [];
};

/** Every decoder warning line, in the order the decoder raised them. */
const warningLines = (
  catalog: Catalog,
  warnings: PromptIntent["warnings"],
): ReadonlyArray<string> => (warnings ?? []).map((w) => catalog.warnings[w.kind](w.message));

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
  return [catalog.messageHeading, ...requesterText(catalog, text)];
}

const CONTROL_CHAR = /\p{Cc}/u;

/** Every code point prints plainly: no control characters, nothing hidden or reordering. */
const isPlainText = (text: string): boolean =>
  !CONTROL_CHAR.test(text) && !hasHiddenCharacters(text);

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
    lines.length > ORDER_ITEMS
      ? [...lines.slice(0, ORDER_ITEMS), catalog.moreItems(lines.length - ORDER_ITEMS)]
      : lines;
  return [
    ...capped(order.offer.map((item) => catalog.orderGive(amount(item)))),
    ...capped(
      order.consideration.map((item) => catalog.orderReceive(item.recipient, amount(item))),
    ),
    ...(order.zone === ZERO_ADDRESS ? [] : [catalog.zoneRestriction(order.zone)]),
  ];
}

const ORDER_PROTOCOL_NAME: Readonly<Record<OffchainOrder["protocol"], string>> = {
  "1inch": "1inch",
  uniswapx: "UniswapX",
  cow: "CoW Protocol",
  "0x": "0x",
};

/** The lines of a recognised off-chain order: header, the most it gives, the least each gets. */
function offchainOrderLines(catalog: Catalog, order: OffchainOrder): ReadonlyArray<string> {
  return [
    catalog.orderHeader(ORDER_PROTOCOL_NAME[order.protocol], order.maker),
    catalog.orderGiveAtMost(formatAmount(catalog, order.give)),
    ...order.receive.map((leg) =>
      catalog.orderReceiveAtLeast(leg.recipient, formatAmount(catalog, leg.amount)),
    ),
    order.expiry === undefined
      ? catalog.orderNoExpiry
      : catalog.orderExpiry(utcDateTime(order.expiry)),
    ...(order.partialFill ? [catalog.orderPartialFill] : []),
    ...(order.allowedSender === undefined ? [] : [catalog.orderAllowedSender(order.allowedSender)]),
    ...(order.exclusiveFiller === undefined
      ? []
      : [catalog.orderExclusiveFiller(order.exclusiveFiller)]),
  ];
}

function safeLines(catalog: Catalog, safe: SafeTransaction): ReadonlyArray<string> {
  return [
    catalog.safeTransaction(safe.safe, safe.nonce),
    ...(safe.operation === "delegatecall" ? [catalog.safeDelegatecall(safe.to)] : []),
    ...safe.calls.flatMap((call) => [
      ...(call.verifiability === "opaque" ? [catalog.unverifiedEffects] : []),
      ...effectLines(catalog, call),
      ...warningLines(catalog, call.warnings),
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
  if (message.order !== undefined) {
    return [
      ...intent.approvals.map((change) => approvalLine(catalog, change)),
      ...offchainOrderLines(catalog, message.order),
    ];
  }
  if (message.seaport !== undefined) {
    return orderLines(catalog, message.seaport);
  }
  if (message.safe !== undefined) {
    return safeLines(catalog, message.safe);
  }
  if (message.authorization !== undefined) {
    return authorizationLines(catalog, message.authorization);
  }
  if (message.authority !== undefined) {
    return authorityLines(catalog, message.authority);
  }
  if (message.farcaster !== undefined) {
    return [
      ...(message.farcaster.kind === "add"
        ? [catalog.fcAddKey(message.farcaster.key, message.farcaster.requestFid)]
        : [catalog.fcKeyRequest(message.farcaster.requestFid, message.farcaster.key)]),
      ...(message.farcaster.deadline === undefined
        ? []
        : [catalog.signatureDeadline(utcDateTime(message.farcaster.deadline))]),
    ];
  }
  if (intent.approvals.length > 0) {
    return [
      catalog.otherOutflows,
      ...effectLines(catalog, intent),
      ...(intent.blind === "typed-data-commitment" ? [catalog.typedCommitment] : []),
      ...(intent.blind === "typed-data-oversize" ? [catalog.typedOversize] : []),
      ...(message.fields ?? []).map((leaf) => quoted(catalog.typedField(leaf.path, leaf.value))),
    ];
  }
  if (message.fields !== undefined) {
    return [
      ...(intent.blind === "typed-data-variant" ? [catalog.typedVariant] : []),
      ...(intent.blind === "typed-data-commitment" ? [catalog.typedCommitment] : []),
      catalog.typedUnverified,
      ...message.fields.map((leaf) => quoted(catalog.typedField(leaf.path, leaf.value))),
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

/** The lines of a recognised EIP-3009 authorization: who can submit it, and its validity. */
function authorizationLines(
  catalog: Catalog,
  authorization: TokenAuthorization,
): ReadonlyArray<string> {
  if (authorization.kind === "cancel") {
    return [catalog.authCancel(authorization.nonce)];
  }
  const window = catalog.authWindow(
    authorization.validAfter === 0 ? undefined : utcDateTime(authorization.validAfter),
    authorization.validBefore === undefined ? undefined : utcDateTime(authorization.validBefore),
  );
  return [
    catalog.send(formatAmount(catalog, authorization.amount), authorization.to),
    authorization.kind === "transfer"
      ? catalog.authAnyone
      : catalog.authOnlyRecipient(authorization.to),
    window,
  ];
}

/** The lines of a recognised account-authority document: the delegatee's power, then warnings. */
function authorityLines(catalog: Catalog, authority: AccountAuthority): ReadonlyArray<string> {
  if (authority.kind === "snapshot-alias") {
    return [catalog.snapshotAlias(authority.alias)];
  }
  if (authority.kind === "morpho") {
    return [
      authority.grant
        ? catalog.morphoGrant(authority.authorized)
        : catalog.morphoRevoke(authority.authorized),
      ...(authority.verified ? [] : [catalog.authorityUnverified(authority.contract)]),
      ...(authority.deadline === undefined
        ? []
        : [catalog.signatureDeadline(utcDateTime(authority.deadline))]),
    ];
  }
  const asset = authority.amount.symbol ?? authority.amount.asset;
  return [
    authority.unlimited
      ? catalog.aaveCredit(authority.delegatee, catalog.unlimited(asset))
      : authority.amount.amount === "0"
        ? catalog.aaveRevoke(authority.delegatee, asset)
        : catalog.aaveCredit(authority.delegatee, formatAmount(catalog, authority.amount)),
    ...(authority.verified ? [] : [catalog.authorityUnverified(authority.contract)]),
    ...(authority.deadline === undefined
      ? []
      : [catalog.signatureDeadline(utcDateTime(authority.deadline))]),
  ];
}

/** HYPE amounts are 8-decimal wei strings (the exchange's staking fields). */
const hype = (wei: string): string => formatUnits(wei, 8);

/**
 * The lines of a recognized Hyperliquid user-signed action; requester text is sanitised. The switch
 * is exhaustive over the action union; a trailing return is unreachable code (TS7027).
 */
// oxlint-disable-next-line typescript/consistent-return
function hyperliquidLines(
  catalog: Catalog,
  action: HyperliquidAction,
  agentHeld?: boolean,
): ReadonlyArray<string> {
  switch (action.kind) {
    case "usd-send":
      return [catalog.hlUsdSend(action.amount, action.destination)];
    case "withdraw":
      return [catalog.hlWithdraw(action.amount, action.destination), catalog.hlWithdrawFee];
    case "spot-send":
      return [
        catalog.hlSpotSend(action.amount, field(action.token), action.destination),
        catalog.hlTokenId,
      ];
    case "usd-class-transfer":
      return [catalog.hlClassTransfer(action.amount, action.toPerp)];
    case "send-asset":
      return [
        catalog.hlSendAsset(
          action.amount,
          field(action.token),
          catalog.hlDex(field(action.sourceDex)),
          action.destination,
          catalog.hlDex(field(action.destinationDex)),
        ),
        ...(action.fromSubAccount === undefined
          ? []
          : [catalog.hlSubAccount(action.fromSubAccount)]),
        catalog.hlTokenId,
      ];
    case "staking-deposit":
      return [catalog.hlStakeDeposit(hype(action.wei))];
    case "staking-withdraw":
      return [catalog.hlStakeWithdraw(hype(action.wei))];
    case "token-delegate":
      return [
        action.undelegate
          ? catalog.hlUndelegate(hype(action.wei), action.validator)
          : catalog.hlDelegate(hype(action.wei), action.validator),
      ];
    case "approve-agent":
      return [
        catalog.hlApproveAgent(action.agent, action.name === "" ? undefined : field(action.name)),
        ...(agentHeld === undefined
          ? []
          : [agentHeld ? catalog.hlAgentHeld : catalog.hlAgentNotHeld]),
        action.validUntil === undefined
          ? catalog.hlAgentNoExpiry
          : catalog.hlAgentExpiry(utcDateTime(Math.floor(action.validUntil / 1000))),
        catalog.hlAgentPowers,
      ];
    case "approve-builder-fee":
      return [catalog.hlBuilderFee(action.builder, action.maxFeeRate)];
  }
}

/** Shares and pUSD are both 6-decimal (clob-client-v2 config.ts). */
const pmUnits = (amount: string): string => formatUnits(amount, 6);

/** PUSD per share; `≈ ` marks a price that does not divide exactly. */
const pmPrice = (price: { amount: string; exact: boolean }): string =>
  `${price.exact ? "" : "≈ "}${formatUnits(price.amount, 6)}`;

function polymarketOrderLines(
  catalog: Catalog,
  intent: PromptIntent,
  order: Extract<PolymarketContent, { kind: "order" }>,
): ReadonlyArray<string> {
  const buy = order.side === "buy";
  const shares = pmUnits(buy ? order.receive.amount : order.give.amount);
  const pusd = pmUnits(buy ? order.give.amount : order.receive.amount);
  const price = pmPrice(order.price);
  return [
    catalog.pmExchange(order.exchange.name, order.exchange.address),
    ...(intent.network === undefined
      ? []
      : [catalog.networkLine(networkLabel(catalog, intent.network))]),
    ...(order.wallet === "proxy"
      ? [catalog.pmProxyFunds(order.maker)]
      : order.wallet === "safe"
        ? [catalog.pmSafeFunds(order.maker)]
        : order.wallet === "deposit-wallet"
          ? [catalog.pmDepositFunds(order.maker)]
          : []),
    buy ? catalog.pmBuyShares(shares, order.tokenId) : catalog.pmSellShares(shares, order.tokenId),
    buy ? catalog.pmPayMax(pusd, price) : catalog.pmReceiveMin(pusd, price),
    catalog.pmFeeSetAtMatch,
    ...(order.builder === undefined ? [] : [catalog.pmBuilder(order.builder)]),
    ...(order.metadata === undefined ? [] : [catalog.pmMetadata(order.metadata)]),
  ];
}

function polymarketAuthLines(
  catalog: Catalog,
  intent: PromptIntent,
  auth: Extract<PolymarketContent, { kind: "auth" }>,
): ReadonlyArray<string> {
  return [
    ...(intent.network === undefined
      ? []
      : [catalog.networkLine(networkLabel(catalog, intent.network))]),
    catalog.pmAuthFor(auth.address),
    catalog.pmAuthTime(utcDateTime(auth.timestamp)),
    catalog.pmAuthNonce(auth.nonce),
    catalog.pmAuthScope,
  ];
}

/** A deposit-wallet batch shows every decoded call, like a Safe's — never truncated. */
function polymarketBatchLines(
  catalog: Catalog,
  intent: PromptIntent,
  batch: Extract<PolymarketContent, { kind: "batch" }>,
): ReadonlyArray<string> {
  return [
    ...(intent.network === undefined
      ? []
      : [catalog.networkLine(networkLabel(catalog, intent.network))]),
    catalog.pmBatchHeader(batch.wallet, batch.nonce, utcDateTime(batch.deadline)),
    ...(batch.calls.length === 0
      ? [catalog.typedOversize]
      : batch.calls.flatMap((call) => [
          ...(call.verifiability === "opaque" ? [catalog.unverifiedEffects] : []),
          ...effectLines(catalog, call),
        ])),
  ];
}

/**
 * The lines of a recognized Polymarket document; replaces the App/Network/Contract/Type lines. The
 * switch is exhaustive over the content union; a trailing return is unreachable (TS7027).
 */
// oxlint-disable-next-line typescript/consistent-return
function polymarketLines(
  catalog: Catalog,
  intent: PromptIntent,
  content: PolymarketContent,
): ReadonlyArray<string> {
  switch (content.kind) {
    case "order":
      return polymarketOrderLines(catalog, intent, content);
    case "auth":
      return polymarketAuthLines(catalog, intent, content);
    case "batch":
      return polymarketBatchLines(catalog, intent, content);
  }
}

function typedDataLines(
  catalog: Catalog,
  intent: PromptIntent,
  message: Extract<MessageContent, { kind: "typed-data" }>,
): ReadonlyArray<string> {
  const { name, chainId, verifyingContract } = message.domain;
  /* A document blind because a string leaf carries hidden characters gets the same hazard line
     a hazardous text message does — ahead of every family branch. */
  const hazard = intent.blind === "message-bytes" ? [catalog.textHazard["hidden-characters"]] : [];
  if (message.hyperliquid !== undefined) {
    /* The domain's chain id is only the wallet's signing chain; the environment the action
       targets is `hyperliquidChain`, so it replaces the App/Network/Verifying contract lines. */
    return [
      ...hazard,
      catalog.hlChain[message.hyperliquid.chain],
      ...hyperliquidLines(catalog, message.hyperliquid, intent.agentHeld),
    ];
  }
  /* A Polymarket document is its own description — before the generic branches, because a
     deposit-wallet batch also carries approvals and outflows. */
  if (message.polymarket !== undefined) {
    return [...hazard, ...polymarketLines(catalog, intent, message.polymarket)];
  }
  /* For TRON the domain chainId is the network's CAIP-2 reference — already checked against
     `intent.network` at normalize — so the network line is the network itself, not eip155. */
  const network =
    intent.family === "tron"
      ? intent.network
      : chainId === undefined
        ? intent.network
        : `eip155:${chainId}`;
  return [
    ...hazard,
    ...(name === undefined ? [] : [catalog.typedApp(field(name))]),
    ...(network === undefined ? [] : [catalog.networkLine(networkLabel(catalog, network))]),
    ...(verifyingContract === undefined ? [] : [catalog.typedContract(verifyingContract)]),
    catalog.typedType(field(message.primaryType)),
    ...typedContentLines(catalog, intent, message),
    ...warningLines(catalog, intent.warnings),
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
    const title =
      intent.blind === undefined
        ? message.polymarket?.kind === "order"
          ? catalog.pmOrderTitle
          : message.polymarket?.kind === "auth"
            ? catalog.signInTitle
            : catalog.titles[intent.summary]
        : catalog.blindTitle;
    return {
      title,
      description: joinLines(typedDataLines(catalog, intent, message)),
    };
  }
  if (message.kind === "text" && intent.fiat24?.kind === "session-grant") {
    /* The wallet built this grant from structured fields, so the prompt describes the session
       it opens — a bearer grant until the expiry and the powers it hands to the signature's
       holder. The Fiat24 server binds nothing in the signed label, so the prompt never claims
       chain or account pinning. */
    const grant = intent.fiat24;
    return {
      title: catalog.fiat24SessionTitle,
      description: joinLines([
        catalog.fiat24SessionBearer(utcDateTime(grant.deadline)),
        catalog.fiat24SessionPower,
        catalog.fiat24SessionSigns(message.text),
      ]),
    };
  }
  if (intent.blind === undefined && message.signIn?.status === "valid") {
    return {
      title: catalog.signInTitle,
      description: joinLines(signInLines(catalog, message.signIn)),
    };
  }
  const hazard = intent.blind === undefined ? undefined : messageTextHazard(message.text);
  /* A digest-length text shows the signed bytes it could be a hash of, then the text only when
     every code point prints plainly — a digest hiding control or invisible characters does not
     get to pose as a message. */
  const digest =
    hazard === "digest-length" ? `0x${bytesToHex(utf8ToBytes(message.text))}` : undefined;
  return {
    title: intent.blind === undefined ? catalog.titles.message : catalog.blindTitle,
    description: joinLines([
      /* Blind text still shows its sanitised excerpt under the hazard line — never a sign-in
         rendering, whose chrome would present the request as legitimate. */
      ...(intent.blind === undefined
        ? message.signIn === undefined
          ? []
          : signInLines(catalog, message.signIn)
        : intent.blind === "fiat24-session-grant"
          ? [catalog.fiat24Grant, ...(hazard === undefined ? [] : [catalog.textHazard[hazard]])]
          : hazard === undefined
            ? []
            : [catalog.textHazard[hazard]]),
      ...(digest === undefined ? [] : [catalog.bytesData(digest)]),
      ...(digest !== undefined && !isPlainText(message.text)
        ? []
        : textLines(catalog, message.text)),
    ]),
  };
}

export function chainPrompt(locale: PromptLocale, intent: PromptIntent): KeystorePrompt {
  const catalog = CATALOGS[locale];
  return intent.message === undefined
    ? transactionPrompt(catalog, intent)
    : messagePrompt(catalog, intent, intent.message);
}
