/**
 * The sessions.* handlers: session-key lifecycle and scheme-document signing (design.md §命令语义).
 *
 * Sessions exist only for HD main accounts (evm.bip44): the owner address is derived from the seed
 * inside the kernel, never trusted from the host. Imported keys cannot own sessions — `keys.remove`
 * has no module hooks, so a deleted imported key would leave an orphaned session.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";

import { checksumEvmAddress, evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import { signEvmTypedData } from "@qntx/wallet-chains/evm/sign";
import type { SessionInfo } from "@qntx/wallet/protocol";

import type { Handler } from "../../commands/context.ts";
import { withWalletSeed } from "../../commands/vault.ts";
import { KernelError } from "../../errors.ts";
import type { KernelPlatform } from "../../platform.ts";
import { wipe } from "../../secret/secret.ts";
import type { StoredRecord } from "../../vault/store.ts";
import { findRecord, findSeedWallet, openRecord, sealRecord } from "../../vault/vault.ts";
import { encodeSessionHeader, findSession, parseSessionHeader, SESSION_KIND } from "./record.ts";
import { isSchemeId, schemeOf } from "./schemes/index.ts";

/** At most 64 live session keys across schemes — also the protocol's sessions.list array cap. */
const MAX_SESSIONS = 64;
/** Random draws retried before giving up on a valid secp256k1 scalar. */
const MAX_KEY_DRAWS = 8;

/** `platform.random(32)` until the bytes are a valid secret key; rejects are wiped. */
const drawSessionKey = (platform: KernelPlatform): Uint8Array => {
  for (let attempt = 0; attempt < MAX_KEY_DRAWS; attempt++) {
    const draw = platform.random(32);
    if (secp256k1.utils.isValidSecretKey(draw)) {
      return draw;
    }
    wipe(draw);
  }
  throw new KernelError("integrity", "could not draw a valid session key");
};

/** The public snapshot of one stored session — the record id is the lowercase address. */
export function sessionInfo(record: StoredRecord): SessionInfo {
  const header = parseSessionHeader(record.header);
  return {
    address: checksumEvmAddress(record.id),
    scheme: header.scheme,
    supported: isSchemeId(header.scheme),
    walletId: header.walletId,
    groupIndex: header.groupIndex,
    owner: header.owner,
    scope: header.scope,
    name: header.name,
    validUntil: header.validUntil,
    createdAt: header.createdAt,
  };
}

export const createSession: Handler<"sessions.create"> = async (ctx, params, session) => {
  const { dek } = ctx.session.require(session);
  const scheme = schemeOf(params.scheme);
  if (scheme === undefined) {
    throw new KernelError("unsupported", "unsupported session scheme");
  }
  const now = ctx.platform.now();
  if (!(now < params.validUntil && params.validUntil <= now + scheme.maxTtlMs)) {
    throw new KernelError("invalid-input", "session validity is out of range");
  }
  let scope: string;
  try {
    scope = scheme.parseScope(params.scope);
  } catch {
    throw new KernelError("invalid-input", "invalid session scope");
  }
  const records = ctx.image.records.filter((record) => record.kind === SESSION_KIND);
  if (
    records.length >= MAX_SESSIONS ||
    records.filter((record) => parseSessionHeader(record.header).scheme === scheme.id).length >=
      scheme.maxPerVault
  ) {
    throw new KernelError("conflict", "session limit reached");
  }
  const entropy = findSeedWallet(ctx.image, params.owner.walletId);
  const owner = await withWalletSeed(ctx.platform.pbkdf2, dek, entropy, (seed) => {
    const master = HDKey.fromMasterSeed(seed);
    try {
      const child = master.derive(`m/44'/60'/0'/0/${params.owner.groupIndex}`);
      try {
        if (child.publicKey === null) {
          throw new KernelError("integrity", "no public key at account path");
        }
        return evmAddressFromPublicKey(child.publicKey);
      } finally {
        child.wipePrivateData();
      }
    } finally {
      master.wipePrivateData();
    }
  });
  const priv = drawSessionKey(ctx.platform);
  try {
    const address = evmAddressFromPublicKey(secp256k1.getPublicKey(priv, true));
    const header = encodeSessionHeader({
      scheme: scheme.id,
      walletId: params.owner.walletId,
      groupIndex: params.owner.groupIndex,
      owner,
      scope,
      name: params.name,
      validUntil: params.validUntil,
      createdAt: now,
    });
    const record = sealRecord(ctx.platform, dek, SESSION_KIND, address.toLowerCase(), header, priv);
    await ctx.commit([{ op: "put-record", record }]);
    return { address };
  } finally {
    wipe(priv);
  }
};

export const listSessions: Handler<"sessions.list"> = (ctx, _params, session) => {
  ctx.session.require(session);
  return ctx.image.records
    .filter((record) => record.kind === SESSION_KIND)
    .map((record) => sessionInfo(record));
};

export const deleteSession: Handler<"sessions.delete"> = async (ctx, params, session) => {
  ctx.session.require(session);
  /* No factor verification on purpose: losing a session key loses nothing — the user re-approves
     a new one. Any scheme's record goes, known or not. */
  const record = findRecord(ctx.image, SESSION_KIND, params.address.toLowerCase());
  await ctx.commit([{ op: "delete-record", kind: record.kind, id: record.id }]);
  return null;
};

export const signSession: Handler<"sessions.sign"> = (ctx, params, session) => {
  const { dek } = ctx.session.require(session);
  /* Only session-key records can serve this method — an HD or imported address is not-found, so a
     session can never be reached through an account path that bypasses its expiry checks. */
  const record = findSession(ctx.image, params.address);
  if (record === undefined) {
    throw new KernelError("not-found", "no such session");
  }
  const header = parseSessionHeader(record.header);
  if (params.scheme !== header.scheme) {
    throw new KernelError("invalid-input", "the scheme does not match the session's record");
  }
  const scheme = schemeOf(header.scheme);
  if (scheme === undefined) {
    throw new KernelError("unsupported", "this kernel does not support the session's scheme");
  }
  const now = ctx.platform.now();
  if (now >= header.validUntil) {
    throw new KernelError("invalid-input", "the session has expired");
  }
  const typedData = scheme.document(params.params, header, now);
  const priv = openRecord(dek, record);
  try {
    /* Defense in depth past the AEAD id binding: the sealed key must derive the record's address
       — a mismatch latches the vault corrupted. */
    if (
      priv.length !== 32 ||
      !secp256k1.utils.isValidSecretKey(priv) ||
      evmAddressFromPublicKey(secp256k1.getPublicKey(priv, true)).toLowerCase() !== record.id
    ) {
      throw new KernelError("integrity", "session key does not match its record", undefined, true);
    }
    return { signature: signEvmTypedData(typedData, priv) };
  } finally {
    wipe(priv);
  }
};
