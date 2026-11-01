import type { Factor, NullValue } from "@qntx/wallet/protocol";
import type { FactorInfo } from "@qntx/wallet/types";

import { KernelError } from "../errors.ts";
import { assertFactorKindAvailable } from "../platform.ts";
import { corePromptFor } from "../prompts.ts";
import type { Secret } from "../secret/secret.ts";
import type { VaultImage } from "../vault/store.ts";
import { factorInfo, makeFactor, rotateVault, unlock, verifyFactor } from "../vault/vault.ts";
import type { KernelContext } from "./context.ts";

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
  const { dek, keyId } = await unlock(ctx.platform, ctx.image, params.factor, ctx.commit);
  // Already unlocked on the same vault key: keep the live session — rotating it would orphan
  // every in-flight request the engine issued against the current id.
  if (ctx.session.unlocked && ctx.session.current().keyId === keyId) {
    dek.wipe();
    return { session: ctx.session.current().id };
  }
  return { session: openSession(ctx, dek, keyId) };
}

/**
 * Opens a session over `ctx.image` and rebuilds live state in one pass: every module drops stale
 * state, then the whole image reconciles in from empty — every record opens under the DEK and every
 * factor binding verifies. A failure latches corrupted and invalidates the session it just opened.
 * Shared by `vault.unlock` and the establish paths that open a session on commit.
 */
export function openSession(ctx: KernelContext, dek: Secret, keyId: string): string {
  for (const module of ctx.modules) {
    module.lock();
  }
  const session = ctx.session.open(dek, keyId);
  ctx.reconcile(EMPTY_IMAGE);
  if (!ctx.session.unlocked) {
    throw new KernelError("integrity", "vault contents failed authentication", undefined, true);
  }
  return session;
}

/**
 * Deletes every record and factor. On a keystore host the device owner proves presence first
 * (WD-055: the main runtime alone cannot erase the vault) and the hardware keys go with the data.
 */
export async function resetVault(ctx: KernelContext): Promise<NullValue> {
  const { keystore } = ctx.platform;
  if (keystore !== undefined) {
    await keystore.authenticate(corePromptFor(keystore, "reset")());
  }
  // A user-initiated reset locks with "user" before the commit drops the session to
  // uninitialized — an external wipe reaching setInitialized instead reports "invalidated".
  ctx.session.lock("user");
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
 * passkey or hardware factor wraps the current DEK only: no rotation, keyId unchanged. At most one
 * hardware factor exists. Kind and uniqueness are checked before the verification prompt.
 */
export async function addFactor(
  ctx: KernelContext,
  params: { verify: Factor; factor: Factor },
  requestSession: string | undefined,
): Promise<FactorInfo> {
  const { dek } = ctx.session.require(requestSession);
  assertFactorKindAvailable(ctx.platform, params.factor.kind);
  if (params.factor.kind === "hardware" && ctx.image.factors.some((f) => f.kind === "hardware")) {
    throw new KernelError("already-exists", "the vault already has a hardware factor");
  }
  await verifyFactor(
    ctx.platform,
    ctx.image,
    params.verify,
    dek,
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
  params: { verify: Factor; id: string },
  requestSession: string | undefined,
): Promise<NullValue> {
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
    corePromptFor(ctx.platform.keystore, "manage-factors"),
  );
  const rotation = await rotateVault(ctx.platform, ctx.image, dek, new Set([params.id]), []);
  await ctx.commit(rotation.ops, {
    rotate: { dek: rotation.dek, keyId: rotation.keyId },
  });
  return null;
}
