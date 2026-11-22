import { encodeFunctionData, getAddress, maxUint256, parseAbi } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/decode.ts";
import { encodeBatchExecute } from "../src/evm/index.ts";
import type { ApprovalChange, EvmTransaction, SignRequest } from "../src/index.ts";

/* Fiat24 pins — Arbitrum One only; the same constants the decoder carries. */
const USD24 = "0xbE00f3db78688d9704BCb4e0a827aea3a9Cc0D62";
const EUR24 = "0x2c5d06f591D0d8cd43Ac232c2B654475a142c7DA";
const CHF24 = "0xd41F1f0cf89fD239ca4c1F8E8ADA46345c86b0a4";
const CNH24 = "0x7288Ac74d211735374A23707D1518DCbbc0144fd";
const ACCOUNT = "0x133CAEecA096cA54889db71956c7f75862Ead7A0";
const DEPOSIT = "0x4582f67698843Dfb6A9F195C0dDee05B0A8C973F";
const CARD = "0xe2e3B88B9893e18D0867c08f9cA93f8aB5935b14";
const PROXIES = [USD24, EUR24, CHF24, CNH24, ACCOUNT, DEPOSIT, CARD] as const;

const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const SIGNER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x00000000000000000000000000000000c0ffee00";

/* Calldata comes from viem over the verified ABI signatures — independent of the ox decoder. */
const TOKEN_ABI = parseAbi([
  "function transferByAccountId(uint256 recipientAccountId, uint256 amount)",
  "function clientPayout(uint256 amount, string contactId)",
  "function clientPayoutRef(uint256 amount, string contactId, uint256 purposeId, string ref)",
  "function transfer(address recipient, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 amount)",
  "function decreaseAllowance(address spender, uint256 amount)",
  "function transferFrom(address sender, address recipient, uint256 amount)",
]);
const ACCOUNT_ABI = parseAbi([
  "function mintByClient(uint256 tokenId)",
  "function mintByClientWithETH(uint256 tokenId) payable",
  "function approve(address to, uint256 tokenId)",
  "function setApprovalForAll(address operator, bool approved)",
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
]);
const DEPOSIT_ABI = parseAbi([
  "function moneyExchangeExactIn(address inputToken, address outputToken, uint256 inputAmount)",
  "function moneyExchangeExactOut(address inputToken, address outputToken, uint256 outputAmount)",
  "function depositTokenViaUsdc(address inputToken, address outputToken, uint256 amount)",
  "function depositETH(address outputToken) payable",
  "function depositTokenViaEth(address inputToken, address outputToken, uint256 amount)",
  "function depositByWallet(address client, address outputToken, uint256 usdcAmount)",
]);

const account = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;

const tx = (to: string | undefined, data: string, value = "0x0", chainId = 42161): SignRequest => ({
  kind: "evm.transaction",
  network: `eip155:${chainId}`,
  account,
  tx: {
    type: "eip1559",
    chainId,
    nonce: 0,
    gas: "0x30000",
    ...(to === undefined ? {} : { to }),
    value,
    data,
    accessList: [],
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x1",
  } as EvmTransaction,
});

const fn = (abi: Parameters<typeof encodeFunctionData>[0]["abi"], name: string, args: unknown[]) =>
  encodeFunctionData({ abi, functionName: name, args });

const sendByAccount = (id: bigint, amount = 20000n) =>
  fn(TOKEN_ABI, "transferByAccountId", [id, amount]);

/** The Fiat24 role an allowance approval carries, undefined for other approval kinds. */
const spenderRole = (change: ApprovalChange | undefined) =>
  change?.kind === "allowance" ? change.fiat24Spender : undefined;

