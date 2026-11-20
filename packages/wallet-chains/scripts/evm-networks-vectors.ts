/// <reference types="node" />
/**
 * Regenerates vectors/chains/evm-networks.json: one sign request per new built-in EVM network — a
 * native transfer on each (and a listed-token transfer on Monad) with the expected
 * `verifiability`/`blind` and the exact kernel prompt in en and zh-Hans. Calldata is built with
 * viem; the expected prompt text is written by hand from the prompt catalog strings.
 *
 * Run from the repo root: bun packages/wallet-chains/scripts/evm-networks-vectors.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { encodeFunctionData, parseAbi } from "viem";

const SIGNER = "0x2222222222222222222222222222222222222222";
const TO = "0x00000000000000000000000000000000DeaDBeef";
const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";

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
  native(46630, "Robinhood Chain Testnet", "ETH"),
];

const out = resolve(import.meta.dirname, "../../../vectors/chains/evm-networks.json");
writeFileSync(out, `${JSON.stringify({ signer: SIGNER, cases }, null, 2)}\n`);
console.log(`wrote ${out}: ${String(cases.length)} cases`);
