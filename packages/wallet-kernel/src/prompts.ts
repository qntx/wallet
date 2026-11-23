/**
 * Kernel-owned verification prompt text (WD-065). The keystore shows these strings in the system
 * verification UI; the main runtime can neither choose nor alter them. The language follows the
 * platform's preferred locale, read natively — Simplified Chinese for `zh` locales that are not
 * Traditional-script or Traditional-region, English for everything else.
 */
import type { KeystorePrompt } from "./platform.ts";

export type PromptLocale = "zh-Hans" | "en";

export function promptLocale(tag: string): PromptLocale {
  // BCP-47, case-insensitive. There is no Traditional copy, so a Traditional user must not be
  // shown Simplified text: an explicit script other than Hans, or a Traditional region, is English.
  const [language, ...subtags] = tag.toLowerCase().split("-");
  if (language !== "zh") {
    return "en";
  }
  const script = subtags.find((s) => /^[a-z]{4}$/.test(s));
  if (script !== undefined) {
    return script === "hans" ? "zh-Hans" : "en";
  }
  const region = subtags.find((s) => /^[a-z]{2}$/.test(s) || /^[0-9]{3}$/.test(s));
  return region === "tw" || region === "hk" || region === "mo" ? "en" : "zh-Hans";
}

export type CorePromptKind =
  | "unlock"
  | "create"
  | "export-mnemonic"
  | "export-private-key"
  | "delete-wallet"
  | "remove-private-key"
  | "backup"
  | "disable-backup"
  | "manage-factors"
  | "app-lock"
  | "enable-blind-signing"
  | "disable-blind-signing"
  | "reset";

const CORE: Readonly<Record<PromptLocale, Readonly<Record<CorePromptKind, KeystorePrompt>>>> = {
  "zh-Hans": {
    unlock: { title: "解锁钱包", description: "验证身份以解锁钱包" },
    create: { title: "保护钱包", description: "验证身份以启用本设备的硬件保护" },
    "export-mnemonic": { title: "导出助记词", description: "验证身份以显示助记词" },
    "export-private-key": { title: "导出私钥", description: "验证身份以导出私钥" },
    "delete-wallet": { title: "删除钱包", description: "验证身份以从本设备删除此钱包" },
    "remove-private-key": { title: "删除密钥", description: "验证身份以删除此密钥" },
    backup: { title: "开启云备份", description: "验证身份以开启云备份" },
    "disable-backup": { title: "关闭云备份", description: "验证身份以关闭云备份" },
    "manage-factors": { title: "管理解锁方式", description: "验证身份以更改钱包的解锁方式" },
    "app-lock": { title: "应用锁", description: "验证身份以更改应用锁" },
    "enable-blind-signing": {
      title: "允许盲签",
      description: "验证身份以允许签署钱包无法显示内容的请求",
    },
    "disable-blind-signing": {
      title: "关闭盲签",
      description: "验证身份以停止签署钱包无法显示内容的请求",
    },
    reset: {
      title: "重置钱包",
      description: "验证设备所有者身份以删除本设备上的全部钱包数据",
    },
  },
  en: {
    unlock: { title: "Unlock wallet", description: "Verify your identity to unlock the wallet" },
    create: {
      title: "Protect wallet",
      description: "Verify your identity to protect the wallet with this device",
    },
    "export-mnemonic": {
      title: "Export recovery phrase",
      description: "Verify your identity to reveal the recovery phrase",
    },
    "export-private-key": {
      title: "Export private key",
      description: "Verify your identity to export the private key",
    },
    "delete-wallet": {
      title: "Delete wallet",
      description: "Verify your identity to delete this wallet from this device",
    },
    "remove-private-key": {
      title: "Remove key",
      description: "Verify your identity to remove this key",
    },
    backup: {
      title: "Turn on cloud backup",
      description: "Verify your identity to turn on cloud backup",
    },
    "disable-backup": {
      title: "Turn off cloud backup",
      description: "Verify your identity to turn off cloud backup",
    },
    "manage-factors": {
      title: "Manage unlock methods",
      description: "Verify your identity to change how the wallet unlocks",
    },
    "app-lock": {
      title: "App lock",
      description: "Verify your identity to change the app lock",
    },
    "enable-blind-signing": {
      title: "Allow blind signing",
      description:
        "Verify your identity to allow signing requests whose content the wallet cannot show",
    },
    "disable-blind-signing": {
      title: "Turn off blind signing",
      description: "Verify your identity to stop signing requests the wallet cannot show",
    },
    reset: {
      title: "Reset wallet",
      description: "Verify you own this device to erase all wallet data on it",
    },
  },
};

export function corePrompt(locale: PromptLocale, kind: CorePromptKind): KeystorePrompt {
  return CORE[locale][kind];
}

/**
 * The display name of a backup protection credential, chosen by the kernel so password managers
 * list it apart from the user's wallet passkeys (the RP and app name are shown next to it).
 */
export function backupCredentialName(locale: PromptLocale): string {
  return BACKUP_CREDENTIAL_NAME[locale];
}

const BACKUP_CREDENTIAL_NAME: Readonly<Record<PromptLocale, string>> = {
  "zh-Hans": "云备份密钥",
  en: "Cloud backup key",
};

/** A prompt thunk for a core operation — the keystore locale is read only when it runs. */
export const corePromptFor =
  (keystore: { readonly locale: string } | undefined, kind: CorePromptKind) => (): KeystorePrompt =>
    corePrompt(promptLocale(keystore?.locale ?? "en"), kind);

/**
 * How much prompt text the system verification dialog can show. These are policy values, not
 * platform facts — neither OS documents a limit — and docs/device-checklist.md is what confirms
 * them on real devices; lowering a value is always the safe direction. iOS renders only the
 * description, so it has no title bound. `lines` counts `description.split("\n")`, `characters`
 * counts Unicode code points (not UTF-16 units).
 */
export type PromptBound = {
  readonly title?: number | undefined;
  readonly lines: number;
  readonly characters: number;
};

export const PROMPT_BOUNDS: Readonly<Record<"ios" | "android", PromptBound>> = {
  ios: { lines: 8, characters: 400 },
  android: { title: 60, lines: 12, characters: 640 },
};

/** Unicode code points of `text` — what the platform dialog measures, not UTF-16 units. */
export function codePoints(text: string): number {
  // oxlint-disable-next-line typescript/no-misused-spread -- counts code points; grapheme clusters must not merge
  return [...text].length;
}

/** Whether the rendered prompt fits the platform bound the keystore reports. */
export function promptFits(prompt: KeystorePrompt, bound: PromptBound): boolean {
  return (
    (bound.title === undefined || codePoints(prompt.title) <= bound.title) &&
    prompt.description.split("\n").length <= bound.lines &&
    codePoints(prompt.description) <= bound.characters
  );
}

/**
 * An integer amount in smallest units rendered at `decimals` places with bigint arithmetic — no
 * float rounding — and trailing fractional zeros trimmed. `amount` is a canonical decimal string.
 */
export function formatUnits(amount: string, decimals: number): string {
  const value = BigInt(amount);
  if (decimals === 0) {
    return value.toString();
  }
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

/** The prompt lines joined for the system UI: one fact per line. */
export function joinLines(lines: ReadonlyArray<string>): string {
  return lines.join("\n");
}
