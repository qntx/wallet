import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
/**
 * Kernel-owned verification prompt text: exact strings for every core prompt kind, the chain prompt
 * per verifiability level, and every Spark approval kind, in both catalogs.
 */
import { base58 } from "@scure/base";
import { Transaction } from "@scure/btc-signer/transaction.js";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import type { DisplayIntent, IntentWarningKind, OffchainOrder } from "@qntx/wallet-chains";
import { decodeBitcoinPsbt } from "@qntx/wallet-chains/bitcoin";
import { checksumEvmAddress, decodeEvm, encodeBatchExecute } from "@qntx/wallet-chains/evm";
import { decodeSolana, normalizeSolana } from "@qntx/wallet-chains/solana";
import { buildTronRawData, decodeTron } from "@qntx/wallet-chains/tron";

import { KernelError } from "../src/errors.ts";
import { CATALOGS, chainPrompt, messagePromptIntent } from "../src/modules/chains/prompt.ts";
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
    expect(corePrompt("en", "enable-blind-signing")).toStrictEqual({
      title: "Allow blind signing",
      description:
        "Verify your identity to allow signing requests whose content the wallet cannot show",
    });
    expect(corePrompt("en", "disable-blind-signing")).toStrictEqual({
      title: "Turn off blind signing",
      description: "Verify your identity to stop signing requests the wallet cannot show",
    });
    expect(corePrompt("zh-Hans", "enable-blind-signing")).toStrictEqual({
      title: "允许盲签",
      description: "验证身份以允许签署钱包无法显示内容的请求",
    });
    expect(corePrompt("zh-Hans", "disable-blind-signing")).toStrictEqual({
      title: "关闭盲签",
      description: "验证身份以停止签署钱包无法显示内容的请求",
    });
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
    expect(chainPrompt("en", intent).description).toBe(
      `Send 2500000 base units of unverified token ${USDC} to ${TO}\nFee unknown`,
    );
  });

  it("approvals: limited and unlimited", () => {
    const intent: PromptIntent = {
      summary: "approve",
      outflows: [],
      approvals: [
        {
          kind: "allowance",
          spender: SPENDER,
          amount: { asset: USDC, amount: "1000000", decimals: 6, symbol: "USDC" },
          change: "set",
          unlimited: false,
          verified: true,
        },
        {
          kind: "allowance",
          spender: SPENDER,
          amount: { asset: USDC, amount: "0", decimals: 6, symbol: "USDC" },
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
      description: `授权 ${SPENDER} 使用 1 USDC\n授权 ${SPENDER} 使用 全部 USDC\n手续费未知`,
    });
    expect(chainPrompt("en", intent).description).toBe(
      `Allow ${SPENDER} to spend 1 USDC\nAllow ${SPENDER} to spend unlimited USDC\nFee unknown`,
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
    expect(text("en", allowance({}))).toBe(`Allow ${SPENDER} to spend 2.5 USDC\nFee unknown`);
    expect(text("zh-Hans", allowance({}))).toBe(`授权 ${SPENDER} 使用 2.5 USDC\n手续费未知`);
    const unlimited = allowance({ unlimited: true });
    expect(text("en", unlimited)).toBe(`Allow ${SPENDER} to spend unlimited USDC\nFee unknown`);
    expect(text("zh-Hans", unlimited)).toBe(`授权 ${SPENDER} 使用 全部 USDC\n手续费未知`);
    const zero = allowance({ amount: { asset: USDC, amount: "0", symbol: "USDC", decimals: 6 } });
    expect(text("en", zero)).toBe(`Revoke ${SPENDER}'s allowance for USDC\nFee unknown`);
    expect(text("zh-Hans", zero)).toBe(`撤销 ${SPENDER} 对 USDC 的授权\n手续费未知`);
    expect(text("en", allowance({ change: "increase" }))).toBe(
      `Allow ${SPENDER} to spend 2.5 USDC more\nFee unknown`,
    );
    expect(text("zh-Hans", allowance({ change: "increase" }))).toBe(
      `授权 ${SPENDER} 再使用 2.5 USDC\n手续费未知`,
    );
    expect(text("en", allowance({ change: "decrease" }))).toBe(
      `Reduce ${SPENDER}'s allowance by 2.5 USDC\nFee unknown`,
    );
    expect(text("zh-Hans", allowance({ change: "decrease" }))).toBe(
      `减少 ${SPENDER} 的授权额度 2.5 USDC\n手续费未知`,
    );
  });

  it("allowance: unknown token shows raw units and the asset id", () => {
    const raw = allowance({ amount: { asset: USDC, amount: "7" } });
    expect(text("en", raw)).toBe(
      `Allow ${SPENDER} to spend 7 base units of unverified token ${USDC}\nFee unknown`,
    );
  });

  it("allowance: Permit2 suffix and UTC expiry", () => {
    const permit = allowance({ via: "permit2", expiration: 1_800_000_000 });
    expect(text("en", permit)).toBe(
      `Allow ${SPENDER} to spend 2.5 USDC via Permit2 until 2027-01-15 (UTC)\nFee unknown`,
    );
    expect(text("zh-Hans", permit)).toBe(
      `授权 ${SPENDER} 使用 2.5 USDC 经 Permit2 至 2027-01-15（UTC）\n手续费未知`,
    );
    const lockdown = allowance({
      via: "permit2",
      amount: { asset: USDC, amount: "0", symbol: "USDC", decimals: 6 },
    });
    expect(text("en", lockdown)).toBe(
      `Revoke ${SPENDER}'s allowance for USDC via Permit2\nFee unknown`,
    );
    expect(text("en", allowance({ expiration: 0, via: "permit2" }))).toBe(
      `Allow ${SPENDER} to spend 2.5 USDC via Permit2\nFee unknown`,
    );
  });

  it("allowance: a one-time AllowanceHolder grant names the contract", () => {
    const grant = allowance({ change: "transfer", via: "allowance-holder" });
    expect(text("en", grant)).toBe(
      `Allow ${SPENDER} to take 2.5 USDC once via AllowanceHolder\nFee unknown`,
    );
    expect(text("zh-Hans", grant)).toBe(
      `授权 ${SPENDER} 一次性转走 2.5 USDC 经 AllowanceHolder\n手续费未知`,
    );
  });

  it("batch swap: the minimum received renders alongside the delegation line", () => {
    const batch: PromptIntent = {
      summary: "batch",
      outflows: [
        {
          to: TO,
          amount: { asset: USDC, amount: "10000000", symbol: "USDC", decimals: 6 },
          verified: true,
        },
      ],
      approvals: [],
      minimumReceived: [
        {
          to: SPENDER,
          amount: {
            asset: "eip155:1/slip44:60",
            amount: "70000000000000000",
            decimals: 18,
            symbol: "ETH",
          },
        },
      ],
      delegation: {
        kind: "set",
        delegator: TO,
        name: "EIP7702StatelessDeleGator",
        version: "1.3.0",
      },
      fee: undefined,
      verifiability: "partial",
    };
    expect(chainPrompt("en", batch).description).toBe(
      `There may be other outflows\nDelegate this account to EIP7702StatelessDeleGator v1.3.0; the contract can execute calls on its behalf\nSend 10 USDC to ${TO}\nReceive at least 0.07 ETH at ${SPENDER}\nFee unknown`,
    );
  });

  it("swap: shows the minimum received after the outflow", () => {
    const swap: PromptIntent = {
      summary: "swap",
      outflows: [
        {
          to: TO,
          amount: { asset: USDC, amount: "10000000", symbol: "USDC", decimals: 6 },
          verified: true,
        },
      ],
      approvals: [],
      minimumReceived: [
        {
          to: SPENDER,
          amount: {
            asset: "eip155:1/slip44:60",
            amount: "70000000000000000",
            decimals: 18,
            symbol: "ETH",
          },
        },
      ],
      fee: undefined,
      verifiability: "partial",
    };
    expect(chainPrompt("en", swap).description).toBe(
      `There may be other outflows\nSend 10 USDC to ${TO}\nReceive at least 0.07 ETH at ${SPENDER}\nFee unknown`,
    );
    expect(chainPrompt("zh-Hans", swap).description).toBe(
      `可能还有其他转出\n发送 10 USDC 到 ${TO}\n至少收到 0.07 ETH，收款地址 ${SPENDER}\n手续费未知`,
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
      `Allow ${SPENDER} to take 2.5 USDC once via Permit2 until 2027-01-15 (UTC)\nFee unknown`,
    );
    expect(text("zh-Hans", once)).toBe(
      `授权 ${SPENDER} 一次性转走 2.5 USDC 经 Permit2 至 2027-01-15（UTC）\n手续费未知`,
    );
    const unlimited = allowance({ change: "transfer", unlimited: true });
    expect(text("en", unlimited)).toBe(`Allow ${SPENDER} to take unlimited USDC once\nFee unknown`);
    expect(text("zh-Hans", unlimited)).toBe(`授权 ${SPENDER} 一次性转走 全部 USDC\n手续费未知`);
  });

  it("a one-time transfer right without an expiration has no until suffix", () => {
    const once = allowance({ change: "transfer", via: "permit2" });
    expect(text("en", once)).toBe(
      `Allow ${SPENDER} to take 2.5 USDC once via Permit2\nFee unknown`,
    );
    expect(text("zh-Hans", once)).toBe(
      `授权 ${SPENDER} 一次性转走 2.5 USDC 经 Permit2\n手续费未知`,
    );
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
    expect(text("en", grant)).toBe(
      `Allow ${SPENDER} to transfer all tokens of ${USDC}\nFee unknown`,
    );
    expect(text("zh-Hans", grant)).toBe(`授权 ${SPENDER} 转走 ${USDC} 的全部代币\n手续费未知`);
    expect(text("en", revoke)).toBe(
      `Revoke ${SPENDER}'s access to all tokens of ${USDC}\nFee unknown`,
    );
    expect(text("zh-Hans", revoke)).toBe(`撤销 ${SPENDER} 对 ${USDC} 全部代币的授权\n手续费未知`);
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

  it("delegation appears first on opaque intents", () => {
    const set: PromptIntent = {
      ...ethTransfer,
      summary: "batch",
      verifiability: "opaque",
      delegation: {
        kind: "set",
        delegator: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
        name: "EIP7702StatelessDeleGator",
        version: "1.3.0",
      },
    };
    expect(chainPrompt("en", set)).toStrictEqual({
      title: "Confirm batch",
      description: `The wallet cannot verify what this call does\nDelegate this account to EIP7702StatelessDeleGator v1.3.0; the contract can execute calls on its behalf\nSend 0.05 ETH to ${TO}\nMax fee 0.0004 ETH`,
    });
    expect(chainPrompt("en", { ...set, delegation: { kind: "revoke" } }).description).toBe(
      `The wallet cannot verify what this call does\nRevoke this account's contract delegation\nSend 0.05 ETH to ${TO}\nMax fee 0.0004 ETH`,
    );
  });

  it("an unknown fee renders its own line; off-chain messages never get one", () => {
    const partial: PromptIntent = { ...ethTransfer, fee: undefined, verifiability: "partial" };
    expect(chainPrompt("en", partial).description).toContain("Fee unknown");
    expect(chainPrompt("zh-Hans", partial).description).toContain("手续费未知");
    const message: PromptIntent = { ...partial, message: { kind: "text", text: "permit" } };
    expect(chainPrompt("en", message).description).not.toContain("Fee unknown");
    expect(chainPrompt("zh-Hans", message).description).not.toContain("手续费未知");
  });

  it("an opaque transaction still states every fact the signed bytes prove", () => {
    const call: PromptIntent = {
      ...ethTransfer,
      network: "eip155:1",
      summary: "contract-call",
      verifiability: "opaque",
      contract: { address: TO, created: false, selector: "0xdeadbeef" },
    };
    expect(chainPrompt("en", call)).toStrictEqual({
      title: "Confirm contract call",
      description: `Network: Ethereum\nThe wallet cannot verify what this call does\nCall contract ${TO}, function 0xdeadbeef\nSend 0.05 ETH to ${TO}\nMax fee 0.0004 ETH`,
    });
    expect(
      chainPrompt("zh-Hans", { ...call, contract: { address: TO, created: true } }).description,
    ).toBe(
      `网络：Ethereum\n钱包无法核实此调用会做什么\n部署合约 ${TO}\n发送 0.05 ETH 到 ${TO}\n最高手续费 0.0004 ETH`,
    );
  });

  it("a batch names the contract of each opaque call only", () => {
    const inner = (
      verifiability: DisplayIntent["verifiability"],
      address: string,
    ): DisplayIntent => ({
      family: "evm",
      network: "eip155:1",
      summary: "contract-call",
      outflows: [],
      approvals: [],
      fee: undefined,
      warnings: [],
      verifiability,
      contract: { address, created: false, selector: "0xdeadbeef" },
    });
    const batch: PromptIntent = {
      ...ethTransfer,
      summary: "batch",
      outflows: [],
      verifiability: "opaque",
      calls: [inner("partial", SPENDER), inner("opaque", TO)],
    };
    expect(chainPrompt("en", batch).description).toBe(
      `The wallet cannot verify what this call does\nCall contract ${TO}, function 0xdeadbeef\nMax fee 0.0004 ETH`,
    );
  });

  it("message bytes prompt a blind sign in both locales", () => {
    const bytes = messagePromptIntent({ kind: "bytes", hex: "0xff" });
    expect(chainPrompt("en", bytes)).toStrictEqual({
      title: "Confirm blind signing",
      description:
        "The wallet cannot show what this signs. Sign only if you fully trust the app.\nData 0xff",
    });
    expect(chainPrompt("zh-Hans", bytes)).toStrictEqual({
      title: "确认盲签",
      description: "钱包无法显示签署的内容。仅在完全信任该应用时签署。\n数据 0xff",
    });
  });

  it("a text message shows a sanitised, bounded excerpt", () => {
    expect(chainPrompt("en", messagePromptIntent({ kind: "text", text: "hello" }))).toStrictEqual({
      title: "Confirm signature",
      description: "Message:\nhello",
    });
    const hostile = `pay \u202Ebob\n\n\n${"x".repeat(400)}\nhidden`;
    /* A bidi override makes the message blind: hazard line first, then the sanitised excerpt. */
    const hostilePrompt = messagePromptIntent({ kind: "text", text: hostile });
    expect(hostilePrompt.blind).toBe("message-bytes");
    expect(chainPrompt("zh-Hans", hostilePrompt).description).toBe(
      `文本含有隐藏或改变显示顺序的字符（显示为 �）；你看到的可能与签署的内容不同\n消息：\npay \uFFFDbob\n${"x".repeat(
        312,
      )}\n… 还有 94 个字符未显示`,
    );
  });

  it("a TRON permission update names operations by contract id, not bitmap position", () => {
    /* Bitmap bits 7, 31 and 46: bit 7 is unassigned, bit 31 is TriggerSmartContract
       (array position 31 holds id 49, UpdateBrokerageContract — a position lookup
       would name it wrongly) and bit 46 is AccountPermissionUpdateContract. */
    const operations = `0x800000800040${"00".repeat(26)}`;
    const intent: PromptIntent = {
      family: "tron",
      network: "tron:728126428",
      summary: "authorization",
      outflows: [],
      approvals: [],
      fee: undefined,
      verifiability: "partial",
      blind: "tron-permission-update",
      tron: {
        contractType: "AccountPermissionUpdateContract",
        expiration: 1_767_225_660_000,
        permissionUpdate: {
          owner: {
            type: "owner",
            id: 2,
            name: "owner",
            threshold: "1",
            parentId: 0,
            keys: [{ address: "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6", weight: "1" }],
          },
          actives: [
            {
              type: "active",
              id: 2,
              name: "active0",
              threshold: "1",
              parentId: 0,
              operations,
              keys: [{ address: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC", weight: "1" }],
            },
          ],
        },
      },
    };
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description:
        "Account takeover: this gives control of this account to TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6, TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC. Whoever holds these keys can move all of its assets.\n" +
        "Network: TRON\n" +
        'Owner permission "owner": threshold 1; keys TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6 (weight 1)\n' +
        'Active permission "active0": threshold 1; keys TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC (weight 1); allows ContractType 7, TriggerSmartContract, AccountPermissionUpdateContract\n' +
        "Expires 2026-01-01 00:01 (UTC)\n" +
        "Bandwidth or account-activation fees may be charged",
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认盲签",
      description:
        "账户接管：此交易把本账户的控制权交给 TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6、TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC，持有这些密钥的人可以转走全部资产。\n" +
        "网络：TRON\n" +
        "所有者权限「owner」：阈值 1；密钥 TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6（权重 1）\n" +
        "活跃权限「active0」：阈值 1；密钥 TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC（权重 1）；允许 ContractType 7、TriggerSmartContract、AccountPermissionUpdateContract\n" +
        "2026-01-01 00:01（UTC）后失效\n" +
        "可能扣除带宽费或账户激活费",
    });
  });

  it("an active permission with no set operations allows no transactions", () => {
    const intent: PromptIntent = {
      family: "tron",
      network: "tron:728126428",
      summary: "authorization",
      outflows: [],
      approvals: [],
      fee: undefined,
      verifiability: "partial",
      blind: "tron-permission-update",
      tron: {
        contractType: "AccountPermissionUpdateContract",
        expiration: 1_767_225_660_000,
        permissionUpdate: {
          owner: {
            type: "owner",
            id: 2,
            name: "owner",
            threshold: "1",
            parentId: 0,
            keys: [{ address: "TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6", weight: "1" }],
          },
          actives: [
            {
              type: "active",
              id: 2,
              name: "active0",
              threshold: "1",
              parentId: 0,
              operations: `0x${"00".repeat(32)}`,
              keys: [{ address: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC", weight: "1" }],
            },
          ],
        },
      },
    };
    expect(chainPrompt("en", intent).description).toBe(
      "Account takeover: this gives control of this account to TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6, TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC. Whoever holds these keys can move all of its assets.\n" +
        "Network: TRON\n" +
        'Owner permission "owner": threshold 1; keys TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6 (weight 1)\n' +
        'Active permission "active0": threshold 1; keys TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC (weight 1); allows no transactions\n' +
        "Expires 2026-01-01 00:01 (UTC)\n" +
        "Bandwidth or account-activation fees may be charged",
    );
    expect(chainPrompt("zh-Hans", intent).description).toBe(
      "账户接管：此交易把本账户的控制权交给 TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6、TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC，持有这些密钥的人可以转走全部资产。\n" +
        "网络：TRON\n" +
        "所有者权限「owner」：阈值 1；密钥 TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6（权重 1）\n" +
        "活跃权限「active0」：阈值 1；密钥 TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC（权重 1）；不允许任何交易\n" +
        "2026-01-01 00:01（UTC）后失效\n" +
        "可能扣除带宽费或账户激活费",
    );
  });
});

describe("chain prompts via the real decoders", () => {
  const evmReq = (
    network: string,
    over: { readonly to?: string; readonly value?: string; readonly data?: string },
  ) => ({
    kind: "evm.transaction" as const,
    network,
    account: { kind: "hd" as const, walletId: "w", groupIndex: 0, template: "evm" },
    tx: {
      chainId: Number(network.slice(7)),
      to: over.to ?? TO,
      data: over.data ?? "0x",
      value: over.value ?? "0x0",
      nonce: 0,
      gas: "0x5208",
      maxFeePerGas: "0x3b9aca00",
      maxPriorityFeePerGas: "0x3b9aca00",
      accessList: [],
      type: "eip1559" as const,
    },
  });

  it("EVM native transfer on Base names the network and formats wei as ETH", () => {
    const intent = decodeEvm(evmReq("eip155:8453", { value: "0xde0b6b3a7640000" }), TO);
    expect(chainPrompt("en", intent).description).toBe(
      `Network: Base\nSend 1 ETH to ${TO}\nMax fee 0.000021 ETH`,
    );
    expect(chainPrompt("zh-Hans", intent).description).toBe(
      `网络：Base\n发送 1 ETH 到 ${TO}\n最高手续费 0.000021 ETH`,
    );
  });

  it("ERC-20 USDC transfer shows its symbol and decimals", () => {
    const data = `0xa9059cbb${TO.slice(2).toLowerCase().padStart(64, "0")}${(1_000_000).toString(16).padStart(64, "0")}`;
    const intent = decodeEvm(
      evmReq("eip155:1", {
        to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        data,
      }),
      TO,
    );
    expect(chainPrompt("en", intent).description).toBe(
      `Network: Ethereum\nSend 1 USDC to ${TO}\nMax fee 0.000021 ETH`,
    );
  });

  it("an unlisted ERC-20 is an unverified token on a partial intent", () => {
    const data = `0xa9059cbb${TO.slice(2).toLowerCase().padStart(64, "0")}${(1_000_000).toString(16).padStart(64, "0")}`;
    const intent = decodeEvm(
      evmReq("eip155:1", {
        to: "0x2222222222222222222222222222222222222222",
        data,
      }),
      TO,
    );
    expect(chainPrompt("en", intent).description).toBe(
      `Network: Ethereum\nThere may be other outflows\nSend 1000000 base units of unverified token 0x2222222222222222222222222222222222222222 to ${TO}\nMax fee 0.000021 ETH`,
    );
  });

  it("an unknown eip155 chain falls back to a generic label and raw native units", () => {
    const intent = decodeEvm(evmReq("eip155:999999", { value: "0xde0b6b3a7640000" }), TO);
    expect(chainPrompt("en", intent).description).toBe(
      `Network: EVM chain 999999\nSend 1 native to ${TO}\nMax fee 0.000021 native`,
    );
  });

  const SOL_PAYER = base58.encode(new Uint8Array(32).fill(0x11));
  const solTransfer = (): Uint8Array => {
    const payer = new Uint8Array(32).fill(0x11);
    const dest = new Uint8Array(32).fill(0x22);
    const system = base58.decode("11111111111111111111111111111111");
    const budget = base58.decode("ComputeBudget111111111111111111111111111111");
    const price = new Uint8Array(9);
    price[0] = 3;
    new DataView(price.buffer).setBigUint64(1, 1000n, true);
    const transfer = new Uint8Array(12);
    const dv = new DataView(transfer.buffer);
    dv.setUint32(0, 2, true);
    dv.setBigUint64(4, 1_000_000n, true);
    return new Uint8Array([
      1,
      0,
      2,
      4,
      ...payer,
      ...dest,
      ...system,
      ...budget,
      ...new Uint8Array(32).fill(0x33),
      2,
      3,
      0,
      9,
      ...price,
      2,
      2,
      0,
      1,
      12,
      ...transfer,
    ]);
  };

  it("a Solana transfer shows SOL amounts and the max fee", () => {
    const req = normalizeSolana(
      {
        kind: "solana.transaction",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44-change" },
        message: solTransfer(),
      },
      SOL_PAYER,
    ) as never;
    const intent = decodeSolana(req, SOL_PAYER);
    const dest = base58.encode(new Uint8Array(32).fill(0x22));
    expect(chainPrompt("en", intent).description).toBe(
      `Network: Solana\nSend 0.001 SOL to ${dest}\nMax fee 0.000005006 SOL`,
    );
    expect(chainPrompt("zh-Hans", intent).description).toBe(
      `网络：Solana\n发送 0.001 SOL 到 ${dest}\n最高手续费 0.000005006 SOL`,
    );
  });

  const BTC_NET = "bip122:000000000019d6689c085ae165831e93";
  const BTC_SCRIPT = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xcd)]);
  const btcPsbt = (sighashType: number | undefined): Uint8Array => {
    const prev = new Transaction({ version: 2 });
    prev.addInput({ txid: hexToBytes("07".repeat(32)), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: BTC_SCRIPT, amount: 100_000n });
    const tx = new Transaction({ version: 2 });
    tx.addInput({
      txid: prev.id,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: BTC_SCRIPT, amount: 100_000n },
      nonWitnessUtxo: prev.toBytes(true, false),
      ...(sighashType === undefined ? {} : { sighashType }),
    });
    tx.addOutput({
      script: new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xab)]),
      amount: 90_000n,
    });
    if (sighashType !== undefined) {
      tx.addOutput({
        script: new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xef)]),
        amount: 5000n,
      });
    }
    return tx.toPSBT(0);
  };
  const btcReq = (psbt: Uint8Array) =>
    ({
      kind: "bitcoin.psbt",
      network: BTC_NET,
      account: { kind: "hd", walletId: "w", groupIndex: 0 },
      psbt,
      sign: [{ index: 0, template: "btc.bip84" }],
    }) as never;

  it("a Bitcoin send shows BTC amounts and the max fee", () => {
    const intent = decodeBitcoinPsbt(btcReq(btcPsbt(undefined)), new Set());
    const text = chainPrompt("en", intent).description;
    expect(text).toContain("Network: Bitcoin");
    expect(text).toContain("Send 0.0009 BTC to bc1q");
    expect(text).toContain("Max fee 0.0001 BTC");
    const zh = chainPrompt("zh-Hans", intent).description;
    expect(zh).toContain("网络：Bitcoin");
    expect(zh).toContain("发送 0.0009 BTC 到 bc1q");
    expect(zh).toContain("最高手续费 0.0001 BTC");
  });

  it("value sent to an unspendable output is shown as burned, in both locales", () => {
    const prev = new Transaction({ version: 2 });
    prev.addInput({ txid: hexToBytes("07".repeat(32)), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: BTC_SCRIPT, amount: 100_000_000n });
    const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
    tx.addInput({
      txid: prev.id,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: BTC_SCRIPT, amount: 100_000_000n },
      nonWitnessUtxo: prev.toBytes(true, false),
    });
    tx.addOutput({
      script: new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xab)]),
      amount: 1_000_000n,
    });
    tx.addOutput({
      script: new Uint8Array([0x6a, 0x04, 0xde, 0xad, 0xbe, 0xef]),
      amount: 98_000_000n,
    });
    const intent = decodeBitcoinPsbt(btcReq(tx.toPSBT(0)), new Set());
    expect(chainPrompt("en", intent).description).toBe(
      "Network: Bitcoin\nSend 0.01 BTC to bc1q4w46h2at4w46h2at4w46h2at4w46h2at25y74s\nBurn 0.98 BTC: it goes to an unspendable output and is lost\nMax fee 0.01 BTC",
    );
    expect(chainPrompt("zh-Hans", intent).description).toBe(
      "网络：Bitcoin\n发送 0.01 BTC 到 bc1q4w46h2at4w46h2at4w46h2at4w46h2at25y74s\n销毁 0.98 BTC：转入无法花费的输出，永久丢失\n最高手续费 0.01 BTC",
    );
  });

  it("a SIGHASH_SINGLE listing shows the fee-unknown line and the warning", () => {
    const intent = decodeBitcoinPsbt(btcReq(btcPsbt(0x83)), new Set());
    expect(intent.verifiability).toBe("partial");
    expect(chainPrompt("en", intent).description).toContain("Fee unknown");
    expect(chainPrompt("en", intent).description).toContain(
      "Signed inputs bind only their same-index outputs",
    );
    expect(chainPrompt("zh-Hans", intent).description).toContain("手续费未知");
  });

  it("unlimited approval and revoke on USDC", () => {
    const approve = `0x095ea7b3${SPENDER.slice(2).toLowerCase().padStart(64, "0")}${"f".repeat(64)}`;
    const unlimited = decodeEvm(
      evmReq("eip155:1", {
        to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        data: approve,
      }),
      TO,
    );
    expect(chainPrompt("en", unlimited).description).toBe(
      `Network: Ethereum\nThere may be other outflows\nAllow ${SPENDER} to spend unlimited USDC\nMax fee 0.000021 ETH`,
    );
    const revoke = decodeEvm(
      evmReq("eip155:1", {
        to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        data: `0x095ea7b3${SPENDER.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}`,
      }),
      TO,
    );
    expect(chainPrompt("en", revoke).description).toContain(
      `Revoke ${SPENDER}'s allowance for USDC`,
    );
  });

  const OTHER = checksumEvmAddress("0x00000000000000000000000000000000000bad00");
  const USDC_ADDR = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

  it("an unverifiable call to an unknown contract is described, not blind", () => {
    const intent = decodeEvm(evmReq("eip155:1", { to: OTHER, data: "0xdeadbeef" }), TO);
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm contract call",
      description: `Network: Ethereum\nThe wallet cannot verify what this call does\nCall contract ${OTHER}, function 0xdeadbeef\nMax fee 0.000021 ETH`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认合约调用",
      description: `网络：Ethereum\n钱包无法核实此调用会做什么\n调用合约 ${OTHER}，函数 0xdeadbeef\n最高手续费 0.000021 ETH`,
    });
  });

  it("a contract creation names the address it deploys", () => {
    const req = evmReq("eip155:1", { data: "0x60006000" });
    const { to: _to, ...tx } = req.tx;
    const intent = decodeEvm({ ...req, tx }, TO);
    const deployed = intent.contract?.address;
    expect(intent.contract?.created).toBe(true);
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm contract call",
      description: `Network: Ethereum\nThe wallet cannot verify what this call does\nDeploy contract ${deployed}\nMax fee 0.000021 ETH`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认合约调用",
      description: `网络：Ethereum\n钱包无法核实此调用会做什么\n部署合约 ${deployed}\n最高手续费 0.000021 ETH`,
    });
  });

  it("an unrecognised function of a listed token is blind", () => {
    const intent = decodeEvm(evmReq("eip155:1", { to: USDC_ADDR, data: "0xdeadbeef" }), TO);
    expect(intent.blind).toBe("token-function");
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description: `Network: Ethereum\nAn unrecognised function of token USDC ${USDC_ADDR} can move this token\nCall contract ${USDC_ADDR}, function 0xdeadbeef\nMax fee 0.000021 ETH`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认盲签",
      description: `网络：Ethereum\n代币 USDC ${USDC_ADDR} 的未知函数，可能转走该代币\n调用合约 ${USDC_ADDR}，函数 0xdeadbeef\n最高手续费 0.000021 ETH`,
    });
  });

  it("a batch leads with the blind call's reason before naming the contracts", () => {
    const data = encodeBatchExecute([
      { to: OTHER, value: 0n, data: "0xdeadbeef" },
      { to: USDC_ADDR, value: 0n, data: "0xdeadbeef" },
    ]);
    const intent = decodeEvm(evmReq("eip155:1", { to: TO, data }), TO);
    expect(intent.blind).toBe("token-function");
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description: `Network: Ethereum\nCall contract ${OTHER}, function 0xdeadbeef\nAn unrecognised function of token USDC ${USDC_ADDR} can move this token\nCall contract ${USDC_ADDR}, function 0xdeadbeef\nMax fee 0.000021 ETH`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认盲签",
      description: `网络：Ethereum\n调用合约 ${OTHER}，函数 0xdeadbeef\n代币 USDC ${USDC_ADDR} 的未知函数，可能转走该代币\n调用合约 ${USDC_ADDR}，函数 0xdeadbeef\n最高手续费 0.000021 ETH`,
    });
  });

  it("calldata to the signer's own account is blind, in both locales", () => {
    const intent = decodeEvm(evmReq("eip155:1", { to: TO, data: "0xdeadbeef" }), TO);
    expect(intent.blind).toBe("account-code");
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description: `Network: Ethereum\nRuns this account's own code with full authority\nCall contract ${TO}, function 0xdeadbeef\nMax fee 0.000021 ETH`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认盲签",
      description: `网络：Ethereum\n以本账户的全部权限执行其自身代码\n调用合约 ${TO}，函数 0xdeadbeef\n最高手续费 0.000021 ETH`,
    });
  });

  it("a 7702 delegation carrying self-calldata still leads with the account-code reason", () => {
    const req = evmReq("eip155:1", { to: TO, data: "0xdeadbeef" });
    const intent = decodeEvm(
      {
        ...req,
        tx: {
          ...req.tx,
          type: "eip7702" as const,
          to: TO,
          authorization: { address: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B" },
        },
      },
      TO,
    );
    expect(intent.blind).toBe("account-code");
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description: `Network: Ethereum\nDelegate this account to EIP7702StatelessDeleGator v1.3.0; the contract can execute calls on its behalf\nRuns this account's own code with full authority\nCall contract ${TO}, function 0xdeadbeef\nMax fee 0.000021 ETH`,
    });
  });

  it("a Solana transaction with an undecodable program is described, not blind", () => {
    const payer = new Uint8Array(32).fill(0x11);
    const dest = new Uint8Array(32).fill(0x22);
    const system = base58.decode("11111111111111111111111111111111");
    const unknown = new Uint8Array(32).fill(0x44);
    const transfer = new Uint8Array(12);
    const dv = new DataView(transfer.buffer);
    dv.setUint32(0, 2, true);
    dv.setBigUint64(4, 1_000_000n, true);
    const message = new Uint8Array([
      1,
      0,
      2,
      4,
      ...payer,
      ...dest,
      ...system,
      ...unknown,
      ...new Uint8Array(32).fill(0x33),
      2,
      2,
      2,
      0,
      1,
      12,
      ...transfer,
      3,
      1,
      0,
      1,
      0xaa,
    ]);
    const req = normalizeSolana(
      {
        kind: "solana.transaction",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44-change" },
        message,
      },
      SOL_PAYER,
    ) as never;
    const intent = decodeSolana(req, SOL_PAYER);
    const program = base58.encode(unknown);
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm transfer",
      description: `Network: Solana\nProgram calls the wallet cannot decode: ${program}\nThese programs can move assets from the accounts in this transaction\nSend 0.001 SOL to ${base58.encode(dest)}\nMax fee 0.000005 SOL`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认转账",
      description: `网络：Solana\n钱包无法解码的程序调用：${program}\n这些程序可以转移本交易涉及账户中的资产\n发送 0.001 SOL 到 ${base58.encode(dest)}\n最高手续费 0.000005 SOL`,
    });
  });

  it("a PSBT with external inputs is described with the fee caveat, not blind", () => {
    const prev = new Transaction({ version: 2 });
    prev.addInput({ txid: hexToBytes("07".repeat(32)), index: 0, sequence: 0xffffffff });
    prev.addOutput({ script: BTC_SCRIPT, amount: 100_000n });
    const other = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0x77)]);
    const prev2 = new Transaction({ version: 2 });
    prev2.addInput({ txid: hexToBytes("08".repeat(32)), index: 0, sequence: 0xffffffff });
    prev2.addOutput({ script: other, amount: 50_000n });
    const tx = new Transaction({ version: 2 });
    tx.addInput({
      txid: prev.id,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: BTC_SCRIPT, amount: 100_000n },
      nonWitnessUtxo: prev.toBytes(true, false),
    });
    tx.addInput({
      txid: prev2.id,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: other, amount: 50_000n },
      nonWitnessUtxo: prev2.toBytes(true, false),
    });
    tx.addOutput({
      script: new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xab)]),
      amount: 140_000n,
    });
    const intent = decodeBitcoinPsbt(btcReq(tx.toPSBT(0)), new Set());
    expect(intent.blind).toBeUndefined();
    expect(chainPrompt("en", intent).description).toContain(
      "Includes inputs from other signers; the fee cannot be verified",
    );
    expect(chainPrompt("zh-Hans", intent).description).toContain(
      "包含其他签名者的输入；无法核实手续费",
    );
  });

  const TRON_OWNER = "TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG";
  const TRON_TO = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC";
  const tronTransfer = (memo: Uint8Array): PromptIntent =>
    decodeTron(
      {
        kind: "tron.transaction",
        network: "tron:728126428",
        account: { kind: "hd", walletId: "w", groupIndex: 0, template: "tron.bip44" },
        rawData: buildTronRawData(
          {
            refBlock: {
              number: 76050000,
              id: "0000000004886e501a2b3c4d5e6f78901a2b3c4d5e6f78901a2b3c4d5e6f7890",
            },
            expiration: 1_767_225_660_000,
            timestamp: 1_767_225_600_000,
            memo,
          },
          { type: "TransferContract", owner: TRON_OWNER, to: TRON_TO, amount: 1_000_000n },
        ),
      },
      TRON_OWNER,
    );

  it("a TRON binary memo shows its hex up to 64 bytes, then only its length", () => {
    const data = new Uint8Array(64).fill(0xff);
    expect(chainPrompt("en", tronTransfer(data)).description).toBe(
      `Network: TRON\nSend 1 TRX to ${TRON_TO}\nMemo data 0x${"ff".repeat(64)}\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged`,
    );
    expect(chainPrompt("zh-Hans", tronTransfer(data)).description).toBe(
      `网络：TRON\n发送 1 TRX 到 ${TRON_TO}\n备注数据 0x${"ff".repeat(64)}\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费`,
    );
    const long = new Uint8Array(65).fill(0xff);
    expect(chainPrompt("en", tronTransfer(long)).description).toBe(
      `Network: TRON\nSend 1 TRX to ${TRON_TO}\nMemo of 65 bytes\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged`,
    );
    expect(chainPrompt("zh-Hans", tronTransfer(long)).description).toBe(
      `网络：TRON\n发送 1 TRX 到 ${TRON_TO}\n备注 65 字节\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费`,
    );
  });

  it("a TRON text memo over the excerpt budget is cut with an omitted count", () => {
    const memo = utf8ToBytes("x".repeat(400));
    expect(chainPrompt("en", tronTransfer(memo)).description).toBe(
      `Network: TRON\nSend 1 TRX to ${TRON_TO}\nMemo:\n${"x".repeat(320)}\n… 80 more characters not shown\nExpires 2026-01-01 00:01 (UTC)\nBandwidth or account-activation fees may be charged`,
    );
    expect(chainPrompt("zh-Hans", tronTransfer(memo)).description).toBe(
      `网络：TRON\n发送 1 TRX 到 ${TRON_TO}\n备注：\n${"x".repeat(320)}\n… 还有 80 个字符未显示\n2026-01-01 00:01（UTC）后失效\n可能扣除带宽费或账户激活费`,
    );
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

describe("solana stake", () => {
  const stake: PromptIntent = {
    summary: "stake",
    outflows: [
      {
        to: "STAKEACCT",
        amount: { asset: "solana-native", amount: "2000000000" },
        verified: true,
      },
    ],
    approvals: [
      {
        kind: "stake-authority",
        account: "STAKEACCT",
        role: "withdrawer",
        authority: "OTHER",
        verified: false,
      },
    ],
    staking: [
      { kind: "create", account: "STAKEACCT", lamports: "2000000000" },
      { kind: "delegate", account: "STAKEACCT", validator: "VOTE" },
    ],
    fee: undefined,
    verifiability: "full",
    warnings: [{ kind: "stake-lockup", message: "locked" }],
  };

  it("lists staking actions and the authority grant in both locales", () => {
    expect(chainPrompt("en", stake).description).toContain(
      "Create stake account STAKEACCT with 2 SOL",
    );
    expect(chainPrompt("en", stake).description).toContain(
      "Delegate stake account STAKEACCT to validator VOTE",
    );
    expect(chainPrompt("en", stake).description).toContain(
      "Give OTHER the withdrawer authority over stake account STAKEACCT",
    );
    expect(chainPrompt("zh-Hans", stake).description).toContain(
      "创建质押账户 STAKEACCT，存入 2 SOL",
    );
    expect(chainPrompt("zh-Hans", stake).description).toContain(
      "委托质押账户 STAKEACCT 给验证者 VOTE",
    );
    expect(chainPrompt("zh-Hans", stake).description).toContain(
      "将质押账户 STAKEACCT 的提取权限交给 OTHER",
    );
  });

  it("shows withdraw and deactivate actions", () => {
    const w: PromptIntent = {
      ...stake,
      approvals: [],
      staking: [
        { kind: "deactivate", account: "STAKEACCT" },
        { kind: "withdraw", account: "STAKEACCT", to: "ME", lamports: "500000000" },
      ],
    };
    expect(chainPrompt("en", w).description).toContain("Deactivate stake STAKEACCT");
    expect(chainPrompt("en", w).description).toContain("Withdraw 0.5 SOL from STAKEACCT to ME");
    expect(chainPrompt("zh-Hans", w).description).toContain("解除质押 STAKEACCT");
    expect(chainPrompt("zh-Hans", w).description).toContain("从 STAKEACCT 提取 0.5 SOL 到 ME");
  });

  describe("platform fee warning line", () => {
    it("renders in both locales", () => {
      const intent = {
        summary: "swap" as const,
        outflows: [],
        approvals: [],
        fee: undefined,
        verifiability: "partial" as const,
        warnings: [{ kind: "platform-fee" as const, message: "50 bps" }],
      };
      expect(chainPrompt("zh-Hans", intent).description).toContain("Jupiter 收取平台费 50 bps");
      expect(chainPrompt("en", intent).description).toContain("Jupiter platform fee: 50 bps");
    });
  });

  describe("lido prompt lines", () => {
    it.each([
      [
        "zh-Hans" as const,
        {
          kind: "lido-submit",
          amount: { asset: "native", amount: "5000000000000000000", symbol: "ETH", decimals: 18 },
          receive: {
            asset: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
            amount: "5000000000000000000",
            symbol: "stETH",
            decimals: 18,
          },
        },
        "通过 Lido 质押 5 ETH，收到约 5 stETH",
      ],
      [
        "en" as const,
        {
          kind: "lido-request",
          token: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
          amount: { asset: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", amount: "1000" },
          owner: "0x1111111111111111111111111111111111111111",
        },
        "Request withdrawal of",
      ],
      [
        "en" as const,
        { kind: "lido-claim", requestIds: ["1", "2"] },
        "Claim Lido withdrawals 1, 2",
      ],
    ])("%s lido %s", (locale, action, needle) => {
      const p = chainPrompt(locale, {
        summary: "stake",
        outflows: [],
        approvals: [],
        fee: undefined,
        verifiability: "partial",
        staking: [action as never],
      });
      expect(JSON.stringify(p)).toContain(needle);
    });
  });
});

describe("message and unverifiable-call prompts via the real decoders", () => {
  const account = { kind: "hd" as const, walletId: "w", groupIndex: 0, template: "evm" };
  const SIGNER = "0x52908400098527886E0F7030069857D2E4169EE7";
  const personal = (text: string) =>
    decodeEvm(
      {
        kind: "evm.personal-message",
        network: "eip155:1",
        account,
        message: new TextEncoder().encode(text),
      },
      SIGNER,
    );
  const typedOn = (network: string, doc: unknown) =>
    decodeEvm({ kind: "evm.typed-data", network, account, typedData: JSON.stringify(doc) }, SIGNER);
  const typed = (doc: unknown) => typedOn("eip155:1", doc);
  const signIn = [
    "app.example.com wants you to sign in with your Ethereum account:",
    SIGNER,
    "",
    "",
    "URI: https://app.example.com/login",
    "Version: 1",
    "Chain ID: 8453",
    "Nonce: 12345678",
    "Issued At: 2026-01-01T00:00:00Z",
  ].join("\n");

  it("a payable call to an unknown contract shows the amount, the contract and the fee", () => {
    const intent = decodeEvm(
      {
        kind: "evm.transaction",
        network: "eip155:1",
        account,
        tx: {
          chainId: 1,
          to: TO,
          data: "0xdeadbeef",
          value: "0x8ac7230489e80000",
          nonce: 0,
          gas: "0x5208",
          maxFeePerGas: "0x174876e800",
          maxPriorityFeePerGas: "0x1",
          accessList: [],
          type: "eip1559",
        },
      },
      SIGNER,
    );
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm contract call",
      description: `Network: Ethereum\nThe wallet cannot verify what this call does\nCall contract ${TO}, function 0xdeadbeef\nSend 10 ETH to ${TO}\nMax fee 0.0021 ETH`,
    });
  });

  it("a sign-in message shows where, as whom and on which network", () => {
    expect(chainPrompt("en", personal(signIn))).toStrictEqual({
      title: "Confirm sign-in",
      description: `Sign in to app.example.com\nAccount ${SIGNER}\nNetwork: Base\nURI https://app.example.com/login`,
    });
    expect(chainPrompt("zh-Hans", personal(signIn)).title).toBe("确认登录");
  });

  it("text that imitates a sign-in is flagged and shown as text", () => {
    const fake = "evil.example wants you to sign in with your Ethereum account:\nnot-an-address";
    expect(chainPrompt("en", personal(fake)).description).toBe(
      `This looks like a sign-in request but is not a valid one\nMessage:\nevil.example wants you to sign in with your Ethereum account:\nnot-an-address`,
    );
  });

  it("unrecognised typed data shows its domain, type and every field it cannot verify", () => {
    const intent = typed({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Order: [{ name: "maker", type: "address" }],
      },
      primaryType: "Order",
      domain: { name: "Some\u202EExchange", chainId: 1, verifyingContract: TO },
      message: { maker: SIGNER },
    });
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm signature",
      description: `App: Some\uFFFDExchange\nNetwork: Ethereum\nVerifying contract ${TO}\nType: Order\nThe wallet cannot verify what this signature authorises\n· maker = ${SIGNER}`,
    });
  });

  it("typed data that signs only hashes is blind and names it, in both locales", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const safe = "0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52";
    const intent = typed({
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        SafeMessage: [{ name: "message", type: "bytes" }],
      },
      primaryType: "SafeMessage",
      domain: { chainId: 1, verifyingContract: safe },
      message: { message: hash },
    });
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description:
        `Network: Ethereum\nVerifying contract ${safe}\nType: SafeMessage\n` +
        `It signs a hash or raw bytes; the wallet cannot see what they commit to\n` +
        `The wallet cannot verify what this signature authorises\n· message = ${hash}`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认盲签",
      description:
        `网络：Ethereum\n验证合约 ${safe}\n类型：SafeMessage\n` +
        `它签署了哈希或原始字节；钱包无法看到它们所承诺的内容\n` +
        `钱包无法核实此签名授权的内容\n· message = ${hash}`,
    });
  });

  it("a Polygon Seaport order renders native amounts as POL, never ETH", () => {
    const item = (wei: string) => ({
      itemType: 0,
      token: "0x0000000000000000000000000000000000000000",
      identifierOrCriteria: "0",
      startAmount: wei,
      endAmount: wei,
    });
    const itemFields = [
      { name: "itemType", type: "uint8" },
      { name: "token", type: "address" },
      { name: "identifierOrCriteria", type: "uint256" },
      { name: "startAmount", type: "uint256" },
      { name: "endAmount", type: "uint256" },
    ];
    const intent = typedOn("eip155:137", {
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
        OfferItem: itemFields,
        ConsiderationItem: [...itemFields, { name: "recipient", type: "address" }],
      },
      primaryType: "OrderComponents",
      domain: {
        name: "Seaport",
        version: "1.6",
        chainId: 137,
        verifyingContract: "0x0000000000000068F116a894984e2DB1123eB395",
      },
      message: {
        offerer: SIGNER,
        zone: "0x0000000000000000000000000000000000000000",
        offer: [item("2000000000000000000")],
        consideration: [{ ...item("100000000000000000000"), recipient: SIGNER }],
        orderType: 0,
        startTime: "1700000000",
        endTime: "1700001000",
        zoneHash: `0x${"00".repeat(32)}`,
        salt: "123",
        conduitKey: `0x${"00".repeat(32)}`,
        counter: "0",
      },
    });
    expect(chainPrompt("en", intent).description).toBe(
      `App: Seaport\nNetwork: Polygon\nVerifying contract 0x0000000000000068F116a894984e2DB1123eB395\nType: OrderComponents\nGive 2 POL\n${SIGNER} receives 100 POL`,
    );
  });

  const SEAPORT_ITEM_FIELDS = [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ];
  const seaportDoc = (message: Record<string, unknown>, domain: Record<string, unknown> = {}) => ({
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
      OfferItem: SEAPORT_ITEM_FIELDS,
      ConsiderationItem: [...SEAPORT_ITEM_FIELDS, { name: "recipient", type: "address" }],
    },
    primaryType: "OrderComponents",
    domain: {
      name: "Seaport",
      version: "1.6",
      chainId: 1,
      verifyingContract: "0x0000000000000068F116a894984e2DB1123eB395",
      ...domain,
    },
    message: {
      offerer: SIGNER,
      zone: "0x0000000000000000000000000000000000000000",
      offer: [],
      consideration: [],
      orderType: 0,
      startTime: "1700000000",
      endTime: "1700001000",
      zoneHash: `0x${"00".repeat(32)}`,
      salt: "123",
      conduitKey: `0x${"00".repeat(32)}`,
      counter: "0",
      ...message,
    },
  });

  it("a Seaport NFT offer names the token and its id", () => {
    const intent = typed(
      seaportDoc({
        offer: [
          {
            itemType: 2,
            token: "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
            identifierOrCriteria: "7090",
            startAmount: "1",
            endAmount: "1",
          },
        ],
      }),
    );
    expect(chainPrompt("en", intent).description).toBe(
      `App: Seaport\nNetwork: Ethereum\nVerifying contract 0x0000000000000068F116a894984e2DB1123eB395\nType: OrderComponents\nGive 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D #7090`,
    );
  });

  it("Seaport criteria items and a non-zero zone are named", () => {
    const nft = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";
    // 12345 = 0x3039 as a 32-byte root.
    const root = `0x${12345n.toString(16).padStart(64, "0")}`;
    const intent = typed(
      seaportDoc({
        zone: TO,
        offer: [
          {
            itemType: 4,
            token: nft,
            identifierOrCriteria: "0",
            startAmount: "1",
            endAmount: "1",
          },
          {
            itemType: 5,
            token: nft,
            identifierOrCriteria: "12345",
            startAmount: "3",
            endAmount: "3",
          },
        ],
      }),
    );
    expect(chainPrompt("en", intent).description).toBe(
      `App: Seaport\nNetwork: Ethereum\nVerifying contract 0x0000000000000068F116a894984e2DB1123eB395\nType: OrderComponents\nGive any token of ${nft}\nGive a token of ${nft} from the set with Merkle root ${root} ×3\nZone ${TO} can restrict or cancel this order`,
    );
    expect(chainPrompt("zh-Hans", intent).description).toBe(
      `应用：Seaport\n网络：Ethereum\n验证合约 0x0000000000000068F116a894984e2DB1123eB395\n类型：OrderComponents\n付出 ${nft} 中的任意代币\n付出 ${nft} 中 Merkle 根 ${root} 所列的代币 ×3\n区域合约 ${TO} 可限制或取消此订单`,
    );
  });

  const ZERO_EVM_ADDR = "0x0000000000000000000000000000000000000000";
  const seaportAddress = fc
    .uint8Array({ minLength: 20, maxLength: 20 })
    .map((b) => `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`);
  /** A Seaport offer/consideration item with the asset fields the prompt renders. */
  const seaportItem = fc
    .record({
      kind: fc.constantFrom(
        "native",
        "erc20",
        "erc721",
        "erc1155",
        "erc721-criteria",
        "erc1155-criteria",
      ),
      token: seaportAddress,
      identifier: fc.bigInt({ min: 0n, max: 2n ** 200n }).map((n) => n.toString(10)),
      count: fc.bigInt({ min: 1n, max: 9n }).map((n) => n.toString(10)),
    })
    .map(({ kind, token, identifier, count }) => {
      const amount = {
        asset: kind === "native" ? "native" : token,
        amount: count,
        ...(kind === "erc721" || kind === "erc1155" ? { tokenId: identifier } : {}),
      };
      return { kind, token, identifier, startAmount: amount, endAmount: amount };
    });
  type SeaportItem = typeof seaportItem extends fc.Arbitrary<infer T> ? T : never;
  /** The per-kind "Give" line assertions — kept out of the property to satisfy the suite. */
  const expectGiveLine = (line: string | undefined, it: SeaportItem): void => {
    const text = line ?? "";
    const count = it.startAmount.amount;
    switch (it.kind) {
      case "erc721":
      case "erc1155":
        expect(text).toContain(`${it.token} #${it.identifier}`);
        expect(text.includes(`×${count}`)).toBe(count !== "1");
        break;
      case "erc721-criteria":
      case "erc1155-criteria":
        if (it.identifier === "0") {
          expect(text).toContain(`any token of ${it.token}`);
        } else {
          expect(text).toContain(`0x${BigInt(it.identifier).toString(16).padStart(64, "0")}`);
        }
        expect(text.includes(`×${count}`)).toBe(count !== "1");
        break;
      case "native":
        expect(text).toContain("native");
        break;
      case "erc20":
        expect(text).toContain(it.token);
        break;
    }
  };

  it("every Seaport item kind renders its token, id or criteria and the zone", () => {
    fc.assert(
      fc.property(
        fc.array(seaportItem, { minLength: 1, maxLength: 9 }),
        fc.array(seaportItem, { maxLength: 2 }),
        fc.oneof(fc.constant(ZERO_EVM_ADDR), seaportAddress),
        (offer, extra, zone) => {
          const seaport = {
            offerer: SIGNER,
            zone,
            startTime: 0,
            endTime: 0,
            offer,
            consideration: extra.map((i) => ({ ...i, recipient: TO })),
          };
          const { description } = chainPrompt("en", typedIntent({ seaport }));
          const lines = description.split("\n");
          const gives = lines.filter((l) => l.startsWith("Give "));
          expect(gives).toHaveLength(Math.min(offer.length, 8));
          for (const [i, it] of offer.slice(0, 8).entries()) {
            expectGiveLine(gives[i], it);
          }
          const last = lines.at(-1);
          expect(last === `Zone ${zone} can restrict or cancel this order`).toBe(
            zone !== ZERO_EVM_ADDR,
          );
        },
      ),
    );
  });

  it("a Safe inner call's native value is formatted in the network's units", () => {
    const safe = "0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52";
    const intent = typedOn("eip155:1", {
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        SafeTx: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
          { name: "operation", type: "uint8" },
          { name: "safeTxGas", type: "uint256" },
          { name: "baseGas", type: "uint256" },
          { name: "gasPrice", type: "uint256" },
          { name: "gasToken", type: "address" },
          { name: "refundReceiver", type: "address" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "SafeTx",
      domain: { chainId: 1, verifyingContract: safe },
      message: {
        to: TO,
        value: "1000000000000000000",
        data: "0x",
        operation: 0,
        safeTxGas: "0",
        baseGas: "0",
        gasPrice: "0",
        gasToken: "0x0000000000000000000000000000000000000000",
        refundReceiver: "0x0000000000000000000000000000000000000000",
        nonce: "7",
      },
    });
    expect(chainPrompt("en", intent).description).toBe(
      `Network: Ethereum\nVerifying contract ${safe}\nType: SafeTx\nSafe ${safe}, transaction 7\nSend 1 ETH to ${TO}`,
    );
  });

  it("a Safe delegatecall to arbitrary code is blind, not decoded as a call", () => {
    const safe = "0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52";
    // ERC-20 transfer calldata — decodeable as a call, but a delegatecall runs it with the
    // Safe's full authority, so its stated effects would be a lie.
    const data = `0xa9059cbb${TO.slice(2).toLowerCase().padStart(64, "0")}${(1_000_000).toString(16).padStart(64, "0")}`;
    const intent = typedOn("eip155:1", {
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        SafeTx: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
          { name: "operation", type: "uint8" },
          { name: "safeTxGas", type: "uint256" },
          { name: "baseGas", type: "uint256" },
          { name: "gasPrice", type: "uint256" },
          { name: "gasToken", type: "address" },
          { name: "refundReceiver", type: "address" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "SafeTx",
      domain: { chainId: 1, verifyingContract: safe },
      message: {
        to: TO,
        value: "0",
        data,
        operation: 1,
        safeTxGas: "0",
        baseGas: "0",
        gasPrice: "0",
        gasToken: "0x0000000000000000000000000000000000000000",
        refundReceiver: "0x0000000000000000000000000000000000000000",
        nonce: "7",
      },
    });
    expect(intent.blind).toBe("safe-delegatecall");
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description: `Network: Ethereum\nVerifying contract ${safe}\nType: SafeTx\nSafe ${safe}, transaction 7\nRuns the code of ${TO} with the Safe's full authority (delegatecall)\nThe wallet cannot verify what this call does\nCall contract ${TO}, function 0xa9059cbb`,
    });
    expect(chainPrompt("zh-Hans", intent).title).toBe("确认盲签");
  });

  const SAFE_TX_TYPES = [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ];
  const safeTxDoc = (message: Record<string, unknown>, domain: Record<string, unknown> = {}) => {
    const d = {
      chainId: 1,
      verifyingContract: "0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52",
      ...domain,
    };
    return {
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        SafeTx: SAFE_TX_TYPES,
      },
      primaryType: "SafeTx",
      domain: d,
      message: {
        to: TO,
        value: "0",
        data: "0x",
        operation: 0,
        safeTxGas: "0",
        baseGas: "0",
        gasPrice: "0",
        gasToken: "0x0000000000000000000000000000000000000000",
        refundReceiver: "0x0000000000000000000000000000000000000000",
        nonce: "7",
        ...message,
      },
    };
  };

  it("a Safe gas refund is priced in the gas token and named for its receiver", () => {
    const attacker = "0xBAd0000000000000000000000000000000000Bad";
    // baseGas 1e6 × gasPrice 1e24 = 1e30 base units of USDC = 1e24 USDC.
    const intent = typed(
      safeTxDoc({
        gasPrice: "1000000000000000000000000",
        baseGas: "1000000",
        gasToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        refundReceiver: attacker,
      }),
    );
    expect(chainPrompt("en", intent).description).toBe(
      `Network: Ethereum\nVerifying contract 0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52\nType: SafeTx\nSafe 0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52, transaction 7\nSend 0 ETH to ${TO}\nPays ${attacker} a gas refund of up to 1000000000000000000000000 USDC, plus 1000000000000000000 USDC per gas of call overhead`,
    );
  });

  it("a Safe gas refund without a receiver pays whoever executes, in the network's units", () => {
    const intent = typedOn(
      "eip155:137",
      safeTxDoc(
        {
          gasPrice: "1000000000000000000",
          baseGas: "21000",
          safeTxGas: "0",
        },
        { chainId: 137 },
      ),
    );
    expect(chainPrompt("en", intent).description).toBe(
      `Network: Polygon\nVerifying contract 0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52\nType: SafeTx\nSafe 0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52, transaction 7\nSend 0 POL to ${TO}\nPays whoever executes it a gas refund of up to 21000 POL, plus 1 POL per gas of call overhead`,
    );
  });

  const nft = { asset: "0x3333333333333333333333333333333333333333", amount: "1", tokenId: "7" };
  const eth = (amount: string) => ({
    asset: "eip155:1/slip44:60",
    amount,
    decimals: 18,
    symbol: "ETH",
  });
  const item = (start: string, end: string) => ({
    kind: "native" as const,
    token: "0x0000000000000000000000000000000000000000",
    identifier: "0",
    startAmount: eth(start),
    endAmount: eth(end),
  });
  const typedIntent = (extra: object): PromptIntent => ({
    summary: "swap",
    outflows: [],
    approvals: [],
    fee: undefined,
    verifiability: "opaque",
    network: "eip155:1",
    message: {
      kind: "typed-data",
      primaryType: "OrderComponents",
      domain: { name: "Seaport", chainId: 1, verifyingContract: SPENDER },
      data: {},
      ...extra,
    },
  });

  const order = {
    offerer: SIGNER,
    zone: TO,
    startTime: 0,
    endTime: 0,
    offer: [{ ...item("0", "0"), kind: "erc721" as const, startAmount: nft, endAmount: nft }],
    consideration: [
      { ...item("1000000000000000000", "500000000000000000"), recipient: SIGNER },
      ...[1, 2, 3, 4].map(() => ({ ...item("1", "1"), recipient: TO })),
    ],
  };
  const safe = {
    safe: SPENDER,
    nonce: "12",
    operation: "delegatecall" as const,
    to: TO,
    value: "0",
    data: "0x12345678",
    calls: [
      {
        ...ethTransfer,
        family: "evm" as const,
        network: "eip155:1",
        warnings: [],
        fee: undefined,
        summary: "contract-call" as const,
        verifiability: "opaque" as const,
        contract: { address: TO, created: false, selector: "0x12345678" },
      },
    ],
    refund: { receiver: SIGNER, gasPrice: eth("1"), amount: eth("5000000") },
  };

  it("a Seaport order lists what is given and who receives what", () => {
    expect(chainPrompt("en", typedIntent({ seaport: order })).description).toBe(
      [
        "App: Seaport",
        "Network: Ethereum",
        `Verifying contract ${SPENDER}`,
        "Type: OrderComponents",
        "Give 0x3333333333333333333333333333333333333333 #7",
        `${SIGNER} receives 1 ETH → 0.5 ETH`,
        ...[1, 2, 3, 4].map(() => `${TO} receives 0.000000000000000001 ETH`),
        `Zone ${TO} can restrict or cancel this order`,
      ].join("\n"),
    );
  });

  /* A recognised off-chain order: the document's approvals come first, then the order's
     header, give, receives and bound lines — without the "other outflows" caveat. */
  const orderAmount = {
    asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    amount: "1500000",
    decimals: 6,
    symbol: "USDC",
  };
  const orderIntent = (
    order: OffchainOrder,
    message: Record<string, unknown>,
    approvals: PromptIntent["approvals"] = [],
  ): PromptIntent => ({
    summary: "swap",
    outflows: [],
    approvals,
    fee: undefined,
    verifiability: "partial",
    network: "eip155:1",
    message: {
      kind: "typed-data",
      data: {},
      order,
      ...message,
    } as PromptIntent["message"] & { kind: "typed-data" },
  });

  it("a UniswapX order follows the take-once permit line", () => {
    const intent = orderIntent(
      {
        protocol: "uniswapx",
        maker: SIGNER,
        give: orderAmount,
        receive: [{ recipient: SIGNER, amount: eth("500000000000000000") }],
        expiry: 1_700_000_000,
        partialFill: true,
        exclusiveFiller: TO,
      },
      {
        primaryType: "PermitWitnessTransferFrom",
        domain: {
          name: "Permit2",
          chainId: 1,
          verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
        },
      },
      [
        {
          kind: "allowance",
          spender: SPENDER,
          amount: orderAmount,
          change: "transfer",
          unlimited: false,
          expiration: 0,
          via: "permit2",
          verified: false,
        },
      ],
    );
    expect(chainPrompt("en", intent).description).toBe(
      [
        "App: Permit2",
        "Network: Ethereum",
        "Verifying contract 0x000000000022D473030F116dDEE9F6B43aC78BA3",
        "Type: PermitWitnessTransferFrom",
        `Allow ${SPENDER} to take 1.5 USDC once via Permit2`,
        `UniswapX order by ${SIGNER}`,
        "Give at most 1.5 USDC",
        `${SIGNER} receives at least 0.5 ETH`,
        "Valid until 2023-11-14 22:13 (UTC)",
        "Can be filled in parts at the same rate",
        `${TO} has the exclusive right to fill it first`,
      ].join("\n"),
    );
  });

  it("a 1inch order with an allowed sender and no expiry shows both bounds", () => {
    const intent = orderIntent(
      {
        protocol: "1inch",
        maker: SIGNER,
        give: orderAmount,
        receive: [{ recipient: TO, amount: eth("500000000000000000") }],
        partialFill: false,
        allowedSender: "0x00000000000000000001",
      },
      {
        primaryType: "Order",
        domain: {
          name: "1inch Aggregation Router",
          version: "6",
          chainId: 1,
          verifyingContract: SPENDER,
        },
      },
    );
    expect(chainPrompt("en", intent).description).toBe(
      [
        "App: 1inch Aggregation Router",
        "Network: Ethereum",
        `Verifying contract ${SPENDER}`,
        "Type: Order",
        `1inch order by ${SIGNER}`,
        "Give at most 1.5 USDC",
        `${TO} receives at least 0.5 ETH`,
        "No expiry",
        "Only a taker whose address ends in 0x00000000000000000001 can fill it",
      ].join("\n"),
    );
  });

  it("a CoW order renders the same bounds in Chinese", () => {
    const intent = orderIntent(
      {
        protocol: "cow",
        maker: SIGNER,
        give: orderAmount,
        receive: [{ recipient: TO, amount: eth("500000000000000000") }],
        expiry: 1_700_000_000,
        partialFill: true,
      },
      {
        primaryType: "Order",
        domain: {
          name: "Gnosis Protocol",
          version: "v2",
          chainId: 1,
          verifyingContract: SPENDER,
        },
      },
    );
    expect(chainPrompt("zh-Hans", intent).description).toBe(
      [
        "应用：Gnosis Protocol",
        "网络：Ethereum",
        `验证合约 ${SPENDER}`,
        "类型：Order",
        `CoW Protocol 订单，挂单方 ${SIGNER}`,
        "最多付出 1.5 USDC",
        `${TO} 至少收到 0.5 ETH`,
        "有效期至 2023-11-14 22:13（UTC）",
        "可按同一价格分批成交",
      ].join("\n"),
    );
  });

  it("a Safe transaction shows its calls, a delegatecall and the gas refund", () => {
    expect(chainPrompt("en", typedIntent({ primaryType: "SafeTx", safe })).description).toBe(
      [
        "App: Seaport",
        "Network: Ethereum",
        `Verifying contract ${SPENDER}`,
        "Type: SafeTx",
        `Safe ${SPENDER}, transaction 12`,
        `Runs the code of ${TO} with the Safe's full authority (delegatecall)`,
        "The wallet cannot verify what this call does",
        `Call contract ${TO}, function 0x12345678`,
        `Send 0.05 ETH to ${TO}`,
        `Pays ${SIGNER} a gas refund of up to 0.000000000005 ETH, plus 0.000000000000000001 ETH per gas of call overhead`,
      ].join("\n"),
    );
  });

  it("renders every message line in Chinese under a zh locale", () => {
    expect(chainPrompt("zh-Hans", personal(signIn)).description).toBe(
      `登录 app.example.com\n账户 ${SIGNER}\n网络：Base\n地址 https://app.example.com/login`,
    );
    expect(
      chainPrompt("zh-Hans", personal("x wants you to sign in with your Ethereum account:"))
        .description,
    ).toBe(
      "内容像登录请求，但格式不合规\n消息：\nx wants you to sign in with your Ethereum account:",
    );
    expect(
      chainPrompt("zh-Hans", typedIntent({ fields: [{ path: "maker", value: SIGNER }] }))
        .description,
    ).toBe(
      `应用：Seaport\n网络：Ethereum\n验证合约 ${SPENDER}\n类型：OrderComponents\n钱包无法核实此签名授权的内容\n· maker = ${SIGNER}`,
    );
    expect(chainPrompt("zh-Hans", typedIntent({ seaport: order })).description).toBe(
      [
        "应用：Seaport",
        "网络：Ethereum",
        `验证合约 ${SPENDER}`,
        "类型：OrderComponents",
        "付出 0x3333333333333333333333333333333333333333 #7",
        `${SIGNER} 收到 1 ETH → 0.5 ETH`,
        ...[1, 2, 3, 4].map(() => `${TO} 收到 0.000000000000000001 ETH`),
        `区域合约 ${TO} 可限制或取消此订单`,
      ].join("\n"),
    );
    expect(chainPrompt("zh-Hans", typedIntent({ primaryType: "SafeTx", safe })).description).toBe(
      [
        "应用：Seaport",
        "网络：Ethereum",
        `验证合约 ${SPENDER}`,
        "类型：SafeTx",
        `Safe ${SPENDER} 的第 12 笔交易`,
        `以 Safe 的全部权限执行 ${TO} 的代码（delegatecall）`,
        "钱包无法核实此调用会做什么",
        `调用合约 ${TO}，函数 0x12345678`,
        `发送 0.05 ETH 到 ${TO}`,
        `向 ${SIGNER} 支付 gas 退款：最多 0.000000000005 ETH，另按每单位 gas 0.000000000000000001 ETH 支付调用开销`,
      ].join("\n"),
    );
  });

  const MULTISEND = checksumEvmAddress("0x40a2accbd92bca938b02010e17a5b8929b49130d");
  const USDC_ADDR = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const OTHER = checksumEvmAddress("0x00000000000000000000000000000000000bad00");

  /** Packed MultiSend entry: operation(1) | to(20) | value(32) | dataLength(32) | data. */
  const packEntry = (to: string, value: bigint, data: string, operation = 0): string =>
    `${operation.toString(16).padStart(2, "0")}${to.slice(2).toLowerCase()}${value
      .toString(16)
      .padStart(64, "0")}${BigInt(data.slice(2).length / 2)
      .toString(16)
      .padStart(64, "0")}${data.slice(2).toLowerCase()}`;

  /** `multiSend(bytes)` calldata: the selector plus a length-prefixed, padded bytes argument. */
  const multiSend = (packed: string): string => {
    const pad = (64 - (packed.length % 64)) % 64;
    return `0x8d80ff0a${(32).toString(16).padStart(64, "0")}${BigInt(packed.length / 2)
      .toString(16)
      .padStart(64, "0")}${packed}${"0".repeat(pad)}`;
  };

  it("a Safe MultiSend batch leads with the blind inner call's reason", () => {
    const packed = packEntry(OTHER, 0n, "0xdeadbeef") + packEntry(USDC_ADDR, 0n, "0xdeadbeef");
    const intent = typed(safeTxDoc({ to: MULTISEND, operation: 1, data: multiSend(packed) }));
    expect(intent.blind).toBe("token-function");
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description: `Network: Ethereum\nVerifying contract 0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52\nType: SafeTx\nSafe 0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52, transaction 7\nRuns the code of ${MULTISEND} with the Safe's full authority (delegatecall)\nThe wallet cannot verify what this call does\nCall contract ${OTHER}, function 0xdeadbeef\nThe wallet cannot verify what this call does\nAn unrecognised function of token USDC ${USDC_ADDR} can move this token\nCall contract ${USDC_ADDR}, function 0xdeadbeef`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认盲签",
      description: `网络：Ethereum\n验证合约 0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52\n类型：SafeTx\nSafe 0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52 的第 7 笔交易\n以 Safe 的全部权限执行 ${MULTISEND} 的代码（delegatecall）\n钱包无法核实此调用会做什么\n调用合约 ${OTHER}，函数 0xdeadbeef\n钱包无法核实此调用会做什么\n代币 USDC ${USDC_ADDR} 的未知函数，可能转走该代币\n调用合约 ${USDC_ADDR}，函数 0xdeadbeef`,
    });
  });

  it("a Safe transaction with a priced gas refund is blind", () => {
    const intent = typed(safeTxDoc({ gasPrice: "2000000000", baseGas: "100000" }));
    expect(intent.blind).toBe("safe-refund-unbounded");
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description: `Network: Ethereum\nVerifying contract 0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52\nType: SafeTx\nSafe 0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52, transaction 7\nSend 0 ETH to ${TO}\nPays whoever executes it a gas refund of up to 0.0002 ETH, plus 0.000000002 ETH per gas of call overhead`,
    });
    expect(chainPrompt("zh-Hans", intent).title).toBe("确认盲签");
    expect(chainPrompt("zh-Hans", intent).description).toContain(
      "向 执行者 支付 gas 退款：最多 0.0002 ETH，另按每单位 gas 0.000000002 ETH 支付调用开销",
    );
  });

  it("typed data too large to list is blind and says so", () => {
    const leafFields = Array.from({ length: 17 }, (_, i) => ({
      name: `f${i}`,
      type: "uint256",
    }));
    const intent = typed({
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Big: leafFields,
      },
      primaryType: "Big",
      domain: { chainId: 1, verifyingContract: TO },
      message: Object.fromEntries(leafFields.map((f) => [f.name, "1"])),
    });
    expect(intent.blind).toBe("typed-data-oversize");
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description: `Network: Ethereum\nVerifying contract ${TO}\nType: Big\nThis typed data is too large to show in full`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认盲签",
      description: `网络：Ethereum\n验证合约 ${TO}\n类型：Big\n此类型数据过大，无法完整显示`,
    });
  });

  it("message bytes show up to 64 bytes of hex and only a length beyond that", () => {
    const personalBytes = (n: number) =>
      decodeEvm(
        {
          kind: "evm.personal-message",
          network: "eip155:1",
          account,
          message: new Uint8Array(n).fill(0xab),
        },
        SIGNER,
      );
    const hex64 = `0x${"ab".repeat(64)}`;
    expect(chainPrompt("en", personalBytes(64))).toStrictEqual({
      title: "Confirm blind signing",
      description: `The wallet cannot show what this signs. Sign only if you fully trust the app.\nData ${hex64}`,
    });
    expect(chainPrompt("zh-Hans", personalBytes(64))).toStrictEqual({
      title: "确认盲签",
      description: `钱包无法显示签署的内容。仅在完全信任该应用时签署。\n数据 ${hex64}`,
    });
    expect(chainPrompt("en", personalBytes(65))).toStrictEqual({
      title: "Confirm blind signing",
      description: `The wallet cannot show what this signs. Sign only if you fully trust the app.\n65 bytes`,
    });
    expect(chainPrompt("zh-Hans", personalBytes(65)).description).toContain("65 字节");
  });

  it("typed data that is neither recognised, shown nor blind is an integrity error", () => {
    const intent = typedIntent({});
    expect(() => chainPrompt("en", intent)).toThrow(KernelError);
    expect(() => chainPrompt("en", intent)).toThrow(
      /unreachable: typed data is neither recognised, shown nor blind/,
    );
  });
});

