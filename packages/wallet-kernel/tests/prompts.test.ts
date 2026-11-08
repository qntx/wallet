/**
 * Kernel-owned verification prompt text: exact strings for every core prompt kind, the chain prompt
 * per verifiability level, and every Spark approval kind, in both catalogs.
 */
import { describe, expect, it } from "vite-plus/test";

import { chainPrompt, MESSAGE_INTENT, messageIntent } from "../src/modules/chains/prompt.ts";
import type { PromptIntent } from "../src/modules/chains/prompt.ts";
import { sparkPrompt } from "../src/modules/spark/prompt.ts";
import { backupCredentialName, corePrompt, formatUnits, promptLocale } from "../src/prompts.ts";

const TO = "0x00000000000000000000000000000000DeaDBeef";
const SPENDER = "0x1111111254EEB25477B68fb85Ed929f73A960582";
const USDC = "eip155:1/erc20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const ethTransfer: PromptIntent = {
  summary: "transfer",
  outflows: [
    {
      to: TO,
      amount: {
        asset: "eip155:1/slip44:60",
        amount: "50000000000000000",
        decimals: 18,
        symbol: "ETH",
      },
      verified: true,
    },
  ],
  approvals: [],
  fee: {
    max: { asset: "eip155:1/slip44:60", amount: "400000000000000", decimals: 18, symbol: "ETH" },
  },
  verifiability: "full",
};

describe("prompt locale and amounts", () => {
  it.each([
    ["zh", "zh-Hans"],
    ["zh-TW", "zh-Hans"],
    ["ZH-hant-HK", "zh-Hans"],
    ["en-US", "en"],
    ["ja-JP", "en"],
    ["", "en"],
  ] as const)("%s → %s", (tag, locale) => {
    expect(promptLocale(tag)).toBe(locale);
  });

  it.each([
    ["50000000000000000", 18, "0.05"],
    ["1000000", 6, "1"],
    ["1234567", 6, "1.234567"],
    ["1", 18, "0.000000000000000001"],
    ["0", 6, "0"],
    ["123", 0, "123"],
    ["340282366920938463463374607431768211455", 18, "340282366920938463463.374607431768211455"],
  ] as const)("formatUnits(%s, %d) = %s", (amount, decimals, expected) => {
    expect(formatUnits(amount, decimals)).toBe(expected);
  });
});

describe("core prompts", () => {
  it("has the exact catalog text", () => {
    expect(corePrompt("zh-Hans", "unlock")).toStrictEqual({
      title: "解锁钱包",
      description: "验证身份以解锁钱包",
    });
    expect(corePrompt("en", "reset")).toStrictEqual({
      title: "Reset wallet",
      description: "Verify you own this device to erase all wallet data on it",
    });
    expect(corePrompt("zh-Hans", "export-mnemonic").title).toBe("导出助记词");
    expect(corePrompt("en", "create").title).toBe("Protect wallet");
  });
});