describe("Fiat24 transferByAccountId", () => {
  it("describes the account-addressed outflow as partial", () => {
    const intent = decodeEvm(tx(USD24, sendByAccount(10365n)), SIGNER);
    expect(intent.summary).toBe("transfer");
    expect(intent.verifiability).toBe("partial");
    expect(intent.blind).toBeUndefined();
    expect(intent.outflows).toStrictEqual([
      {
        to: USD24,
        amount: { asset: USD24, amount: "20000", symbol: "USD24", decimals: 2 },
        verified: true,
        fiat24: { account: "10365" },
      },
    ]);
    expect(intent.warnings).toStrictEqual([]);
  });

  it.each([
    [9099n, []],
    [9100n, [{ kind: "fiat24-internal-account", message: "9100" }]],
    [9299n, [{ kind: "fiat24-internal-account", message: "9299" }]],
    [9300n, []],
  ] as const)("internal-account warning only inside 9100..9299: %s", (id, warnings) => {
    const intent = decodeEvm(tx(EUR24, sendByAccount(id)), SIGNER);
    expect(intent.warnings).toStrictEqual(warnings);
  });

  it.each([
    ["trailing bytes", `${sendByAccount(10365n)}001122`],
    ["truncated calldata", sendByAccount(10365n).slice(0, -4)],
    ["a selector short of arguments", sendByAccount(10365n).slice(0, 74)],
  ])("a malformed call is blind: %s", (_name, data) => {
    const intent = decodeEvm(tx(USD24, data), SIGNER);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.blind).toBe("fiat24-function");
  });

  it("value on the non-payable function is claimed blind", () => {
    const intent = decodeEvm(tx(USD24, sendByAccount(10365n), "0x1"), SIGNER);
    expect(intent.blind).toBe("fiat24-function");
    expect(intent.outflows).toStrictEqual([
      {
        to: USD24,
        amount: { asset: "native", amount: "1", symbol: "ETH", decimals: 18 },
        verified: true,
      },
    ]);
  });

  it.each([
    ["Ethereum", 1],
    ["Arbitrum Sepolia", 421614],
  ])("the same calldata on %s is claimed blind", (_name, chainId) => {
    const intent = decodeEvm(tx(USD24, sendByAccount(10365n), "0x0", chainId), SIGNER);
    expect(intent.blind).toBe("fiat24-function");
  });

  it("a Fiat24 selector sent to another contract is claimed blind", () => {
    const intent = decodeEvm(tx(OTHER, sendByAccount(10365n)), SIGNER);
    expect(intent.blind).toBe("fiat24-function");
    expect(intent.summary).toBe("contract-call");
  });
});

describe("Fiat24 pinned proxies claim every other call", () => {
  it.each(PROXIES)("an unknown selector on %s is claimed blind", (proxy) => {
    const intent = decodeEvm(tx(proxy, "0xdeadbeef01020304"), SIGNER);
    expect(intent.blind).toBe("fiat24-function");
    expect(intent.verifiability).toBe("opaque");
  });

  it("the account NFT's approve is claimed blind", () => {
    const data = fn(ACCOUNT_ABI, "approve", [OTHER, 123456n]);
    const intent = decodeEvm(tx(ACCOUNT, data), SIGNER);
    expect(intent.blind).toBe("fiat24-function");
  });

  it("the account NFT's setApprovalForAll is claimed blind", () => {
    const data = fn(ACCOUNT_ABI, "setApprovalForAll", [OTHER, true]);
    const intent = decodeEvm(tx(ACCOUNT, data), SIGNER);
    expect(intent.blind).toBe("fiat24-function");
  });

  it("depositByWallet is claimed blind", () => {
    const data = fn(DEPOSIT_ABI, "depositByWallet", [SIGNER, USD24, 5000000n]);
    const intent = decodeEvm(tx(DEPOSIT, data), SIGNER);
    expect(intent.blind).toBe("fiat24-function");
  });

  it("an ERC-721-shaped call on a cash token is claimed blind", () => {
    const data = fn(ACCOUNT_ABI, "setApprovalForAll", [OTHER, true]);
    const intent = decodeEvm(tx(USD24, data), SIGNER);
    expect(intent.blind).toBe("fiat24-function");
  });
});

