import { bytesToHex } from "@noble/hashes/utils.js";

import type { Factor, NullValue, VerifyFactor } from "@qntx/wallet/protocol";
import type { FactorInfo } from "@qntx/wallet/types";

import { KernelError } from "../errors.ts";
import { assertFactorKindAvailable, requireKeystore } from "../platform.ts";
import type { Pbkdf2 } from "../platform.ts";
import { corePromptFor } from "../prompts.ts";
import { wipe } from "../secret/secret.ts";
import type { Secret } from "../secret/secret.ts";
import { withSeed } from "../seed/seed.ts";
import { resetAnchor } from "../vault/anchor.ts";
import { BLIND_SIGNING, POLICY_KIND, policyRecord, sealPolicy } from "../vault/policy.ts";
import type { StoredRecord, VaultImage } from "../vault/store.ts";
import {
  factorInfo,
  factorRow,
  makeFactor,
  newKeystoreKek,
  openWalletSecret,
  rotateVault,
  unlock,
  verifyFactor,
} from "../vault/vault.ts";
import type { KernelContext } from "./context.ts";
import { passphraseText } from "./passphrase.ts";

/**
 * Opens a wallet's sealed entropy record, then withSeed over its entropy and passphrase; wipes both
 * on every path.
 */
export async function withWalletSeed<R>(
  pbkdf2: Pbkdf2,
  dek: Secret,
  record: StoredRecord,
  use: (seed: Uint8Array) => R | Promise<R>,
): Promise<R> {
  const { entropy, passphrase } = openWalletSecret(dek, record);
  try {
    return await withSeed(pbkdf2, entropy, passphraseText(passphrase), use);
  } finally {
    wipe(entropy);
    if (passphrase !== undefined) {
      wipe(passphrase);
    }
  }
}

const EMPTY_IMAGE: VaultImage = { meta: undefined, records: [], factors: [] };

export async function unlockVault(
  ctx: KernelContext,
  params: { factor: Factor },
): Promise<{ session: string }> {
  // The attempt must see the freshest counters and factor set — not the cached image. If the
  // reload surfaces a non-ok health (data this build rejects), the unlock must not run.
  await ctx.reload();
  if (ctx.health === "corrupted") {
    throw new KernelError("integrity", "the vault is corrupted");
  }
  if (ctx.health === "unsupported") {
    throw new KernelError("unsupported", "the vault needs a newer build");
  }
  const { dek, keyId } = await unlock(ctx.platform, ctx.image, params.factor);
  // Already unlocked on the same vault key: keep the live session — rotating it would orphan
  // every in-flight request the engine issued against the current id.
  if (ctx.session.unlocked && ctx.session.current().keyId === keyId) {
    dek.wipe();
    return { session: ctx.session.current().id };
  }
  const session = await openSession(ctx, dek, keyId);
  // Best-effort cleanup of a dead keystore key of the other kind: probe/commit failures never
  // break the session the unlock just opened.
  await probeKeystoreFactor(ctx, params.factor.kind).catch(() => undefined);
  return { session };
}

/**
 * Probes the keystore factor of the kind `unlockedKind` did not use (device unlock → hardware row;
 * hardware unlock → device row). A `false` probe means the key is gone for good: the row is dropped
 * — never the vault's last factor — and the stale key removed best-effort.
 */
async function probeKeystoreFactor(ctx: KernelContext, unlockedKind: string): Promise<void> {
  const { keystore } = ctx.platform;
  if (keystore === undefined || (unlockedKind !== "device" && unlockedKind !== "hardware")) {
    return;
  }
  const other = unlockedKind === "device" ? "hardware" : "device";
  const row = ctx.image.factors.find((f) => f.kind === other);
  if (row === undefined || ctx.image.factors.length <= 1) {
    return;
  }
  if (await keystore.probe(row.id, other === "device" ? "device" : "presence")) {
    return;
  }
  await ctx.commit([{ op: "delete-factor", id: row.id }]);
  await keystore.remove(row.id).catch(() => undefined);
}

/**
 * Opens a session over `ctx.image` and rebuilds live state in one pass: every module drops stale
 * state, then the whole image reconciles in from empty — the manifest vouches for the vault's
 * structure, every record opens under the DEK and every factor binding verifies. A failure latches
 * corrupted and invalidates the session it just opened. A session that survives authentication
 * raises the vault anchor's floor to the image's revision. Shared by `vault.unlock` and the
 * establish paths that open a session on commit.
 */
export async function openSession(ctx: KernelContext, dek: Secret, keyId: string): Promise<string> {
  for (const module of ctx.modules) {
    module.lock();
  }
  const session = ctx.session.open(dek, keyId);
  ctx.reconcile(EMPTY_IMAGE);
  if (!ctx.session.unlocked) {
    throw new KernelError("integrity", "vault contents failed authentication", undefined, true);
  }
  await ctx.raiseAnchor();
  return session;
}

