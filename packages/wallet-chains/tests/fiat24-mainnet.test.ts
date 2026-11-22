import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/index.ts";
import type { EvmTransaction, SignRequest } from "../src/index.ts";

/**
 * Vectors/chains/fiat24-mainnet.json — real Arbitrum One calls into the pinned Fiat24 proxies,
 * collected by scripts/vectors/fiat24-mainnet.ts from archive logs. The expected class per (to,
 * selector) below is written by hand from the decoder's rules, not captured from it.
 */
type CorpusTx = {
  readonly hash: string;
  readonly block: string;
  readonly chainId: string;
  readonly type: string;
  readonly from: string;
  readonly to: string | null;
  readonly value: string;
  readonly nonce: string;
  readonly gas: string;
  readonly gasPrice: string | null;
  readonly maxFeePerGas: string | null;
  readonly maxPriorityFeePerGas: string | null;
  readonly input: string;
};

const corpus = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/fiat24-mainnet.json"), "utf8"),
) as { cases: ReadonlyArray<CorpusTx> };

const USD24 = "0xbe00f3db78688d9704bcb4e0a827aea3a9cc0d62";
const EUR24 = "0x2c5d06f591d0d8cd43ac232c2b654475a142c7da";
const CHF24 = "0xd41f1f0cf89fd239ca4c1f8e8ada46345c86b0a4";
const ACCOUNT = "0x133caeeca096ca54889db71956c7f75862ead7a0";
const DEPOSIT = "0x4582f67698843dfb6a9f195c0ddee05b0a8c973f";
const CARD = "0xe2e3b88b9893e18d0867c08f9ca93f8ab5935b14";
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

/* Expected class per (to, selector) — hand-written from the decoder's rules table. */
const EXPECTED: Readonly<Record<string, { summary: string; blind?: string }>> = {
  // account 0x10480e13: a function the decoder does not describe
  [`${ACCOUNT}:0x10480e13`]: { summary: "contract-call", blind: "fiat24-function" },
  // approve on the cash tokens and on USDC — the standard ERC-20 path
  [`${EUR24}:0x095ea7b3`]: { summary: "approve" },
  [`${USD24}:0x095ea7b3`]: { summary: "approve" },
  [`${USDC}:0x095ea7b3`]: { summary: "approve" },
  // transfer on a cash token — the standard ERC-20 path
  [`${USD24}:0xa9059cbb`]: { summary: "transfer" },
  // clientPayoutRef — bank payout to a recorded payee
  [`${EUR24}:0xeb6d2d71`]: { summary: "payout" },
  [`${CHF24}:0xeb6d2d71`]: { summary: "payout" },
  // deposit contract: both exchange directions and all three top-ups
  [`${DEPOSIT}:0x72a023fa`]: { summary: "swap" }, // moneyExchangeExactIn
  [`${DEPOSIT}:0x8f28f584`]: { summary: "swap" }, // moneyExchangeExactOut
  [`${DEPOSIT}:0x2d2da806`]: { summary: "swap" }, // depositETH
  [`${DEPOSIT}:0xa01c3e2b`]: { summary: "swap" }, // depositTokenViaEth
  [`${DEPOSIT}:0xb461e299`]: { summary: "swap" }, // depositTokenViaUsdc
  // card contract functions — claimed by the family, blind
  [`${CARD}:0xaf6991b7`]: { summary: "contract-call", blind: "fiat24-function" },
  [`${CARD}:0xc645f854`]: { summary: "contract-call", blind: "fiat24-function" },
};

/** The expectation for a (to, selector) key — throws when the table does not cover it. */
const keyOf = (c: CorpusTx): string =>
  `${(c.to ?? "").toLowerCase()}:${c.input.slice(0, 10).toLowerCase()}`;

const expectedFor = (key: string): { summary: string; blind?: string } => {
  const expected = EXPECTED[key];
  if (expected === undefined) {
    throw new Error(`missing expectation for ${key}`);
  }
  return expected;
};

const tx = (c: CorpusTx): SignRequest => {
  const base = {
    chainId: Number(c.chainId),
    nonce: Number(c.nonce),
    gas: c.gas,
    value: c.value,
    data: c.input,
    ...(c.to === null ? {} : { to: c.to }),
  };
  const evm: EvmTransaction =
    c.type === "0x2"
      ? {
          ...base,
          type: "eip1559",
          accessList: [],
          maxFeePerGas: c.maxFeePerGas ?? "0x0",
          maxPriorityFeePerGas: c.maxPriorityFeePerGas ?? "0x0",
        }
      : { ...base, type: "legacy", gasPrice: c.gasPrice ?? "0x0" };
  return {
    kind: "evm.transaction",
    network: `eip155:${base.chainId}`,
    account: { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" },
    tx: evm,
  };
};

describe("Fiat24 mainnet corpus", () => {
  it("every (to, selector) in the corpus has a hand-written expectation", () => {
    for (const c of corpus.cases) {
      expect(expectedFor(keyOf(c))).toBeDefined();
    }
  });

  it.each(corpus.cases.map((c) => [c.hash, c] as const))("%s", (_hash, c) => {
    const expected = expectedFor(keyOf(c));
    const intent = decodeEvm(tx(c), c.from);
    expect(intent.summary).toBe(expected.summary);
    expect(intent.blind).toBe(expected.blind);
  });
});