describe("ERC-20 calls on the cash tokens keep the standard path", () => {
  it("transfer stays a full intent", () => {
    const data = fn(TOKEN_ABI, "transfer", [OTHER, 20000n]);
    const intent = decodeEvm(tx(USD24, data), SIGNER);
    expect(intent.summary).toBe("transfer");
    expect(intent.verifiability).toBe("full");
    expect(intent.outflows[0]?.to.toLowerCase()).toBe(OTHER);
    expect(intent.outflows[0]?.amount.symbol).toBe("USD24");
  });

  it("approve stays partial with no Fiat24 spender", () => {
    const data = fn(TOKEN_ABI, "approve", [OTHER, 20000n]);
    const intent = decodeEvm(tx(USD24, data), SIGNER);
    expect(intent.summary).toBe("approve");
    expect(spenderRole(intent.approvals[0])).toBeUndefined();
    expect(intent.warnings).toStrictEqual([]);
  });

  it("value on a cash token's approve is claimed blind", () => {
    const data = fn(TOKEN_ABI, "approve", [OTHER, 20000n]);
    expect(decodeEvm(tx(USD24, data, "0x1"), SIGNER).blind).toBe("fiat24-function");
  });
});

describe("Fiat24 spender labels and warnings", () => {
  const approve = (token: string, spender: string, amount: bigint, chainId = 42161) =>
    decodeEvm(tx(token, fn(TOKEN_ABI, "approve", [spender, amount]), "0x0", chainId), SIGNER);

  it("labels the card contract and warns about the pull", () => {
    const intent = approve(EUR24, CARD, 500000n);
    expect(spenderRole(intent.approvals[0])).toBe("card");
    expect(intent.warnings).toStrictEqual([{ kind: "fiat24-card-pull", message: "card" }]);
  });

  it("a zero allowance to the card warns nothing", () => {
    const intent = approve(EUR24, CARD, 0n);
    expect(spenderRole(intent.approvals[0])).toBe("card");
    expect(intent.warnings).toStrictEqual([]);
  });

  it("an unlimited card allowance warns both pulls and danger", () => {
    const intent = approve(EUR24, CARD, maxUint256);
    expect(intent.warnings).toStrictEqual([
      { kind: "fiat24-card-pull", message: "card" },
      { kind: "fiat24-unlimited-approval", level: "danger", message: "card" },
    ]);
  });

  it("increaseAllowance to the card warns about the pull", () => {
    const data = fn(TOKEN_ABI, "increaseAllowance", [CARD, 1000n]);
    const intent = decodeEvm(tx(USD24, data), SIGNER);
    expect(spenderRole(intent.approvals[0])).toBe("card");
    expect(intent.warnings.some((w) => w.kind === "fiat24-card-pull")).toBe(true);
  });

  it("decreaseAllowance to the card is labelled but warns nothing", () => {
    const data = fn(TOKEN_ABI, "decreaseAllowance", [CARD, 1000n]);
    const intent = decodeEvm(tx(USD24, data), SIGNER);
    expect(spenderRole(intent.approvals[0])).toBe("card");
    expect(intent.warnings).toStrictEqual([]);
  });

  it("labels the deposit contract without a pull warning", () => {
    const intent = approve(USD24, DEPOSIT, 500000n);
    expect(spenderRole(intent.approvals[0])).toBe("deposit");
    expect(intent.warnings).toStrictEqual([]);
  });

  it("an unlimited deposit allowance is a danger warning", () => {
    const intent = approve(USD24, DEPOSIT, maxUint256);
    expect(intent.warnings).toStrictEqual([
      { kind: "fiat24-unlimited-approval", level: "danger", message: "deposit" },
    ]);
  });

  it("labels apply to any token's approvals, not only the cash tokens", () => {
    const intent = approve(USDC_ARB, CARD, 5000000n);
    expect(spenderRole(intent.approvals[0])).toBe("card");
    expect(intent.warnings.some((w) => w.kind === "fiat24-card-pull")).toBe(true);
  });

  it("labels apply only on Arbitrum One", () => {
    const intent = approve(USDC_MAINNET, CARD, 5000000n, 1);
    expect(spenderRole(intent.approvals[0])).toBeUndefined();
    expect(intent.warnings).toStrictEqual([]);
  });

  it("an unrelated spender is not labelled", () => {
    const intent = approve(EUR24, OTHER, 500000n);
    expect(spenderRole(intent.approvals[0])).toBeUndefined();
    expect(intent.warnings).toStrictEqual([]);
  });
});