describe("near-miss blind prompts", () => {
  const account = { kind: "hd" as const, walletId: "w", groupIndex: 0, template: "evm" };
  const SIGNER = "0x52908400098527886E0F7030069857D2E4169EE7";
  const USDC_ADDR = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const SOL_PAYER = base58.encode(new Uint8Array(32).fill(0x11));
  const typed = (doc: unknown) =>
    decodeEvm(
      { kind: "evm.typed-data", network: "eip155:1", account, typedData: JSON.stringify(doc) },
      SIGNER,
    );
  const OTHER = "0x0000000000000000000000000000000000001234";

  it("a typed-data near miss of a listed token is blind, in both locales", () => {
    const intent = typed({
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
        ],
      },
      primaryType: "TransferWithAuthorization",
      domain: { name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC_ADDR },
      message: { from: SIGNER, to: OTHER, value: "1" },
    });
    expect(intent.blind).toBe("typed-data-variant");
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description:
        "App: USD Coin\n" +
        "Network: Ethereum\n" +
        `Verifying contract ${USDC_ADDR}\n` +
        "Type: TransferWithAuthorization\n" +
        "The wallet recognises this kind of signature but not this form of it; it may authorise moving assets\n" +
        "The wallet cannot verify what this signature authorises\n" +
        `· from = ${SIGNER}\n· to = ${OTHER}\n· value = 1`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认盲签",
      description:
        "应用：USD Coin\n" +
        "网络：Ethereum\n" +
        `验证合约 ${USDC_ADDR}\n` +
        "类型：TransferWithAuthorization\n" +
        "钱包认识这类签名，但不认识这种形式；它可能授权转移资产\n" +
        "钱包无法核实此签名授权的内容\n" +
        `· from = ${SIGNER}\n· to = ${OTHER}\n· value = 1`,
    });
  });

  it("a typed-data variant without showable fields says both", () => {
    const intent = typed({
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Permit: Array.from({ length: 17 }, (_, i) => ({ name: `f${i}`, type: "uint256" })),
      },
      primaryType: "Permit",
      domain: {
        chainId: 1,
        verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      },
      message: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, "1"])),
    });
    expect(intent.blind).toBe("typed-data-variant");
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description:
        "Network: Ethereum\n" +
        "Verifying contract 0x000000000022D473030F116dDEE9F6B43aC78BA3\n" +
        "Type: Permit\n" +
        "The wallet recognises this kind of signature but not this form of it; it may authorise moving assets\n" +
        "This typed data is too large to show in full",
    });
  });

  it("a Seaport order over the item limit is blind in both locales", () => {
    const itemFields = [
      { name: "itemType", type: "uint8" },
      { name: "token", type: "address" },
      { name: "identifierOrCriteria", type: "uint256" },
      { name: "startAmount", type: "uint256" },
      { name: "endAmount", type: "uint256" },
    ];
    const item = {
      itemType: 0,
      token: "0x0000000000000000000000000000000000000000",
      identifierOrCriteria: "0",
      startAmount: "1000000000000000000",
      endAmount: "1000000000000000000",
    };
    const intent = typed({
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
        OfferItem: itemFields,
        ConsiderationItem: [...itemFields, { name: "recipient", type: "address" }],
      },
      primaryType: "OrderComponents",
      domain: {
        name: "Seaport",
        version: "1.6",
        chainId: 1,
        verifyingContract: "0x0000000000000068F116a894984e2DB1123eB395",
      },
      message: {
        offerer: SIGNER,
        zone: "0x0000000000000000000000000000000000000000",
        offer: Array.from({ length: 9 }, () => item),
        consideration: [{ ...item, startAmount: "0", endAmount: "0", recipient: SIGNER }],
        orderType: 0,
        startTime: "1700000000",
        endTime: "1700001000",
        zoneHash: `0x${"00".repeat(32)}`,
        salt: "1",
        conduitKey: `0x${"00".repeat(32)}`,
        counter: "0",
      },
    });
    expect(intent.blind).toBe("typed-data-oversize");
    const prompt = chainPrompt("en", intent);
    expect(prompt.title).toBe("Confirm blind signing");
    expect(prompt.description).toContain("… 1 more items not shown");
    expect(chainPrompt("zh-Hans", intent).title).toBe("确认盲签");
  });

  it("a Solana instruction of a core program the signer signs is blind, in both locales", () => {
    const payer = new Uint8Array(32).fill(0x11);
    const src = new Uint8Array(32).fill(0x22);
    const dst = new Uint8Array(32).fill(0x33);
    const token = base58.decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const message = new Uint8Array([
      1,
      0,
      1,
      4,
      ...payer,
      ...src,
      ...dst,
      ...token,
      ...new Uint8Array(32).fill(0x44),
      1,
      3,
      3,
      1,
      2,
      0,
      9,
      3,
      5,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    const req = normalizeSolana(
      {
        kind: "solana.transaction",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44-change" },
        message,
      },
      SOL_PAYER,
    ) as never;
    const intent = decodeSolana(req, SOL_PAYER);
    expect(intent.blind).toBe("core-instruction");
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description:
        "Network: Solana\n" +
        "Program calls the wallet cannot decode: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA\n" +
        "These programs can move assets from the accounts in this transaction\n" +
        "Max fee 0.000005 SOL",
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认盲签",
      description:
        "网络：Solana\n" +
        "钱包无法解码的程序调用：TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA\n" +
        "这些程序可以转移本交易涉及账户中的资产\n" +
        "最高手续费 0.000005 SOL",
    });
  });
});

