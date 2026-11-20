/// <reference types="node" />
/**
 * Regenerates vectors/chains/signing-classes.json: everyday dApp requests and the six blind reason
 * codes with their expected `verifiability`/`blind` and the exact kernel prompt in en and zh-Hans.
 * Calldata is built with viem; the expected class and prompt text are literals written by hand.
 *
 * SignRequest fields that cannot live in JSON: `typedData` is the parsed document (consumers pass
 * JSON.stringify of it) and `message` is `{"$bytes": hex}` (consumers decode to Uint8Array).
 *
 * Run from the repo root: bun packages/wallet-chains/scripts/signing-classes-vectors.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { encodeFunctionData, getAddress, getContractAddress, parseAbi } from "viem";

const SIGNER = "0x2222222222222222222222222222222222222222";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const AAVE_V3 = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const ROUTER = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af";
const TO = "0x00000000000000000000000000000000DeaDBeef";
const OTHER = getAddress("0x00000000000000000000000000000000000bad00");
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
const typedData = (doc: unknown) => ({
  kind: "evm.typed-data",
  network: "eip155:1",
  account,
  typedData: doc,
});
const personal = (hex: string) => ({
  kind: "evm.personal-message",
  network: "eip155:1",
  account,
  message: { $bytes: hex },
});

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
const typedCommitment =
  "It signs only hashes or raw bytes; the wallet cannot see what they commit to";
const typedCommitmentZh = "只签署哈希或原始字节；钱包无法看到它们所承诺的内容";
const typedVariant =
  "The wallet recognises this kind of signature but not this form of it; it may authorise moving assets";
const typedVariantZh = "钱包认识这类签名，但不认识这种形式；它可能授权转移资产";
const typedOversize = "This typed data is too large to show in full";
const typedOversizeZh = "此类型数据过大，无法完整显示";
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
  colon: string,
  salt: string,
  tokenId: string,
  makerAmount: string,
  takerAmount: string,
  timestamp: string,
): string =>
  [
    `salt${colon}${salt}`,
    `maker${colon}${PM_SIGNER}`,
    `signer${colon}${PM_SIGNER}`,
    `tokenId${colon}${tokenId}`,
    `makerAmount${colon}${makerAmount}`,
    `takerAmount${colon}${takerAmount}`,
    `side${colon}0`,
    `signatureType${colon}0`,
    `timestamp${colon}${timestamp}`,
    `metadata${colon}${PM_ZERO32}`,
    `builder${colon}${PM_ZERO32}`,
  ].join("\n");
const PM_ORDER_LEAVES_1 = pmLeaves(
  ": ",
  "746666666340",
  PM_TOKEN_ID,
  "50000000",
  "100000000",
  "1777777777000",
);
const PM_ORDER_LEAVES_1_ZH = pmLeaves(
  "：",
  "746666666340",
  PM_TOKEN_ID,
  "50000000",
  "100000000",
  "1777777777000",
);
const PM_ORDER_LEAVES_2 = pmLeaves(
  ": ",
  "800000080650",
  PM_TOKEN_ID_2,
  "40000000",
  "80000000",
  "1777777957000",
);
const PM_ORDER_LEAVES_2_ZH = pmLeaves(
  "：",
  "800000080650",
  PM_TOKEN_ID_2,
  "40000000",
  "80000000",
  "1777777957000",
);

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
  .map((f) => `${f.name}: 1`)
  .join("\n");
const fields16Zh = leaves(16)
  .map((f) => `${f.name}：1`)
  .join("\n");

const hash32 = `0x${"ab".repeat(32)}`;
const bytes100 = "cd".repeat(100);
const SAFE = "0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52";
const SEAPORT_16 = "0x0000000000000068F116a894984e2DB1123eB395";
const GROUND_DIGEST = "5718efa1a01c4e34c7b5481f5450604d1274491d0f310532dcbd7461c9ae3b79";
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

const cases = [
  {
    name: "WETH9 deposit() (wrap 1 ETH)",
    request: tx({
      to: WETH,
      data: encodeFunctionData({ abi: parseAbi(["function deposit() payable"]) }),
      value: "0xde0b6b3a7640000",
    }),
    verifiability: "opaque",
    blind: null,
    prompt: p(
      "Confirm contract call",
      "确认合约调用",
      `${net}\n${caveat}\nCall contract ${WETH}, function 0xd0e30db0\nSend 1 ETH to ${WETH}\n${fee}`,
      `${netZh}\n${caveatZh}\n调用合约 ${WETH}，函数 0xd0e30db0\n发送 1 ETH 到 ${WETH}\n${feeZh}`,
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
    verifiability: "opaque",
    blind: null,
    prompt: p(
      "Confirm signature",
      "确认签名",
      `App: Gnosis Protocol\n${net}\nVerifying contract 0x9008D19f58AAbD9eD0D60971565AA8510560ab41\nType: Order\n${typedCaveat}\nsellToken: ${USDC}\nbuyToken: ${WETH}\nreceiver: ${SIGNER}\nsellAmount: 1000000\nbuyAmount: 1\nvalidTo: 2000000000\nappData: 0x${"00".repeat(32)}\nfeeAmount: 0\nkind: sell\npartiallyFillable: false\nsellTokenBalance: erc20\nbuyTokenBalance: erc20`,
      `应用：Gnosis Protocol\n${netZh}\n验证合约 0x9008D19f58AAbD9eD0D60971565AA8510560ab41\n类型：Order\n${typedCaveatZh}\nsellToken：${USDC}\nbuyToken：${WETH}\nreceiver：${SIGNER}\nsellAmount：1000000\nbuyAmount：1\nvalidTo：2000000000\nappData：0x${"00".repeat(32)}\nfeeAmount：0\nkind：sell\npartiallyFillable：false\nsellTokenBalance：erc20\nbuyTokenBalance：erc20`,
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
      `App: Ether Mail\n${net}\nVerifying contract 0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC\nType: Mail\n${typedCaveat}\nfrom.name: Cow\nfrom.wallet: 0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826\nto.name: Bob\nto.wallet: 0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB\ncontents: Hello, Bob!`,
      `应用：Ether Mail\n${netZh}\n验证合约 0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC\n类型：Mail\n${typedCaveatZh}\nfrom.name：Cow\nfrom.wallet：0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826\nto.name：Bob\nto.wallet：0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB\ncontents：Hello, Bob!`,
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
    prompt: p("Confirm signature", "确认签名", "Message:\nhello world", "消息：\nhello world"),
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
      `${net}\nVerifying contract ${SAFE}\nType: SafeMessage\n${typedCommitment}\n${typedCaveat}\nmessage: ${hash32}`,
      `${netZh}\n验证合约 ${SAFE}\n类型：SafeMessage\n${typedCommitmentZh}\n${typedCaveatZh}\nmessage：${hash32}`,
    ),
  },
  {
    name: "USDC TransferWithAuthorization (EIP-3009 near miss)",
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
        from: SIGNER,
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
      `App: USD Coin\n${net}\nVerifying contract ${USDC}\nType: TransferWithAuthorization\n${typedVariant}\n${typedCaveat}\nfrom: ${SIGNER}\nto: ${OTHER}\nvalue: 1000000\nvalidAfter: 0\nvalidBefore: 2000000000\nnonce: ${hash32}`,
      `应用：USD Coin\n${netZh}\n验证合约 ${USDC}\n类型：TransferWithAuthorization\n${typedVariantZh}\n${typedCaveatZh}\nfrom：${SIGNER}\nto：${OTHER}\nvalue：1000000\nvalidAfter：0\nvalidBefore：2000000000\nnonce：${hash32}`,
    ),
  },
  {
    name: "Seaport OrderComponents, five offers (over the prompt limit)",
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
        offer: Array.from({ length: 5 }, () => seaportNativeItem),
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
      `App: Seaport\n${net}\nVerifying contract ${SEAPORT_16}\nType: OrderComponents\nGive 1 ETH\nGive 1 ETH\nGive 1 ETH\nGive 1 ETH\n… 1 more items not shown\n${SIGNER} receives 0 ETH`,
      `应用：Seaport\n${netZh}\n验证合约 ${SEAPORT_16}\n类型：OrderComponents\n付出 1 ETH\n付出 1 ETH\n付出 1 ETH\n付出 1 ETH\n… 还有 1 项未显示\n${SIGNER} 收到 0 ETH`,
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
      `${blindBytes}\nData 0x${GROUND_DIGEST}`,
      `${blindBytesZh}\n数据 0x${GROUND_DIGEST}`,
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
      `${blindBytes}\nMessage:\n${hexText}`,
      `${blindBytesZh}\n消息：\n${hexText}`,
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
      `${HL_APP_EN}\nNetwork: Arbitrum Sepolia\n${HL_CONTRACT_EN}\nType: HyperliquidTransaction:ConvertToMultiSigUser\n${typedVariant}\n${typedCaveat}\nhyperliquidChain: Testnet\nsigners: ["0x1111111111111111111111111111111111111111","0x2222222222222222222222222222222222222222"]\nnonce: 1700000001600`,
      `${HL_APP_ZH}\n网络：Arbitrum Sepolia\n${HL_CONTRACT_ZH}\n类型：HyperliquidTransaction:ConvertToMultiSigUser\n${typedVariantZh}\n${typedCaveatZh}\nhyperliquidChain：Testnet\nsigners：["0x1111111111111111111111111111111111111111","0x2222222222222222222222222222222222222222"]\nnonce：1700000001600`,
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
      `${HL_APP_EN}\nNetwork: Arbitrum One\n${HL_CONTRACT_EN}\nType: HyperliquidTransaction:UsdSend\n${typedVariant}\n${typedCaveat}\nhyperliquidChain: Mainnet\ndestination: 0x5e9ee1089755c3435139848e47e6635505d5a13a\namount: 2.5\ntime: 1700000000000`,
      `${HL_APP_ZH}\n网络：Arbitrum One\n${HL_CONTRACT_ZH}\n类型：HyperliquidTransaction:UsdSend\n${typedVariantZh}\n${typedCaveatZh}\nhyperliquidChain：Mainnet\ndestination：0x5e9ee1089755c3435139848e47e6635505d5a13a\namount：2.5\ntime：1700000000000`,
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
      `${HL_APP_EN}\nNetwork: Arbitrum One\n${HL_CONTRACT_EN}\nType: HyperliquidTransaction:UsdSend\n${typedVariant}\n${typedCaveat}\nhyperliquidChain: Mainnet\ndestination: 0x5e9ee1089755c3435139848e47e6635505d5a13a\namount: 1e3\ntime: 1700000000000`,
      `${HL_APP_ZH}\n网络：Arbitrum One\n${HL_CONTRACT_ZH}\n类型：HyperliquidTransaction:UsdSend\n${typedVariantZh}\n${typedCaveatZh}\nhyperliquidChain：Mainnet\ndestination：0x5e9ee1089755c3435139848e47e6635505d5a13a\namount：1e3\ntime：1700000000000`,
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
      `App: Exchange\nNetwork: EVM chain 1337\n${HL_CONTRACT_EN}\nType: Agent\n${typedCommitment}\n${typedCaveat}\nsource: a\nconnectionId: 0x25367e0dba84351148288c2233cd6130ed6cec5967ded0c0b7334f36f957cc90`,
      `应用：Exchange\n网络：EVM 链 1337\n${HL_CONTRACT_ZH}\n类型：Agent\n${typedCommitmentZh}\n${typedCaveatZh}\nsource：a\nconnectionId：0x25367e0dba84351148288c2233cd6130ed6cec5967ded0c0b7334f36f957cc90`,
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
      `App: ClobAuthDomain\nNetwork: Polygon Amoy\nType: ClobAuth\n${typedVariant}\n${typedCaveat}\naddress: ${SIGNER}\ntimestamp: 10000000\nnonce: 23\nmessage: Sign in to Polymarket`,
      `应用：ClobAuthDomain\n网络：Polygon Amoy\n类型：ClobAuth\n${typedVariantZh}\n${typedCaveatZh}\naddress：${SIGNER}\ntimestamp：10000000\nnonce：23\nmessage：Sign in to Polymarket`,
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
];

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

writeFileSync(
  resolve(import.meta.dirname, "../../../vectors/chains/signing-classes.json"),
  `${JSON.stringify({ signer: SIGNER, cases }, null, 2)}\n`,
);
console.log(`wrote ${cases.length} cases`);