describe("Fiat24 moneyExchange", () => {
  const exchangeIn = (input: string, output: string, amount: bigint) =>
    fn(DEPOSIT_ABI, "moneyExchangeExactIn", [input, output, amount]);
  const exchangeOut = (input: string, output: string, amount: bigint) =>
    fn(DEPOSIT_ABI, "moneyExchangeExactOut", [input, output, amount]);

  it("exact-in describes the pay side and the issuer-rate receive", () => {
    const intent = decodeEvm(tx(DEPOSIT, exchangeIn(USD24, EUR24, 20000n)), SIGNER);
    expect(intent.summary).toBe("swap");
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows).toStrictEqual([
      {
        to: DEPOSIT,
        amount: { asset: USD24, amount: "20000", symbol: "USD24", decimals: 2 },
        verified: true,
      },
    ]);
    expect(intent.fiat24).toStrictEqual({
      kind: "exchange",
      side: "exact-in",
      receive: { asset: EUR24, symbol: "EUR24", decimals: 2 },
    });
    expect(intent.minimumReceived).toBeUndefined();
    expect(intent.warnings).toStrictEqual([{ kind: "fiat24-issuer-rate", message: "" }]);
  });

  it("exact-out names the pay token, the receive amount and both warnings", () => {
    const intent = decodeEvm(tx(DEPOSIT, exchangeOut(USD24, EUR24, 30000n)), SIGNER);
    expect(intent.summary).toBe("swap");
    expect(intent.outflows).toStrictEqual([]);
    expect(intent.fiat24).toStrictEqual({
      kind: "exchange",
      side: "exact-out",
      pay: { asset: USD24, symbol: "USD24", decimals: 2 },
      receive: { asset: EUR24, amount: "30000", symbol: "EUR24", decimals: 2 },
    });
    expect(intent.warnings.map((w) => w.kind)).toStrictEqual([
      "fiat24-issuer-rate",
      "fiat24-exact-out-unbounded",
    ]);
  });

  it.each([
    ["exact-in, non-cash input", exchangeIn(USDC_ARB, EUR24, 20000n)],
    ["exact-in, non-cash output", exchangeIn(USD24, USDC_ARB, 20000n)],
    ["exact-in, same token in and out", exchangeIn(USD24, USD24, 20000n)],
    ["exact-out, non-cash input", exchangeOut(USDC_ARB, EUR24, 20000n)],
    ["exact-out, non-cash output", exchangeOut(USD24, USDC_ARB, 20000n)],
    ["exact-out, same token in and out", exchangeOut(CHF24, CHF24, 20000n)],
    ["trailing bytes", `${exchangeIn(USD24, EUR24, 20000n)}0011`],
    ["truncated calldata", exchangeIn(USD24, EUR24, 20000n).slice(0, -8)],
    ["truncated exact-out", exchangeOut(USD24, EUR24, 30000n).slice(0, -8)],
  ])("a near miss is claimed blind: %s", (_name, data) => {
    const intent = decodeEvm(tx(DEPOSIT, data), SIGNER);
    expect(intent.blind).toBe("fiat24-function");
  });

  it("value on an exchange is claimed blind", () => {
    const intent = decodeEvm(tx(DEPOSIT, exchangeIn(USD24, EUR24, 20000n), "0x1"), SIGNER);
    expect(intent.blind).toBe("fiat24-function");
  });

  it("an exchange to another chain or contract is claimed blind", () => {
    expect(decodeEvm(tx(DEPOSIT, exchangeIn(USD24, EUR24, 20000n), "0x0", 1), SIGNER).blind).toBe(
      "fiat24-function",
    );
    expect(decodeEvm(tx(OTHER, exchangeIn(USD24, EUR24, 20000n)), SIGNER).blind).toBe(
      "fiat24-function",
    );
  });
});