describe("blind text prompts", () => {
  const account = { kind: "hd" as const, walletId: "w", groupIndex: 0, template: "evm" };
  const SIGNER = "0x52908400098527886E0F7030069857D2E4169EE7";
  const personal = (text: string) =>
    decodeEvm(
      {
        kind: "evm.personal-message",
        network: "eip155:1",
        account,
        message: new TextEncoder().encode(text),
      },
      SIGNER,
    );

  it("hex-rendered text shows its excerpt under the encoded-bytes hazard, in both locales", () => {
    const text = `0x${"ab".repeat(32)}`;
    const intent = personal(text);
    expect(intent.blind).toBe("message-bytes");
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description: `This text encodes raw bytes; the wallet cannot see what they authorise\nMessage:\n${text}`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认盲签",
      description: `文本是原始字节的编码；钱包无法看到它们授权的内容\n消息：\n${text}`,
    });
  });

  it("a 32-byte text shows under the digest-length hazard, in both locales", () => {
    const text = "Sign in to app.example.org #4821";
    const intent = personal(text);
    expect(intent.blind).toBe("message-bytes");
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description: `This 32-byte message could be a hash: signing it may authorise whatever the hash commits to\nMessage:\n${text}`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认盲签",
      description: `这条 32 字节的消息可能是哈希：签署它可能授权该哈希所承诺的任何内容\n消息：\n${text}`,
    });
  });

  it("text with a bidi override shows under the hidden-characters hazard, sanitised", () => {
    const intent = personal("pay \u202Ebob");
    expect(intent.blind).toBe("message-bytes");
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description:
        "This text contains hidden or reordering characters (shown as �); what you read may differ from what is signed\nMessage:\npay �bob",
    });
  });

  it("a Persian ZWNJ login is ordinary text, not blind", () => {
    const text = "برای ورود به حساب کاربری می\u200Cخواهم امضا کنم";
    const intent = personal(text);
    expect(intent.blind).toBeUndefined();
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm signature",
      description: `Message:\n${text}`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认签名",
      description: `消息：\n${text}`,
    });
  });
});

