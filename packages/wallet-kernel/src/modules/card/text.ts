/**
 * Kernel-owned card text (design §10): reader prompts and secure-input labels embed only kernel
 * data — short IDs, counts, op names, remaining attempts. The main runtime never supplies or edits
 * these strings; a reader prompt that cannot be built within the byte cap is a `card-unsupported`
 * in runTap, never truncated.
 */
import type { CardTapReason } from "@qntx/wallet/protocol";

import type { PromptLocale } from "../../prompts.ts";

export type CardOpName =
  | "status"
  | "add"
  | "accounts"
  | "health"
  | "change-access"
  | "erase"
  | "create"
  | "sign";

const OP_NAME: Readonly<Record<PromptLocale, Readonly<Record<CardOpName, string>>>> = {
  "zh-Hans": {
    status: "卡片状态",
    add: "添加卡片",
    accounts: "读取账户",
    health: "卡片检查",
    "change-access": "修改访问码",
    erase: "抹掉卡片",
    create: "创建卡钱包",
    sign: "签名",
  },
  en: {
    status: "Card status",
    add: "Add card",
    accounts: "Load accounts",
    health: "Card check",
    "change-access": "Change access code",
    erase: "Erase card",
    create: "Create card wallet",
    sign: "Sign",
  },
};

/** Reader sheet text for a tap step: the op name plus the card's short ID when known. */
export function tapPrompt(
  locale: PromptLocale,
  op: CardOpName,
  reason: CardTapReason,
  card: string | undefined,
): string {
  const name = OP_NAME[locale][op];
  if (reason === "retry") {
    return card === undefined
      ? locale === "zh-Hans"
        ? `${name} — 再次贴卡以继续`
        : `${name} — tap the card again to continue`
      : locale === "zh-Hans"
        ? `${name} — 再次贴卡片 ${card} 以继续`
        : `${name} — tap card ${card} again to continue`;
  }
  if (card === undefined) {
    return locale === "zh-Hans"
      ? `${name} — 将卡片贴近读卡器`
      : `${name} — hold a qntx card to the reader`;
  }
  return locale === "zh-Hans"
    ? `${name} — 将卡片 ${card} 贴近读卡器`
    : `${name} — hold card ${card} to the reader`;
}

const codeFor = (locale: PromptLocale, card: string | undefined): string =>
  card === undefined
    ? locale === "zh-Hans"
      ? "输入这张卡的访问码"
      : "Enter this card's access code"
    : locale === "zh-Hans"
      ? `输入卡片 ${card} 的访问码`
      : `Enter the access code for card ${card}`;

/** Secure-input label for an access-code ask; `remaining` is the card's attempts left. */
export function accessCodeLabel(
  locale: PromptLocale,
  card: string | undefined,
  remaining: number | undefined,
): string {
  const base = codeFor(locale, card);
  if (remaining === undefined) {
    return base;
  }
  if (remaining === 1) {
    return locale === "zh-Hans"
      ? `${base} — 最后一次机会，输错会抹掉这张卡`
      : `${base} — last attempt, a wrong code erases this card`;
  }
  return locale === "zh-Hans" ? `${base} — 还剩 ${remaining} 次` : `${base} — ${remaining} left`;
}

/** Secure-input label for a new access code. */
export function newAccessCodeLabel(locale: PromptLocale, card: string | undefined): string {
  void card;
  return locale === "zh-Hans"
    ? "设置新的访问码（8–64 个可打印字符；6–7 位需要再次输入确认）"
    : "Choose a new access code (8–64 printable characters; 6–7 needs a second entry)";
}

/** Secure-input label for the confirmation entry of a new access code. */
export function confirmAccessCodeLabel(
  locale: PromptLocale,
  card: string | undefined,
  short: boolean,
): string {
  void card;
  if (short) {
    return locale === "zh-Hans"
      ? "访问码较短 — 再次输入以确认"
      : "The code is short — enter it again to confirm";
  }
  return locale === "zh-Hans" ? "再次输入新的访问码" : "Enter the new access code again";
}

/** Secure-input label for the short ID printed on a card. */
export function shortIdLabel(locale: PromptLocale): string {
  return locale === "zh-Hans" ? "输入卡片上印的短 ID" : "Enter the short ID printed on the card";
}

/**
 * The card line under a rendered signing intent on the reader (design §8): the pinned member's
 * short ID when the wallet has one, else an untargeted tap ask.
 */
export function signCardLine(locale: PromptLocale, cards: ReadonlyArray<string>): string {
  const [card] = cards;
  if (card === undefined) {
    return locale === "zh-Hans" ? "贴一张 qntx 卡以签名" : "Tap a qntx card to sign";
  }
  return locale === "zh-Hans" ? `贴卡片 ${card} 以签名` : `Tap card ${card} to sign`;
}