describe("chain prompts", () => {
  it("full: every outflow and the fee cap, addresses in full", () => {
    expect(chainPrompt("zh-Hans", ethTransfer)).toStrictEqual({
      title: "确认转账",
      description: `发送 0.05 ETH 到 ${TO}\n最高手续费 0.0004 ETH`,
    });
    expect(chainPrompt("en", ethTransfer)).toStrictEqual({
      title: "Confirm transfer",
      description: `Send 0.05 ETH to ${TO}\nMax fee 0.0004 ETH`,
    });
  });

  it("an amount without decimals shows raw units and the asset id", () => {
    const intent: PromptIntent = {
      ...ethTransfer,
      outflows: [{ to: TO, amount: { asset: USDC, amount: "2500000" }, verified: false }],
      fee: undefined,
    };
    expect(chainPrompt("en", intent).description).toBe(`Send 2500000 ${USDC} to ${TO}`);
  });

  it("approvals: limited and unlimited", () => {
    const intent: PromptIntent = {
      summary: "approve",
      outflows: [],
      approvals: [
        {
          kind: "allowance",
          spender: SPENDER,
          amount: { asset: USDC, amount: "1000000" },
          change: "set",
          unlimited: false,
          verified: true,
        },
        {
          kind: "allowance",
          spender: SPENDER,
          amount: { asset: USDC, amount: "0" },
          change: "set",
          unlimited: true,
          verified: true,
        },
      ],
      fee: undefined,
      verifiability: "full",
    };
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认授权",
      description: `授权 ${SPENDER} 使用 1000000 ${USDC}\n授权 ${SPENDER} 使用 全部 ${USDC}`,
    });
    expect(chainPrompt("en", intent).description).toBe(
      `Allow ${SPENDER} to spend 1000000 ${USDC}\nAllow ${SPENDER} to spend unlimited ${USDC}`,
    );
  });

  const allowance = (over: Record<string, unknown>) =>
    ({
      kind: "allowance",
      spender: SPENDER,
      amount: { asset: USDC, amount: "2500000", symbol: "USDC", decimals: 6 },
      change: "set",
      unlimited: false,
      verified: true,
      ...over,
    }) as PromptIntent["approvals"][number];
  const approveIntent = (...approvals: PromptIntent["approvals"]): PromptIntent => ({
    summary: "approve",
    outflows: [],
    approvals,
    fee: undefined,
    verifiability: "full",
  });
  const text = (locale: "en" | "zh-Hans", ...approvals: PromptIntent["approvals"]) =>
    chainPrompt(locale, approveIntent(...approvals)).description;

  it("allowance: set, unlimited, revoke, increase, decrease", () => {
    expect(text("en", allowance({}))).toBe(`Allow ${SPENDER} to spend 2.5 USDC`);
    expect(text("zh-Hans", allowance({}))).toBe(`授权 ${SPENDER} 使用 2.5 USDC`);
    const unlimited = allowance({ unlimited: true });
    expect(text("en", unlimited)).toBe(`Allow ${SPENDER} to spend unlimited USDC`);
    expect(text("zh-Hans", unlimited)).toBe(`授权 ${SPENDER} 使用 全部 USDC`);
    const zero = allowance({ amount: { asset: USDC, amount: "0", symbol: "USDC", decimals: 6 } });
    expect(text("en", zero)).toBe(`Revoke ${SPENDER}'s allowance for USDC`);
    expect(text("zh-Hans", zero)).toBe(`撤销 ${SPENDER} 对 USDC 的授权`);
    expect(text("en", allowance({ change: "increase" }))).toBe(
      `Allow ${SPENDER} to spend 2.5 USDC more`,
    );
    expect(text("zh-Hans", allowance({ change: "increase" }))).toBe(
      `授权 ${SPENDER} 再使用 2.5 USDC`,
    );
    expect(text("en", allowance({ change: "decrease" }))).toBe(
      `Reduce ${SPENDER}'s allowance by 2.5 USDC`,
    );
    expect(text("zh-Hans", allowance({ change: "decrease" }))).toBe(
      `减少 ${SPENDER} 的授权额度 2.5 USDC`,
    );
  });

  it("allowance: unknown token shows raw units and the asset id", () => {
    const raw = allowance({ amount: { asset: USDC, amount: "7" } });
    expect(text("en", raw)).toBe(`Allow ${SPENDER} to spend 7 ${USDC}`);
  });

  it("allowance: Permit2 suffix and UTC expiry", () => {
    const permit = allowance({ via: "permit2", expiration: 1_800_000_000 });
    expect(text("en", permit)).toBe(
      `Allow ${SPENDER} to spend 2.5 USDC via Permit2 until 2027-01-15 (UTC)`,
    );
    expect(text("zh-Hans", permit)).toBe(
      `授权 ${SPENDER} 使用 2.5 USDC 经 Permit2 至 2027-01-15（UTC）`,
    );
    const lockdown = allowance({
      via: "permit2",
      amount: { asset: USDC, amount: "0", symbol: "USDC", decimals: 6 },
    });
    expect(text("en", lockdown)).toBe(`Revoke ${SPENDER}'s allowance for USDC via Permit2`);
    expect(text("en", allowance({ expiration: 0, via: "permit2" }))).toBe(
      `Allow ${SPENDER} to spend 2.5 USDC via Permit2`,
    );
  });

  it.each([
    [1, "1970-01-01"],
    [951_782_400, "2000-02-29"],
    [1_709_164_799, "2024-02-28"],
    [1_709_164_800, "2024-02-29"],
    [4_102_444_800, "2100-01-01"],
  ] as const)("expiry %d renders as %s in UTC", (expiration, date) => {
    const line = text("en", allowance({ via: "permit2", expiration }));
    expect(line).toContain(`until ${date} (UTC)`);
  });

  it("allowance: one-time transfer right, limited and unlimited, with Permit2 and expiry", () => {
    const once = allowance({ change: "transfer", via: "permit2", expiration: 1_800_000_000 });
    expect(text("en", once)).toBe(
      `Allow ${SPENDER} to take 2.5 USDC once via Permit2 until 2027-01-15 (UTC)`,
    );
    expect(text("zh-Hans", once)).toBe(
      `授权 ${SPENDER} 一次性转走 2.5 USDC 经 Permit2 至 2027-01-15（UTC）`,
    );
    const unlimited = allowance({ change: "transfer", unlimited: true });
    expect(text("en", unlimited)).toBe(`Allow ${SPENDER} to take unlimited USDC once`);
    expect(text("zh-Hans", unlimited)).toBe(`授权 ${SPENDER} 一次性转走 全部 USDC`);
  });

  it("a one-time transfer right without an expiration has no until suffix", () => {
    const once = allowance({ change: "transfer", via: "permit2" });
    expect(text("en", once)).toBe(`Allow ${SPENDER} to take 2.5 USDC once via Permit2`);
    expect(text("zh-Hans", once)).toBe(`授权 ${SPENDER} 一次性转走 2.5 USDC 经 Permit2`);
  });

  it("operator approval and revocation", () => {
    const grant = {
      kind: "operator",
      asset: USDC,
      spender: SPENDER,
      approved: true,
      verified: false,
    } as const;
    const revoke = { ...grant, approved: false } as const;
    expect(text("en", grant)).toBe(`Allow ${SPENDER} to transfer all tokens of ${USDC}`);
    expect(text("zh-Hans", grant)).toBe(`授权 ${SPENDER} 转走 ${USDC} 的全部代币`);
    expect(text("en", revoke)).toBe(`Revoke ${SPENDER}'s access to all tokens of ${USDC}`);
    expect(text("zh-Hans", revoke)).toBe(`撤销 ${SPENDER} 对 ${USDC} 全部代币的授权`);
  });

  it("partial leads with the other-outflows warning", () => {
    const intent: PromptIntent = {
      ...ethTransfer,
      summary: "contract-call",
      verifiability: "partial",
    };
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认合约调用",
      description: `可能还有其他转出\n发送 0.05 ETH 到 ${TO}\n最高手续费 0.0004 ETH`,
    });
  });

  it("delegation set and revoke render their lines", () => {
    const set: PromptIntent = {
      ...ethTransfer,
      summary: "authorization",
      outflows: [],
      delegation: {
        kind: "set",
        delegator: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
        name: "EIP7702StatelessDeleGator",
        version: "1.3.0",
      },
    };
    expect(chainPrompt("en", set)).toStrictEqual({
      title: "Confirm account authorization",
      description:
        "Delegate this account to EIP7702StatelessDeleGator v1.3.0; the contract can execute calls on its behalf\nMax fee 0.0004 ETH",
    });
    expect(chainPrompt("en", { ...set, delegation: { kind: "revoke" } })).toStrictEqual({
      title: "Confirm account authorization",
      description: "Revoke this account's contract delegation\nMax fee 0.0004 ETH",
    });
  });

  it("opaque and messages show only the generic line", () => {
    expect(chainPrompt("en", { ...ethTransfer, verifiability: "opaque" })).toStrictEqual({
      title: "Confirm transfer",
      description: "Sign a request from an app",
    });
    expect(chainPrompt("zh-Hans", MESSAGE_INTENT)).toStrictEqual({
      title: "确认签名",
      description: "签署来自应用的请求",
    });
  });

  it("message bytes prompt a blind sign in both locales", () => {
    const evm = { ...MESSAGE_INTENT, message: { kind: "bytes" as const, hex: "0xff" } };
    expect(chainPrompt("en", evm)).toStrictEqual({
      title: "Confirm blind signing",
      description: "Sign data that cannot be shown as text",
    });
    expect(chainPrompt("zh-Hans", evm)).toStrictEqual({
      title: "确认盲签",
      description: "签署无法显示为文字的数据",
    });
    const solana = messageIntent(new Uint8Array([0xff]));
    expect(solana.message).toStrictEqual({ kind: "bytes", hex: "0xff" });
    expect(chainPrompt("en", solana)).toStrictEqual({
      title: "Confirm blind signing",
      description: "Sign data that cannot be shown as text",
    });
    const text = messageIntent(new TextEncoder().encode("hello"));
    expect(chainPrompt("en", text)).toStrictEqual({
      title: "Confirm signature",
      description: "Sign a request from an app",
    });
  });
});

