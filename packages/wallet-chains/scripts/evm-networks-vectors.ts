/// <reference types="node" />
/**
 * Regenerates vectors/chains/evm-networks.json: one sign request per new built-in EVM network — a
 * native transfer on each (and a listed-token transfer where the token table lists one) with the
 * expected `verifiability`/`blind` and the exact kernel prompt in en and zh-Hans. Calldata is built
 * with viem; the expected prompt text is written by hand from the prompt catalog strings.
 *
 * Run from the repo root: bun packages/wallet-chains/scripts/evm-networks-vectors.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { encodeFunctionData, parseAbi } from "viem";

const SIGNER = "0x2222222222222222222222222222222222222222";
const TO = "0x00000000000000000000000000000000DeaDBeef";
const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const INK_USDC = "0x2D270e6886d130D724215A266106e6832161EAEd";
const CELO_ALIAS = "0x471EcE3750Da237f93B8E339c536989b8978a438";
const ARC_USDC_ALIAS = "0x3600000000000000000000000000000000000000";
const MONAD_WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const SEI_WSEI = "0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7";
const SCROLL_WETH = "0x5300000000000000000000000000000000000004";
const ETHEREUM_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DEPOSIT = encodeFunctionData({ abi: parseAbi(["function deposit() payable"]) });
const withdraw = (wad: bigint) =>
  encodeFunctionData({ abi: parseAbi(["function withdraw(uint256)"]), args: [wad] });

const swapP = (en: string, zh: string) => ({
  en: { title: "Confirm swap", description: en },
  "zh-Hans": { title: "确认兑换", description: zh },
});

const account = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" };
const tx = (chainId: number, over: { to?: string; data?: string; value?: string }) => ({
  kind: "evm.transaction",
  network: `eip155:${String(chainId)}`,
  account,
  tx: {
    type: "eip1559",
    chainId,
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
const legacyTx = (chainId: number, over: { to?: string; data?: string; value?: string }) => ({
  kind: "evm.transaction",
  network: `eip155:${String(chainId)}`,
  account,
  tx: {
    type: "legacy",
    chainId,
    nonce: 0,
    gas: "0x30000",
    value: "0x0",
    data: "0x",
    accessList: [],
    gasPrice: "0x3b9aca00",
    ...over,
  },
});

const p = (en: string, zh: string) => ({
  en: { title: "Confirm transfer", description: en },
  "zh-Hans": { title: "确认转账", description: zh },
});

const FEE = "0.000196608"; // gas 0x30000 × maxFeePerGas 0x3b9aca00
const native = (chainId: number, name: string, symbol: string) => ({
  name: `${name} native ${symbol} transfer`,
  request: tx(chainId, { to: TO, value: "0xde0b6b3a7640000" }),
  verifiability: "full",
  blind: null,
  prompt: p(
    `Network: ${name}\nSend 1 ${symbol} to ${TO}\nMax fee ${FEE} ${symbol}`,
    `网络：${name}\n发送 1 ${symbol} 到 ${TO}\n最高手续费 ${FEE} ${symbol}`,
  ),
});

const cases = [
  native(143, "Monad", "MON"),
  {
    name: "Monad USDC transfer",
    request: tx(143, {
      to: MONAD_USDC,
      data: encodeFunctionData({
        abi: parseAbi(["function transfer(address,uint256)"]),
        args: [TO, 1_000_000n],
      }),
    }),
    verifiability: "full",
    blind: null,
    prompt: p(
      `Network: Monad\nSend 1 USDC to ${TO}\nMax fee ${FEE} MON`,
      `网络：Monad\n发送 1 USDC 到 ${TO}\n最高手续费 ${FEE} MON`,
    ),
  },
  native(130, "Unichain", "ETH"),
  native(324, "ZKsync Era", "ETH"),
  native(534352, "Scroll", "ETH"),
  native(167000, "Taiko", "ETH"),
  native(46630, "Robinhood Chain Testnet", "ETH"),
  {
    // The CELO alias is a listed token to the decoder: a `transfer` reads like any listed one.
    name: "Celo CELO alias transfer",
    request: tx(42220, {
      to: CELO_ALIAS,
      data: encodeFunctionData({
        abi: parseAbi(["function transfer(address,uint256)"]),
        args: [TO, 2_500_000_000_000_000_000n],
      }),
    }),
    verifiability: "full",
    blind: null,
    prompt: p(
      `Network: Celo\nSend 2.5 CELO to ${TO}\nMax fee ${FEE} CELO`,
      `网络：Celo\n发送 2.5 CELO 到 ${TO}\n最高手续费 ${FEE} CELO`,
    ),
  },
  {
    // Arc's USDC alias likewise: an `approve` gets the listed-token approval lines.
    name: "Arc USDC alias approve",
    request: tx(5042, {
      to: ARC_USDC_ALIAS,
      data: encodeFunctionData({
        abi: parseAbi(["function approve(address,uint256)"]),
        args: [TO, 5_000_000n],
      }),
    }),
    verifiability: "partial",
    blind: null,
    prompt: {
      en: {
        title: "Confirm approval",
        description: `Network: Arc\nThere may be other outflows\nAllow ${TO} to spend 5 USDC\nMax fee ${FEE} USDC`,
      },
      "zh-Hans": {
        title: "确认授权",
        description: `网络：Arc\n可能还有其他转出\n授权 ${TO} 使用 5 USDC\n最高手续费 ${FEE} USDC`,
      },
    },
  },
  {
    // deposit() on a listed wrapped native describes as a coin→token swap.
    name: "Monad WMON deposit",
    request: tx(143, { to: MONAD_WMON, data: DEPOSIT, value: "0x14d1120d7b160000" }),
    verifiability: "full",
    blind: null,
    prompt: swapP(
      `Network: Monad\nSend 1.5 MON to ${MONAD_WMON}\nReceive at least 1.5 WMON at ${SIGNER}\nMax fee ${FEE} MON`,
      `网络：Monad\n发送 1.5 MON 到 ${MONAD_WMON}\n至少收到 1.5 WMON，收款地址 ${SIGNER}\n最高手续费 ${FEE} MON`,
    ),
  },
  {
    name: "Sei WSEI withdraw",
    request: tx(1329, { to: SEI_WSEI, data: withdraw(2_000_000_000_000_000_000n) }),
    verifiability: "full",
    blind: null,
    prompt: swapP(
      `Network: Sei\nSend 2 WSEI to ${SEI_WSEI}\nReceive at least 2 SEI at ${SIGNER}\nMax fee ${FEE} SEI`,
      `网络：Sei\n发送 2 WSEI 到 ${SEI_WSEI}\n至少收到 2 SEI，收款地址 ${SIGNER}\n最高手续费 ${FEE} SEI`,
    ),
  },
  {
    name: "Scroll WETH deposit",
    request: tx(534352, { to: SCROLL_WETH, data: DEPOSIT, value: "0x6f05b59d3b20000" }),
    verifiability: "full",
    blind: null,
    prompt: swapP(
      `Network: Scroll\nSend 0.5 ETH to ${SCROLL_WETH}\nReceive at least 0.5 WETH at ${SIGNER}\nMax fee ${FEE} ETH`,
      `网络：Scroll\n发送 0.5 ETH 到 ${SCROLL_WETH}\n至少收到 0.5 WETH，收款地址 ${SIGNER}\n最高手续费 ${FEE} ETH`,
    ),
  },
  {
    name: "Ethereum WETH withdraw",
    request: tx(1, { to: ETHEREUM_WETH, data: withdraw(1_000_000_000_000_000_000n) }),
    verifiability: "full",
    blind: null,
    prompt: swapP(
      `Network: Ethereum\nSend 1 WETH to ${ETHEREUM_WETH}\nReceive at least 1 ETH at ${SIGNER}\nMax fee ${FEE} ETH`,
      `网络：Ethereum\n发送 1 WETH 到 ${ETHEREUM_WETH}\n至少收到 1 ETH，收款地址 ${SIGNER}\n最高手续费 ${FEE} ETH`,
    ),
  },
  {
    // opBNB prices legacy: the Max fee line comes out of gas × gasPrice.
    name: "opBNB native BNB transfer",
    request: legacyTx(204, { to: TO, value: "0xde0b6b3a7640000" }),
    verifiability: "full",
    blind: null,
    prompt: p(
      `Network: opBNB\nSend 1 BNB to ${TO}\nMax fee ${FEE} BNB`,
      `网络：opBNB\n发送 1 BNB 到 ${TO}\n最高手续费 ${FEE} BNB`,
    ),
  },
  {
    name: "Ink USDC transfer",
    request: tx(57073, {
      to: INK_USDC,
      data: encodeFunctionData({
        abi: parseAbi(["function transfer(address,uint256)"]),
        args: [TO, 1_000_000n],
      }),
    }),
    verifiability: "full",
    blind: null,
    prompt: p(
      `Network: Ink\nSend 1 USDC to ${TO}\nMax fee ${FEE} ETH`,
      `网络：Ink\n发送 1 USDC 到 ${TO}\n最高手续费 ${FEE} ETH`,
    ),
  },
];

const out = resolve(import.meta.dirname, "../../../vectors/chains/evm-networks.json");
writeFileSync(out, `${JSON.stringify({ signer: SIGNER, cases }, null, 2)}\n`);
console.log(`wrote ${out}: ${String(cases.length)} cases`);
