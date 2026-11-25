/**
 * Kernel-owned verification prompt text (WD-065). The keystore shows these strings in the system
 * verification UI; the main runtime can neither choose nor alter them. The language follows the
 * platform's preferred locale, read natively — Simplified Chinese for `zh` locales that are not
 * Traditional-script or Traditional-region, English for everything else.
 */
import type { HardwareDevice } from "@qntx/wallet/protocol";

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

/** Verification kinds for card operations — the card namespace of `corePrompt`. */
export type CardPromptKind =
  | "card-change-access"
  | "card-erase"
  | "card-create"
  | "card-transfer"
  | "card-reseal"
  | "card-forget-access";

const CARD: Readonly<
  Record<PromptLocale, Readonly<Record<CardPromptKind, (cards: string) => KeystorePrompt>>>
> = {
  "zh-Hans": {
    "card-change-access": (cards) => ({
      title: "更改卡片访问码",
      description: `验证身份以更改卡 ${cards} 的访问码`,
    }),
    "card-erase": (cards) => ({
      title: "擦除卡上的钱包",
      description: `验证身份以擦除卡 ${cards} 上的钱包`,
    }),
    "card-create": (cards) => ({
      title: "创建卡钱包",
      description: `验证身份以将钱包移入卡 ${cards}`,
    }),
    "card-transfer": (cards) => ({
      title: "写入成员卡",
      description: `验证身份以把钱包写入卡 ${cards}`,
    }),
    "card-reseal": (cards) => ({
      title: "重写卡访问码",
      description: `验证身份以给卡 ${cards} 设置新的访问码`,
    }),
    "card-forget-access": (cards) => ({
      title: "遗忘卡访问码",
      description: `验证身份以删除卡 ${cards} 已保存的访问码`,
    }),
  },
  en: {
    "card-change-access": (cards) => ({
      title: "Change card access code",
      description: `Verify your identity to change the access code on ${cards}`,
    }),
    "card-erase": (cards) => ({
      title: "Erase the card's wallet",
      description: `Verify your identity to erase the wallet on ${cards}`,
    }),
    "card-create": (cards) => ({
      title: "Create card wallet",
      description: `Verify your identity to move the wallet onto ${cards}`,
    }),
    "card-transfer": (cards) => ({
      title: "Provision member card",
      description: `Verify your identity to write the wallet onto ${cards}`,
    }),
    "card-reseal": (cards) => ({
      title: "Reseal card",
      description: `Verify your identity to set a new access code on ${cards}`,
    }),
    "card-forget-access": (cards) => ({
      title: "Forget card access code",
      description: `Verify your identity to delete the saved access code for ${cards}`,
    }),
  },
};

export function cardPrompt(
  locale: PromptLocale,
  kind: CardPromptKind,
  cards: ReadonlyArray<string>,
): KeystorePrompt {
  return CARD[locale][kind](cards.join(", "));
}

/** The display name of a hardware device kind — the user-facing word in device prompts. */
export const HARDWARE_DEVICE_NAME: Readonly<Record<HardwareDevice, string>> = {
  keystone: "Keystone",
  ledger: "Ledger",
  onekey: "OneKey",
};

/**
 * Verification kinds for hardware-signer operations that change what the vault trusts: pairing pins
 * a claimed device's keys; an accounts fetch merges keys for paths the pin does not serve.
 * `hardware-accounts` names the account group the fetch serves.
 */
export type HardwarePromptKind = "hardware-pair" | "hardware-accounts";

const HARDWARE: Readonly<
  Record<
    PromptLocale,
    Readonly<Record<HardwarePromptKind, (device: string, groupIndex: number) => KeystorePrompt>>
  >
> = {
  "zh-Hans": {
    "hardware-pair": (device) => ({
      title: `配对 ${device}`,
      description: `验证身份以配对这台 ${device}——其公开密钥将记录在此设备上`,
    }),
    "hardware-accounts": (device, g) => ({
      title: `获取 ${device} 密钥`,
      description: `验证身份以从这台 ${device} 获取账户 ${g} 的公开密钥`,
    }),
  },
  en: {
    "hardware-pair": (device) => ({
      title: `Pair ${device}`,
      description: `Verify your identity to pair this ${device} — its public keys get pinned`,
    }),
    "hardware-accounts": (device, g) => ({
      title: `Fetch ${device} keys`,
      description: `Verify your identity to fetch the public keys of account ${g} from this ${device}`,
    }),
  },
};

export function hardwarePrompt(
  locale: PromptLocale,
  kind: HardwarePromptKind,
  device: HardwareDevice,
  groupIndex = 0,
): KeystorePrompt {
  return HARDWARE[locale][kind](HARDWARE_DEVICE_NAME[device], groupIndex);
}

/** A prompt thunk for a card operation — locale and the card list resolve only when it runs. */
export const cardPromptFor =
  (
    keystore: { readonly locale: string } | undefined,
    kind: CardPromptKind,
    cards: () => ReadonlyArray<string>,
  ) =>
  (): KeystorePrompt =>
    cardPrompt(promptLocale(keystore?.locale ?? "en"), kind, cards());

