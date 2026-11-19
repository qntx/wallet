/**
 * Factor plumbing for the host connector: public `UnlockFactor`/`InitialFactor` inputs become wire
 * `Factor` material, passkey material comes from the host's WebAuthn ceremony, and every secret
 * byte travels in a fresh exact-size buffer on the transfer list.
 */
import { base64urlnopad } from "@scure/base";

import type {
  BackupFactor,
  BackupUnlockFactor,
  Factor,
  MethodName,
  ParamsOf,
  VerifyFactor as WireVerifyFactor,
} from "./protocol/index.ts";
import { WalletError } from "./types.ts";
import type {
  FactorInfo,
  InitialFactor,
  PasskeyConfig,
  UnlockFactor,
  VerifyFactor,
} from "./types.ts";

export type PrfSalts = { readonly first: Uint8Array; readonly second?: Uint8Array };

/** Purpose bytes stamped into the first byte of a credential's WebAuthn user handle. */
export const PASSKEY_PURPOSE_WALLET = 0x01;
export const PASSKEY_PURPOSE_VAULT = 0x02;

export type PrfResult = {
  readonly credentialId: Uint8Array;
  readonly first: Uint8Array;
  readonly second?: Uint8Array;
  /** The assertion's `userHandle` — its first byte declares the credential's purpose. */
  readonly userHandle?: Uint8Array;
  /** The credential survives this device: the authenticator data's BE and BS flags are both set. */
  readonly synced: boolean;
};

/**
 * The WebAuthn ceremony the host performs. Implementations throw `WalletError` — "cancelled" when
 * the user aborts, "passkey-prf-unsupported" when the credential cannot produce a PRF. `name` is
 * the new credential's display name, validated by the host before the call (1–64 characters).
 */
export type PasskeyCeremony = {
  readonly create: (input: {
    readonly purpose: "wallet" | "vault";
    readonly name: string;
    readonly salts: PrfSalts;
  }) => Promise<PrfResult>;
  readonly assert: (input: {
    readonly credentialIds?: ReadonlyArray<Uint8Array>;
    readonly salts: PrfSalts;
  }) => Promise<PrfResult>;
};

/**
 * Which vault factors a host offers: `hardware` (React Native — the platform keystore factors,
 * device and hardware, and omitted factors mean the silent device one) or `software` (web/node —
 * passkey and password). The kernel enforces the same rule; resolving here keeps a doomed request
 * from firing a ceremony.
 */
export type FactorMode = "hardware" | "software";

/** What factor resolution needs from the wallet: config, the ceremony, live factor records. */
export type FactorSource = {
  readonly mode: FactorMode;
  readonly passkey: PasskeyConfig;
  readonly ceremony: PasskeyCeremony | undefined;
  readonly factors: () => ReadonlyArray<FactorInfo>;
  /** Whether the vault currently requires a verifying unlock (no device factor). */
  readonly appLock: () => boolean;
};

function hardwareOnly(): WalletError {
  return new WalletError("unsupported", "this host unlocks only with the keystore factors");
}

export function noHardware(): WalletError {
  return new WalletError("unsupported", "keystore factors exist only on React Native");
}

/** The factor `vault.unlock()` uses when the caller passes none. */
export function defaultUnlockFactor(source: FactorSource): UnlockFactor {
  if (source.mode === "hardware") {
    // Under app lock there is no device factor — the silent default would just report not-found.
    return source.appLock() ? { kind: "hardware" } : { kind: "device" };
  }
  return { kind: "passkey" };
}

export function vaultSaltBytes(source: FactorSource): Uint8Array {
  return new TextEncoder().encode(source.passkey.vaultSalt);
}

export function walletSaltBytes(source: FactorSource): Uint8Array {
  return new TextEncoder().encode(source.passkey.walletSalt);
}

export function backupSaltBytes(source: FactorSource): Uint8Array {
  return new TextEncoder().encode(source.passkey.backupSalt);
}