/**
 * Deletes every record and factor. On a keystore host the device owner proves presence first
 * (WD-055: the main runtime alone cannot erase the vault) and the hardware keys go with the data.
 * An open, healthy vault can only be erased by whoever holds its live session; a locked,
 * forgotten-password or unhealthy vault stays sessionless — reset is its recovery path.
 */
export async function resetVault(
  ctx: KernelContext,
  requestSession: string | undefined,
): Promise<NullValue> {
  if (ctx.session.unlocked && ctx.health === "ok") {
    ctx.session.require(requestSession);
  }
  const { keystore } = ctx.platform;
  if (keystore !== undefined) {
    await keystore.authenticate(corePromptFor(keystore, "reset")());
  }
  // A user-initiated reset locks with "user" before the commit drops the session to
  // uninitialized — an external wipe reaching setInitialized instead reports "invalidated".
  ctx.session.lock("user");
  // Raise the floor before the erase: reset is the recovery path, so a vault the user is wiping
  // loses nothing by reading corrupted if the clear then fails — the next reset finishes it. The
  // opposite order is unrecoverable: the post-clear reload reads the anchor first, so a garbage
  // anchor would fail reset before anything could repair it.
  await resetAnchor(ctx.platform.anchor);
  await ctx.commit([{ op: "clear" }]);
  if (keystore !== undefined) {
    // Best effort: the data is already gone, and the next establish clears leftover keys first.
    await keystore.clear().catch(() => undefined);
  }
  return null;
}

/**
 * Adds a factor after re-verifying with an existing one. A password factor REPLACES the existing
 * password factor and rotates the DEK (change password): every record re-seals and every retained
 * factor re-wraps in one guarded commit — other hosts see the keyId change and invalidate. A
 * passkey factor wraps the current DEK only: no rotation, keyId unchanged. Factor management does
 * not exist on keystore hosts — `enrolVerification` covers their single verifying factor. Kind is
 * checked before the verification prompt.
 */
export async function addFactor(
  ctx: KernelContext,
  params: { verify: VerifyFactor; factor: Factor },
  requestSession: string | undefined,
): Promise<FactorInfo> {
  if (ctx.platform.keystore !== undefined) {
    throw new KernelError("unsupported", "factor management is not available on this host");
  }
  const { dek } = ctx.session.require(requestSession);
  assertFactorKindAvailable(ctx.platform, params.factor.kind);
  await verifyFactor(
    ctx.platform,
    ctx.image,
    params.verify,
    dek,
    ctx.commit,
    corePromptFor(ctx.platform.keystore, "manage-factors"),
  );
  if (params.factor.kind !== "password") {
    const stored = await makeFactor(ctx.platform, params.factor, dek);
    await ctx.commit([{ op: "put-factor", factor: stored }]);
    return factorInfo(stored);
  }
  const replaced = ctx.image.factors.find((f) => f.kind === "password");
  const rotation = await rotateVault(
    ctx.platform,
    ctx.image,
    dek,
    new Set(replaced === undefined ? [] : [replaced.id]),
    [params.factor],
  );
  const addedRow = rotation.added.at(0);
  if (addedRow === undefined) {
    throw new KernelError("integrity", "unreachable: rotation produced no factor");
  }
  const info = factorInfo(addedRow);
  await ctx.commit(rotation.ops, {
    rotate: { dek: rotation.dek, keyId: rotation.keyId },
  });
  return info;
}

export async function removeFactor(
  ctx: KernelContext,
  params: { verify: VerifyFactor; id: string },
  requestSession: string | undefined,
): Promise<NullValue> {
  if (ctx.platform.keystore !== undefined) {
    throw new KernelError("unsupported", "factor management is not available on this host");
  }
  const { dek } = ctx.session.require(requestSession);
  const stored = ctx.image.factors.find((f) => f.id === params.id);
  if (stored === undefined) {
    throw new KernelError("not-found", "no such factor");
  }
  if (ctx.image.factors.length <= 1) {
    throw new KernelError("invalid-input", "the vault must keep at least one factor");
  }
  await verifyFactor(
    ctx.platform,
    ctx.image,
    params.verify,
    dek,
    ctx.commit,
    corePromptFor(ctx.platform.keystore, "manage-factors"),
  );
  const rotation = await rotateVault(ctx.platform, ctx.image, dek, new Set([params.id]), []);
  await ctx.commit(rotation.ops, {
    rotate: { dek: rotation.dek, keyId: rotation.keyId },
  });
  return null;
}

/**
 * Registers the verifying (hardware) factor on a keystore vault that has none — or replaces one the
 * keystore reports dead. The only unguarded enrolment: it exists so a device-only vault can gain
 * presence verification without already having it. A live hardware row is `already-exists`; no lock
 * screen is `verification-unavailable` and writes nothing.
 */