describe("spark prompts", () => {
  const key = new Uint8Array(33).fill(2);
  const keyHex = "02".repeat(33);
  const hash = new Uint8Array(32).fill(0xab);
  const hashHex = "ab".repeat(32);

  it("transfer lists every receiver", () => {
    expect(
      sparkPrompt("zh-Hans", {
        kind: "transfer",
        receivers: [{ identityPublicKey: key, amountSats: 1000 }],
      }),
    ).toStrictEqual({ title: "确认 Spark 转账", description: `发送 1000 sats 到 ${keyHex}` });
  });

  it("lightning with and without an invoice amount", () => {
    expect(
      sparkPrompt("en", {
        kind: "lightning",
        paymentHash: hash,
        invoiceAmountSats: 2100,
        maxFeeSats: 10,
      }),
    ).toStrictEqual({
      title: "Confirm Lightning payment",
      description: `Pay 2100 sats, payment hash ${hashHex}\nMax fee 10 sats`,
    });
    expect(
      sparkPrompt("zh-Hans", { kind: "lightning", paymentHash: hash, maxFeeSats: 10 }).description,
    ).toBe(`支付闪电发票，付款哈希 ${hashHex}\n最高手续费 10 sats`);
  });

  it("exit, onchain and token", () => {
    const address = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
    expect(
      sparkPrompt("en", { kind: "exit", address, amountSats: 50_000, maxFeeSats: 300 }),
    ).toStrictEqual({
      title: "Confirm withdrawal",
      description: `Withdraw 50000 sats to ${address}\nMax fee 300 sats`,
    });
    expect(sparkPrompt("zh-Hans", { kind: "onchain", address, maxFeeSats: 500 })).toStrictEqual({
      title: "确认链上发送",
      description: `发送到 ${address}，最高手续费 500 sats`,
    });
    expect(
      sparkPrompt("en", {
        kind: "token",
        tokenIdentifier: hash,
        receivers: [{ ownerPublicKey: key, amount: "42" }],
      }),
    ).toStrictEqual({
      title: "Confirm token transfer",
      description: `Send 42 of token ${hashHex} to ${keyHex}`,
    });
  });
});