describe("Fiat24 calls inside a batch", () => {
  it("inner warnings concatenate and inner approvals are labelled", () => {
    const approveCard = fn(TOKEN_ABI, "approve", [CARD, maxUint256]);
    const toInternal = sendByAccount(9102n);
    const data = encodeBatchExecute([
      { to: USD24, value: 0n, data: approveCard },
      { to: USD24, value: 0n, data: toInternal },
    ]);
    const intent = decodeEvm(tx(SIGNER, data), SIGNER);
    expect(intent.summary).toBe("batch");
    expect(intent.warnings).toStrictEqual([
      { kind: "fiat24-card-pull", message: "card" },
      { kind: "fiat24-unlimited-approval", level: "danger", message: "card" },
      { kind: "fiat24-internal-account", message: "9102" },
    ]);
    expect(spenderRole(intent.calls?.[0]?.approvals[0])).toBe("card");
    expect(intent.calls?.[1]?.outflows[0]?.fiat24).toStrictEqual({ account: "9102" });
  });

  it("a card approval plus an exchange keeps every warning", () => {
    const data = encodeBatchExecute([
      { to: USD24, value: 0n, data: fn(TOKEN_ABI, "approve", [CARD, maxUint256]) },
      {
        to: DEPOSIT,
        value: 0n,
        data: fn(DEPOSIT_ABI, "moneyExchangeExactIn", [USD24, EUR24, 20000n]),
      },
    ]);
    const intent = decodeEvm(tx(SIGNER, data), SIGNER);
    expect(intent.warnings.map((w) => w.kind)).toStrictEqual([
      "fiat24-card-pull",
      "fiat24-unlimited-approval",
      "fiat24-issuer-rate",
    ]);
    expect(intent.calls?.[1]?.fiat24).toStrictEqual({
      kind: "exchange",
      side: "exact-in",
      receive: { asset: EUR24, symbol: "EUR24", decimals: 2 },
    });
  });
});

describe("Fiat24 payouts", () => {
  it("clientPayout describes the bank payout by payee id", () => {
    const data = fn(TOKEN_ABI, "clientPayout", [20000n, "peggy"]);
    const intent = decodeEvm(tx(USD24, data), SIGNER);
    expect(intent.summary).toBe("payout");
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows).toStrictEqual([
      {
        to: USD24,
        amount: { asset: USD24, amount: "20000", symbol: "USD24", decimals: 2 },
        verified: true,
        fiat24: { payee: "peggy" },
      },
    ]);
    expect(intent.fiat24).toStrictEqual({ kind: "payout", contactId: "peggy" });
    expect(intent.warnings).toStrictEqual([{ kind: "fiat24-payee-offchain", message: "" }]);
  });

  it("clientPayoutRef keeps the purpose id decimal and the reference verbatim", () => {
    const ref = "rent march\r\nGMT";
    const data = fn(TOKEN_ABI, "clientPayoutRef", [30000n, "peggy", 42n, ref]);
    const intent = decodeEvm(tx(EUR24, data), SIGNER);
    expect(intent.summary).toBe("payout");
    expect(intent.fiat24).toStrictEqual({
      kind: "payout",
      contactId: "peggy",
      purposeId: "42",
      ref,
    });
    expect(intent.outflows[0]?.fiat24).toStrictEqual({ payee: "peggy" });
    expect(intent.warnings).toStrictEqual([{ kind: "fiat24-payee-offchain", message: "" }]);
  });

  it.each([
    ["value on clientPayout", fn(TOKEN_ABI, "clientPayout", [20000n, "peggy"]), "0x1"],
    ["trailing bytes", `${fn(TOKEN_ABI, "clientPayout", [20000n, "peggy"])}0011`, "0x0"],
    ["truncated calldata", fn(TOKEN_ABI, "clientPayout", [20000n, "peggy"]).slice(0, -10), "0x0"],
  ])("a near miss is claimed blind: %s", (_name, data, value) => {
    const intent = decodeEvm(tx(USD24, data, value), SIGNER);
    expect(intent.blind).toBe("fiat24-function");
  });

  it("a non-canonical string offset is claimed blind", () => {
    /* clientPayout head is (amount, offset): pushing the string tail 32 bytes further is a
       valid but non-canonical encoding of the same call — the decoder refuses it. */
    const canonical = fn(TOKEN_ABI, "clientPayout", [1000n, "peggy"]);
    const tail = canonical.slice(138);
    const data = `${canonical.slice(0, 74)}${"60".padStart(64, "0")}${"0".repeat(64)}${tail}`;
    const intent = decodeEvm(tx(USD24, data), SIGNER);
    expect(intent.blind).toBe("fiat24-function");
  });
});

