/// <reference types="node" />
/**
 * Regenerates vectors/chains/signing-classes.json: everyday EVM dApp requests, the claimed
 * order-protocol documents (CoW, 1inch, UniswapX via a Permit2 witness, Snapshot, a claim near
 * miss), synthetic Solana legacy messages (SPL Transfer/Burn, Stake Split, an unknown program
 * taking the signer, program-authority blind), every TRON transaction vector from
 * vectors/chains/tron.json, three TRON messages, and the blind reason codes with their expected
 * `verifiability`/`blind` and the exact kernel prompt in en and zh-Hans. Calldata is built with
 * viem; Solana messages are compiled with @solana/kit like the tests; TRON raw bytes are read from
 * tron.json; the expected class and prompt text are literals written by hand.
 *
 * SignRequest fields that cannot live in JSON: `typedData` is the parsed document (consumers pass
 * JSON.stringify of it) and `message` is `{"$bytes": hex}` (consumers decode to Uint8Array).
 *
 * Run from the repo root: bun packages/wallet-chains/scripts/signing-classes-vectors.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { getRevokeInstruction } from "@solana-program/token";
import { getRevokeInstruction as getRevokeInstruction2022 } from "@solana-program/token-2022";
import { address } from "@solana/addresses";
import { AccountRole, createNoopSigner } from "@solana/kit";
import {
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/transaction-messages";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  parseAbi,
} from "viem";

import { solanaAddressFromPublicKey } from "../src/solana/ids.ts";
import { buildTronRawData } from "../src/tron/builders.ts";

const SIGNER = "0x2222222222222222222222222222222222222222";
const TRON_SIGNER = "TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const AAVE_V3 = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const ROUTER = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af";
const TO = "0x00000000000000000000000000000000DeaDBeef";
const CRYPTO_KITTIES = getAddress("0x06012c8cf97BEaD5deAe237070F9587f8E7A266d");
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const CCTP_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CCTP_FORWARDER = "0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757";
const netArb = "Network: Arbitrum One";
const netArbZh = "网络：Arbitrum One";
const netBase = "Network: Base";
const netBaseZh = "网络：Base";
const netFlare = "Network: Flare";
const netFlareZh = "网络：Flare";
const netOp = "Network: OP Mainnet";
const netOpZh = "网络：OP Mainnet";
const OTHER = getAddress("0x00000000000000000000000000000000000bad00");
const MORPHO = getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
const FARCASTER_KEY_GATEWAY = "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B";
const FARCASTER_VALIDATOR = "0x00000000FC700472606ED4fA22623Acf62c60553";
const FARCASTER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const AAVE_USDC_DEBT = getAddress("0x72E95b8931767C79bA4EeE721354d6E99a61D004");
const DEPLOYED = getContractAddress({ from: SIGNER, nonce: 0n });

const account = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" };
const tx = (over: { to?: string; data?: string; value?: string }) => ({
  kind: "evm.transaction",
  network: "eip155:1",
  account,
  tx: {
    type: "eip1559",
    chainId: 1,
    nonce: 0,
    gas: "0x30000",
    value: "0x0",
    data: "0x",
    accessList: [],
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x1",
    ...over,
  },
});
const arbTx = (over: { to?: string; data?: string; value?: string }) => ({
  kind: "evm.transaction",
  network: "eip155:42161",
  account,
  tx: {
    type: "eip1559",
    chainId: 42161,
    nonce: 0,
    gas: "0x30000",
    value: "0x0",
    data: "0x",
    accessList: [],
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x1",
    ...over,
  },
});
const typedData = (doc: unknown) => ({
  kind: "evm.typed-data",
  network: "eip155:1",
  account,
  typedData: doc,
});
const opTypedData = (doc: unknown) => ({
  kind: "evm.typed-data",
  network: "eip155:10",
  account,
  typedData: doc,
});
const solanaMessage = (hex: string) => ({
  kind: "solana.message",
  network: SOL_MAINNET,
  account: SOL_ACCOUNT,
  message: { $bytes: hex },
  format: "raw",
});

const personal = (hex: string) => ({
  kind: "evm.personal-message",
  network: "eip155:1",
  account,
  message: { $bytes: hex },
});

const tronAccount = { kind: "hd", walletId: "w", groupIndex: 0, template: "tron.bip44" };
const tronTx = (rawDataHex: string) => ({
  kind: "tron.transaction",
  network: "tron:728126428",
  account: tronAccount,
  rawData: { $bytes: rawDataHex },
});
const tronMessage = (hex: string) => ({
  kind: "tron.message",
  network: "tron:728126428",
  account: tronAccount,
  message: { $bytes: hex },
});
const tronTypedData = (typedData: string) => ({
  kind: "tron.typed-data",
  network: "tron:728126428",
  account: tronAccount,
  typedData,
});

/* Solana fixtures: the same legacy-message compiler the solana tests use — the fee payer signs,
   the blockhash is the all-1s address. Addresses are test literals. */
const SOL_SIGNER = "11111111111111111111111111111112";
const SOL_BLOCKHASH = "11111111111111111111111111111111";
const SOL_ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "solana" };
const SOL_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOL_STAKE_PROG = "Stake11111111111111111111111111111111111111";
const SOL_DRAINER = "Dra1ner111111111111111111111111111111111111";
const SOL_DEST = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const SOL_SRC = "So11111111111111111111111111111111111111112";
const SOL_MINT = "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq";
const SOL_STAKE_ACCT = "YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf";

type SolAccount = {
  readonly address: ReturnType<typeof address>;
  readonly role: AccountRole;
  readonly signer?: unknown;
};
const solIx = (program: string, accounts: ReadonlyArray<SolAccount>, data: Uint8Array) => ({
  programAddress: address(program),
  accounts,
  data,
});
const solRo = (a: string) => ({ address: address(a), role: AccountRole.READONLY });
const solW = (a: string) => ({ address: address(a), role: AccountRole.WRITABLE });
const solSgn = (a: string) => ({
  address: address(a),
  role: AccountRole.READONLY_SIGNER,
  signer: createNoopSigner(address(a)),
});
const solU64 = (n: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const solU32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const solCat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const solMessage = (instructions: ReadonlyArray<unknown>): string => {
  let message = setTransactionMessageLifetimeUsingBlockhash(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the kit lifetime param is branded
    { blockhash: address(SOL_BLOCKHASH), lastValidBlockHeight: 1000n } as never,
    setTransactionMessageFeePayer(
      address(SOL_SIGNER),
      createTransactionMessage({ version: "legacy" }),
    ),
  );
  for (const ix of instructions) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- kit's opaque generics
    message = appendTransactionMessageInstruction(ix as never, message as never);
  }
  const bytes = getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message));
  return Buffer.from(bytes).toString("hex");
};
const solanaTx = (messageHex: string) => ({
  kind: "solana.transaction",
  network: SOL_MAINNET,
  account: SOL_ACCOUNT,
  message: { $bytes: messageHex },
});

/** TRON transaction vectors: expected class and prompts are literals, raw bytes from tron.json. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the generated vector file has a fixed shape
const TRON_VECTORS = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/tron.json"), "utf8"),
) as { transactions: Array<{ name: string; rawDataHex: string }> };

/** TRON typed-data documents: the oracle-checked canonical JSON from tron-typed-data.json. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the generated vector file has a fixed shape
const TRON_TD_VECTORS = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../vectors/chains/tron-typed-data.json"),
    "utf8",
  ),
) as {
  cases: Array<{ name: string; typedData: string }>;
  blind: Array<{ name: string; typedData: string }>;
};
const tronTdDoc = (name: string): string => {
  const found =
    TRON_TD_VECTORS.cases.find((c) => c.name === name) ??
    TRON_TD_VECTORS.blind.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(`tron-typed-data.json has no case named "${name}"`);
  }
  return found.typedData;
};

/* Hyperliquid documents come from the oracle-checked vectors file (vectors/chains/hyperliquid.ts
   builds it; do not duplicate action literals here). */
type HlDoc = {
  domain: { chainId: number };
  types: Record<string, unknown>;
  message: Record<string, unknown>;
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- this generator wrote that JSON
const hl = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/hyperliquid.json"), "utf8"),
) as {
  userSigned: Array<{ name: string; typedData: HlDoc }>;
  l1: Array<{ name: string; typedData: HlDoc }>;
};
const hlDoc = (list: ReadonlyArray<{ name: string; typedData: HlDoc }>, name: string) => {
  const found = list.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(`hyperliquid.json has no case named "${name}"`);
  }
  return found.typedData;
};
const hlTyped = (doc: HlDoc) => ({
  kind: "evm.typed-data",
  network: `eip155:${doc.domain.chainId}`,
  account,
  typedData: doc,
});

/* Polymarket documents come from vectors/chains/polymarket.json (oracle: clob-client-v2 1.2.1
   plus on-chain hashOrder); documents bound to the signing account are rewritten to SIGNER —
   the signature bytes are irrelevant to decoding. */
type PmDoc = {
  domain: { chainId: number } & Record<string, unknown>;
  types: Record<string, unknown>;
  message: Record<string, unknown>;
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- this generator wrote that JSON
const pm = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/polymarket.json"), "utf8"),
) as { cases: Array<{ name: string; typedData: PmDoc }> };
const pmDoc = (name: string): PmDoc => {
  const found = pm.cases.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(`polymarket.json has no case named "${name}"`);
  }
  return structuredClone(found.typedData);
};
const pmTyped = (doc: PmDoc) => ({
  kind: "evm.typed-data",
  network: `eip155:${doc.domain.chainId}`,
  account,
  typedData: doc,
});
const hlUsdSendDoc = hlDoc(hl.userSigned, "usdSend Arbitrum One signing chain");
const hlExtraTypes = {
  ...hlUsdSendDoc,
  types: { ...hlUsdSendDoc.types, Extra: [{ name: "a", type: "uint256" }] },
};
const hlBadAmount = {
  ...hlUsdSendDoc,
  message: { ...hlUsdSendDoc.message, amount: "1e3" },
};

const net = "Network: Ethereum";
const netZh = "网络：Ethereum";
const caveat = "The wallet cannot verify what this call does";
const caveatZh = "钱包无法核实此调用会做什么";
const fee = "Max fee 0.000196608 ETH";
const feeZh = "最高手续费 0.000196608 ETH";
const blindBytes = "The wallet cannot show what this signs. Sign only if you fully trust the app.";
const blindBytesZh = "钱包无法显示签署的内容。仅在完全信任该应用时签署。";
const typedCaveat = "The wallet cannot verify what this signature authorises";
const typedCaveatZh = "钱包无法核实此签名授权的内容";
const typedCommitment = "It signs a hash or raw bytes; the wallet cannot see what they commit to";
const typedCommitmentZh = "它签署了哈希或原始字节；钱包无法看到它们所承诺的内容";
const typedVariant =
  "The wallet recognises this kind of signature but not this form of it; it may authorise moving assets";
const typedVariantZh = "钱包认识这类签名，但不认识这种形式；它可能授权转移资产";
const typedOversize = "This typed data is too large to show in full";
const typedOversizeZh = "此类型数据过大，无法完整显示";
const hiddenChars =
  "This text contains hidden or reordering characters (shown as �); what you read may differ from what is signed";
const hiddenCharsZh = "文本含有隐藏或改变显示顺序的字符（显示为 �）；你看到的可能与签署的内容不同";
const HL_DEST = getAddress("0x5e9ee1089755c3435139848e47e6635505d5a13a");
const HL_AGENT = getAddress("0x1234567890abcdef1234567890abcdef12345678");
const HL_APP_EN = "App: HyperliquidSignTransaction";
const HL_APP_ZH = "应用：HyperliquidSignTransaction";
const HL_CONTRACT_EN = "Verifying contract 0x0000000000000000000000000000000000000000";
const HL_CONTRACT_ZH = "验证合约 0x0000000000000000000000000000000000000000";
const HL_AGENT_POWERS =
  "The agent can trade for this account and its sub-accounts and move funds inside Hyperliquid, including into vaults, without asking you. It cannot withdraw or send funds to other accounts.";
const HL_AGENT_POWERS_ZH =
  "该代理无需你确认即可替此账户及其子账户交易，并在 Hyperliquid 内转移资金（包括存入金库）；它不能提现或向其他账户转账。";

/* Polymarket prompt literals: the allow-listed exchanges and the generated order leaves. */
const PM_CTF_EXCHANGE = "0xE111180000d2663C0091e4f400237545B87B996B";
const PM_V3 = "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa";
const PM_PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const PM_CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const PM_WALLET = "0x3000000000000000000000000000000000000003";
const PM_UNKNOWN = "0x00000000000000000000000000000000c0ffee00";
const PM_UNKNOWN_CHECKSUM = getAddress(PM_UNKNOWN);
const PM_TOKEN_ID = "21742633143463906290569050155826241533067272736897614950488156847949938836455";
const PM_TOKEN_ID_2 =
  "6048711698446802097821302547443908381638681757684206197981905346932645477957";
const PM_FEE_AT_MATCH =
  "Polymarket sets the trading fee when the order is matched; this signature does not cap it";