/**
 * The `chain.exportAccount` prompt's per-locale text. The prompt is rendered from the requested
 * nodes — one row each — so the verification names every scope the export discloses: the first row
 * frames the share, `evmAccount` states the wallet-wide EVM disclosure, `leaf` and `btcAccount`
 * name the account and template each xpub or public key covers.
 */
export type ExportAccountText = {
  readonly title: string;
  readonly share: (groupIndex: number) => string;
  /** The danger row one unconfirmed device entry adds, ahead of every node row. */
  readonly unconfirmed: (path: string) => string;
  readonly evmAccount: (path: string) => string;
  readonly leaf: (family: "EVM" | "TRON" | "Solana", groupIndex: number, path: string) => string;
  readonly btcAccount: (
    template: string,
    network: string,
    groupIndex: number,
    path: string,
  ) => string;
  readonly btcTemplate: Readonly<
    Record<"btc.bip44" | "btc.bip49" | "btc.bip84" | "btc.bip86", string>
  >;
};

const EXPORT_ACCOUNT: Readonly<Record<PromptLocale, ExportAccountText>> = {
  en: {
    title: "Connect watch-only wallet",
    share: (g) => `Share public keys of account ${g} — never a private key`,
    unconfirmed: (path) =>
      `\u26A0 Not confirmed on the device — check an address of this account on the device first: ${path}`,
    evmAccount: (path) => `EVM: the addresses of every account of this wallet (${path})`,
    leaf: (family, g, path) => `${family} address of account ${g} (${path})`,
    btcAccount: (template, network, g, path) =>
      `Bitcoin ${template} on ${network}: every address of account ${g} (${path})`,
    btcTemplate: {
      "btc.bip44": "Legacy (BIP-44)",
      "btc.bip49": "Wrapped SegWit (BIP-49)",
      "btc.bip84": "Native SegWit (BIP-84)",
      "btc.bip86": "Taproot (BIP-86)",
    },
  },
  "zh-Hans": {
    title: "连接观察钱包",
    share: (g) => `共享账户 ${g} 的公开密钥——绝不包含私钥`,
    unconfirmed: (path) => `\u26A0 未在设备上确认——请先在设备上核对该账户的地址：${path}`,
    evmAccount: (path) => `EVM：本钱包所有账户的地址（${path}）`,
    leaf: (family, g, path) => `${family} 账户 ${g} 的地址（${path}）`,
    btcAccount: (template, network, g, path) =>
      `${network} ${template}：账户 ${g} 的全部地址（${path}）`,
    btcTemplate: {
      "btc.bip44": "传统（BIP-44）",
      "btc.bip49": "兼容隔离见证（BIP-49）",
      "btc.bip84": "原生隔离见证（BIP-84）",
      "btc.bip86": "Taproot（BIP-86）",
    },
  },
};

export function exportAccountText(locale: PromptLocale): ExportAccountText {
  return EXPORT_ACCOUNT[locale];
}

export type BackupPasswordLabel = "choose" | "again" | "mismatch" | "short" | "enter";

/**
 * The secure-input labels for the kernel's backup-password ceremony: enable asks for the new
 * password, then a repeat; a mismatch or a too-short entry is re-asked with the reason in the
 * title; restore asks once.
 */
const BACKUP_PASSWORD_LABELS: Readonly<Record<PromptLocale, Record<BackupPasswordLabel, string>>> =
  {
    "zh-Hans": {
      choose: "选择云备份密码",
      again: "再次输入密码",
      mismatch: "两次输入的密码不一致——选择云备份密码",
      short: "密码至少 12 个字符——选择云备份密码",
      enter: "输入云备份密码",
    },
    en: {
      choose: "Choose a cloud backup password",
      again: "Enter the password again",
      mismatch: "The passwords did not match — choose a cloud backup password",
      short: "Use at least 12 characters — choose a cloud backup password",
      enter: "Enter the cloud backup password",
    },
  };

export function backupPasswordLabel(locale: PromptLocale, kind: BackupPasswordLabel): string {
  return BACKUP_PASSWORD_LABELS[locale][kind];
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

const SESSION_APPROVAL_CODE: Readonly<Record<PromptLocale, (code: string) => string>> = {
  "zh-Hans": (code) => `在下方输入 ${code} 以批准以上限额`,
  en: (code) => `Type ${code} below to approve these limits`,
};

/**
 * The last line of a `session-approval` label — always last, so a clipped label drops the code line
 * first and a submitted code proves the lines above it were on screen.
 */
export function sessionApprovalCode(locale: PromptLocale, code: string): string {
  return SESSION_APPROVAL_CODE[locale](code);
}

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

/** `YYYY-MM-DD` of a Unix-seconds instant in UTC (civil-from-days; no `Date` in the enclave). */
export function utcDate(seconds: number): string {
  const z = Math.floor(seconds / 86_400) + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** `YYYY-MM-DD HH:MM` of a Unix-seconds instant in UTC. */
export const utcDateTime = (seconds: number): string =>
  `${utcDate(seconds)} ${String(Math.floor(seconds / 3600) % 24).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}`;