/**
 * The host-run backup passkey ceremony (web): the PRF is evaluated over `backupSalt` with one of
 * the vault's passkey credentials, producing `prfBackup` instead of the vault `prf`.
 */
async function hostBackupPasskey(
  source: FactorSource,
  wire: SecretWire,
): Promise<Extract<BackupFactor, { ceremony: "host" }>> {
  const ceremony = requireCeremony(source);
  const result = await ceremony.assert({
    credentialIds: passkeyCredentialIds(source),
    salts: { first: backupSaltBytes(source) },
  });
  return {
    kind: "passkey",
    ceremony: "host",
    credentialId: wire.bytes(result.credentialId),
    prfBackup: wire.bytes(result.first, true),
  };
}

function backupPassword(
  factor: UnlockFactor,
  wire: SecretWire,
): { readonly kind: "password"; readonly password: Uint8Array } | undefined {
  if (factor.kind === "hardware" || factor.kind === "device") {
    throw new WalletError("invalid-input", "backup factors are passkeys or passwords");
  }
  return factor.kind === "password"
    ? { kind: "password", password: wire.text(factor.password) }
    : undefined;
}

/**
 * Resolves a public `UnlockFactor` to a factor that seals a new backup key. A hardware host lets
 * the kernel register the protection credential itself; nothing secret crosses the channel.
 */
export async function resolveBackupFactor(
  source: FactorSource,
  factor: UnlockFactor,
  wire: SecretWire,
): Promise<BackupFactor> {
  const password = backupPassword(factor, wire);
  if (password !== undefined) {
    return password;
  }
  if (source.mode === "hardware") {
    return {
      kind: "passkey",
      ceremony: "kernel",
      rpId: source.passkey.rpId,
      rpName: source.passkey.rpName,
      backupSalt: source.passkey.backupSalt,
    };
  }
  return hostBackupPasskey(source, wire);
}

/** Resolves a public `UnlockFactor` to a factor that opens a backup envelope. */
export async function resolveBackupUnlockFactor(
  source: FactorSource,
  factor: UnlockFactor,
  wire: SecretWire,
): Promise<BackupUnlockFactor> {
  const password = backupPassword(factor, wire);
  if (password !== undefined) {
    return password;
  }
  if (source.mode === "hardware") {
    return {
      kind: "passkey",
      ceremony: "kernel",
      rpId: source.passkey.rpId,
      backupSalt: source.passkey.backupSalt,
    };
  }
  return hostBackupPasskey(source, wire);
}

/** Passkey credential ids of the current vault factors, for `assert`'s allowCredentials. */
function passkeyCredentialIds(source: FactorSource): Uint8Array[] {
  return source
    .factors()
    .flatMap((factor) =>
      factor.kind === "passkey" ? [base64urlnopad.decode(factor.credentialId)] : [],
    );
}

/**
 * The secret buffers of one request. Every byte array that carries a secret to the kernel is placed
 * here in a fresh exact-size buffer (transferring must never detach caller-owned memory, and a
 * secret source is zeroed once copied); the channel either moves the whole set on the post's
 * transfer list or calls `wipe()`. A wire is never half-detached and never left resident.
 */
export class SecretWire {
  private readonly buffers: ArrayBuffer[] = [];
  private wiped = false;

  /**
   * A wire copy of `source`; `wipeSource` zeroes a secret original after copying. Once the wire is
   * wiped its request is over, so a late copy (a ceremony that settled after the build failed) is
   * zeroed at once instead of staying resident with nothing left to wipe it.
   */
  bytes(source: Uint8Array, wipeSource = false): Uint8Array {
    const wire = new Uint8Array(source);
    if (wipeSource) {
      source.fill(0);
    }
    if (this.wiped) {
      wire.fill(0);
      return wire;
    }
    this.buffers.push(wire.buffer);
    return wire;
  }

  /** A wire copy of a secret string (passwords, mnemonics, passphrases). */
  text(text: string): Uint8Array {
    return this.bytes(new TextEncoder().encode(text));
  }

