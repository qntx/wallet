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
import { writeFileSync } from "node:fs";
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
      `${net}\nVerifying contract ${TO}\nType: Big\nThis typed data is too large to show in full`,
      `${netZh}\n验证合约 ${TO}\n类型：Big\n此类型数据过大，无法完整显示`,
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
];

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

writeFileSync(
  resolve(import.meta.dirname, "../../../vectors/chains/signing-classes.json"),
  `${JSON.stringify({ signer: SIGNER, cases }, null, 2)}\n`,
);
console.log(`wrote ${cases.length} cases`);