describe("Fiat24 account minting", () => {
  it("mintByClient opens the account for the caller", () => {
    const data = fn(ACCOUNT_ABI, "mintByClient", [123456n]);
    const intent = decodeEvm(tx(ACCOUNT, data), SIGNER);
    expect(intent.summary).toBe("contract-call");
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows).toStrictEqual([]);
    expect(intent.fiat24).toStrictEqual({ kind: "open-account", account: "123456" });
    expect(intent.warnings).toStrictEqual([{ kind: "fiat24-account-link", message: "" }]);
  });

  it("mintByClientWithETH pays the fee in ETH to the account contract", () => {
    const data = fn(ACCOUNT_ABI, "mintByClientWithETH", [123456n]);
    const intent = decodeEvm(tx(ACCOUNT, data, "0xde0b6b3a7640000"), SIGNER);
    expect(intent.outflows).toStrictEqual([
      {
        to: ACCOUNT,
        amount: {
          asset: "native",
          amount: "1000000000000000000",
          symbol: "ETH",
          decimals: 18,
        },
        verified: true,
      },
    ]);
    expect(intent.fiat24).toStrictEqual({ kind: "open-account", account: "123456" });
    expect(intent.warnings).toStrictEqual([{ kind: "fiat24-account-link", message: "" }]);
  });

  it("zero value on the payable mint is claimed blind", () => {
    const intent = decodeEvm(tx(ACCOUNT, fn(ACCOUNT_ABI, "mintByClientWithETH", [1n])), SIGNER);
    expect(intent.blind).toBe("fiat24-function");
  });

  it("value on the non-payable mint is claimed blind", () => {
    const intent = decodeEvm(tx(ACCOUNT, fn(ACCOUNT_ABI, "mintByClient", [1n]), "0x1"), SIGNER);
    expect(intent.blind).toBe("fiat24-function");
  });
});

describe("Fiat24 account NFT movement", () => {
  const nftCall = (name: string, args: unknown[]) => fn(ACCOUNT_ABI, name, args);

  it.each([
    ["transferFrom", nftCall("transferFrom", [SIGNER, OTHER, 123456n])],
    ["safeTransferFrom", nftCall("safeTransferFrom", [SIGNER, OTHER, 123456n])],
    ["safeTransferFrom with data", nftCall("safeTransferFrom", [SIGNER, OTHER, 123456n, "0x"])],
  ])("%s of an account token is a danger move", (_name, data) => {
    const intent = decodeEvm(tx(ACCOUNT, data), SIGNER);
    expect(intent.summary).toBe("transfer");
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows).toStrictEqual([
      {
        to: getAddress(OTHER),
        amount: { asset: ACCOUNT, amount: "1", tokenId: "123456" },
        verified: false,
      },
    ]);
    expect(intent.warnings).toStrictEqual([
      {
        kind: "fiat24-account-move",
        level: "danger",
        message: `#123456 → ${getAddress(OTHER)}`,
      },
    ]);
  });

  it("an operator moving another's account is described the same way", () => {
    const data = nftCall("transferFrom", [OTHER, SIGNER, 99n]);
    const intent = decodeEvm(tx(ACCOUNT, data), SIGNER);
    expect(intent.summary).toBe("transfer");
    expect(intent.outflows).toStrictEqual([
      {
        to: SIGNER,
        amount: { asset: ACCOUNT, amount: "1", tokenId: "99" },
        verified: false,
      },
    ]);
    expect(intent.warnings[0]?.kind).toBe("fiat24-account-move");
  });

  it("value on an account move is claimed blind", () => {
    const intent = decodeEvm(
      tx(ACCOUNT, nftCall("transferFrom", [SIGNER, OTHER, 1n]), "0x1"),
      SIGNER,
    );
    expect(intent.blind).toBe("fiat24-function");
  });
});

