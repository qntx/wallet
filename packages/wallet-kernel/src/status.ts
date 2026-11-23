import { PROTOCOL_VERSION } from "@qntx/wallet/protocol";
import type { BackupInfo, NullValue } from "@qntx/wallet/protocol";
import type { FactorInfo, NostrKeyInfo, StatusPayload, WalletInfo } from "@qntx/wallet/types";

import type { KernelContext, VaultHooks } from "./commands/context.ts";
import { KernelError } from "./errors.ts";
import { CARD_WALLET_KIND, cardWalletInfo, parseCardWalletHeader } from "./modules/card/record.ts";
import type { NostrModule } from "./modules/nostr/index.ts";
import {
  HARDWARE_WALLET_KIND,
  hardwareWalletInfo,
  parseHardwareHeader,
} from "./modules/signers/record.ts";
import {
  parseBackupKeyHeader,
  parseDataKeyHeader,
  parseEntropyHeader,
  parseKeyHeader,
  parsePolicyHeader,
} from "./vault/headers.ts";
import { MANIFEST_HEADER, MANIFEST_ID, MANIFEST_KIND } from "./vault/manifest.ts";
import { BLIND_SIGNING, POLICY_KIND } from "./vault/policy.ts";
import type { StoredRecord, VaultImage } from "./vault/store.ts";
import { VAULT_FORMAT } from "./vault/store.ts";
import { factorInfo, walletInfo } from "./vault/vault.ts";

/** The kernel's read on a loaded vault image; `unavailable` never appears here (load threw). */
export type ImageHealth = "ok" | "corrupted" | "unsupported";

function metaHealth(image: VaultImage): ImageHealth | undefined {
  const { meta } = image;
  if (meta === undefined) {
    // No meta but stored rows: the vault was torn halfway — corrupted.
    return image.records.length > 0 || image.factors.length > 0 ? "corrupted" : "ok";
  }
  if (!Number.isSafeInteger(meta.format)) {
    return "corrupted";
  }
  if (meta.format !== VAULT_FORMAT) {
    return "unsupported";
  }
  if (
    !Number.isSafeInteger(meta.revision) ||
    meta.revision < 1 ||
    typeof meta.keyId !== "string" ||
    !/^[0-9a-f]{32}$/.test(meta.keyId)
  ) {
    return "corrupted";
  }
  return undefined;
}

const FACTOR_KINDS = new Set(["device", "hardware", "password", "passkey"]);

/**
 * Snapshot contents for the `status` payload — the record-ownership composition point, and the
 * image's health assessment. The core parses the kinds it owns (entropy, data-key), every record a
 * module claims is re-parsed by that module's `parseHeader`, and each module's own status function
 * is called explicitly. An unclaimed kind or a newer format marks the vault `unsupported` — the
 * data stays untouched and the user must update; a malformed known header marks it `corrupted`.
 * Locked snapshots are display-only data from unauthenticated public headers.
 */
