/**
 * The hyperliquid.* handlers: agent lifecycle and L1 signing (design.md §内核 apps 模块).
 *
 * Agents exist only for HD main accounts (evm.bip44): the owner address is derived from the seed
 * inside the kernel, never trusted from the host. Imported keys cannot own agents — `keys.remove`
 * has no module hooks, so a deleted imported key would leave an orphaned agent.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";

import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import { signEvmTypedData } from "@qntx/wallet-chains/evm/sign";
import { hyperliquidL1Action, validate } from "@qntx/wallet/protocol";

import type { Handler } from "../../commands/context.ts";
import { withWalletSeed } from "../../commands/vault.ts";
import { KernelError } from "../../errors.ts";
import type { KernelPlatform } from "../../platform.ts";
import { wipe } from "../../secret/secret.ts";
import { findRecord, openRecord, sealRecord } from "../../vault/vault.ts";
import { l1ConnectionId, phantomAgentTypedData } from "./l1.ts";
import {
  agentInfo,
  encodeAgentHeader,
  findAgent,
  HL_AGENT_KIND,
  parseAgentHeader,
} from "./record.ts";

/** At most 16 live agents — also the protocol's listAgents array cap. */
const MAX_AGENTS = 16;
/**
 * Hyperliquid allows an agent name's `valid_until` at most 180 days out (docs exchange-endpoint
 * §Approve an API wallet).
 */
const AGENT_MAX_TTL_MS = 180 * 86_400_000;
/**
 * The kernel accepts a nonce within ±5 minutes of wall time. Hyperliquid itself accepts nonces in
 * (T−2d, T+1d) (docs nonces-and-api-wallets); the tighter window bounds how far ahead a compromised
 * runtime can pre-sign while the vault happens to be unlocked.
 */
const NONCE_WINDOW_MS = 300_000;
/** Random draws retried before giving up on a valid secp256k1 scalar. */
const MAX_KEY_DRAWS = 8;

/** `platform.random(32)` until the bytes are a valid secret key; rejects are wiped. */
const drawAgentKey = (platform: KernelPlatform): Uint8Array => {
  for (let attempt = 0; attempt < MAX_KEY_DRAWS; attempt++) {
    const draw = platform.random(32);
    if (secp256k1.utils.isValidSecretKey(draw)) {
      return draw;
    }
    wipe(draw);
  }
  throw new KernelError("integrity", "could not draw a valid agent key");
};

export const createAgent: Handler<"hyperliquid.createAgent"> = async (ctx, params, session) => {
  const { dek } = ctx.session.require(session);
  const now = ctx.platform.now();
  if (!(now < params.validUntil && params.validUntil <= now + AGENT_MAX_TTL_MS)) {
    throw new KernelError("invalid-input", "agent validity is out of range");
  }
  if (ctx.image.records.filter((record) => record.kind === HL_AGENT_KIND).length >= MAX_AGENTS) {
    throw new KernelError("conflict", "agent limit reached");
  }
  const entropy = findRecord(ctx.image, "entropy", params.owner.walletId);
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
  const priv = drawAgentKey(ctx.platform);
  try {
    const address = evmAddressFromPublicKey(secp256k1.getPublicKey(priv, true));
    const header = encodeAgentHeader({
      walletId: params.owner.walletId,
      groupIndex: params.owner.groupIndex,
      owner,
      network: params.network,
      name: params.name,
      validUntil: params.validUntil,
      createdAt: now,
    });
    const record = sealRecord(
      ctx.platform,
      dek,
      HL_AGENT_KIND,
      address.toLowerCase(),
      header,
      priv,
    );
    await ctx.commit([{ op: "put-record", record }]);
    return { address };
  } finally {
    wipe(priv);
  }
};

export const listAgents: Handler<"hyperliquid.listAgents"> = (ctx, _params, session) => {
  ctx.session.require(session);
  return ctx.image.records
    .filter((record) => record.kind === HL_AGENT_KIND)
    .map((record) => agentInfo(record));
};

export const deleteAgent: Handler<"hyperliquid.deleteAgent"> = async (ctx, params, session) => {
  ctx.session.require(session);
  /* No factor verification on purpose: losing an agent loses nothing — the user re-approves a new
     one on Hyperliquid. */
  const record = findRecord(ctx.image, HL_AGENT_KIND, params.address.toLowerCase());
  await ctx.commit([{ op: "delete-record", kind: record.kind, id: record.id }]);
  return null;
};

export const signL1: Handler<"hyperliquid.signL1"> = (ctx, params, session) => {
  const { dek } = ctx.session.require(session);
  /* Only hl-agent records can serve this method — an HD or imported address is not-found, so an
     agent can never be reached through an account path that bypasses its expiry and nonce checks. */
  const record = findAgent(ctx.image, params.agent);
  if (record === undefined) {
    throw new KernelError("not-found", "no such agent");
  }
  const header = parseAgentHeader(record.header);
  const now = ctx.platform.now();
  if (now >= header.validUntil) {
    throw new KernelError("invalid-input", "the agent has expired");
  }
  if (Math.abs(params.nonce - now) > NONCE_WINDOW_MS) {
    throw new KernelError("invalid-input", "nonce outside the signing window");
  }
  const action = validate(hyperliquidL1Action, params.action);
  if (action === undefined) {
    throw new KernelError("invalid-input", "malformed action");
  }
  const typedData = phantomAgentTypedData(
    l1ConnectionId({
      action,
      nonce: params.nonce,
      ...(params.vaultAddress === undefined ? {} : { vaultAddress: params.vaultAddress }),
      ...(params.expiresAfter === undefined ? {} : { expiresAfter: params.expiresAfter }),
    }),
    header.network,
  );
  const priv = openRecord(dek, record);
  try {
    /* Defense in depth past the AEAD id binding: the sealed key must derive the record's address
       — a mismatch latches the vault corrupted. */
    if (
      priv.length !== 32 ||
      !secp256k1.utils.isValidSecretKey(priv) ||
      evmAddressFromPublicKey(secp256k1.getPublicKey(priv, true)).toLowerCase() !== record.id
    ) {
      throw new KernelError("integrity", "agent key does not match its record", undefined, true);
    }
    return { signature: signEvmTypedData(typedData, priv) };
  } finally {
    wipe(priv);
  }
};