export async function enrolVerification(
  ctx: KernelContext,
  _params: NullValue,
  requestSession: string | undefined,
): Promise<NullValue> {
  const keystore = requireKeystore(ctx.platform);
  const { dek } = ctx.session.require(requestSession);
  const existing = ctx.image.factors.find((f) => f.kind === "hardware");
  if (existing !== undefined) {
    if (await keystore.probe(existing.id, "presence")) {
      throw new KernelError("already-exists", "the vault already has a verifying factor");
    }
    // The hardware key is gone for good — drop the dead row before the new one lands.
    await ctx.commit([{ op: "delete-factor", id: existing.id }]);
    await keystore.remove(existing.id).catch(() => undefined);
  }
  const id = bytesToHex(ctx.platform.random(16));
  try {
    const material = await newKeystoreKek(ctx.platform, id, {
      protection: "presence",
      prompt: corePromptFor(keystore, "create")(),
    });
    // The session can end while the system prompt is up — the row must not outlive it.
    ctx.session.require(requestSession);
    const row = factorRow(ctx.platform, material, id, dek);
    await ctx.commit([{ op: "put-factor", factor: row }]);
  } catch (error) {
    await keystore.remove(id).catch(() => undefined);
    throw error;
  }
  return null;
}

/**
 * The native app lock: `enabled` drops the silent device factor — its keystore key is removed, the
 * DEK rotates so the key the device key protected dies with it, and every other host's session
 * invalidates — and `disabled` restores it. Already in the target state is a prompt-free no-op;
 * otherwise a presence ceremony verifies first.
 */
export async function setAppLock(
  ctx: KernelContext,
  params: { enabled: boolean; verify: VerifyFactor },
  requestSession: string | undefined,
): Promise<NullValue> {
  const keystore = requireKeystore(ctx.platform);
  const { dek } = ctx.session.require(requestSession);
  const locked = !ctx.image.factors.some((f) => f.kind === "device");
  if (params.enabled === locked) {
    return null;
  }
  await verifyFactor(
    ctx.platform,
    ctx.image,
    params.verify,
    dek,
    ctx.commit,
    corePromptFor(keystore, "app-lock"),
  );
  const session = ctx.session.require(requestSession);
  const deviceRow = ctx.image.factors.find((f) => f.kind === "device");
  if (params.enabled) {
    if (deviceRow === undefined) {
      return null; // the state changed between the image read and the verify
    }
    const rotation = await rotateVault(
      ctx.platform,
      ctx.image,
      session.dek,
      new Set([deviceRow.id]),
      [],
    );
    // The device key dies first: a key that outlived the commit would open any earlier image of
    // the vault put back by a store writer. If it cannot be removed nothing changes; if the commit
    // then fails, the row is dead and the next hardware unlock's probe drops it.
    try {
      await keystore.remove(deviceRow.id);
    } catch {
      rotation.dek.wipe();
      throw new KernelError("unavailable", "the device key could not be removed");
    }
    await ctx.commit(rotation.ops, {
      rotate: { dek: rotation.dek, keyId: rotation.keyId },
    });
    return null;
  }
  if (deviceRow !== undefined) {
    return null;
  }
  const id = bytesToHex(ctx.platform.random(16));
  try {
    const material = await newKeystoreKek(ctx.platform, id, { protection: "device" });
    const row = factorRow(ctx.platform, material, id, session.dek);
    await ctx.commit([{ op: "put-factor", factor: row }]);
  } catch (error) {
    await keystore.remove(id).catch(() => undefined);
    throw error;
  }
  return null;
}

/**
 * Blind signing: whether `chain.sign` accepts a request the decoder marked blind — content it can
 * neither show nor bound. Off until the owner turns it on; already in the target state is a
 * prompt-free no-op, otherwise a verification comes first — in both directions, so the setting only
 * ever follows its owner.
 */
export async function setBlindSigning(
  ctx: KernelContext,
  params: { enabled: boolean; verify: VerifyFactor },
  requestSession: string | undefined,
): Promise<NullValue> {
  const { dek } = ctx.session.require(requestSession);
  if (params.enabled === (policyRecord(ctx.image, BLIND_SIGNING) !== undefined)) {
    return null;
  }
  await verifyFactor(
    ctx.platform,
    ctx.image,
    params.verify,
    dek,
    ctx.commit,
    corePromptFor(
      ctx.platform.keystore,
      params.enabled ? "enable-blind-signing" : "disable-blind-signing",
    ),
  );
  const session = ctx.session.require(requestSession);
  await ctx.commit([
    params.enabled
      ? { op: "put-record", record: sealPolicy(ctx.platform, session.dek, BLIND_SIGNING) }
      : { op: "delete-record", kind: POLICY_KIND, id: BLIND_SIGNING },
  ]);
  return null;
}