describe("hyperliquid prompts", () => {
  const HL_DEST = "0x5E9EE1089755C3435139848e47e6635505D5a13A";
  const HL_AGENT = "0x1234567890AbcdEF1234567890aBcdef12345678";
  const HL_SUB = "0x0123456789abcDEF0123456789abCDef01234567";
  const HL_BUILDER = "0x0000000000000000000000000000000000000Bad";
  const HL_VALIDATOR = "0x0000000000000000000000000000000000000123";
  const HL_TOKEN = "SPOT:0x22222222222222222222222222222222";
  const HL_POWERS =
    "The agent can trade for this account and its sub-accounts and move funds inside Hyperliquid, including into vaults, without asking you. It cannot withdraw or send funds to other accounts.";
  const HL_POWERS_ZH =
    "该代理无需你确认即可替此账户及其子账户交易，并在 Hyperliquid 内转移资金（包括存入金库）；它不能提现或向其他账户转账。";

  const hlIntent = (
    summary: PromptIntent["summary"],
    verifiability: PromptIntent["verifiability"],
    hyperliquid: NonNullable<
      Extract<PromptIntent["message"], { kind: "typed-data" }>["hyperliquid"]
    >,
  ): PromptIntent => ({
    summary,
    outflows: [],
    approvals: [],
    fee: undefined,
    verifiability,
    network: "eip155:42161",
    message: {
      kind: "typed-data",
      primaryType: "HyperliquidTransaction:X",
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: 42161,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      data: {},
      hyperliquid,
    },
  });

  it("withdraw names the bridge and its fee", () => {
    const intent = hlIntent("transfer", "partial", {
      kind: "withdraw",
      chain: "Testnet",
      destination: HL_DEST,
      amount: "25",
    });
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm transfer",
      description: `Hyperliquid Testnet\nWithdraw 25 USDC from Hyperliquid to ${HL_DEST} through the Hyperliquid bridge\nHyperliquid charges a withdrawal fee`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认转账",
      description: `Hyperliquid 测试网\n经 Hyperliquid 跨链桥提现 25 USDC 到 ${HL_DEST}\nHyperliquid 会收取提现手续费`,
    });
  });

  it("spot-send warns the token name is unverified", () => {
    const intent = hlIntent("transfer", "partial", {
      kind: "spot-send",
      chain: "Testnet",
      destination: HL_DEST,
      token: HL_TOKEN,
      amount: "10.25",
    });
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm transfer",
      description: `Hyperliquid Testnet\nSend 10.25 of token ${HL_TOKEN} to ${HL_DEST} on Hyperliquid\nThe wallet cannot verify the token's name; check its id`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认转账",
      description: `Hyperliquid 测试网\n在 Hyperliquid 上发送 10.25 代币 ${HL_TOKEN} 到 ${HL_DEST}\n钱包无法核实代币名称，请核对其 id`,
    });
  });

  it("usd-class-transfer names both directions", () => {
    const toPerp = hlIntent("transfer", "full", {
      kind: "usd-class-transfer",
      chain: "Mainnet",
      amount: "5",
      toPerp: true,
    });
    expect(chainPrompt("en", toPerp)).toStrictEqual({
      title: "Confirm transfer",
      description: "Hyperliquid Mainnet\nMove 5 USDC from your Hyperliquid spot balance to perps",
    });
    expect(chainPrompt("zh-Hans", toPerp)).toStrictEqual({
      title: "确认转账",
      description: "Hyperliquid 主网\n将 5 USDC 从 Hyperliquid 现货账户转入永续账户",
    });
    const toSpot = hlIntent("transfer", "full", {
      kind: "usd-class-transfer",
      chain: "Testnet",
      amount: "0.75",
      toPerp: false,
    });
    expect(chainPrompt("en", toSpot).description).toBe(
      "Hyperliquid Testnet\nMove 0.75 USDC from your Hyperliquid perps balance to spot",
    );
    expect(chainPrompt("zh-Hans", toSpot).description).toBe(
      "Hyperliquid 测试网\n将 0.75 USDC 从 Hyperliquid 永续账户转入现货账户",
    );
  });

  it("send-asset names both DEXes and the sub-account", () => {
    const intent = hlIntent("transfer", "partial", {
      kind: "send-asset",
      chain: "Mainnet",
      destination: HL_DEST,
      sourceDex: "",
      destinationDex: "spot",
      token: HL_TOKEN,
      amount: "1.5",
    });
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm transfer",
      description: `Hyperliquid Mainnet\nSend 1.5 of token ${HL_TOKEN} from perps to spot of ${HL_DEST}\nThe wallet cannot verify the token's name; check its id`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认转账",
      description: `Hyperliquid 主网\n发送 1.5 代币 ${HL_TOKEN}：从永续账户到 ${HL_DEST} 的现货账户\n钱包无法核实代币名称，请核对其 id`,
    });
    const sub = hlIntent("transfer", "partial", {
      kind: "send-asset",
      chain: "Testnet",
      destination: HL_DEST,
      sourceDex: "spot",
      destinationDex: "builder01",
      token: HL_TOKEN,
      amount: "3",
      fromSubAccount: HL_SUB,
    });
    expect(chainPrompt("en", sub).description).toBe(
      `Hyperliquid Testnet\nSend 3 of token ${HL_TOKEN} from spot to DEX builder01 of ${HL_DEST}\nFrom sub-account ${HL_SUB}\nThe wallet cannot verify the token's name; check its id`,
    );
    expect(chainPrompt("zh-Hans", sub).description).toBe(
      `Hyperliquid 测试网\n发送 3 代币 ${HL_TOKEN}：从现货账户到 ${HL_DEST} 的DEX builder01\n来自子账户 ${HL_SUB}\n钱包无法核实代币名称，请核对其 id`,
    );
  });

  it("staking-withdraw warns about the unstaking queue", () => {
    const intent = hlIntent("stake", "full", {
      kind: "staking-withdraw",
      chain: "Testnet",
      wei: "250000000",
    });
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm staking",
      description:
        "Hyperliquid Testnet\nMove 2.5 HYPE from staking to your spot balance; it arrives after Hyperliquid's 7-day unstaking queue",
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认质押",
      description:
        "Hyperliquid 测试网\n将 2.5 HYPE 从质押账户转回现货账户，经 Hyperliquid 的 7 天解除质押队列后到账",
    });
  });

  it("token-delegate covers delegate and undelegate", () => {
    const delegate = hlIntent("stake", "partial", {
      kind: "token-delegate",
      chain: "Mainnet",
      validator: HL_VALIDATOR,
      wei: "10000000000",
      undelegate: false,
    });
    expect(chainPrompt("en", delegate)).toStrictEqual({
      title: "Confirm staking",
      description: `Hyperliquid Mainnet\nDelegate 100 HYPE to validator ${HL_VALIDATOR}`,
    });
    expect(chainPrompt("zh-Hans", delegate)).toStrictEqual({
      title: "确认质押",
      description: `Hyperliquid 主网\n将 100 HYPE 委托给验证者 ${HL_VALIDATOR}`,
    });
    const undelegate = hlIntent("stake", "partial", {
      kind: "token-delegate",
      chain: "Testnet",
      validator: HL_VALIDATOR,
      wei: "500000000",
      undelegate: true,
    });
    expect(chainPrompt("en", undelegate).description).toBe(
      `Hyperliquid Testnet\nUndelegate 5 HYPE from validator ${HL_VALIDATOR}`,
    );
    expect(chainPrompt("zh-Hans", undelegate).description).toBe(
      `Hyperliquid 测试网\n从验证者 ${HL_VALIDATOR} 取消委托 5 HYPE`,
    );
  });

  it("approve-agent covers named and unnamed agents without expiry", () => {
    const named = hlIntent("approve", "partial", {
      kind: "approve-agent",
      chain: "Mainnet",
      agent: HL_AGENT,
      name: "bot-1",
    });
    expect(chainPrompt("en", named)).toStrictEqual({
      title: "Confirm approval",
      description: `Hyperliquid Mainnet\nApprove agent ${HL_AGENT} named "bot-1"\nNo expiry in the name: Hyperliquid's default applies\n${HL_POWERS}`,
    });
    expect(chainPrompt("zh-Hans", named)).toStrictEqual({
      title: "确认授权",
      description: `Hyperliquid 主网\n授权代理 ${HL_AGENT}，名称“bot-1”\n名称中没有有效期：适用 Hyperliquid 的默认期限\n${HL_POWERS_ZH}`,
    });
    const unnamed = hlIntent("approve", "partial", {
      kind: "approve-agent",
      chain: "Mainnet",
      agent: HL_AGENT,
      name: "",
    });
    expect(chainPrompt("en", unnamed).description).toBe(
      `Hyperliquid Mainnet\nApprove agent ${HL_AGENT} (unnamed)\nNo expiry in the name: Hyperliquid's default applies\n${HL_POWERS}`,
    );
    expect(chainPrompt("zh-Hans", unnamed).description).toBe(
      `Hyperliquid 主网\n授权代理 ${HL_AGENT}（未命名）\n名称中没有有效期：适用 Hyperliquid 的默认期限\n${HL_POWERS_ZH}`,
    );
  });

  it("approve-agent says whether this wallet holds the agent key", () => {
    const action = {
      kind: "approve-agent" as const,
      chain: "Mainnet" as const,
      agent: HL_AGENT,
      name: "bot-1",
      validUntil: 1798765432000,
    };
    const held = chainPrompt("en", {
      ...hlIntent("approve", "partial", action),
      agentHeld: true,
    });
    expect(held.description).toBe(
      `Hyperliquid Mainnet\nApprove agent ${HL_AGENT} named "bot-1"\nThe agent key is held by this wallet\nValid until 2027-01-01 01:03 (UTC)\n${HL_POWERS}`,
    );
    expect(
      chainPrompt("zh-Hans", { ...hlIntent("approve", "partial", action), agentHeld: true })
        .description,
    ).toBe(
      `Hyperliquid 主网\n授权代理 ${HL_AGENT}，名称“bot-1”\n代理密钥由本钱包持有\n有效期至 2027-01-01 01:03（UTC）\n${HL_POWERS_ZH}`,
    );
    const notHeld = chainPrompt("en", {
      ...hlIntent("approve", "partial", action),
      agentHeld: false,
    });
    expect(notHeld.description).toContain(
      "The agent key is not held by this wallet: whoever holds it can trade this account",
    );
    expect(
      chainPrompt("zh-Hans", { ...hlIntent("approve", "partial", action), agentHeld: false })
        .description,
    ).toContain("代理密钥不在本钱包中：持有者可以替此账户交易");
    // Without the binding flag the intent is unchanged (old behavior).
    expect(chainPrompt("en", hlIntent("approve", "partial", action)).description).not.toContain(
      "held by this wallet",
    );
  });

  it("approve-builder-fee names the builder and the rate", () => {
    const intent = hlIntent("approve", "partial", {
      kind: "approve-builder-fee",
      chain: "Mainnet",
      builder: HL_BUILDER,
      maxFeeRate: "0.1%",
    });
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm approval",
      description: `Hyperliquid Mainnet\nAllow builder ${HL_BUILDER} to charge up to 0.1% of each order's value`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认授权",
      description: `Hyperliquid 主网\n允许 builder ${HL_BUILDER} 对每笔订单收取最多 0.1% 的费用`,
    });
  });
});

