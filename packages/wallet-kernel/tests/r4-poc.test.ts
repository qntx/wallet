/**
 * R4 review-classify PoCs on the kernel prompt (Focus D). Each `it` pins CURRENT behaviour at
 * f4b5d53; the comment states what the owner should have been shown.
 */
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "@qntx/wallet-chains/evm";

import { chainPrompt } from "../src/modules/chains/prompt.ts";

const SIGNER = "0x2222222222222222222222222222222222222222";
const account = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;
const REACTOR = "0x00000011F84B9aa48e5f8aA8B9897600006289Be";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ATTACKER = "0x000000000000000000000000000000000000bEEF";

const typed = (doc: unknown, network = "eip155:1") =>
  ({ kind: "evm.typed-data", network, account, typedData: JSON.stringify(doc) }) as const;
const personal = (text: string) =>
  ({
    kind: "evm.personal-message",
    network: "eip155:1",
    account,
    message: new TextEncoder().encode(text),
  }) as const;

describe("D1 a Permit2 witness order's prompt hides the witness and its warning", () => {
  const doc = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "ExclusiveDutchOrder" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      ExclusiveDutchOrder: [
        { name: "info", type: "OrderInfo" },
        { name: "decayStartTime", type: "uint256" },
        { name: "decayEndTime", type: "uint256" },
        { name: "exclusiveFiller", type: "address" },
        { name: "exclusivityOverrideBps", type: "uint256" },
        { name: "inputToken", type: "address" },
        { name: "inputStartAmount", type: "uint256" },
        { name: "inputEndAmount", type: "uint256" },
        { name: "outputs", type: "DutchOutput[]" },
      ],
      OrderInfo: [
        { name: "reactor", type: "address" },
        { name: "swapper", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "additionalValidationContract", type: "address" },
        { name: "additionalValidationData", type: "bytes" },
      ],
      DutchOutput: [
        { name: "token", type: "address" },
        { name: "startAmount", type: "uint256" },
        { name: "endAmount", type: "uint256" },
        { name: "recipient", type: "address" },
      ],
    },
    primaryType: "PermitWitnessTransferFrom",
    domain: {
      name: "Permit2",
      chainId: 1,
      verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    },
    message: {
      permitted: { token: USDC, amount: "1000000000" },
      spender: REACTOR,
      nonce: "1",
      deadline: "2000000000",
      witness: {
        info: {
          reactor: REACTOR,
          swapper: SIGNER,
          nonce: "1",
          deadline: "2000000000",
          additionalValidationContract: "0x0000000000000000000000000000000000000000",
          additionalValidationData: "0x",
        },
        decayStartTime: "0",
        decayEndTime: "0",
        exclusiveFiller: ATTACKER,
        exclusivityOverrideBps: "0",
        inputToken: USDC,
        inputStartAmount: "1000000000",
        inputEndAmount: "1000000000",
        outputs: [{ token: WETH, startAmount: "1", endAmount: "1", recipient: ATTACKER }],
      },
    },
  };

  it("en / zh-Hans prompts: input approval only, no witness line, no output, no warning", () => {
    const intent = decodeEvm(typed(doc), SIGNER);
    expect(intent.warnings.map((w) => w.kind)).toStrictEqual(["permit2-witness"]);
    const en = chainPrompt("en", intent);
    const zh = chainPrompt("zh-Hans", intent);
    console.log(JSON.stringify({ en, zh }, null, 2));
    for (const prompt of [en, zh]) {
      expect(prompt.description).not.toMatch(/beef|WETH|0xC02a|recipient|output/i);
      expect(prompt.description).not.toContain("further terms");
    }
    expect(en.description).toContain("Allow");
  });
});

describe("D2 readable 32-byte text is shown as hex", () => {
  it("a 32-char nonce login renders as bytes hex, not as the text", () => {
    const text = "9f86d081884c7d659a2feaa0c55ad015";
    const intent = decodeEvm(personal(text), SIGNER);
    const en = chainPrompt("en", intent);
    console.log(JSON.stringify(en));
    expect(en.title).toBe("Confirm blind signing");
    expect(en.description).not.toContain(text);
    expect(en.description).toContain(Buffer.from(text).toString("hex"));
  });

  it("a Persian ZWNJ login renders as hex, though the excerpt sanitiser could show it", () => {
    const text = "برای ورود به حساب کاربری می‌خواهم امضا کنم";
    const en = chainPrompt("en", decodeEvm(personal(text), SIGNER));
    console.log(JSON.stringify(en));
    expect(en.description).not.toContain("برای");
  });
});

describe("D3 typed-data field names can reproduce kernel lines", () => {
  it("a field named Network renders a second, attacker-chosen Network line", () => {
    const intent = decodeEvm(
      typed({
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "chainId", type: "uint256" },
          ],
          Login: [
            { name: "Network", type: "string" },
            { name: "Contract", type: "string" },
          ],
        },
        primaryType: "Login",
        domain: { name: "Example", chainId: 1 },
        message: { Network: "Sepolia (testnet, no value)", Contract: USDC },
      }),
      SIGNER,
    );
    const en = chainPrompt("en", intent).description;
    const zh = chainPrompt("zh-Hans", intent).description;
    console.log(JSON.stringify({ en, zh }, null, 2));
    expect(en).toContain("\nNetwork: Ethereum\n");
    expect(en).toContain("\nNetwork: Sepolia (testnet, no value)");
    expect(en).toContain(`\nContract: ${USDC}`);
  });
});