  /** The `passphrase` wire field for a BIP-39 passphrase: absent for none (undefined or ""). */
  passphrase(text: string | undefined): { readonly passphrase?: Uint8Array } {
    return text === undefined || text === "" ? {} : { passphrase: this.text(text) };
  }

  /** Every buffer this wire recorded — the post's transfer list. */
  get transfer(): ArrayBuffer[] {
    return this.buffers;
  }

  /** Zeroes every recorded buffer still attached — already-transferred ones are gone. */
  wipe(): void {
    this.wiped = true;
    for (const buffer of this.buffers) {
      if (buffer.byteLength > 0) {
        new Uint8Array(buffer).fill(0);
      }
    }
  }
}

/**
 * Param field names whose bytes are secrets. Everything else on the wire — credential ids, public
 * keys, unsigned payloads, ciphertexts — is public material.
 */
type SecretField =
  | "password"
  | "prf"
  | "prfWallet"
  | "prfBackup"
  | "mnemonic"
  | "passphrase"
  | "secret"
  | "answers";

/** True when any field reachable through T's objects, arrays or union members is a SecretField. */
type CarriesSecret<T> = T extends Uint8Array
  ? false
  : T extends ReadonlyArray<infer E>
    ? CarriesSecret<E>
    : T extends Readonly<Record<PropertyKey, unknown>>
      ? true extends {
          [K in keyof T]: K extends SecretField ? true : CarriesSecret<T[K]>;
        }[keyof T]
        ? true
        : false
      : false;

/** Methods whose params can carry secret bytes — they may only be sent through callWithSecrets. */
export type SecretMethod = {
  [M in MethodName]: true extends CarriesSecret<ParamsOf<M>> ? M : never;
}[MethodName];

/** Methods whose params never carry secret bytes. */
export type PlainMethod = Exclude<MethodName, SecretMethod>;

/**
 * Every field name under which T's values hold a `Uint8Array`, reached through objects, arrays,
 * union members and optional fields — a `ReadonlyArray<Uint8Array>` field names its field too.
 */
export type BytesFieldOf<T> = T extends Uint8Array
  ? never
  : T extends ReadonlyArray<infer E>
    ? BytesFieldOf<E>
    : T extends Readonly<Record<PropertyKey, unknown>>
      ? {
          [K in keyof T]-?: NonNullable<T[K]> extends Uint8Array | ReadonlyArray<Uint8Array>
            ? K
            : BytesFieldOf<NonNullable<T[K]>>;
        }[keyof T]
      : never;

/**
 * Param byte fields that are public material: credential ids, public keys, ciphertexts, unsigned
 * payloads, hashes and signature shares.
 */
type PublicBytesField =
  | "adaptorPublicKey"
  | "binding"
  | "challenge"
  | "ciphertext"
  | "ciphertexts"
  | "connectorTx"
  | "credentialId"
  | "exitTx"
  | "hashLockPublicKey"
  | "hiding"
  | "identityPublicKey"
  | "invoice"
  | "message"
  | "ownerPublicKey"
  | "package"
  | "partialTransaction"
  | "paymentHash"
  | "psbt"
  | "publicKey"
  | "receiverIdentityPublicKey"
  | "script"
  | "secretCipher"
  | "signatureShare"
  | "sspSignature"
  | "tokenIdentifier"
  | "transaction"
  | "txid"
  | "verifyingKey";

/**
 * `never` while every params byte field is classified. A new `Uint8Array` params field lands here,
 * failing the type test until it joins {@link SecretField} (secret bytes) or {@link PublicBytesField}
 * (public material).
 */
export type UnclassifiedBytesField = Exclude<
  { [M in MethodName]: BytesFieldOf<ParamsOf<M>> }[MethodName],
  SecretField | PublicBytesField
>;

export function requireCeremony(source: FactorSource): PasskeyCeremony {
  if (source.ceremony === undefined) {
    throw new WalletError("unsupported", "no passkey ceremony is configured");
  }
  return source.ceremony;
}

