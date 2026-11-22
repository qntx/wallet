/**
 * PoC for finding F-2: `Fiat24Account.mintByClient(tokenId)` burns the account price in F24 from
 * the caller (`f24.burnFrom(_msgSender(), fiat24PriceList.getPrice(_tokenId))`, verified source
 * Fiat24Account.sol), bounded only by the caller's F24 allowance — yet the decoded intent and the
 * approval prompt show an account opening with no cost line at all. Asserts the CURRENT silent
 * rendering; a prompt that surfaces the F24 burn makes this fail.
 */
import { encodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { EvmTransaction, SignRequest } from "@qntx/wallet-chains";
import { decodeEvm } from "@qntx/wallet-chains/evm";

import { chainPrompt } from "../../src/modules/chains/prompt.ts";

/* Fiat24Account proxy on Arbitrum One (pinned in the decoder). */
const FIAT24_ACCOUNT = "0x133CAEecA096cA54889db71956c7f75862Ead7A0";
const SIGNER = "0x2222222222222222222222222222222222222222";

const tx: SignRequest = {
  kind: "evm.transaction",
  network: "eip155:42161",
  account: { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" },
  tx: {
    type: "eip1559",
    chainId: 42161,
    nonce: 0,
    gas: "0x30000",
    to: FIAT24_ACCOUNT,
    value: "0x0",
    data: encodeFunctionData({
      abi: parseAbi(["function mintByClient(uint256 tokenId)"]),
      functionName: "mintByClient",
      args: [100000n],
    }),
    accessList: [],
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x1",
  } satisfies EvmTransaction,
};

describe("Fiat24 mintByClient hides the F24 burn", () => {
  const intent = decodeEvm(tx, SIGNER);

  it("decodes as a bare account opening — no outflow, no approval", () => {
    expect(intent.blind).toBeUndefined();
    expect(intent.fiat24).toStrictEqual({ kind: "open-account", account: "100000" });
    expect(intent.outflows).toStrictEqual([]);
    expect(intent.approvals).toStrictEqual([]);
    expect(intent.warnings?.map((warning) => warning.kind)).toStrictEqual(["fiat24-account-link"]);
  });

  it("the approval prompt never mentions F24 or a burn", () => {
    const prompt = chainPrompt("en", intent);
    /* The burn takes an issuer-set F24 price from the caller's balance — nothing in the
       description tells the user signing this will cost F24. */
    expect(prompt.description).not.toMatch(/\bF24\b/);
    expect(prompt.description).not.toContain("burn");
    expect(prompt.description).not.toContain("price");
  });
});