const PM_FEE_AT_MATCH_ZH = "交易手续费由 Polymarket 在撮合时设定；此签名不限制其金额";
const PM_SIGNER = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
const PM_ZERO32 = `0x${"0".repeat(64)}`;
const pmLeaves = (
  salt: string,
  tokenId: string,
  makerAmount: string,
  takerAmount: string,
  timestamp: string,
): string =>
  [
    `· salt = ${salt}`,
    `· maker = ${PM_SIGNER}`,
    `· signer = ${PM_SIGNER}`,
    `· tokenId = ${tokenId}`,
    `· makerAmount = ${makerAmount}`,
    `· takerAmount = ${takerAmount}`,
    `· side = 0`,
    `· signatureType = 0`,
    `· timestamp = ${timestamp}`,
    `· metadata = ${PM_ZERO32}`,
    `· builder = ${PM_ZERO32}`,
  ].join("\n");
const PM_ORDER_LEAVES_1 = pmLeaves(
  "746666666340",
  PM_TOKEN_ID,
  "50000000",
  "100000000",
  "1777777777000",
);
const PM_ORDER_LEAVES_1_ZH = PM_ORDER_LEAVES_1;
const PM_ORDER_LEAVES_2 = pmLeaves(
  "800000080650",
  PM_TOKEN_ID_2,
  "40000000",
  "80000000",
  "1777777957000",
);
const PM_ORDER_LEAVES_2_ZH = PM_ORDER_LEAVES_2;

const p = (title: string, titleZh: string, en: string, zh: string) => ({
  en: { title, description: en },
  "zh-Hans": { title: titleZh, description: zh },
});