describe("polymarket prompts", () => {
  const PM_EXCHANGE = "0xE111180000d2663C0091e4f400237545B87B996B";
  const PM_PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
  const PM_CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
  const PM_WALLET = "0x3000000000000000000000000000000000000003";
  const PM_PROXY = "0x1000000000000000000000000000000000000001";
  const PM_SAFE = "0x2000000000000000000000000000000000000002";
  const PM_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const PM_TOKEN = "21742633143463906290569050155826241533067272736897614950488156847949938836455";
  const PM_FEE =
    "Polymarket sets the trading fee when the order is matched; this signature does not cap it";
  const PM_FEE_ZH = "交易手续费由 Polymarket 在撮合时设定；此签名不限制其金额";
  const pusd = (amount: string) => ({ asset: PM_PUSD, decimals: 6, symbol: "pUSD", amount });
  const shares = (amount: string) => ({
    asset: PM_CTF,
    decimals: 6,
    tokenId: PM_TOKEN,
    amount,
  });

  type PmContent = NonNullable<
    Extract<PromptIntent["message"], { kind: "typed-data" }>["polymarket"]
  >;
  const pmIntent = (
    summary: PromptIntent["summary"],
    verifiability: PromptIntent["verifiability"],
    polymarket: PmContent,
    blind?: PromptIntent["blind"],
  ): PromptIntent => ({
    summary,
    outflows: [],
    approvals: [],
    fee: undefined,
    verifiability,
    network: "eip155:137",
    ...(blind === undefined ? {} : { blind }),
    message: {
      kind: "typed-data",
      primaryType: "Order",
      domain: { name: "Polymarket CTF Exchange" },
      data: {},
      polymarket,
    },
  });
  const pmOrder = (
    over: Partial<Extract<PmContent, { kind: "order" }>>,
  ): Extract<PmContent, { kind: "order" }> => ({
    kind: "order",
    exchange: { address: PM_EXCHANGE, name: "CTF Exchange", version: "2" },
    side: "buy",
    tokenId: PM_TOKEN,
    maker: PM_ACCOUNT,
    signer: PM_ACCOUNT,
    wallet: "account",
    give: pusd("50000000"),
    receive: shares("100000000"),
    price: { amount: "500000", exact: true },
    ...over,
  });

  it("an EOA buy shows the exchange, shares and pay cap", () => {
    const intent = pmIntent("swap", "partial", pmOrder({}));
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm order",
      description: `Polymarket CTF Exchange ${PM_EXCHANGE}\nNetwork: Polygon\nBuy at least 100 shares of outcome token ${PM_TOKEN}\nPay at most 50 pUSD (price 0.5 pUSD per share)\n${PM_FEE}`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认订单",
      description: `Polymarket CTF Exchange ${PM_EXCHANGE}\n网络：Polygon\n买入至少 100 份结果代币 ${PM_TOKEN}\n最多支付 50 pUSD（价格 0.5 pUSD/份）\n${PM_FEE_ZH}`,
    });
  });

  it("an EOA sell shows the shares given and the receive floor", () => {
    const intent = pmIntent(
      "swap",
      "partial",
      pmOrder({ side: "sell", give: shares("100000000"), receive: pusd("50000000") }),
    );
    expect(chainPrompt("en", intent).description).toBe(
      `Polymarket CTF Exchange ${PM_EXCHANGE}\nNetwork: Polygon\nSell 100 shares of outcome token ${PM_TOKEN}\nReceive at least 50 pUSD before fees (price 0.5 pUSD per share)\n${PM_FEE}`,
    );
    expect(chainPrompt("zh-Hans", intent).description).toBe(
      `Polymarket CTF Exchange ${PM_EXCHANGE}\n网络：Polygon\n卖出 100 份结果代币 ${PM_TOKEN}\n扣费前至少收到 50 pUSD（价格 0.5 pUSD/份）\n${PM_FEE_ZH}`,
    );
  });

  it("each funding wallet gets its own line", () => {
    const cases = [
      [
        "proxy",
        PM_PROXY,
        `Funds from your Polymarket proxy wallet ${PM_PROXY}`,
        `资金来自你的 Polymarket 代理钱包 ${PM_PROXY}`,
      ],
      [
        "safe",
        PM_SAFE,
        `Funds from your Polymarket Safe ${PM_SAFE}`,
        `资金来自你的 Polymarket Safe ${PM_SAFE}`,
      ],
      [
        "deposit-wallet",
        PM_WALLET,
        `Funds from deposit wallet ${PM_WALLET}; only its owner's signature makes this order valid`,
        `资金来自存款钱包 ${PM_WALLET}；只有其所有者的签名才能使此订单生效`,
      ],
    ] as const;
    for (const [wallet, maker, enLine, zhLine] of cases) {
      const intent = pmIntent("swap", "partial", pmOrder({ wallet, maker, signer: PM_ACCOUNT }));
      expect(chainPrompt("en", intent).description).toContain(enLine);
      expect(chainPrompt("zh-Hans", intent).description).toContain(zhLine);
    }
  });

  it("a non-exact price is marked approximate and builder fields show verbatim", () => {
    const intent = pmIntent(
      "swap",
      "partial",
      pmOrder({
        give: pusd("1000000"),
        receive: shares("3000001"),
        price: { amount: "333333", exact: false },
        builder: `0x${"62".repeat(32)}`,
        metadata: `0x${"ab".repeat(32)}`,
      }),
    );
    expect(chainPrompt("en", intent).description).toBe(
      `Polymarket CTF Exchange ${PM_EXCHANGE}\nNetwork: Polygon\nBuy at least 3.000001 shares of outcome token ${PM_TOKEN}\nPay at most 1 pUSD (price ≈ 0.333333 pUSD per share)\n${PM_FEE}\nBuilder code 0x${"62".repeat(32)}\nOrder metadata 0x${"ab".repeat(32)}`,
    );
    expect(chainPrompt("zh-Hans", intent).description).toBe(
      `Polymarket CTF Exchange ${PM_EXCHANGE}\n网络：Polygon\n买入至少 3.000001 份结果代币 ${PM_TOKEN}\n最多支付 1 pUSD（价格 ≈ 0.333333 pUSD/份）\n${PM_FEE_ZH}\nBuilder 代码 0x${"62".repeat(32)}\n订单元数据 0x${"ab".repeat(32)}`,
    );
  });

  it("CLOB auth prompts as a sign-in", () => {
    const intent = pmIntent("message", "partial", {
      kind: "auth",
      address: PM_ACCOUNT,
      timestamp: 10000000,
      nonce: "23",
    });
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm sign-in",
      description: `Network: Polygon\nCreate or derive Polymarket API credentials for ${PM_ACCOUNT}\nTime 1970-04-26 17:46 (UTC)\nCredential nonce 23\nThe credentials authenticate account requests such as cancelling orders; every order still needs your signature`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认登录",
      description: `网络：Polygon\n为 ${PM_ACCOUNT} 创建或派生 Polymarket API 凭证\n时间 1970-04-26 17:46（UTC）\n凭证序号 23\n凭证用于验证撤单等账户请求；每笔订单仍需你的签名`,
    });
  });

  it("a batch lists every decoded call", () => {
    const call = (over: Partial<DisplayIntent>): DisplayIntent => ({
      summary: "approve",
      outflows: [],
      approvals: [],
      warnings: [],
      fee: undefined,
      verifiability: "partial",
      family: "evm",
      network: "eip155:137",
      ...over,
    });
    const intent = pmIntent("batch", "partial", {
      kind: "batch",
      wallet: PM_WALLET,
      nonce: "7",
      deadline: 1800000000,
      calls: [
        call({
          approvals: [
            {
              kind: "allowance",
              spender: PM_EXCHANGE,
              amount: { asset: PM_PUSD, amount: "25000000" },
              change: "set",
              unlimited: false,
              verified: false,
            },
          ],
        }),
        call({
          approvals: [
            {
              kind: "operator",
              asset: PM_CTF,
              spender: PM_EXCHANGE,
              approved: true,
              verified: false,
            },
          ],
        }),
      ],
    });
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm batch",
      description: `Network: Polygon\nPolymarket deposit wallet ${PM_WALLET}, batch 7, valid until 2027-01-15 08:00 (UTC)\nAllow ${PM_EXCHANGE} to spend 25000000 base units of unverified token ${PM_PUSD}\nAllow ${PM_EXCHANGE} to transfer all tokens of ${PM_CTF}`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认批量交易",
      description: `网络：Polygon\nPolymarket 存款钱包 ${PM_WALLET} 的第 7 批调用，有效期至 2027-01-15 08:00（UTC）\n授权 ${PM_EXCHANGE} 使用 25000000 个最小单位（未验证代币 ${PM_PUSD}）\n授权 ${PM_EXCHANGE} 转走 ${PM_CTF} 的全部代币`,
    });
  });

  it("an oversize batch shows the header and the oversize warning", () => {
    const intent = pmIntent(
      "batch",
      "opaque",
      { kind: "batch", wallet: PM_WALLET, nonce: "7", deadline: 1800000000, calls: [] },
      "typed-data-oversize",
    );
    expect(chainPrompt("en", intent)).toStrictEqual({
      title: "Confirm blind signing",
      description: `Network: Polygon\nPolymarket deposit wallet ${PM_WALLET}, batch 7, valid until 2027-01-15 08:00 (UTC)\nThis typed data is too large to show in full`,
    });
    expect(chainPrompt("zh-Hans", intent)).toStrictEqual({
      title: "确认盲签",
      description: `网络：Polygon\nPolymarket 存款钱包 ${PM_WALLET} 的第 7 批调用，有效期至 2027-01-15 08:00（UTC）\n此类型数据过大，无法完整显示`,
    });
  });
});