/** A passkey credential's display name: trimmed, 1–64 UTF-16 code units, else invalid-input. */
export function passkeyName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    throw new WalletError("invalid-input", "the passkey name must be 1–64 characters");
  }
  return trimmed;
}

/**
 * Resolves a public `UnlockFactor` to wire factor material. `wire` collects every buffer the port
 * must move. Ceremony errors surface as they are (cancelled / passkey-prf-unsupported).
 */
export async function resolveFactor(
  source: FactorSource,
  factor: UnlockFactor,
  wire: SecretWire,
): Promise<Factor> {
  if (source.mode === "hardware") {
    if (factor.kind !== "device" && factor.kind !== "hardware") {
      throw hardwareOnly();
    }
    return { kind: factor.kind };
  }
  if (factor.kind === "hardware" || factor.kind === "device") {
    throw noHardware();
  }
  if (factor.kind === "password") {
    return { kind: "password", password: wire.text(factor.password) };
  }
  const ceremony = requireCeremony(source);
  const result = await ceremony.assert({
    credentialIds: passkeyCredentialIds(source),
    salts: { first: vaultSaltBytes(source) },
  });
  return {
    kind: "passkey",
    credentialId: wire.bytes(result.credentialId),
    prf: wire.bytes(result.first, true),
  };
}

/**
 * The fail-closed gate on every verify parameter: a `device` factor proves no presence, so it can
 * never verify — rejected here before any ceremony, and again by the wire validator and the
 * kernel's `verifyFactor`.
 */
export async function resolveVerifyFactor(
  source: FactorSource,
  factor: VerifyFactor,
  wire: SecretWire,
): Promise<WireVerifyFactor> {
  if ((factor as UnlockFactor).kind === "device") {
    throw new WalletError("invalid-input", "the device factor cannot verify");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- device was rejected above
  return (await resolveFactor(source, factor, wire)) as WireVerifyFactor;
}

/**
 * Resolves a public `InitialFactor` (a factor being created). For `create/restoreWithPasskey` the
 * default passkey factor reuses the wallet ceremony's own credential and `second` PRF output; a
 * hardware host chooses its own vault factors (the wire `device` marker lets the kernel build the
 * device + hardware set) and drops that output.
 */
export async function resolveInitialFactor(
  source: FactorSource,
  factor: InitialFactor | undefined,
  wire: SecretWire,
  walletCeremony?: PrfResult,
): Promise<Factor> {
  if (source.mode === "hardware") {
    walletCeremony?.second?.fill(0);
    if (factor !== undefined) {
      throw new WalletError("unsupported", "this host chooses its own vault factors");
    }
    return { kind: "device" };
  }
  if (factor === undefined || factor.kind === "passkey") {
    const name = factor === undefined ? undefined : passkeyName(factor.name);
    if (walletCeremony !== undefined) {
      const { second } = walletCeremony;
      if (second === undefined) {
        throw new WalletError(
          "passkey-prf-unsupported",
          "the ceremony returned no vault PRF output",
        );
      }
      return {
        kind: "passkey",
        credentialId: wire.bytes(walletCeremony.credentialId),
        prf: wire.bytes(second, true),
      };
    }
    if (name === undefined) {
      // No caller reaches this today (createFactorParam requires a factor), but the ceremony
      // contract needs a name — fail closed rather than inventing one.
      throw new WalletError("invalid-input", "a passkey factor requires a name");
    }
    const result = await requireCeremony(source).create({
      purpose: "vault",
      name,
      salts: { first: vaultSaltBytes(source) },
    });
    return {
      kind: "passkey",
      credentialId: wire.bytes(result.credentialId),
      prf: wire.bytes(result.first, true),
    };
  }
  if (factor.kind === "password") {
    walletCeremony?.second?.fill(0); // the passkey vault factor is not needed
    return { kind: "password", password: wire.text(factor.password) };
  }
  throw noHardware();
}