const leaves = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `f${i}`, type: "uint256" }));
const bigDoc = (n: number) => ({
  types: {
    EIP712Domain: [
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Big: leaves(n),
  },
  primaryType: "Big",
  domain: { chainId: 1, verifyingContract: TO },
  message: Object.fromEntries(leaves(n).map((f) => [f.name, "1"])),
});
const fields16 = leaves(16)
  .map((f) => `· ${f.name} = 1`)
  .join("\n");
const fields16Zh = fields16;

const hash32 = `0x${"ab".repeat(32)}`;
const bytes100 = "cd".repeat(100);
const SAFE = "0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52";
const SEAPORT_16 = "0x0000000000000068F116a894984e2DB1123eB395";
const GROUND_DIGEST = "5718efa1a01c4e34c7b5481f5450604d1274491d0f310532dcbd7461c9ae3b79";
const TEXT32 = "Sign this harmless text, please!";
const toHex = (bytes: Uint8Array) =>
  `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
const TEXT32_HEX = toHex(utf8(TEXT32));
const BOM32_HEX = toHex(
  new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("sign this digest for me now!!")]),
);
const hexText = `0x${"ab".repeat(32)}`;

const seaportItemFields = [
  { name: "itemType", type: "uint8" },
  { name: "token", type: "address" },
  { name: "identifierOrCriteria", type: "uint256" },
  { name: "startAmount", type: "uint256" },
  { name: "endAmount", type: "uint256" },
];
const seaportNativeItem = {
  itemType: 0,
  token: "0x0000000000000000000000000000000000000000",
  identifierOrCriteria: "0",
  startAmount: "1000000000000000000",
  endAmount: "1000000000000000000",
};

type VectorCase = {
  readonly name: string;
  readonly request: unknown;
  readonly verifiability: string;
  readonly blind: unknown;
  readonly prompt: unknown;
};

const cases: VectorCase[] = [
  {
    name: "WETH9 deposit() (wrap 1 ETH)",
    request: tx({
      to: WETH,
      data: encodeFunctionData({ abi: parseAbi(["function deposit() payable"]) }),
      value: "0xde0b6b3a7640000",
    }),
    verifiability: "full",
    blind: null,
    prompt: p(
      "Confirm swap",
      "确认兑换",
      `${net}\nSend 1 ETH to ${WETH}\nReceive at least 1 WETH at ${SIGNER}\n${fee}`,
      `${netZh}\n发送 1 ETH 到 ${WETH}\n至少收到 1 WETH，收款地址 ${SIGNER}\n${feeZh}`,
    ),
  },
  {
    name: "Aave V3 Pool supply(USDC, 1e6, signer, 0)",
    request: tx({
      to: AAVE_V3,
      data: encodeFunctionData({
        abi: parseAbi(["function supply(address,uint256,address,uint16)"]),
        args: [USDC, 1_000_000n, SIGNER, 0],
      }),
    }),
    verifiability: "opaque",
    blind: null,
    prompt: p(
      "Confirm contract call",
      "确认合约调用",
      `${net}\n${caveat}\nCall contract ${AAVE_V3}, function 0x617ba037\n${fee}`,
      `${netZh}\n${caveatZh}\n调用合约 ${AAVE_V3}，函数 0x617ba037\n${feeZh}`,
    ),
  },
  {
    name: "Uniswap Universal Router execute() (0.01 ETH)",
    request: tx({
      to: ROUTER,
      data: encodeFunctionData({
        abi: parseAbi(["function execute(bytes,bytes[],uint256)"]),
        args: ["0x0b00", ["0x", "0x"], 2_000_000_000n],
      }),
      value: "0x2386f26fc10000",
    }),
    verifiability: "opaque",
    blind: null,
    prompt: p(
      "Confirm contract call",
      "确认合约调用",
      `${net}\n${caveat}\nCall contract ${ROUTER}, function 0x3593564c\nSend 0.01 ETH to ${ROUTER}\n${fee}`,
      `${netZh}\n${caveatZh}\n调用合约 ${ROUTER}，函数 0x3593564c\n发送 0.01 ETH 到 ${ROUTER}\n${feeZh}`,
    ),
  },
  {
    name: "CoW Protocol GPv2 Order (EIP-712)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Order: [
          { name: "sellToken", type: "address" },
          { name: "buyToken", type: "address" },
          { name: "receiver", type: "address" },
          { name: "sellAmount", type: "uint256" },
          { name: "buyAmount", type: "uint256" },
          { name: "validTo", type: "uint32" },
          { name: "appData", type: "bytes32" },
          { name: "feeAmount", type: "uint256" },
          { name: "kind", type: "string" },
          { name: "partiallyFillable", type: "bool" },
          { name: "sellTokenBalance", type: "string" },
          { name: "buyTokenBalance", type: "string" },
        ],
      },
      primaryType: "Order",
      domain: {
        name: "Gnosis Protocol",
        version: "v2",
        chainId: 1,
        verifyingContract: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
      },
      message: {
        sellToken: USDC,
        buyToken: WETH,
        receiver: SIGNER,
        sellAmount: "1000000",
        buyAmount: "1",
        validTo: 2_000_000_000,
        appData: `0x${"00".repeat(32)}`,
        feeAmount: "0",
        kind: "sell",
        partiallyFillable: false,
        sellTokenBalance: "erc20",
        buyTokenBalance: "erc20",
      },
    }),
    /* The CoW family decoder claims the document; appData stays hidden as part of the order. */
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm swap",
      "确认兑换",
      `App: Gnosis Protocol\n${net}\nVerifying contract 0x9008D19f58AAbD9eD0D60971565AA8510560ab41\nType: Order\nCoW Protocol order by ${SIGNER}\nGive at most 1 USDC\n${SIGNER} receives at least 0.000000000000000001 WETH\nValid until 2033-05-18 03:33 (UTC)`,
      `应用：Gnosis Protocol\n${netZh}\n验证合约 0x9008D19f58AAbD9eD0D60971565AA8510560ab41\n类型：Order\nCoW Protocol 订单，挂单方 ${SIGNER}\n最多付出 1 USDC\n${SIGNER} 至少收到 0.000000000000000001 WETH\n有效期至 2033-05-18 03:33（UTC）`,
    ),
  },
  {
    name: "Aave V3 Pool withdraw(USDC, max, 0x…0BAD00)",
    request: tx({
      to: AAVE_V3,
      data: encodeFunctionData({
        abi: parseAbi(["function withdraw(address,uint256,address)"]),
        args: [USDC, 2n ** 256n - 1n, OTHER],
      }),
    }),
    verifiability: "opaque",
    blind: null,
    prompt: p(
      "Confirm contract call",
      "确认合约调用",
      `${net}\n${caveat}\nCall contract ${AAVE_V3}, function 0x69328dec\n${fee}`,
      `${netZh}\n${caveatZh}\n调用合约 ${AAVE_V3}，函数 0x69328dec\n${feeZh}`,
    ),
  },
  {
    name: "USDC unrecognised function",
    request: tx({ to: USDC, data: "0xdeadbeef" }),
    verifiability: "opaque",
    blind: "token-function",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `${net}\nAn unrecognised function of token USDC ${USDC} can move this token\nCall contract ${USDC}, function 0xdeadbeef\n${fee}`,
      `${netZh}\n代币 USDC ${USDC} 的未知函数，可能转走该代币\n调用合约 ${USDC}，函数 0xdeadbeef\n${feeZh}`,
    ),
  },
  {
    name: "USDC transfer (readable)",
    request: tx({
      to: USDC,
      data: encodeFunctionData({
        abi: parseAbi(["function transfer(address,uint256)"]),
        args: [TO, 1_000_000n],
      }),
    }),
    verifiability: "full",
    blind: null,
    prompt: p(
      "Confirm transfer",
      "确认转账",
      `${net}\nSend 1 USDC to ${TO}\n${fee}`,
      `${netZh}\n发送 1 USDC 到 ${TO}\n${feeZh}`,
    ),
  },
  {
    name: "ERC-721 approve(0, 42) clears the token approval",
    request: tx({
      to: CRYPTO_KITTIES,
      data: encodeFunctionData({
        abi: parseAbi(["function approve(address spender, uint256 tokenId)"]),
        args: ["0x0000000000000000000000000000000000000000", 42n],
      }),
    }),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm approval",
      "确认授权",
      `${net}\nThere may be other outflows\nClear the approval on ${CRYPTO_KITTIES} #42\n${fee}`,
      `${netZh}\n可能还有其他转出\n清除 ${CRYPTO_KITTIES} #42 的单个授权\n${feeZh}`,
    ),
  },
  {
    name: "USDC approve(spender, 0) revokes the allowance",
    request: tx({
      to: USDC,
      data: encodeFunctionData({
        abi: parseAbi(["function approve(address spender, uint256 amount)"]),
        args: [TO, 0n],
      }),
    }),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm approval",
      "确认授权",
      `${net}\nThere may be other outflows\nRevoke ${TO}'s allowance for USDC\n${fee}`,
      `${netZh}\n可能还有其他转出\n撤销 ${TO} 对 USDC 的授权\n${feeZh}`,
    ),
  },
  {
    name: "ERC-721 setApprovalForAll(operator, false) revokes the operator",
    request: tx({
      to: CRYPTO_KITTIES,
      data: encodeFunctionData({
        abi: parseAbi(["function setApprovalForAll(address operator, bool approved)"]),
        args: [TO, false],
      }),
    }),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm approval",
      "确认授权",
      `${net}\nThere may be other outflows\nRevoke ${TO}'s access to all tokens of ${CRYPTO_KITTIES}\n${fee}`,
      `${netZh}\n可能还有其他转出\n撤销 ${TO} 对 ${CRYPTO_KITTIES} 全部代币的授权\n${feeZh}`,
    ),
  },
  {
    name: "Permit2 lockdown revokes a token+spender pair",
    request: tx({
      to: PERMIT2,
      data: encodeFunctionData({
        abi: parseAbi(["function lockdown((address token, address spender)[] approvals)"]),
        args: [[{ token: USDC, spender: TO }]],
      }),
    }),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm approval",
      "确认授权",
      `${net}\nThere may be other outflows\nRevoke ${TO}'s allowance for USDC via Permit2\n${fee}`,
      `${netZh}\n可能还有其他转出\n撤销 ${TO} 对 USDC 的授权 经 Permit2\n${feeZh}`,
    ),
  },
  {
    name: "calldata to the signing account",
    request: tx({ to: SIGNER, data: "0xdeadbeef" }),
    verifiability: "opaque",
    blind: "account-code",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `${net}\nRuns this account's own code with full authority\nCall contract ${SIGNER}, function 0xdeadbeef\n${fee}`,
      `${netZh}\n以本账户的全部权限执行其自身代码\n调用合约 ${SIGNER}，函数 0xdeadbeef\n${feeZh}`,
    ),
  },
  {
    name: "contract creation",
    request: tx({ data: "0x60006000" }),
    verifiability: "opaque",
    blind: null,
    prompt: p(
      "Confirm contract call",
      "确认合约调用",
      `${net}\n${caveat}\nDeploy contract ${DEPLOYED}\n${fee}`,
      `${netZh}\n${caveatZh}\n部署合约 ${DEPLOYED}\n${feeZh}`,
    ),
  },
  {
    name: "EIP-712 Mail (eth-sig-util example)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Person: [
          { name: "name", type: "string" },
          { name: "wallet", type: "address" },
        ],
        Mail: [
          { name: "from", type: "Person" },
          { name: "to", type: "Person" },
          { name: "contents", type: "string" },
        ],
      },
      primaryType: "Mail",
      domain: {
        name: "Ether Mail",
        version: "1",
        chainId: 1,
        verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
      },
      message: {
        from: {
          name: "Cow",
          wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826",
        },
        to: {
          name: "Bob",
          wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB",
        },
        contents: "Hello, Bob!",
      },
    }),
    verifiability: "opaque",
    blind: null,
    prompt: p(
      "Confirm signature",
      "确认签名",
      `App: Ether Mail\n${net}\nVerifying contract 0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC\nType: Mail\n${typedCaveat}\n· from.name = Cow\n· from.wallet = 0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826\n· to.name = Bob\n· to.wallet = 0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB\n· contents = Hello, Bob!`,
      `应用：Ether Mail\n${netZh}\n验证合约 0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC\n类型：Mail\n${typedCaveatZh}\n· from.name = Cow\n· from.wallet = 0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826\n· to.name = Bob\n· to.wallet = 0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB\n· contents = Hello, Bob!`,
    ),
  },
  {
    name: "EIP-712 sixteen leaves (described)",
    request: typedData(bigDoc(16)),
    verifiability: "opaque",
    blind: null,
    prompt: p(
      "Confirm signature",
      "确认签名",
      `${net}\nVerifying contract ${TO}\nType: Big\n${typedCaveat}\n${fields16}`,
      `${netZh}\n验证合约 ${TO}\n类型：Big\n${typedCaveatZh}\n${fields16Zh}`,
    ),
  },
  {
    name: "EIP-712 seventeen leaves (too large to show)",
    request: typedData(bigDoc(17)),
    verifiability: "opaque",
    blind: "typed-data-oversize",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `${net}\nVerifying contract ${TO}\nType: Big\n${typedOversize}`,
      `${netZh}\n验证合约 ${TO}\n类型：Big\n${typedOversizeZh}`,
    ),
  },
  {
    name: "EIP-712 string leaf with hidden characters",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        Root: [{ name: "subject", type: "string" }],
      },
      primaryType: "Root",
      domain: { name: "App", version: "1", chainId: 1 },
      message: { subject: "pay ‮bob" },
    }),
    verifiability: "opaque",
    blind: "message-bytes",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `${hiddenChars}\nApp: App\n${net}\nType: Root\n${typedCaveat}\n· subject = pay �bob`,
      `${hiddenCharsZh}\n应用：App\n${netZh}\n类型：Root\n${typedCaveatZh}\n· subject = pay �bob`,
    ),
  },
  {
    name: "personal_sign 32-byte hash",
    request: personal(hash32),
    verifiability: "opaque",
    blind: "message-bytes",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `${blindBytes}\nData ${hash32}`,
      `${blindBytesZh}\n数据 ${hash32}`,
    ),
  },
  {
    name: "personal_sign 100 bytes",
    request: personal(`0x${bytes100}`),
    verifiability: "opaque",
    blind: "message-bytes",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `${blindBytes}\n100 bytes`,
      `${blindBytesZh}\n100 字节`,
    ),
  },
  {
    name: "personal_sign text (readable)",
    request: personal(
      `0x${[...utf8("hello world")].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
    ),
    verifiability: "opaque",
    blind: null,
    prompt: p("Confirm signature", "确认签名", "Message:\n· hello world", "消息：\n· hello world"),
  },
  {
    name: "personal_sign kernel-line forgery",
    request: personal(
      `0x${[...utf8("Confirm this order\nNetwork: Ethereum\nMax fee 0.5 ETH")].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
    ),
    verifiability: "opaque",
    blind: null,
    prompt: p(
      "Confirm signature",
      "确认签名",
      "Message:\n· Confirm this order\n· Network: Ethereum\n· Max fee 0.5 ETH",
      "消息：\n· Confirm this order\n· Network: Ethereum\n· Max fee 0.5 ETH",
    ),
  },
  {
    name: "EIP-712 SafeMessage(bytes) (commitment)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        SafeMessage: [{ name: "message", type: "bytes" }],
      },
      primaryType: "SafeMessage",
      domain: { chainId: 1, verifyingContract: SAFE },
      message: { message: hash32 },
    }),
    verifiability: "opaque",
    blind: "typed-data-commitment",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `${net}\nVerifying contract ${SAFE}\nType: SafeMessage\n${typedCommitment}\n${typedCaveat}\n· message = ${hash32}`,
      `${netZh}\n验证合约 ${SAFE}\n类型：SafeMessage\n${typedCommitmentZh}\n${typedCaveatZh}\n· message = ${hash32}`,
    ),
  },
  {
    name: "USDC TransferWithAuthorization (EIP-3009 near miss, from not the signer)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      domain: { name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC },
      message: {
        from: OTHER,
        to: OTHER,
        value: "1000000",
        validAfter: "0",
        validBefore: "2000000000",
        nonce: hash32,
      },
    }),
    verifiability: "opaque",
    blind: "typed-data-variant",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `App: USD Coin\n${net}\nVerifying contract ${USDC}\nType: TransferWithAuthorization\n${typedVariant}\n${typedCaveat}\n· from = ${OTHER}\n· to = ${OTHER}\n· value = 1000000\n· validAfter = 0\n· validBefore = 2000000000\n· nonce = ${hash32}`,
      `应用：USD Coin\n${netZh}\n验证合约 ${USDC}\n类型：TransferWithAuthorization\n${typedVariantZh}\n${typedCaveatZh}\n· from = ${OTHER}\n· to = ${OTHER}\n· value = 1000000\n· validAfter = 0\n· validBefore = 2000000000\n· nonce = ${hash32}`,
    ),
  },
  {
    name: "USDC TransferWithAuthorization (x402, listed Base USDC)",
    request: {
      ...typedData({
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        domain: {
          name: "USD Coin",
          version: "2",
          chainId: 8453,
          verifyingContract: BASE_USDC,
        },
        message: {
          from: SIGNER,
          to: OTHER,
          value: "10000",
          validAfter: "0",
          validBefore: "1738886400",
          nonce: hash32,
        },
      }),
      network: "eip155:8453",
    },
    verifiability: "full",
    blind: null,
    prompt: p(
      "Confirm transfer",
      "确认转账",
      `App: USD Coin\n${netBase}\nVerifying contract ${BASE_USDC}\nType: TransferWithAuthorization\nSend 0.01 USDC to ${OTHER}\nAnyone holding this signature can submit the transfer\nValid before 2025-02-07 00:00 (UTC)`,
      `应用：USD Coin\n${netBaseZh}\n验证合约 ${BASE_USDC}\n类型：TransferWithAuthorization\n发送 0.01 USDC 到 ${OTHER}\n任何持有此签名的人都可以提交这笔转账\n2025-02-07 00:00 之前有效（UTC）`,
    ),
  },
  {
    name: "USDC ReceiveWithAuthorization (listed Arbitrum USDC)",
    request: {
      ...typedData({
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          ReceiveWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "ReceiveWithAuthorization",
        domain: {
          name: "USD Coin",
          version: "2",
          chainId: 42161,
          verifyingContract: ARB_USDC,
        },
        message: {
          from: SIGNER,
          to: OTHER,
          value: "8080000",
          validAfter: "1772641538",
          validBefore: "1772645198",
          nonce: hash32,
        },
      }),
      network: "eip155:42161",
    },
    verifiability: "full",
    blind: null,
    prompt: p(
      "Confirm transfer",
      "确认转账",
      `App: USD Coin\n${netArb}\nVerifying contract ${ARB_USDC}\nType: ReceiveWithAuthorization\nSend 8.08 USDC to ${OTHER}\nOnly ${OTHER} can submit the transfer\nValid after 2026-03-04 16:25 and before 2026-03-04 17:26 (UTC)`,
      `应用：USD Coin\n${netArbZh}\n验证合约 ${ARB_USDC}\n类型：ReceiveWithAuthorization\n发送 8.08 USDC 到 ${OTHER}\n只有 ${OTHER} 可以提交这笔转账\n2026-03-04 16:25 之后、2026-03-04 17:26 之前有效（UTC）`,
    ),
  },
  {
    name: "USDT0 CancelAuthorization (Flare, unlisted token)",
    request: {
      ...typedData({
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          CancelAuthorization: [
            { name: "authorizer", type: "address" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "CancelAuthorization",
        domain: {
          name: "USD₮0",
          version: "1",
          chainId: 14,
          verifyingContract: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D",
        },
        message: {
          authorizer: SIGNER,
          nonce: hash32,
        },
      }),
      network: "eip155:14",
    },
    verifiability: "full",
    blind: null,
    prompt: p(
      "Confirm signature",
      "确认签名",
      `App: USD₮0\n${netFlare}\nVerifying contract 0xe7cd86e13AC4309349F30B3435a9d337750fC82D\nType: CancelAuthorization\nCancel the unused transfer authorization ${hash32}; no funds move`,
      `应用：USD₮0\n${netFlareZh}\n验证合约 0xe7cd86e13AC4309349F30B3435a9d337750fC82D\n类型：CancelAuthorization\n取消未使用的转账授权 ${hash32}；不转移资金`,
    ),
  },
  {
    name: "zkstables TransferWithAuthorization (unlisted token)",
    request: {
      ...typedData({
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        domain: {
          name: "ZK Stables USD",
          version: "1",
          chainId: 8453,
          verifyingContract: "0x8ED36a645beF11075283524C01acA742CbAfC832",
        },
        message: {
          from: SIGNER,
          to: OTHER,
          value: "21370000",
          validAfter: "1767225600",
          validBefore: "1767225600",
          nonce: hash32,
        },
      }),
      network: "eip155:8453",
    },
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm transfer",
      "确认转账",
      `App: ZK Stables USD\n${netBase}\nVerifying contract 0x8ED36a645beF11075283524C01acA742CbAfC832\nType: TransferWithAuthorization\nSend 21370000 base units of unverified token 0x8ED36a645beF11075283524C01acA742CbAfC832 to ${OTHER}\nAnyone holding this signature can submit the transfer\nValid after 2026-01-01 00:00 and before 2026-01-01 00:00 (UTC)`,
      `应用：ZK Stables USD\n${netBaseZh}\n验证合约 0x8ED36a645beF11075283524C01acA742CbAfC832\n类型：TransferWithAuthorization\n发送 21370000 个最小单位（未验证代币 0x8ED36a645beF11075283524C01acA742CbAfC832） 到 ${OTHER}\n任何持有此签名的人都可以提交这笔转账\n2026-01-01 00:00 之后、2026-01-01 00:00 之前有效（UTC）`,
    ),
  },
  {
    name: "Morpho Authorization grant (verified)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Authorization: [
          { name: "authorizer", type: "address" },
          { name: "authorized", type: "address" },
          { name: "isAuthorized", type: "bool" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Authorization",
      domain: { chainId: 1, verifyingContract: MORPHO },
      message: {
        authorizer: SIGNER,
        authorized: OTHER,
        isAuthorized: true,
        nonce: "0",
        deadline: "1900000000",
      },
    }),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm account authorization",
      "确认账户授权",
      `${net}\nVerifying contract ${MORPHO}\nType: Authorization\nLet ${OTHER} manage your Morpho positions: it can withdraw your supplied assets and collateral and borrow against your collateral, sending the funds anywhere\nThis signature can be used until 2030-03-17 17:46 (UTC)`,
      `${netZh}\n验证合约 ${MORPHO}\n类型：Authorization\n允许 ${OTHER} 管理你在 Morpho 的仓位：它可以提走你存入的资产和抵押品，并以你的抵押品借款，资金可转到任何地址\n此签名在 2030-03-17 17:46（UTC）前可被使用`,
    ),
  },
  {
    name: "Morpho Authorization revoke (verified)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Authorization: [
          { name: "authorizer", type: "address" },
          { name: "authorized", type: "address" },
          { name: "isAuthorized", type: "bool" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Authorization",
      domain: { chainId: 1, verifyingContract: MORPHO },
      message: {
        authorizer: SIGNER,
        authorized: OTHER,
        isAuthorized: false,
        nonce: "1",
        deadline: "281474976710656",
      },
    }),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm account authorization",
      "确认账户授权",
      `${net}\nVerifying contract ${MORPHO}\nType: Authorization\nRevoke ${OTHER}'s authority over your Morpho positions`,
      `${netZh}\n验证合约 ${MORPHO}\n类型：Authorization\n撤销 ${OTHER} 管理你 Morpho 仓位的权限`,
    ),
  },
  {
    name: "Aave DelegationWithSig unlimited credit (verified USDC debt token)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        DelegationWithSig: [
          { name: "delegatee", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "DelegationWithSig",
      domain: {
        name: "Aave Ethereum Variable Debt USDC",
        version: "1",
        chainId: 1,
        verifyingContract: AAVE_USDC_DEBT,
      },
      message: {
        delegatee: OTHER,
        value: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        nonce: "0",
        deadline: "1900000000",
      },
    }),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm account authorization",
      "确认账户授权",
      `App: Aave Ethereum Variable Debt USDC\n${net}\nVerifying contract ${AAVE_USDC_DEBT}\nType: DelegationWithSig\nLet ${OTHER} borrow up to unlimited USDC on your Aave credit: you owe the debt and your collateral backs it\nThis signature can be used until 2030-03-17 17:46 (UTC)`,
      `应用：Aave Ethereum Variable Debt USDC\n${netZh}\n验证合约 ${AAVE_USDC_DEBT}\n类型：DelegationWithSig\n允许 ${OTHER} 以你的 Aave 信用借入最多 全部 USDC：债务由你承担，以你的抵押品担保\n此签名在 2030-03-17 17:46（UTC）前可被使用`,
    ),
  },
  {
    name: "Aave DelegationWithSig bounded credit (unverified contract)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        DelegationWithSig: [
          { name: "delegatee", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "DelegationWithSig",
      domain: {
        name: "Aave Whatever Variable Debt X",
        version: "1",
        chainId: 1,
        verifyingContract: OTHER,
      },
      message: { delegatee: OTHER, value: "1000000", nonce: "0", deadline: "1900000000" },
    }),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm account authorization",
      "确认账户授权",
      `App: Aave Whatever Variable Debt X\n${net}\nVerifying contract ${OTHER}\nType: DelegationWithSig\nLet ${OTHER} borrow up to 1000000 base units of unverified token ${OTHER} on your Aave credit: you owe the debt and your collateral backs it\nThe wallet does not know contract ${OTHER}; it may grant other powers\nThis signature can be used until 2030-03-17 17:46 (UTC)`,
      `应用：Aave Whatever Variable Debt X\n${netZh}\n验证合约 ${OTHER}\n类型：DelegationWithSig\n允许 ${OTHER} 以你的 Aave 信用借入最多 1000000 个最小单位（未验证代币 ${OTHER}）：债务由你承担，以你的抵押品担保\n钱包不认识合约 ${OTHER}；它可能授予其他权限\n此签名在 2030-03-17 17:46（UTC）前可被使用`,
    ),
  },
  {
    name: "Snapshot Alias",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
        ],
        Alias: [
          { name: "from", type: "address" },
          { name: "alias", type: "address" },
          { name: "timestamp", type: "uint64" },
        ],
      },
      primaryType: "Alias",
      domain: { name: "snapshot", version: "0.1.4" },
      message: { from: SIGNER, alias: OTHER, timestamp: 1700000000 },
    }),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm account authorization",
      "确认账户授权",
      `App: snapshot\n${net}\nType: Alias\nLet ${OTHER} vote, create proposals and act on Snapshot as you`,
      `应用：snapshot\n${netZh}\n类型：Alias\n允许 ${OTHER} 以你的身份在 Snapshot 投票、发起提案和执行其他操作`,
    ),
  },
  {
    name: "Morpho Authorization near miss (authorizer not the signer)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Authorization: [
          { name: "authorizer", type: "address" },
          { name: "authorized", type: "address" },
          { name: "isAuthorized", type: "bool" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Authorization",
      domain: { chainId: 1, verifyingContract: MORPHO },
      message: {
        authorizer: OTHER,
        authorized: SIGNER,
        isAuthorized: true,
        nonce: "0",
        deadline: "1900000000",
      },
    }),
    verifiability: "opaque",
    blind: "typed-data-variant",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `${net}\nVerifying contract ${MORPHO}\nType: Authorization\n${typedVariant}\n${typedCaveat}\n· authorizer = ${OTHER}\n· authorized = ${SIGNER}\n· isAuthorized = true\n· nonce = 0\n· deadline = 1900000000`,
      `${netZh}\n验证合约 ${MORPHO}\n类型：Authorization\n${typedVariantZh}\n${typedCaveatZh}\n· authorizer = ${OTHER}\n· authorized = ${SIGNER}\n· isAuthorized = true\n· nonce = 0\n· deadline = 1900000000`,
    ),
  },
  {
    name: "Aave DelegationWithSig near miss (domain version not 1)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        DelegationWithSig: [
          { name: "delegatee", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "DelegationWithSig",
      domain: {
        name: "Aave Ethereum Variable Debt USDC",
        version: "2",
        chainId: 1,
        verifyingContract: AAVE_USDC_DEBT,
      },
      message: { delegatee: OTHER, value: "1000000", nonce: "0", deadline: "1900000000" },
    }),
    verifiability: "opaque",
    blind: "typed-data-variant",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `App: Aave Ethereum Variable Debt USDC\n${net}\nVerifying contract ${AAVE_USDC_DEBT}\nType: DelegationWithSig\n${typedVariant}\n${typedCaveat}\n· delegatee = ${OTHER}\n· value = 1000000\n· nonce = 0\n· deadline = 1900000000`,
      `应用：Aave Ethereum Variable Debt USDC\n${netZh}\n验证合约 ${AAVE_USDC_DEBT}\n类型：DelegationWithSig\n${typedVariantZh}\n${typedCaveatZh}\n· delegatee = ${OTHER}\n· value = 1000000\n· nonce = 0\n· deadline = 1900000000`,
    ),
  },
  {
    name: "Snapshot Alias near miss (from not the signer)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
        ],
        Alias: [
          { name: "from", type: "address" },
          { name: "alias", type: "address" },
          { name: "timestamp", type: "uint64" },
        ],
      },
      primaryType: "Alias",
      domain: { name: "snapshot", version: "0.1.4" },
      message: { from: OTHER, alias: OTHER, timestamp: 1700000000 },
    }),
    verifiability: "opaque",
    blind: "typed-data-variant",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `App: snapshot\n${net}\nType: Alias\n${typedVariant}\n${typedCaveat}\n· from = ${OTHER}\n· alias = ${OTHER}\n· timestamp = 1700000000`,
      `应用：snapshot\n${netZh}\n类型：Alias\n${typedVariantZh}\n${typedCaveatZh}\n· from = ${OTHER}\n· alias = ${OTHER}\n· timestamp = 1700000000`,
    ),
  },
  {
    name: "Farcaster KeyGateway Add signer key",
    request: opTypedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Add: [
          { name: "owner", type: "address" },
          { name: "keyType", type: "uint32" },
          { name: "key", type: "bytes" },
          { name: "metadataType", type: "uint8" },
          { name: "metadata", type: "bytes" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Add",
      domain: {
        name: "Farcaster KeyGateway",
        version: "1",
        chainId: 10,
        verifyingContract: FARCASTER_KEY_GATEWAY,
      },
      message: {
        owner: SIGNER,
        keyType: 1,
        key: FARCASTER_KEY,
        metadataType: 1,
        metadata: encodeAbiParameters(
          [
            {
              type: "tuple",
              components: [
                { name: "requestFid", type: "uint256" },
                { name: "requestSigner", type: "address" },
                { name: "signature", type: "bytes" },
                { name: "deadline", type: "uint256" },
              ],
            },
          ],
          [
            {
              requestFid: 42n,
              requestSigner: OTHER,
              signature: `0x${"00".repeat(65)}`,
              deadline: 1900000000n,
            },
          ],
        ),
        nonce: "0",
        deadline: "1900000000",
      },
    }),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm account authorization",
      "确认账户授权",
      `App: Farcaster KeyGateway\n${netOp}\nVerifying contract ${FARCASTER_KEY_GATEWAY}\nType: Add\nAdd signer key ${FARCASTER_KEY} to your Farcaster account, requested by app fid 42; until you remove it, it can publish posts, reactions and follows as you\nThis signature can be used until 2030-03-17 17:46 (UTC)`,
      `应用：Farcaster KeyGateway\n${netOpZh}\n验证合约 ${FARCASTER_KEY_GATEWAY}\n类型：Add\n向你的 Farcaster 账户添加签名密钥 ${FARCASTER_KEY}（应用 fid 42 请求）；在你移除前，它可以以你的身份发帖、点赞和关注\n此签名在 2030-03-17 17:46（UTC）前可被使用`,
    ),
  },
  {
    name: "Farcaster SignedKeyRequest",
    request: opTypedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        SignedKeyRequest: [
          { name: "requestFid", type: "uint256" },
          { name: "key", type: "bytes" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "SignedKeyRequest",
      domain: {
        name: "Farcaster SignedKeyRequestValidator",
        version: "1",
        chainId: 10,
        verifyingContract: FARCASTER_VALIDATOR,
      },
      message: { requestFid: "42", key: FARCASTER_KEY, deadline: "1900000000" },
    }),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm signature",
      "确认签名",
      `App: Farcaster SignedKeyRequestValidator\n${netOp}\nVerifying contract ${FARCASTER_VALIDATOR}\nType: SignedKeyRequest\nAs app fid 42, request signer key ${FARCASTER_KEY} for a Farcaster user\nThis signature can be used until 2030-03-17 17:46 (UTC)`,
      `应用：Farcaster SignedKeyRequestValidator\n${netOpZh}\n验证合约 ${FARCASTER_VALIDATOR}\n类型：SignedKeyRequest\n以应用 fid 42 的身份为 Farcaster 用户请求签名密钥 ${FARCASTER_KEY}\n此签名在 2030-03-17 17:46（UTC）前可被使用`,
    ),
  },
  {
    name: "Seaport OrderComponents, nine offers (over the prompt limit)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        OrderComponents: [
          { name: "offerer", type: "address" },
          { name: "zone", type: "address" },
          { name: "offer", type: "OfferItem[]" },
          { name: "consideration", type: "ConsiderationItem[]" },
          { name: "orderType", type: "uint8" },
          { name: "startTime", type: "uint256" },
          { name: "endTime", type: "uint256" },
          { name: "zoneHash", type: "bytes32" },
          { name: "salt", type: "uint256" },
          { name: "conduitKey", type: "bytes32" },
          { name: "counter", type: "uint256" },
        ],
        OfferItem: seaportItemFields,
        ConsiderationItem: [...seaportItemFields, { name: "recipient", type: "address" }],
      },
      primaryType: "OrderComponents",
      domain: { name: "Seaport", version: "1.6", chainId: 1, verifyingContract: SEAPORT_16 },
      message: {
        offerer: SIGNER,
        zone: "0x0000000000000000000000000000000000000000",
        offer: Array.from({ length: 9 }, () => seaportNativeItem),
        consideration: [
          { ...seaportNativeItem, startAmount: "0", endAmount: "0", recipient: SIGNER },
        ],
        orderType: 0,
        startTime: "1700000000",
        endTime: "1700001000",
        zoneHash: `0x${"00".repeat(32)}`,
        salt: "1",
        conduitKey: `0x${"00".repeat(32)}`,
        counter: "0",
      },
    }),
    verifiability: "opaque",
    blind: "typed-data-oversize",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `App: Seaport\n${net}\nVerifying contract ${SEAPORT_16}\nType: OrderComponents\n${"Give 1 ETH\n".repeat(8)}… 1 more items not shown\n${SIGNER} receives 0 ETH`,
      `应用：Seaport\n${netZh}\n验证合约 ${SEAPORT_16}\n类型：OrderComponents\n${"付出 1 ETH\n".repeat(8)}… 还有 1 项未显示\n${SIGNER} 收到 0 ETH`,
    ),
  },
  {
    name: "personal_sign 32-byte UTF-8 digest",
    request: personal(`0x${GROUND_DIGEST}`),
    verifiability: "opaque",
    blind: "message-bytes",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `This 32-byte message could be a hash: signing it may authorise whatever the hash commits to\nData 0x${GROUND_DIGEST}`,
      `这条 32 字节的消息可能是哈希：签署它可能授权该哈希所承诺的任何内容\n数据 0x${GROUND_DIGEST}`,
    ),
  },
  {
    name: "personal_sign 32-byte text",
    request: personal(TEXT32_HEX),
    verifiability: "opaque",
    blind: "message-bytes",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `This 32-byte message could be a hash: signing it may authorise whatever the hash commits to\nData ${TEXT32_HEX}\nMessage:\n· ${TEXT32}`,
      `这条 32 字节的消息可能是哈希：签署它可能授权该哈希所承诺的任何内容\n数据 ${TEXT32_HEX}\n消息：\n· ${TEXT32}`,
    ),
  },
  {
    name: "personal_sign BOM-prefixed 32-byte",
    request: personal(BOM32_HEX),
    verifiability: "opaque",
    blind: "message-bytes",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `This 32-byte message could be a hash: signing it may authorise whatever the hash commits to\nData ${BOM32_HEX}`,
      `这条 32 字节的消息可能是哈希：签署它可能授权该哈希所承诺的任何内容\n数据 ${BOM32_HEX}`,
    ),
  },
  {
    name: "personal_sign hex-rendered text",
    request: personal(
      `0x${[...utf8(hexText)].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
    ),
    verifiability: "opaque",
    blind: "message-bytes",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      "This text encodes raw bytes; the wallet cannot see what they authorise\nMessage:\n· 0xabababababababababababababababababababababababababababababababab",
      "文本是原始字节的编码；钱包无法看到它们授权的内容\n消息：\n· 0xabababababababababababababababababababababababababababababababab",
    ),
  },
  /* Hyperliquid: documents come from vectors/chains/hyperliquid.json (oracles: nktkas 0.33.3 and
     hyperliquid-python-sdk); the prompts below are literals. */
  {
    name: "Hyperliquid usdSend (EIP-712)",
    request: hlTyped(hlDoc(hl.userSigned, "usdSend Arbitrum One signing chain")),
    verifiability: "full",
    blind: null,
    prompt: p(
      "Confirm transfer",
      "确认转账",
      `Hyperliquid Mainnet\nSend 2.5 USDC to ${HL_DEST} on Hyperliquid`,
      `Hyperliquid 主网\n在 Hyperliquid 上发送 2.5 USDC 到 ${HL_DEST}`,
    ),
  },
  {
    name: "Hyperliquid approveAgent with valid_until (EIP-712)",
    request: hlTyped(hlDoc(hl.userSigned, "approveAgent with valid_until")),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm approval",
      "确认授权",
      `Hyperliquid Testnet\nApprove agent ${HL_AGENT} named "bot-2"\nValid until 2027-01-01 01:03 (UTC)\n${HL_AGENT_POWERS}`,
      `Hyperliquid 测试网\n授权代理 ${HL_AGENT}，名称“bot-2”\n有效期至 2027-01-01 01:03（UTC）\n${HL_AGENT_POWERS_ZH}`,
    ),
  },
  {
    name: "Hyperliquid cDeposit (EIP-712)",
    request: hlTyped(hlDoc(hl.userSigned, "cDeposit")),
    verifiability: "full",
    blind: null,
    prompt: p(
      "Confirm staking",
      "确认质押",
      `Hyperliquid Mainnet\nMove 1.5 HYPE from your spot balance into staking`,
      `Hyperliquid 主网\n将 1.5 HYPE 从现货账户转入质押账户`,
    ),
  },
  {
    name: "Hyperliquid convertToMultiSigUser (EIP-712)",
    request: hlTyped(hlDoc(hl.userSigned, "convertToMultiSigUser (blind)")),
    verifiability: "opaque",
    blind: "typed-data-variant",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `${HL_APP_EN}\nNetwork: Arbitrum Sepolia\n${HL_CONTRACT_EN}\nType: HyperliquidTransaction:ConvertToMultiSigUser\n${typedVariant}\n${typedCaveat}\n· hyperliquidChain = Testnet\n· signers = ["0x1111111111111111111111111111111111111111","0x2222222222222222222222222222222222222222"]\n· nonce = 1700000001600`,
      `${HL_APP_ZH}\n网络：Arbitrum Sepolia\n${HL_CONTRACT_ZH}\n类型：HyperliquidTransaction:ConvertToMultiSigUser\n${typedVariantZh}\n${typedCaveatZh}\n· hyperliquidChain = Testnet\n· signers = ["0x1111111111111111111111111111111111111111","0x2222222222222222222222222222222222222222"]\n· nonce = 1700000001600`,
    ),
  },
  {
    name: "Hyperliquid usdSend with an extra type (EIP-712)",
    request: hlTyped(hlExtraTypes),
    verifiability: "opaque",
    blind: "typed-data-variant",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `${HL_APP_EN}\nNetwork: Arbitrum One\n${HL_CONTRACT_EN}\nType: HyperliquidTransaction:UsdSend\n${typedVariant}\n${typedCaveat}\n· hyperliquidChain = Mainnet\n· destination = 0x5e9ee1089755c3435139848e47e6635505d5a13a\n· amount = 2.5\n· time = 1700000000000`,
      `${HL_APP_ZH}\n网络：Arbitrum One\n${HL_CONTRACT_ZH}\n类型：HyperliquidTransaction:UsdSend\n${typedVariantZh}\n${typedCaveatZh}\n· hyperliquidChain = Mainnet\n· destination = 0x5e9ee1089755c3435139848e47e6635505d5a13a\n· amount = 2.5\n· time = 1700000000000`,
    ),
  },
  {
    name: "Hyperliquid usdSend with exponent amount (EIP-712)",
    request: hlTyped(hlBadAmount),
    verifiability: "opaque",
    blind: "typed-data-variant",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `${HL_APP_EN}\nNetwork: Arbitrum One\n${HL_CONTRACT_EN}\nType: HyperliquidTransaction:UsdSend\n${typedVariant}\n${typedCaveat}\n· hyperliquidChain = Mainnet\n· destination = 0x5e9ee1089755c3435139848e47e6635505d5a13a\n· amount = 1e3\n· time = 1700000000000`,
      `${HL_APP_ZH}\n网络：Arbitrum One\n${HL_CONTRACT_ZH}\n类型：HyperliquidTransaction:UsdSend\n${typedVariantZh}\n${typedCaveatZh}\n· hyperliquidChain = Mainnet\n· destination = 0x5e9ee1089755c3435139848e47e6635505d5a13a\n· amount = 1e3\n· time = 1700000000000`,
    ),
  },
  {
    name: "Hyperliquid L1 phantom agent (EIP-712)",
    request: hlTyped(hlDoc(hl.l1, "order")),
    verifiability: "opaque",
    blind: "typed-data-commitment",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `App: Exchange\nNetwork: EVM chain 1337\n${HL_CONTRACT_EN}\nType: Agent\n${typedCommitment}\n${typedCaveat}\n· source = a\n· connectionId = 0x25367e0dba84351148288c2233cd6130ed6cec5967ded0c0b7334f36f957cc90`,
      `应用：Exchange\n网络：EVM 链 1337\n${HL_CONTRACT_ZH}\n类型：Agent\n${typedCommitmentZh}\n${typedCaveatZh}\n· source = a\n· connectionId = 0x25367e0dba84351148288c2233cd6130ed6cec5967ded0c0b7334f36f957cc90`,
    ),
  },
  /* Polymarket: documents come from vectors/chains/polymarket.json (oracle: clob-client-v2
     1.2.1, on-chain hashOrder); the prompts below are literals. Orders and auth bound to the
     signing account are rewritten to SIGNER — decoding never checks the signature bytes. */
  {
    name: "Polymarket CTF Exchange buy (EIP-712)",
    request: pmTyped(
      (() => {
        const d = pmDoc("CTF Exchange buy (EOA)");
        d.message.signer = SIGNER;
        d.message.maker = SIGNER;
        return d;
      })(),
    ),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm order",
      "确认订单",
      `Polymarket CTF Exchange ${PM_CTF_EXCHANGE}\nNetwork: Polygon\nBuy at least 100 shares of outcome token ${PM_TOKEN_ID}\nPay at most 50 pUSD (price 0.5 pUSD per share)\n${PM_FEE_AT_MATCH}`,
      `Polymarket CTF Exchange ${PM_CTF_EXCHANGE}\n网络：Polygon\n买入至少 100 份结果代币 ${PM_TOKEN_ID}\n最多支付 50 pUSD（价格 0.5 pUSD/份）\n${PM_FEE_AT_MATCH_ZH}`,
    ),
  },
  {
    name: "Polymarket deposit-wallet order (EIP-712)",
    request: pmTyped(pmDoc("deposit-wallet buy (POLY_1271)")),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm order",
      "确认订单",
      `Polymarket CTF Exchange ${PM_CTF_EXCHANGE}\nNetwork: Polygon\nFunds from deposit wallet ${PM_WALLET}; only its owner's signature makes this order valid\nBuy at least 50 shares of outcome token ${PM_TOKEN_ID_2}\nPay at most 25 pUSD (price 0.5 pUSD per share)\n${PM_FEE_AT_MATCH}`,
      `Polymarket CTF Exchange ${PM_CTF_EXCHANGE}\n网络：Polygon\n资金来自存款钱包 ${PM_WALLET}；只有其所有者的签名才能使此订单生效\n买入至少 50 份结果代币 ${PM_TOKEN_ID_2}\n最多支付 25 pUSD（价格 0.5 pUSD/份）\n${PM_FEE_AT_MATCH_ZH}`,
    ),
  },
  {
    name: "Polymarket CLOB auth (EIP-712)",
    request: pmTyped(
      (() => {
        const d = pmDoc("ClobAuth (Amoy)");
        d.message.address = SIGNER;
        return d;
      })(),
    ),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm sign-in",
      "确认登录",
      `Network: Polygon Amoy\nCreate or derive Polymarket API credentials for ${SIGNER}\nTime 1970-04-26 17:46 (UTC)\nCredential nonce 23\nThe credentials authenticate account requests such as cancelling orders; every order still needs your signature`,
      `网络：Polygon Amoy\n为 ${SIGNER} 创建或派生 Polymarket API 凭证\n时间 1970-04-26 17:46（UTC）\n凭证序号 23\n凭证用于验证撤单等账户请求；每笔订单仍需你的签名`,
    ),
  },
  {
    name: "Polymarket deposit-wallet batch approvals (EIP-712)",
    request: pmTyped(pmDoc("batch: pUSD approve + CTF setApprovalForAll")),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm batch",
      "确认批量交易",
      `Network: Polygon\nPolymarket deposit wallet ${PM_WALLET}, batch 7, valid until 2027-01-15 08:00 (UTC)\nAllow ${PM_CTF_EXCHANGE} to spend 25000000 base units of unverified token ${PM_PUSD}\nAllow ${PM_CTF_EXCHANGE} to transfer all tokens of ${PM_CTF}`,
      `网络：Polygon\nPolymarket 存款钱包 ${PM_WALLET} 的第 7 批调用，有效期至 2027-01-15 08:00（UTC）\n授权 ${PM_CTF_EXCHANGE} 使用 25000000 个最小单位（未验证代币 ${PM_PUSD}）\n授权 ${PM_CTF_EXCHANGE} 转走 ${PM_CTF} 的全部代币`,
    ),
  },
  {
    name: "Polymarket order signed for another account (EIP-712)",
    request: pmTyped(pmDoc("CTF Exchange buy (EOA)")),
    verifiability: "opaque",
    blind: "typed-data-variant",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `App: Polymarket CTF Exchange\nNetwork: Polygon\nVerifying contract ${PM_CTF_EXCHANGE}\nType: Order\n${typedVariant}\n${typedCaveat}\n${PM_ORDER_LEAVES_1}`,
      `应用：Polymarket CTF Exchange\n网络：Polygon\n验证合约 ${PM_CTF_EXCHANGE}\n类型：Order\n${typedVariantZh}\n${typedCaveatZh}\n${PM_ORDER_LEAVES_1_ZH}`,
    ),
  },
  {
    name: "Polymarket order on an unknown exchange (EIP-712)",
    request: pmTyped(
      (() => {
        const d = pmDoc("CTF Exchange buy (EOA)");
        d.domain.verifyingContract = PM_UNKNOWN;
        return d;
      })(),
    ),
    verifiability: "opaque",
    blind: "typed-data-variant",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `App: Polymarket CTF Exchange\nNetwork: Polygon\nVerifying contract ${PM_UNKNOWN_CHECKSUM}\nType: Order\n${typedVariant}\n${typedCaveat}\n${PM_ORDER_LEAVES_1}`,
      `应用：Polymarket CTF Exchange\n网络：Polygon\n验证合约 ${PM_UNKNOWN_CHECKSUM}\n类型：Order\n${typedVariantZh}\n${typedCaveatZh}\n${PM_ORDER_LEAVES_1_ZH}`,
    ),
  },
  {
    name: "Polymarket Exchange V3 address at version 2 (EIP-712)",
    request: pmTyped(
      (() => {
        const d = pmDoc("Exchange V3 buy (EOA)");
        d.domain.version = "2";
        return d;
      })(),
    ),
    verifiability: "opaque",
    blind: "typed-data-variant",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `App: Polymarket CTF Exchange\nNetwork: Polygon\nVerifying contract ${PM_V3}\nType: Order\n${typedVariant}\n${typedCaveat}\n${PM_ORDER_LEAVES_2}`,
      `应用：Polymarket CTF Exchange\n网络：Polygon\n验证合约 ${PM_V3}\n类型：Order\n${typedVariantZh}\n${typedCaveatZh}\n${PM_ORDER_LEAVES_2_ZH}`,
    ),
  },
  {
    name: "Polymarket CLOB auth with a different message (EIP-712)",
    request: pmTyped(
      (() => {
        const d = pmDoc("ClobAuth (Amoy)");
        d.message.address = SIGNER;
        d.message.message = "Sign in to Polymarket";
        return d;
      })(),
    ),
    verifiability: "opaque",
    blind: "typed-data-variant",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `App: ClobAuthDomain\nNetwork: Polygon Amoy\nType: ClobAuth\n${typedVariant}\n${typedCaveat}\n· address = ${SIGNER}\n· timestamp = 10000000\n· nonce = 23\n· message = Sign in to Polymarket`,
      `应用：ClobAuthDomain\n网络：Polygon Amoy\n类型：ClobAuth\n${typedVariantZh}\n${typedCaveatZh}\n· address = ${SIGNER}\n· timestamp = 10000000\n· nonce = 23\n· message = Sign in to Polymarket`,
    ),
  },
  {
    name: "Polymarket batch calling the wallet itself (EIP-712)",
    request: pmTyped(pmDoc("batch: call to the wallet itself")),
    verifiability: "opaque",
    blind: "account-code",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `Network: Polygon\nPolymarket deposit wallet ${PM_WALLET}, batch 7, valid until 2027-01-15 08:00 (UTC)\n${caveat}\nRuns this account's own code with full authority\nCall contract ${PM_WALLET}, function 0x095ea7b3`,
      `网络：Polygon\nPolymarket 存款钱包 ${PM_WALLET} 的第 7 批调用，有效期至 2027-01-15 08:00（UTC）\n${caveatZh}\n以本账户的全部权限执行其自身代码\n调用合约 ${PM_WALLET}，函数 0x095ea7b3`,
    ),
  },
  {
    name: "1inch LOP v4 Order at Aggregation Router v6 (EIP-712)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Order: [
          { name: "salt", type: "uint256" },
          { name: "maker", type: "address" },
          { name: "receiver", type: "address" },
          { name: "makerAsset", type: "address" },
          { name: "takerAsset", type: "address" },
          { name: "makingAmount", type: "uint256" },
          { name: "takingAmount", type: "uint256" },
          { name: "makerTraits", type: "uint256" },
        ],
      },
      primaryType: "Order",
      domain: {
        name: "1inch Aggregation Router",
        version: "6",
        chainId: 1,
        verifyingContract: "0x111111125421cA6dc452d289314280a0f8842A65",
      },
      message: {
        salt: "0",
        maker: SIGNER,
        receiver: TO,
        makerAsset: USDC,
        takerAsset: WETH,
        makingAmount: "1000000",
        takingAmount: "500000000000000000",
        makerTraits: "0",
      },
    }),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm swap",
      "确认兑换",
      `App: 1inch Aggregation Router\n${net}\nVerifying contract 0x111111125421cA6dc452d289314280a0f8842A65\nType: Order\n1inch order by ${SIGNER}\nGive at most 1 USDC\n${TO} receives at least 0.5 WETH\nNo expiry\nCan be filled in parts at the same rate`,
      `应用：1inch Aggregation Router\n${netZh}\n验证合约 0x111111125421cA6dc452d289314280a0f8842A65\n类型：Order\n1inch 订单，挂单方 ${SIGNER}\n最多付出 1 USDC\n${TO} 至少收到 0.5 WETH\n无到期时间\n可按同一价格分批成交`,
    ),
  },
  {
    name: "UniswapX V3DutchOrder Permit2 witness (EIP-712)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "V3DutchOrder" },
        ],
        OrderInfo: [
          { name: "reactor", type: "address" },
          { name: "swapper", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "additionalValidationContract", type: "address" },
          { name: "additionalValidationData", type: "bytes" },
        ],
        V3DutchOrder: [
          { name: "info", type: "OrderInfo" },
          { name: "cosigner", type: "address" },
          { name: "startingBaseFee", type: "uint256" },
          { name: "baseInput", type: "V3DutchInput" },
          { name: "baseOutputs", type: "V3DutchOutput[]" },
        ],
        V3DutchInput: [
          { name: "token", type: "address" },
          { name: "startAmount", type: "uint256" },
          { name: "curve", type: "NonlinearDutchDecay" },
          { name: "maxAmount", type: "uint256" },
          { name: "adjustmentPerGweiBaseFee", type: "uint256" },
        ],
        V3DutchOutput: [
          { name: "token", type: "address" },
          { name: "startAmount", type: "uint256" },
          { name: "curve", type: "NonlinearDutchDecay" },
          { name: "recipient", type: "address" },
          { name: "minAmount", type: "uint256" },
          { name: "adjustmentPerGweiBaseFee", type: "uint256" },
        ],
        NonlinearDutchDecay: [
          { name: "relativeBlocks", type: "uint256" },
          { name: "relativeAmounts", type: "int256[]" },
        ],
      },
      primaryType: "PermitWitnessTransferFrom",
      domain: {
        name: "Permit2",
        chainId: 1,
        verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      },
      message: {
        permitted: { token: WETH, amount: "100" },
        spender: "0x0000000015757c461808EA25Eb309638B62681cf",
        nonce: "0",
        deadline: "2000000000",
        witness: {
          info: {
            reactor: "0x0000000015757c461808EA25Eb309638B62681cf",
            swapper: SIGNER,
            nonce: "0",
            deadline: "2000000000",
            additionalValidationContract: "0x0000000000000000000000000000000000000000",
            additionalValidationData: "0x",
          },
          cosigner: OTHER,
          startingBaseFee: "0",
          baseInput: {
            token: WETH,
            startAmount: "1",
            curve: { relativeBlocks: "10", relativeAmounts: ["0"] },
            maxAmount: "9",
            adjustmentPerGweiBaseFee: "0",
          },
          baseOutputs: [
            {
              token: USDC,
              startAmount: "2000000",
              curve: { relativeBlocks: "10", relativeAmounts: ["0"] },
              recipient: SIGNER,
              minAmount: "1000000",
              adjustmentPerGweiBaseFee: "0",
            },
          ],
        },
      },
    }),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm swap",
      "确认兑换",
      `App: Permit2\n${net}\nVerifying contract 0x000000000022D473030F116dDEE9F6B43aC78BA3\nType: PermitWitnessTransferFrom\nAllow 0x0000000015757c461808EA25Eb309638B62681cf to take 0.0000000000000001 WETH once via Permit2 until 2033-05-18 (UTC)\nUniswapX order by ${SIGNER}\nGive at most 0.000000000000000009 WETH\n${SIGNER} receives at least 1 USDC\nValid until 2033-05-18 03:33 (UTC)`,
      `应用：Permit2\n${netZh}\n验证合约 0x000000000022D473030F116dDEE9F6B43aC78BA3\n类型：PermitWitnessTransferFrom\n授权 0x0000000015757c461808EA25Eb309638B62681cf 一次性转走 0.0000000000000001 WETH 经 Permit2 至 2033-05-18（UTC）\nUniswapX 订单，挂单方 ${SIGNER}\n最多付出 0.000000000000000009 WETH\n${SIGNER} 至少收到 1 USDC\n有效期至 2033-05-18 03:33（UTC）`,
    ),
  },
  {
    /* The published 0x gasless-v2 API response document (0xProject/0x-examples@3b296df0
       gasless-v2-headless-example/README.md, trade.eip712) — a real Base USDC→WETH MetaTxn
       order through the feature-3 Settler. */
    name: "0x gasless Settler MetaTxn Permit2 witness (EIP-712)",
    request: {
      ...typedData({
        types: {
          PermitWitnessTransferFrom: [
            { name: "permitted", type: "TokenPermissions" },
            { name: "spender", type: "address" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "slippageAndActions", type: "SlippageAndActions" },
          ],
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          TokenPermissions: [
            { name: "token", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          SlippageAndActions: [
            { name: "recipient", type: "address" },
            { name: "buyToken", type: "address" },
            { name: "minAmountOut", type: "uint256" },
            { name: "actions", type: "bytes[]" },
          ],
        },
        domain: {
          name: "Permit2",
          chainId: 8453,
          verifyingContract: "0x000000000022d473030f116ddee9f6b43ac78ba3",
        },
        message: {
          permitted: { token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", amount: "100000" },
          spender: "0x5ce929ddb01804bff35b2f5c77b735bdb094aac8",
          nonce: "2241959297937691820908574931991581",
          deadline: "1721085355",
          slippageAndActions: {
            recipient: "0x4d2a422db44144996e855ce15fb581a477dbb947",
            buyToken: "0x4200000000000000000000000000000000000006",
            minAmountOut: "25345560227526",
            actions: ["0x0dfeb41900", "0x38c9c14700"],
          },
        },
        primaryType: "PermitWitnessTransferFrom",
      }),
      network: "eip155:8453",
    },
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm swap",
      "确认兑换",
      `App: Permit2\n${netBase}\nVerifying contract 0x000000000022D473030F116dDEE9F6B43aC78BA3\nType: PermitWitnessTransferFrom\nAllow 0x5CE929DDB01804bfF35B2F5c77b735bdB094AAc8 to take 0.1 USDC once via Permit2 until 2024-07-15 (UTC)\n0x order by ${SIGNER}\nGive at most 0.1 USDC\n0x4D2A422dB44144996E855ce15FB581a477dbB947 receives at least 0.000025345560227526 WETH\nValid until 2024-07-15 23:15 (UTC)`,
      `应用：Permit2\n${netBaseZh}\n验证合约 0x000000000022D473030F116dDEE9F6B43aC78BA3\n类型：PermitWitnessTransferFrom\n授权 0x5CE929DDB01804bfF35B2F5c77b735bdB094AAc8 一次性转走 0.1 USDC 经 Permit2 至 2024-07-15（UTC）\n0x 订单，挂单方 ${SIGNER}\n最多付出 0.1 USDC\n0x4D2A422dB44144996E855ce15FB581a477dbB947 至少收到 0.000025345560227526 WETH\n有效期至 2024-07-15 23:15（UTC）`,
    ),
  },
  {
    name: "Snapshot Vote (EIP-712)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
        ],
        Vote: [
          { name: "from", type: "string" },
          { name: "space", type: "string" },
          { name: "timestamp", type: "uint64" },
          { name: "proposal", type: "string" },
          { name: "choice", type: "uint32" },
          { name: "reason", type: "string" },
          { name: "app", type: "string" },
          { name: "metadata", type: "string" },
        ],
      },
      primaryType: "Vote",
      domain: { name: "snapshot", version: "0.1.4" },
      message: {
        from: SIGNER,
        space: "example.eth",
        timestamp: "1700000000",
        proposal: hash32,
        choice: "1",
        reason: "",
        app: "snapshot",
        metadata: "{}",
      },
    }),
    verifiability: "opaque",
    blind: null,
    prompt: p(
      "Confirm signature",
      "确认签名",
      `App: snapshot\n${net}\nType: Vote\n${typedCaveat}\n· from = ${SIGNER}\n· space = example.eth\n· timestamp = 1700000000\n· proposal = ${hash32}\n· choice = 1\n· reason = \n· app = snapshot\n· metadata = {}`,
      `应用：snapshot\n${netZh}\n类型：Vote\n${typedCaveatZh}\n· from = ${SIGNER}\n· space = example.eth\n· timestamp = 1700000000\n· proposal = ${hash32}\n· choice = 1\n· reason = \n· app = snapshot\n· metadata = {}`,
    ),
  },
  {
    name: "0x Exchange Proxy order shape (claim near miss)",
    request: typedData({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Order: [{ name: "anything", type: "uint256" }],
      },
      primaryType: "Order",
      domain: {
        name: "ZeroEx",
        version: "1.0.0",
        chainId: 1,
        verifyingContract: "0xDef1C0ded9bec7F1a1670819833240f027b25EfF",
      },
      message: { anything: "1" },
    }),
    verifiability: "opaque",
    blind: "typed-data-variant",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `App: ZeroEx\n${net}\nVerifying contract 0xDef1C0ded9bec7F1a1670819833240f027b25EfF\nType: Order\n${typedVariant}\n${typedCaveat}\n· anything = 1`,
      `应用：ZeroEx\n${netZh}\n验证合约 0xDef1C0ded9bec7F1a1670819833240f027b25EfF\n类型：Order\n${typedVariantZh}\n${typedCaveatZh}\n· anything = 1`,
    ),
  },
  {
    name: "solana SPL Token Transfer (unchecked)",
    request: solanaTx(
      solMessage([
        solIx(
          SOL_TOKEN,
          [solW(SOL_SRC), solW(SOL_DEST), solSgn(SOL_SIGNER)],
          solCat(new Uint8Array([3]), solU64(5n)),
        ),
      ]),
    ),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm transfer",
      "确认转账",
      `Network: Solana\nThere may be other outflows\nSend 5 base units of the token in account ${SOL_SRC} to ${SOL_DEST}\nMax fee 0.000005 SOL`,
      `网络：Solana\n可能还有其他转出\n从代币账户 ${SOL_SRC} 发送 5 个最小单位到 ${SOL_DEST}\n最高手续费 0.000005 SOL`,
    ),
  },
  {
    name: "solana SPL Token Burn",
    request: solanaTx(
      solMessage([
        solIx(
          SOL_TOKEN,
          [solW(SOL_SRC), solRo(SOL_MINT), solSgn(SOL_SIGNER)],
          solCat(new Uint8Array([8]), solU64(5n)),
        ),
      ]),
    ),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm transfer",
      "确认转账",
      `Network: Solana\nThere may be other outflows\nBurn 5 base units of unverified token ${SOL_MINT} from token account ${SOL_SRC}; it is destroyed\nMax fee 0.000005 SOL`,
      `网络：Solana\n可能还有其他转出\n从代币账户 ${SOL_SRC} 销毁 5 个最小单位（未验证代币 ${SOL_MINT}），永久消失\n最高手续费 0.000005 SOL`,
    ),
  },
  {
    name: "solana SPL Token Revoke",
    request: solanaTx(
      solMessage([
        getRevokeInstruction({
          source: address(SOL_SRC),
          owner: createNoopSigner(address(SOL_SIGNER)),
        }),
      ]),
    ),
    verifiability: "full",
    blind: null,
    prompt: p(
      "Confirm contract call",
      "确认合约调用",
      `Network: Solana\nRevoke the delegate of token account ${SOL_SRC}\nMax fee 0.000005 SOL`,
      `网络：Solana\n撤销代币账户 ${SOL_SRC} 的代理授权\n最高手续费 0.000005 SOL`,
    ),
  },
  {
    name: "solana Token + Token-2022 Revokes",
    request: solanaTx(
      solMessage([
        getRevokeInstruction({
          source: address(SOL_SRC),
          owner: createNoopSigner(address(SOL_SIGNER)),
        }),
        getRevokeInstruction2022({
          source: address(SOL_DEST),
          owner: createNoopSigner(address(SOL_SIGNER)),
        }),
      ]),
    ),
    verifiability: "full",
    blind: null,
    prompt: p(
      "Confirm contract call",
      "确认合约调用",
      `Network: Solana\nRevoke the delegate of token account ${SOL_SRC}\nRevoke the delegate of token account ${SOL_DEST}\nMax fee 0.000005 SOL`,
      `网络：Solana\n撤销代币账户 ${SOL_SRC} 的代理授权\n撤销代币账户 ${SOL_DEST} 的代理授权\n最高手续费 0.000005 SOL`,
    ),
  },
  {
    name: "solana Stake Split",
    request: solanaTx(
      solMessage([
        solIx(
          SOL_STAKE_PROG,
          [solW(SOL_STAKE_ACCT), solW(SOL_DEST), solSgn(SOL_SIGNER)],
          solCat(solU32(3), solU64(7n)),
        ),
      ]),
    ),
    verifiability: "full",
    blind: null,
    prompt: p(
      "Confirm staking",
      "确认质押",
      `Network: Solana\nSplit 0.000000007 SOL from stake account ${SOL_STAKE_ACCT} into ${SOL_DEST}\nMax fee 0.000005 SOL`,
      `网络：Solana\n从质押账户 ${SOL_STAKE_ACCT} 拆分 0.000000007 SOL 到 ${SOL_DEST}\n最高手续费 0.000005 SOL`,
    ),
  },
  {
    name: "solana unknown program taking the signer",
    request: solanaTx(
      solMessage([
        solIx(
          SOL_DRAINER,
          [solSgn(SOL_SIGNER), solW(SOL_SRC), solW(SOL_DEST), solRo(SOL_TOKEN)],
          solCat(new Uint8Array([0]), solU64(5n)),
        ),
      ]),
    ),
    verifiability: "opaque",
    blind: null,
    prompt: p(
      "Confirm contract call",
      "确认合约调用",
      `Network: Solana\nProgram ${SOL_DRAINER} receives this account's signature: it can move ALL SOL in this account\nProgram ${SOL_DRAINER} can act with this account's authority on: ${SOL_SRC} (may be yours); ${SOL_DEST} (may be yours)\nProgram calls the wallet cannot decode: ${SOL_DRAINER}\nThese programs can move assets from the accounts in this transaction\nMax fee 0.000005 SOL`,
      `网络：Solana\n程序 ${SOL_DRAINER} 获得本账户的签名：可以转走本账户的全部 SOL\n程序 ${SOL_DRAINER} 可以以本账户的权限操作：${SOL_SRC}（可能属于你）；${SOL_DEST}（可能属于你）\n钱包无法解码的程序调用：${SOL_DRAINER}\n这些程序可以转移本交易涉及账户中的资产\n最高手续费 0.000005 SOL`,
    ),
  },
  {
    name: "solana program-authority blind (13 writable accounts)",
    request: solanaTx(
      solMessage([
        solIx(
          SOL_DRAINER,
          [
            solSgn(SOL_SIGNER),
            /* One over PROGRAM_AUTHORITY_ACCOUNTS — the wallet cannot list what it can reach. */
            ...Array.from({ length: 13 }, (_, i) =>
              solW(solanaAddressFromPublicKey(new Uint8Array(32).fill(i + 1))),
            ),
          ],
          solCat(new Uint8Array([0]), solU64(5n)),
        ),
      ]),
    ),
    verifiability: "opaque",
    blind: "program-authority",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `Network: Solana\nProgram ${SOL_DRAINER} receives this account's signature and can reach accounts the wallet cannot list\nProgram calls the wallet cannot decode: ${SOL_DRAINER}\nThese programs can move assets from the accounts in this transaction\nMax fee 0.000005 SOL`,
      `网络：Solana\n程序 ${SOL_DRAINER} 获得本账户的签名，并可操作钱包无法列出的账户\n钱包无法解码的程序调用：${SOL_DRAINER}\n这些程序可以转移本交易涉及账户中的资产\n最高手续费 0.000005 SOL`,
    ),
  },
  {
    name: "solana message 32-byte text",
    request: solanaMessage(TEXT32_HEX.slice(2)),
    verifiability: "opaque",
    blind: "message-bytes",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `This 32-byte message could be a hash: signing it may authorise whatever the hash commits to\nData ${TEXT32_HEX}\nMessage:\n· ${TEXT32}`,
      `这条 32 字节的消息可能是哈希：签署它可能授权该哈希所承诺的任何内容\n数据 ${TEXT32_HEX}\n消息：\n· ${TEXT32}`,
    ),
  },
  {
    name: "solana message kernel-line forgery",
    request: solanaMessage(
      [...utf8("Confirm this order\nNetwork: Ethereum\nMax fee 0.5 ETH")]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    ),
    verifiability: "opaque",
    blind: null,
    prompt: p(
      "Confirm signature",
      "确认签名",
      "Message:\n· Confirm this order\n· Network: Ethereum\n· Max fee 0.5 ETH",
      "消息：\n· Confirm this order\n· Network: Ethereum\n· Max fee 0.5 ETH",
    ),
  },
  {
    name: "solana message 32 bytes",
    request: solanaMessage("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"),
    verifiability: "opaque",
    blind: "message-bytes",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      "This 32-byte message could be a hash: signing it may authorise whatever the hash commits to\nData 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
      "这条 32 字节的消息可能是哈希：签署它可能授权该哈希所承诺的任何内容\n数据 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    ),
  },
  {
    name: "CCTP depositForBurnWithHook 5 USDC to Hyperliquid",
    request: arbTx({
      to: CCTP_MESSENGER,
      data: encodeFunctionData({
        abi: parseAbi([
          "function depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)",
        ]),
        functionName: "depositForBurnWithHook",
        args: [
          5_000_000n,
          19,
          `0x${CCTP_FORWARDER.slice(2).padStart(64, "0")}`,
          ARB_USDC,
          `0x${CCTP_FORWARDER.slice(2).padStart(64, "0")}`,
          200_000n,
          1000,
          `0x636374702d666f7277617264${"00".repeat(12)}0000000000000018${SIGNER.slice(2)}00000000`,
        ],
      }),
    }),
    verifiability: "partial",
    blind: null,
    prompt: p(
      "Confirm transfer",
      "确认转账",
      `${netArb}\nThere may be other outflows\nSend 5 USDC to ${CCTP_MESSENGER}\nDeposit 5 USDC to your Hyperliquid perps account ${SIGNER}\nCircle fee at most 0.2 USDC\n${fee}`,
      `${netArbZh}\n可能还有其他转出\n发送 5 USDC 到 ${CCTP_MESSENGER}\n向你的 Hyperliquid 合约账户 ${SIGNER} 存入 5 USDC\nCircle 手续费至多 0.2 USDC\n${feeZh}`,
    ),
  },
  {
    name: "CCTP depositForBurn wrong domain (blind)",
    request: arbTx({
      to: CCTP_MESSENGER,
      data: encodeFunctionData({
        abi: parseAbi([
          "function depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)",
        ]),
        functionName: "depositForBurnWithHook",
        args: [
          5_000_000n,
          3,
          `0x${CCTP_FORWARDER.slice(2).padStart(64, "0")}`,
          ARB_USDC,
          `0x${CCTP_FORWARDER.slice(2).padStart(64, "0")}`,
          200_000n,
          1000,
          `0x636374702d666f7277617264${"00".repeat(12)}0000000000000018${SIGNER.slice(2)}00000000`,
        ],
      }),
    }),
    verifiability: "opaque",
    blind: "cctp-destination",
    prompt: p(
      "Confirm blind signing",
      "确认盲签",
      `${netArb}\nCall contract ${CCTP_MESSENGER}, function 0x779b432d\n${fee}`,
      `${netArbZh}\n调用合约 ${CCTP_MESSENGER}，函数 0x779b432d\n${feeZh}`,
    ),
  },
];