export function statusContents(
  image: VaultImage,
  modules: ReadonlyArray<VaultHooks>,
  nostr: NostrModule,
): {
  factors: FactorInfo[];
  wallets: WalletInfo[];
  keys: ReadonlyArray<NostrKeyInfo>;
  importedKeys: ReadonlyArray<{
    keyId: string;
    family: "evm" | "solana" | "bitcoin" | "tron";
    address: string;
    createdAt: number;
  }>;
  backup: BackupInfo | NullValue;
  blindSigning: boolean;
  health: ImageHealth;
} {
  const factors: FactorInfo[] = [];
  const wallets: WalletInfo[] = [];
  const importedKeys: Array<{
    keyId: string;
    family: "evm" | "solana" | "bitcoin" | "tron";
    address: string;
    createdAt: number;
  }> = [];
  let backup: BackupInfo | NullValue = null;
  let blindSigning = false;
  const owned: StoredRecord[] = [];
  const meta = metaHealth(image);
  let corrupted = meta === "corrupted";
  let unsupported = meta === "unsupported";
  // Keystore factor kinds are singular: a second row of either means the vault was torn.
  for (const kind of ["device", "hardware"]) {
    if (image.factors.filter((factor) => factor.kind === kind).length > 1) {
      corrupted = true;
    }
  }
  for (const factor of image.factors) {
    if (!FACTOR_KINDS.has(factor.kind)) {
      unsupported = true; // a factor kind written by another build
      continue;
    }
    try {
      factors.push(factorInfo(factor));
    } catch (error) {
      if (error instanceof KernelError && error.code === "unsupported") {
        unsupported = true;
      } else {
        corrupted = true;
      }
    }
  }
  for (const record of image.records) {
    try {
      if (record.kind === "entropy") {
        wallets.push(walletInfo(parseEntropyHeader(record.header)));
      } else if (record.kind === "data-key") {
        parseDataKeyHeader(record.header);
      } else if (record.kind === "key") {
        const header = parseKeyHeader(record.header);
        importedKeys.push({ keyId: record.id, ...header });
      } else if (record.kind === HARDWARE_WALLET_KIND) {
        const header = parseHardwareHeader(record.header);
        wallets.push({ ...hardwareWalletInfo(header), walletId: record.id });
      } else if (record.kind === CARD_WALLET_KIND) {
        wallets.push(cardWalletInfo(parseCardWalletHeader(record.header)));
      } else if (record.kind === "backup-key") {
        // The backup key is a single fixed record — a stray id is malformed.
        if (record.id === "default") {
          const header = parseBackupKeyHeader(record.header);
          backup = {
            id: header.id,
            factors: header.factors.map((f) => f.kind),
            createdAt: header.createdAt,
          };
        } else {
          corrupted = true;
        }
      } else if (record.kind === MANIFEST_KIND) {
        // Authenticated at unlock; structurally there is one, with no public content.
        corrupted ||= record.id !== MANIFEST_ID || record.header !== MANIFEST_HEADER;
      } else if (record.kind === POLICY_KIND) {
        // One known policy; any other id was written by another build.
        if (record.id === BLIND_SIGNING) {
          parsePolicyHeader(record.header);
          blindSigning = true;
        } else {
          unsupported = true;
        }
      } else {
        /* An owned record's header is checked by its module — malformed is vault corruption like
           any other authenticated public row. The record joins `owned` before the parse so the
           module's status section still sees it when the parse throws. */
        const owner = modules.find((module) => module.ownsRecord(record.kind));
        if (owner === undefined) {
          unsupported = true; // a record kind no module of this build owns
        } else {
          owned.push(record);
          owner.parseHeader(record);
        }
      }
    } catch {
      corrupted = true;
    }
  }
  // An established vault carries exactly one manifest — without it nothing vouches for the rest.
  if (
    image.meta !== undefined &&
    image.records.filter((r) => r.kind === MANIFEST_KIND).length !== 1
  ) {
    corrupted = true;
  }
  const section = nostr.status(owned.filter((record) => nostr.vault.ownsRecord(record.kind)));
  corrupted = corrupted || section.corrupted;
  return {
    factors,
    wallets,
    keys: section.keys,
    importedKeys,
    backup,
    blindSigning,
    health: unsupported ? "unsupported" : corrupted ? "corrupted" : "ok",
  };
}

/** The `status` payload for the current session + image; shared by `status` and `postStatus`. */
export function statusPayload(ctx: KernelContext, nostr: NostrModule): StatusPayload {
  const { factors, wallets, keys, importedKeys, backup, blindSigning } = statusContents(
    ctx.image,
    ctx.modules,
    nostr,
  );
  return {
    protocol: PROTOCOL_VERSION,
    vault: ctx.health === "ok" ? ctx.session.status : ctx.health,
    // App lock is the absence of the silent device factor on an established vault.
    appLock: ctx.image.meta !== undefined && !ctx.image.factors.some((f) => f.kind === "device"),
    verification: factors.some(
      (f) => f.kind === "hardware" || f.kind === "passkey" || f.kind === "password",
    )
      ? "available"
      : "unavailable",
    factors,
    wallets,
    nostr: { keys },
    importedKeys,
    backup,
    blindSigning,
  };
}