describe("decoder warnings reach the prompt", () => {
  const WITNESS_SPENDER = "0x1111111254EEB25477B68fb85Ed929f73A960582";

  const txIntent = (warnings: PromptIntent["warnings"]): PromptIntent => ({
    summary: "swap",
    outflows: [],
    approvals: [],
    fee: undefined,
    verifiability: "partial",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    family: "solana",
    ...(warnings === undefined ? {} : { warnings }),
  });

  const typedIntent = (warnings: PromptIntent["warnings"]): PromptIntent => ({
    summary: "approve",
    outflows: [],
    approvals: [
      {
        kind: "allowance",
        spender: WITNESS_SPENDER,
        amount: { asset: USDC, amount: "1000000", decimals: 6, symbol: "USDC" },
        change: "set",
        unlimited: false,
        verified: true,
      },
    ],
    fee: undefined,
    verifiability: "partial",
    network: "eip155:1",
    family: "evm",
    message: { kind: "typed-data", primaryType: "Permit", domain: {}, data: {} },
    ...(warnings === undefined ? {} : { warnings }),
  });

  it("every catalog warning renders in a transaction prompt, in order, in both locales", () => {
    const kinds = Object.keys(CATALOGS.en.warnings) as IntentWarningKind[];
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      for (const locale of ["en", "zh-Hans"] as const) {
        const prompt = chainPrompt(locale, txIntent([{ kind, message: "50 bps" }]));
        const lines = prompt.description.split("\n");
        expect(lines.at(-1), `${locale} ${kind}`).toBe(CATALOGS[locale].warnings[kind]("50 bps"));
      }
    }
    /* Two warnings keep their order. */
    const ordered = chainPrompt(
      "en",
      txIntent([
        { kind: "platform-fee", message: "50 bps" },
        { kind: "sighash-single-anyonecanpay", message: "m" },
      ]),
    ).description;
    const feeLine = CATALOGS.en.warnings["platform-fee"]("50 bps");
    const sighashLine = CATALOGS.en.warnings["sighash-single-anyonecanpay"]("m");
    expect(ordered.indexOf(feeLine)).toBeGreaterThan(-1);
    expect(ordered.indexOf(feeLine)).toBeLessThan(ordered.indexOf(sighashLine));
  });

  it("every catalog warning renders after the content lines of a typed-data prompt", () => {
    const kinds = Object.keys(CATALOGS.en.warnings) as IntentWarningKind[];
    for (const kind of kinds) {
      for (const locale of ["en", "zh-Hans"] as const) {
        const prompt = chainPrompt(locale, typedIntent([{ kind, message: "50 bps" }]));
        const lines = prompt.description.split("\n");
        expect(lines.at(-1), `${locale} ${kind}`).toBe(CATALOGS[locale].warnings[kind]("50 bps"));
      }
    }
  });

  it("a Permit2 witness order prompts the witness warning", () => {
    const REACTOR = "0x00000000000000000000000000000000C0FFEE01";
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
        permitted: { token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", amount: "1000000000" },
        spender: REACTOR,
        nonce: "1",
        deadline: "2000000000",
        witness: {
          info: {
            reactor: REACTOR,
            swapper: "0x52908400098527886E0F7030069857D2E4169EE7",
            nonce: "1",
            deadline: "2000000000",
            additionalValidationContract: "0x0000000000000000000000000000000000000000",
            additionalValidationData: "0x",
          },
          decayStartTime: "0",
          decayEndTime: "0",
          exclusiveFiller: "0x00000000000000000000000000000000DeaDBeef",
          exclusivityOverrideBps: "0",
          inputToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          inputStartAmount: "1000000000",
          inputEndAmount: "1000000000",
          outputs: [
            {
              token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
              startAmount: "1",
              endAmount: "1",
              recipient: "0x00000000000000000000000000000000DeaDBeef",
            },
          ],
        },
      },
    };
    const intent = decodeEvm(
      {
        kind: "evm.typed-data",
        network: "eip155:1",
        account: { kind: "hd", walletId: "w", groupIndex: 0, template: "evm" },
        typedData: JSON.stringify(doc),
      },
      "0x52908400098527886E0F7030069857D2E4169EE7",
    );
    expect(intent.warnings.map((w) => w.kind)).toStrictEqual(["permit2-witness"]);
    expect(chainPrompt("en", intent).description).toContain(
      "This permit carries further terms (a witness)",
    );
    expect(chainPrompt("zh-Hans", intent).description).toContain("此许可附带附加条款（witness）");
  });
});

describe("typed field lines cannot imitate kernel lines", () => {
  const fieldIntent = (path: string, value: string): PromptIntent => ({
    summary: "message",
    outflows: [],
    approvals: [],
    fee: undefined,
    verifiability: "partial",
    network: "eip155:1",
    family: "evm",
    message: {
      kind: "typed-data",
      primaryType: "Order",
      domain: { chainId: 1 },
      data: {},
      fields: [{ path, value }],
    },
  });

  it("a field named like a kernel line shows as a dotted field line, in both locales", () => {
    const en = chainPrompt("en", fieldIntent("Network", "Sepolia (testnet, no value)"));
    /* Only the kernel's own network line may start with the heading. */
    expect(en.description.split("\n").filter((line) => line.startsWith("Network:"))).toHaveLength(
      1,
    );
    expect(en.description).toContain("\n· Network = Sepolia (testnet, no value)");

    const zh = chainPrompt("zh-Hans", fieldIntent("网络", "Sepolia (testnet)"));
    expect(zh.description.split("\n").filter((line) => line.startsWith("网络："))).toHaveLength(1);
    expect(zh.description).toContain("\n· 网络 = Sepolia (testnet)");
  });
});