const TRON_TX_EXPECTED: Readonly<
  Record<
    string,
    { readonly verifiability: string; readonly blind: unknown; readonly prompt: unknown }
  >
> = {
  "trx-transfer": {
    verifiability: "full",
    blind: null,
    prompt: {
      en: {
        title: "Confirm transfer",
        description:
          "Network: TRON\nSend 1 TRX to TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
      },
      "zh-Hans": {
        title: "确认转账",
        description:
          "网络：TRON\n发送 1 TRX 到 TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
  "trx-transfer-memo": {
    verifiability: "full",
    blind: null,
    prompt: {
      en: {
        title: "Confirm transfer",
        description:
          "Network: TRON\nSend 2 TRX to THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3\nMemo:\n· tron fixed-vector memo\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
      },
      "zh-Hans": {
        title: "确认转账",
        description:
          "网络：TRON\n发送 2 TRX 到 THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3\n备注：\n· tron fixed-vector memo\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
  "trx-transfer-permission-2": {
    verifiability: "full",
    blind: null,
    prompt: {
      en: {
        title: "Confirm transfer",
        description:
          "Network: TRON\nSend 3 TRX to TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC\nSigns under permission 2 of this account\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
      },
      "zh-Hans": {
        title: "确认转账",
        description:
          "网络：TRON\n发送 3 TRX 到 TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC\n以本账户的权限 2 签署\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
  "trc20-transfer": {
    verifiability: "full",
    blind: null,
    prompt: {
      en: {
        title: "Confirm transfer",
        description:
          "Network: TRON\nSend 10 USDT to TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC\nExpires 2026-01-01 00:01 (UTC)\nMax fee 30 TRX for energy; bandwidth fees may be charged in addition",
      },
      "zh-Hans": {
        title: "确认转账",
        description:
          "网络：TRON\n发送 10 USDT 到 TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC\n2026-01-01 00:01（UTC）后失效\n能量费上限 30 TRX；另可能扣除带宽费",
      },
    },
  },
  "trc20-transfer-self": {
    verifiability: "full",
    blind: null,
    prompt: {
      en: {
        title: "Confirm transfer",
        description:
          "Network: TRON\nSend 0.000001 USDT to TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG\nExpires 2026-01-01 00:01 (UTC)\nMax fee 30 TRX for energy; bandwidth fees may be charged in addition",
      },
      "zh-Hans": {
        title: "确认转账",
        description:
          "网络：TRON\n发送 0.000001 USDT 到 TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG\n2026-01-01 00:01（UTC）后失效\n能量费上限 30 TRX；另可能扣除带宽费",
      },
    },
  },
  "trc20-approve": {
    verifiability: "partial",
    blind: null,
    prompt: {
      en: {
        title: "Confirm approval",
        description:
          "Network: TRON\nThere may be other outflows\nAllow THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3 to spend 5 USDT\nExpires 2026-01-01 00:01 (UTC)\nMax fee 30 TRX for energy; bandwidth fees may be charged in addition",
      },
      "zh-Hans": {
        title: "确认授权",
        description:
          "网络：TRON\n可能还有其他转出\n授权 THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3 使用 5 USDT\n2026-01-01 00:01（UTC）后失效\n能量费上限 30 TRX；另可能扣除带宽费",
      },
    },
  },
  "trc20-approve-unlimited": {
    verifiability: "partial",
    blind: null,
    prompt: {
      en: {
        title: "Confirm approval",
        description:
          "Network: TRON\nThere may be other outflows\nAllow THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3 to spend unlimited USDT\nExpires 2026-01-01 00:01 (UTC)\nMax fee 30 TRX for energy; bandwidth fees may be charged in addition",
      },
      "zh-Hans": {
        title: "确认授权",
        description:
          "网络：TRON\n可能还有其他转出\n授权 THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3 使用 全部 USDT\n2026-01-01 00:01（UTC）后失效\n能量费上限 30 TRX；另可能扣除带宽费",
      },
    },
  },
  "trc721-approve-clear": {
    verifiability: "partial",
    blind: null,
    prompt: {
      en: {
        title: "Confirm approval",
        description:
          "Network: TRON\nThere may be other outflows\nClear the approval on TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6 #42\nExpires 2026-01-01 00:01 (UTC)\nMax fee 30 TRX for energy; bandwidth fees may be charged in addition",
      },
      "zh-Hans": {
        title: "确认授权",
        description:
          "网络：TRON\n可能还有其他转出\n清除 TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6 #42 的单个授权\n2026-01-01 00:01（UTC）后失效\n能量费上限 30 TRX；另可能扣除带宽费",
      },
    },
  },
  "trc10-transfer": {
    verifiability: "partial",
    blind: null,
    prompt: {
      en: {
        title: "Confirm transfer",
        description:
          "Network: TRON\nThere may be other outflows\nSend 500 base units of unverified token trc10:1002000 to TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
      },
      "zh-Hans": {
        title: "确认转账",
        description:
          "网络：TRON\n可能还有其他转出\n发送 500 个最小单位（未验证代币 trc10:1002000） 到 TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
  "freeze-v2-energy": {
    verifiability: "full",
    blind: null,
    prompt: {
      en: {
        title: "Confirm staking",
        description:
          "Network: TRON\nStake 2 TRX for Energy\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
      },
      "zh-Hans": {
        title: "确认质押",
        description:
          "网络：TRON\n质押 2 TRX 获取能量\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
  "freeze-v2-bandwidth": {
    verifiability: "full",
    blind: null,
    prompt: {
      en: {
        title: "Confirm staking",
        description:
          "Network: TRON\nStake 3 TRX for Bandwidth\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
      },
      "zh-Hans": {
        title: "确认质押",
        description:
          "网络：TRON\n质押 3 TRX 获取带宽\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
  "unfreeze-v2-energy": {
    verifiability: "full",
    blind: null,
    prompt: {
      en: {
        title: "Confirm staking",
        description:
          "Network: TRON\nUnstake 1 TRX of Energy; it can be withdrawn after the network's waiting period\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
      },
      "zh-Hans": {
        title: "确认质押",
        description:
          "网络：TRON\n解除质押能量的 1 TRX，等待期结束后可提取\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
  "delegate-energy": {
    verifiability: "full",
    blind: null,
    prompt: {
      en: {
        title: "Confirm staking",
        description:
          "Network: TRON\nDelegate the Energy of 4 TRX staked to TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
      },
      "zh-Hans": {
        title: "确认质押",
        description:
          "网络：TRON\n将 4 TRX 质押产生的能量代理给 TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
  "delegate-bandwidth-locked": {
    verifiability: "full",
    blind: null,
    prompt: {
      en: {
        title: "Confirm staking",
        description:
          "Network: TRON\nDelegate the Bandwidth of 5 TRX staked to THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3, locked for 28800 blocks (about 24 h)\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
      },
      "zh-Hans": {
        title: "确认质押",
        description:
          "网络：TRON\n将 5 TRX 质押产生的带宽代理给 THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3，锁定 28800 个区块（约 24 小时）\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
  "undelegate-energy": {
    verifiability: "full",
    blind: null,
    prompt: {
      en: {
        title: "Confirm staking",
        description:
          "Network: TRON\nReclaim the Energy of 2 TRX staked from TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
      },
      "zh-Hans": {
        title: "确认质押",
        description:
          "网络：TRON\n收回代理给 TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC 的 2 TRX 质押所产生的能量\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
  "withdraw-expire-unfreeze": {
    verifiability: "full",
    blind: null,
    prompt: {
      en: {
        title: "Confirm staking",
        description:
          "Network: TRON\nWithdraw all unstaked TRX whose waiting period has ended\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
      },
      "zh-Hans": {
        title: "确认质押",
        description:
          "网络：TRON\n提取所有等待期已结束的解除质押 TRX\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
  "cancel-all-unfreeze-v2": {
    verifiability: "full",
    blind: null,
    prompt: {
      en: {
        title: "Confirm staking",
        description:
          "Network: TRON\nCancel all pending unstakes, re-staking them, and withdraw those already expired\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
      },
      "zh-Hans": {
        title: "确认质押",
        description:
          "网络：TRON\n取消所有未完成的解除质押（重新质押），并提取已到期的部分\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
  "vote-witness": {
    verifiability: "full",
    blind: null,
    prompt: {
      en: {
        title: "Confirm staking",
        description:
          "Network: TRON\nReplace all current votes of this account with:\n3 votes for super representative TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC\n7 votes for super representative THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
      },
      "zh-Hans": {
        title: "确认质押",
        description:
          "网络：TRON\n以下列投票替换本账户当前的全部投票：\n为超级代表 TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC 投 3 票\n为超级代表 THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3 投 7 票\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
  "withdraw-balance": {
    verifiability: "full",
    blind: null,
    prompt: {
      en: {
        title: "Confirm staking",
        description:
          "Network: TRON\nClaim voting rewards to this account\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
      },
      "zh-Hans": {
        title: "确认质押",
        description:
          "网络：TRON\n领取投票奖励到本账户\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
  "account-permission-update": {
    verifiability: "partial",
    blind: "tron-permission-update",
    prompt: {
      en: {
        title: "Confirm blind signing",
        description:
          'Account takeover: this gives control of this account to TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6, TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG, TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC. Whoever holds these keys can move all of its assets.\nNetwork: TRON\nOwner permission "owner": threshold 1; keys TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6 (weight 1)\nActive permission "active0": threshold 2; keys TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG (weight 1), TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC (weight 1); allows TransferContract, TriggerSmartContract\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged',
      },
      "zh-Hans": {
        title: "确认盲签",
        description:
          "账户接管：此交易把本账户的控制权交给 TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6、TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG、TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC，持有这些密钥的人可以转走全部资产。\n网络：TRON\n所有者权限「owner」：阈值 1；密钥 TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6（权重 1）\n活跃权限「active0」：阈值 2；密钥 TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG（权重 1）、TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC（权重 1）；允许 TransferContract、TriggerSmartContract\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
  "trigger-call-value": {
    verifiability: "opaque",
    blind: null,
    prompt: {
      en: {
        title: "Confirm contract call",
        description:
          "Network: TRON\nThe wallet cannot verify what this call does\nCall contract TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6, function 0x2fbebd38\nSend 1 TRX to TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6\nExpires 2026-01-01 00:01 (UTC)\nMax fee 10 TRX for energy; bandwidth fees may be charged in addition",
      },
      "zh-Hans": {
        title: "确认合约调用",
        description:
          "网络：TRON\n钱包无法核实此调用会做什么\n调用合约 TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6，函数 0x2fbebd38\n发送 1 TRX 到 TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6\n2026-01-01 00:01（UTC）后失效\n能量费上限 10 TRX；另可能扣除带宽费",
      },
    },
  },
  "trigger-token-unknown-selector": {
    verifiability: "opaque",
    blind: "token-function",
    prompt: {
      en: {
        title: "Confirm blind signing",
        description:
          "Network: TRON\nAn unrecognised function of token USDT TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t can move this token\nCall contract TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t, function 0xcc872b66\nExpires 2026-01-01 00:01 (UTC)\nMax fee 10 TRX for energy; bandwidth fees may be charged in addition",
      },
      "zh-Hans": {
        title: "确认盲签",
        description:
          "网络：TRON\n代币 USDT TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t 的未知函数，可能转走该代币\n调用合约 TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t，函数 0xcc872b66\n2026-01-01 00:01（UTC）后失效\n能量费上限 10 TRX；另可能扣除带宽费",
      },
    },
  },
  "unsupported-account-update": {
    verifiability: "opaque",
    blind: "tron-contract",
    prompt: {
      en: {
        title: "Confirm blind signing",
        description:
          "Network: TRON\nThe wallet does not support the TRON contract AccountUpdateContract and cannot show what it does\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
      },
      "zh-Hans": {
        title: "确认盲签",
        description:
          "网络：TRON\n钱包不支持 TRON 合约类型 AccountUpdateContract，无法显示它的作用\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
      },
    },
  },
};

const TRON_MSG_CASES = {
  "tron message text": {
    verifiability: "opaque",
    blind: null,
    messageHex: "7369676e207468697320666f72206d65",
    prompt: {
      en: {
        title: "Confirm signature",
        description: "Message:\n· sign this for me",
      },
      "zh-Hans": {
        title: "确认签名",
        description: "消息：\n· sign this for me",
      },
    },
  },
  "tron message 32 bytes": {
    verifiability: "opaque",
    blind: "message-bytes",
    messageHex: "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    prompt: {
      en: {
        title: "Confirm blind signing",
        description:
          "This 32-byte message could be a hash: signing it may authorise whatever the hash commits to\nData 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
      },
      "zh-Hans": {
        title: "确认盲签",
        description:
          "这条 32 字节的消息可能是哈希：签署它可能授权该哈希所承诺的任何内容\n数据 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
      },
    },
  },
  "tron message 32-byte text": {
    verifiability: "opaque",
    blind: "message-bytes",
    messageHex: "5369676e2074686973206861726d6c65737320746578742c20706c6561736521",
    prompt: {
      en: {
        title: "Confirm blind signing",
        description:
          "This 32-byte message could be a hash: signing it may authorise whatever the hash commits to\nData 0x5369676e2074686973206861726d6c65737320746578742c20706c6561736521\nMessage:\n· Sign this harmless text, please!",
      },
      "zh-Hans": {
        title: "确认盲签",
        description:
          "这条 32 字节的消息可能是哈希：签署它可能授权该哈希所承诺的任何内容\n数据 0x5369676e2074686973206861726d6c65737320746578742c20706c6561736521\n消息：\n· Sign this harmless text, please!",
      },
    },
  },
  "tron message kernel-line forgery": {
    verifiability: "opaque",
    blind: null,
    messageHex: [...utf8("Confirm this order\nNetwork: Ethereum\nMax fee 0.5 ETH")]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
    prompt: {
      en: {
        title: "Confirm signature",
        description: "Message:\n· Confirm this order\n· Network: Ethereum\n· Max fee 0.5 ETH",
      },
      "zh-Hans": {
        title: "确认签名",
        description: "消息：\n· Confirm this order\n· Network: Ethereum\n· Max fee 0.5 ETH",
      },
    },
  },
  "tron message sign-in": {
    verifiability: "opaque",
    blind: null,
    messageHex:
      "6578616d706c652e636f6d2077616e747320796f7520746f207369676e20696e207769746820796f757220457468657265756d206163636f756e743a0a5455455a53644b736f4448514d655a77696874646f42694e34367a786847575964480a0a5552493a2068747470733a2f2f6578616d706c652e636f6d0a56657273696f6e3a20310a436861696e2049443a20310a4e6f6e63653a206162633132330a4973737565642041743a20323032342d30312d30315430303a30303a30305a",
    prompt: {
      en: {
        title: "Confirm signature",
        description:
          "This looks like a sign-in request but is not a valid one\nMessage:\n· example.com wants you to sign in with your Ethereum account:\n· TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH\n· URI: https://example.com\n· Version: 1\n· Chain ID: 1\n· Nonce: abc123\n… 31 more characters not shown",
      },
      "zh-Hans": {
        title: "确认签名",
        description:
          "内容像登录请求，但格式不合规\n消息：\n· example.com wants you to sign in with your Ethereum account:\n· TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH\n· URI: https://example.com\n· Version: 1\n· Chain ID: 1\n· Nonce: abc123\n… 还有 31 个字符未显示",
      },
    },
  },
};

for (const vector of TRON_VECTORS.transactions) {
  const expected = TRON_TX_EXPECTED[vector.name];
  if (expected === undefined) {
    throw new Error(`no expected signing class for TRON vector ${vector.name}`);
  }
  cases.push({
    name: `tron ${vector.name}`,
    request: tronTx(vector.rawDataHex),
    verifiability: expected.verifiability,
    blind: expected.blind,
    prompt: expected.prompt,
  });
}
for (const [name, row] of Object.entries(TRON_MSG_CASES)) {
  cases.push({
    name: `tron ${name}`,
    request: tronMessage(row.messageHex),
    verifiability: row.verifiability,
    blind: row.blind,
    prompt: row.prompt,
  });
}

/* A TRON transfer whose memo is text that imitates the kernel's own prompt lines; every memo
   line renders as marked requester text. */
cases.push({
  name: "tron transfer forged memo",
  request: tronTx(
    toHex(
      buildTronRawData(
        {
          refBlock: {
            number: 76050000,
            id: "0000000004886e501a2b3c4d5e6f78901a2b3c4d5e6f78901a2b3c4d5e6f7890",
          },
          expiration: 1_767_225_660_000,
          timestamp: 1_767_225_600_000,
          memo: utf8(
            "Order #8812\nNetwork: Nile (testnet, no value)\nExpires 2026-01-01 00:01 (UTC)\nFee limit 0.1 TRX",
          ),
        },
        {
          type: "TransferContract",
          owner: TRON_SIGNER,
          to: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC",
          amount: 1_000_000n,
        },
      ),
    ),
  ),
  verifiability: "full",
  blind: null,
  prompt: {
    en: {
      title: "Confirm transfer",
      description:
        "Network: TRON\nSend 1 TRX to TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC\nMemo:\n· Order #8812\n· Network: Nile (testnet, no value)\n· Expires 2026-01-01 00:01 (UTC)\n· Fee limit 0.1 TRX\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged",
    },
    "zh-Hans": {
      title: "确认转账",
      description:
        "网络：TRON\n发送 1 TRX 到 TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC\n备注：\n· Order #8812\n· Network: Nile (testnet, no value)\n· Expires 2026-01-01 00:01 (UTC)\n· Fee limit 0.1 TRX\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费",
    },
  },
});

const TRON_TD_CASES = {
  "typed-data permit2": {
    doc: "permit2-single",
    verifiability: "partial",
    blind: null,
    prompt: {
      en: {
        title: "Confirm approval",
        description:
          "App: Permit2\n" +
          "Network: TRON\n" +
          "Verifying contract TTJxU3P8rHycAyFY4kVtGNfmnMH4ezcuM9\n" +
          "Type: PermitSingle\n" +
          "There may be other outflows\n" +
          "Allow T9yD14Nj9j7xAB4dbGeiX9h8unkKLxmGkn to spend 1 USDT via Permit2 until 2033-05-18 (UTC)",
      },
      "zh-Hans": {
        title: "确认授权",
        description:
          "应用：Permit2\n" +
          "网络：TRON\n" +
          "验证合约 TTJxU3P8rHycAyFY4kVtGNfmnMH4ezcuM9\n" +
          "类型：PermitSingle\n" +
          "可能还有其他转出\n" +
          "授权 T9yD14Nj9j7xAB4dbGeiX9h8unkKLxmGkn 使用 1 USDT 经 Permit2 至 2033-05-18（UTC）",
      },
    },
  },
  "typed-data trctoken": {
    doc: "trctoken",
    verifiability: "opaque",
    blind: null,
    prompt: {
      en: {
        title: "Confirm signature",
        description:
          "App: TRC10\n" +
          "Network: TRON\n" +
          "Type: Send\n" +
          "The wallet cannot verify what this signature authorises\n" +
          "· asset = 1002000\n· to = TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t\n· amount = 42",
      },
      "zh-Hans": {
        title: "确认签名",
        description:
          "应用：TRC10\n" +
          "网络：TRON\n" +
          "类型：Send\n" +
          "钱包无法核实此签名授权的内容\n" +
          "· asset = 1002000\n· to = TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t\n· amount = 42",
      },
    },
  },
  "typed-data oversize": {
    doc: "oversize",
    verifiability: "opaque",
    blind: "typed-data-oversize",
    prompt: {
      en: {
        title: "Confirm blind signing",
        description:
          "App: Big\n" +
          "Network: TRON\n" +
          "Type: Wide\n" +
          "This typed data is too large to show in full",
      },
      "zh-Hans": {
        title: "确认盲签",
        description: "应用：Big\n网络：TRON\n类型：Wide\n此类型数据过大，无法完整显示",
      },
    },
  },
};

for (const [name, row] of Object.entries(TRON_TD_CASES)) {
  cases.push({
    name: `tron ${name}`,
    request: tronTypedData(tronTdDoc(row.doc)),
    verifiability: row.verifiability,
    blind: row.blind,
    prompt: row.prompt,
  });
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

writeFileSync(
  resolve(import.meta.dirname, "../../../vectors/chains/signing-classes.json"),
  `${JSON.stringify({ signers: { evm: SIGNER, tron: TRON_SIGNER, solana: SOL_SIGNER }, cases }, null, 2)}\n`,
);
console.log(`wrote ${cases.length} cases`);
