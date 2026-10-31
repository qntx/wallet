/**
 * The system verification prompt for `spark.approve`, rendered from the kernel-decoded approval
 * summary (WD-065, G-SV). Receivers are shown as the full lowercase hex identity or owner public
 * key: the Spark address encoder lives in the network client, which the kernel does not bundle.
 */
import { bytesToHex } from "@noble/hashes/utils.js";

import type { SparkApprovalSummary } from "@qntx/wallet/protocol";

import type { KeystorePrompt } from "../../platform.ts";
import { joinLines } from "../../prompts.ts";
import type { PromptLocale } from "../../prompts.ts";

type Catalog = {
  readonly titles: Readonly<Record<SparkApprovalSummary["kind"], string>>;
  readonly send: (sats: number, to: string) => string;
  readonly pay: (sats: number, hash: string) => string;
  readonly payOpen: (hash: string) => string;
  readonly withdraw: (sats: number, address: string) => string;
  readonly onchain: (address: string, maxFee: number) => string;
  readonly maxFee: (maxFee: number) => string;
  readonly sendToken: (amount: string, token: string, to: string) => string;
};

const CATALOGS: Readonly<Record<PromptLocale, Catalog>> = {
  "zh-Hans": {
    titles: {
      transfer: "确认 Spark 转账",
      lightning: "确认闪电付款",
      exit: "确认提取到链上",
      onchain: "确认链上发送",
      token: "确认代币转账",
    },
    send: (sats, to) => `发送 ${sats} sats 到 ${to}`,
    pay: (sats, hash) => `支付 ${sats} sats，付款哈希 ${hash}`,
    payOpen: (hash) => `支付闪电发票，付款哈希 ${hash}`,
    withdraw: (sats, address) => `提取 ${sats} sats 到 ${address}`,
    onchain: (address, maxFee) => `发送到 ${address}，最高手续费 ${maxFee} sats`,
    maxFee: (maxFee) => `最高手续费 ${maxFee} sats`,
    sendToken: (amount, token, to) => `发送 ${amount} 个代币 ${token} 到 ${to}`,
  },
  en: {
    titles: {
      transfer: "Confirm Spark transfer",
      lightning: "Confirm Lightning payment",
      exit: "Confirm withdrawal",
      onchain: "Confirm on-chain send",
      token: "Confirm token transfer",
    },
    send: (sats, to) => `Send ${sats} sats to ${to}`,
    pay: (sats, hash) => `Pay ${sats} sats, payment hash ${hash}`,
    payOpen: (hash) => `Pay a Lightning invoice, payment hash ${hash}`,
    withdraw: (sats, address) => `Withdraw ${sats} sats to ${address}`,
    onchain: (address, maxFee) => `Send to ${address}, max fee ${maxFee} sats`,
    maxFee: (maxFee) => `Max fee ${maxFee} sats`,
    sendToken: (amount, token, to) => `Send ${amount} of token ${token} to ${to}`,
  },
};

function lines(catalog: Catalog, summary: SparkApprovalSummary): string[] {
  if (summary.kind === "transfer") {
    return summary.receivers.map((receiver) =>
      catalog.send(receiver.amountSats, bytesToHex(receiver.identityPublicKey)),
    );
  }
  if (summary.kind === "lightning") {
    const hash = bytesToHex(summary.paymentHash);
    return [
      summary.invoiceAmountSats === undefined
        ? catalog.payOpen(hash)
        : catalog.pay(summary.invoiceAmountSats, hash),
      catalog.maxFee(summary.maxFeeSats),
    ];
  }
  if (summary.kind === "exit") {
    return [
      catalog.withdraw(summary.amountSats, summary.address),
      catalog.maxFee(summary.maxFeeSats),
    ];
  }
  if (summary.kind === "onchain") {
    return [catalog.onchain(summary.address, summary.maxFeeSats)];
  }
  const token = bytesToHex(summary.tokenIdentifier);
  return summary.receivers.map((receiver) =>
    catalog.sendToken(receiver.amount, token, bytesToHex(receiver.ownerPublicKey)),
  );
}

export function sparkPrompt(locale: PromptLocale, summary: SparkApprovalSummary): KeystorePrompt {
  const catalog = CATALOGS[locale];
  return { title: catalog.titles[summary.kind], description: joinLines(lines(catalog, summary)) };
}