describe("Fiat24 top-ups", () => {
  it("depositTokenViaUsdc pays USDC in and receives a cash token at the issuer rate", () => {
    const data = fn(DEPOSIT_ABI, "depositTokenViaUsdc", [USDC_ARB, EUR24, 5_000_000n]);
    const intent = decodeEvm(tx(DEPOSIT, data), SIGNER);
    expect(intent.summary).toBe("swap");
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows).toStrictEqual([
      {
        to: DEPOSIT,
        amount: { asset: USDC_ARB, amount: "5000000", symbol: "USDC", decimals: 6 },
        verified: true,
      },
    ]);
    expect(intent.fiat24).toStrictEqual({
      kind: "top-up",
      receive: { asset: EUR24, symbol: "EUR24", decimals: 2 },
    });
    expect(intent.warnings).toStrictEqual([{ kind: "fiat24-issuer-rate", message: "" }]);
  });

  it("a non-USDC input adds the swap-quote warning", () => {
    const data = fn(DEPOSIT_ABI, "depositTokenViaUsdc", [USD24, EUR24, 5000n]);
    const intent = decodeEvm(tx(DEPOSIT, data), SIGNER);
    expect(intent.warnings).toStrictEqual([
      { kind: "fiat24-issuer-rate", message: "" },
      { kind: "fiat24-swap-quote", message: "" },
    ]);
  });

  it("an unlisted input pays unverified base units", () => {
    const data = fn(DEPOSIT_ABI, "depositTokenViaEth", [OTHER, USD24, 5n]);
    const intent = decodeEvm(tx(DEPOSIT, data), SIGNER);
    expect(intent.outflows).toStrictEqual([
      { to: DEPOSIT, amount: { asset: getAddress(OTHER), amount: "5" }, verified: false },
    ]);
    expect(intent.warnings).toStrictEqual([
      { kind: "fiat24-issuer-rate", message: "" },
      { kind: "fiat24-swap-quote", message: "" },
    ]);
  });

  it("depositETH pays ETH in and always warns the in-transaction swap", () => {
    const data = fn(DEPOSIT_ABI, "depositETH", [CNH24]);
    const intent = decodeEvm(tx(DEPOSIT, data, "0xde0b6b3a7640000"), SIGNER);
    expect(intent.outflows).toStrictEqual([
      {
        to: DEPOSIT,
        amount: {
          asset: "native",
          amount: "1000000000000000000",
          symbol: "ETH",
          decimals: 18,
        },
        verified: true,
      },
    ]);
    expect(intent.fiat24).toStrictEqual({
      kind: "top-up",
      receive: { asset: CNH24, symbol: "CNH24", decimals: 2 },
    });
    expect(intent.warnings).toStrictEqual([
      { kind: "fiat24-issuer-rate", message: "" },
      { kind: "fiat24-swap-quote", message: "" },
    ]);
  });

  it.each([
    [
      "value on depositTokenViaUsdc",
      fn(DEPOSIT_ABI, "depositTokenViaUsdc", [USDC_ARB, EUR24, 5n]),
      "0x1",
    ],
    [
      "value on depositTokenViaEth",
      fn(DEPOSIT_ABI, "depositTokenViaEth", [USDC_ARB, EUR24, 5n]),
      "0x1",
    ],
    ["zero value on depositETH", fn(DEPOSIT_ABI, "depositETH", [EUR24]), "0x0"],
    [
      "a non-cash output on depositTokenViaUsdc",
      fn(DEPOSIT_ABI, "depositTokenViaUsdc", [USDC_ARB, OTHER, 5n]),
      "0x0",
    ],
    ["a non-cash output on depositETH", fn(DEPOSIT_ABI, "depositETH", [OTHER]), "0x1"],
    [
      "a non-cash output on depositTokenViaEth",
      fn(DEPOSIT_ABI, "depositTokenViaEth", [USDC_ARB, OTHER, 5n]),
      "0x0",
    ],
    [
      "trailing bytes on depositTokenViaUsdc",
      `${fn(DEPOSIT_ABI, "depositTokenViaUsdc", [USDC_ARB, EUR24, 5n])}0011`,
      "0x0",
    ],
  ])("a near miss is claimed blind: %s", (_name, data, value) => {
    const intent = decodeEvm(tx(DEPOSIT, data, value), SIGNER);
    expect(intent.blind).toBe("fiat24-function");
  });

  it("a USDC input spelled in another case is still USDC", () => {
    const data = fn(DEPOSIT_ABI, "depositTokenViaUsdc", [
      USDC_ARB.toLowerCase(),
      EUR24,
      5_000_000n,
    ]);
    const intent = decodeEvm(tx(DEPOSIT, data), SIGNER);
    expect(intent.warnings).toStrictEqual([{ kind: "fiat24-issuer-rate", message: "" }]);
  });
});