describe("backup credential name", () => {
  it("names the protection credential apart from wallet passkeys, per locale", () => {
    expect(backupCredentialName("en")).toBe("Cloud backup key");
    expect(backupCredentialName("zh-Hans")).toBe("云备份密钥");
  });
});

describe("sighash-single-anyonecanpay caution", () => {
  const listing: PromptIntent = {
    summary: "transfer",
    outflows: [{ to: "bc1qpayee", amount: { asset: "sats", amount: "90000" }, verified: true }],
    approvals: [],
    fee: undefined,
    verifiability: "partial",
    warnings: [
      {
        kind: "sighash-single-anyonecanpay",
        message:
          "signed inputs bind only their same-index outputs; the rest of the transaction can change",
      },
    ],
  };

  it("adds the same-index line in both locales, also on an opaque intent", () => {
    expect(chainPrompt("en", listing).description).toContain(
      "Signed inputs bind only their same-index outputs; the rest of the transaction can change",
    );
    expect(chainPrompt("zh-Hans", listing).description).toContain(
      "已签输入只绑定同序号输出，交易其余部分可被改动",
    );
    expect(chainPrompt("en", { ...listing, verifiability: "opaque" }).description).toContain(
      "same-index outputs",
    );
  });

  it("leaves other prompts untouched", () => {
    expect(chainPrompt("en", { ...listing, warnings: [] }).description).not.toContain("same-index");
  });
});
