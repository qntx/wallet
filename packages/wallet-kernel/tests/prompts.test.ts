import { hexToBytes } from "@noble/hashes/utils.js";
/**
 * Kernel-owned verification prompt text: exact strings for every core prompt kind, the chain prompt
 * per verifiability level, and every Spark approval kind, in both catalogs.
 */
import { base58 } from "@scure/base";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { describe, expect, it } from "vite-plus/test";

import { decodeBitcoinPsbt } from "@qntx/wallet-chains/bitcoin";
import { decodeEvm } from "@qntx/wallet-chains/evm";
import { decodeSolana, normalizeSolana } from "@qntx/wallet-chains/solana";

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
      description:
        "Delegate this account to EIP7702StatelessDeleGator v1.3.0; the contract can execute calls on its behalf\nSign a request from an app",
    });
    expect(chainPrompt("en", { ...set, delegation: { kind: "revoke" } })).toStrictEqual({
      title: "Confirm batch",
      description: "Revoke this account's contract delegation\nSign a request from an app",
    });
  });

  it("an unknown fee renders its own line; off-chain messages never get one", () => {
    const partial: PromptIntent = { ...ethTransfer, fee: undefined, verifiability: "partial" };
    expect(chainPrompt("en", partial).description).toContain("Fee unknown");
    expect(chainPrompt("zh-Hans", partial).description).toContain("手续费未知");
    const message: PromptIntent = { ...partial, message: { kind: "text", text: "permit" } };
    expect(chainPrompt("en", message).description).not.toContain("Fee unknown");
    expect(chainPrompt("zh-Hans", message).description).not.toContain("手续费未知");
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
        warnings: [{ kind: "platform-fee", message: "50 bps" }],
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
