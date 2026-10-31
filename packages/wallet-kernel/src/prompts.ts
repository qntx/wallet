/**
 * Kernel-owned verification prompt text (WD-065). The keystore shows these strings in the system
 * verification UI; the main runtime can neither choose nor alter them. The language follows the
 * platform's preferred locale, read natively — `zh*` selects Simplified Chinese, anything else
 * English.
 */
import type { KeystorePrompt } from "./platform.ts";

export type PromptLocale = "zh-Hans" | "en";

export function promptLocale(tag: string): PromptLocale {
  return tag.toLowerCase().startsWith("zh") ? "zh-Hans" : "en";
}

export type CorePromptKind =
  | "unlock"
  | "create"
  | "export-mnemonic"
  | "export-key"
  | "delete-wallet"
  | "remove-key"
  | "backup"
  | "manage-factors"
  | "reset";

const CORE: Readonly<Record<PromptLocale, Readonly<Record<CorePromptKind, KeystorePrompt>>>> = {
  "zh-Hans": {
    unlock: { title: "解锁钱包", description: "验证身份以解锁钱包" },
    create: { title: "保护钱包", description: "验证身份以启用本设备的硬件保护" },
    "export-mnemonic": { title: "导出助记词", description: "验证身份以显示助记词" },
    "export-key": { title: "导出私钥", description: "验证身份以导出私钥" },
    "delete-wallet": { title: "删除钱包", description: "验证身份以从本设备删除此钱包" },
    "remove-key": { title: "删除密钥", description: "验证身份以删除此密钥" },
    backup: { title: "开启云备份", description: "验证身份以开启云备份" },
    "manage-factors": { title: "管理解锁方式", description: "验证身份以更改钱包的解锁方式" },
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
    "export-key": {
      title: "Export private key",
      description: "Verify your identity to export the private key",
    },
    "delete-wallet": {
      title: "Delete wallet",
      description: "Verify your identity to delete this wallet from this device",
    },
    "remove-key": { title: "Remove key", description: "Verify your identity to remove this key" },
    backup: {
      title: "Turn on cloud backup",
      description: "Verify your identity to turn on cloud backup",
    },
    "manage-factors": {
      title: "Manage unlock methods",
      description: "Verify your identity to change how the wallet unlocks",
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

/** A prompt thunk for a core operation — the keystore locale is read only when it runs. */
export const corePromptFor =
  (keystore: { readonly locale: string } | undefined, kind: CorePromptKind) => (): KeystorePrompt =>
    corePrompt(promptLocale(keystore?.locale ?? "en"), kind);

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
