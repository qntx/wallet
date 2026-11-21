/**
 * The polymarket.* handlers: sealed CLOB L2 credentials and the HMAC request signature (design.md
 * §内核, research.md §2).
 *
 * Credentials exist only for HD accounts (evm.bip44): the owner address is derived from the seed
 * inside the kernel, never trusted from the host. `signL2` opens the record, HMACs and wipes — the
 * api secret is never live in the kernel beyond one call and never reaches the main runtime after
 * import (design.md §不变量 1).
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { base64url } from "@scure/base";
import { HDKey } from "@scure/bip32";

import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";

import type { Handler } from "../../commands/context.ts";
import { withWalletSeed } from "../../commands/vault.ts";
import { KernelError } from "../../errors.ts";
import { wipe } from "../../secret/secret.ts";
import { findRecord, openRecord, sealRecord } from "../../vault/vault.ts";
import {
  credsRecordId,
  decodeSecret,
  encodeCredentialsHeader,
  encodeCredentialsPlaintext,
  findCreds,
  parseCredentialsHeader,
  parseCredentialsPlaintext,
  PM_CREDS_KIND,
} from "./pm-record.ts";

/** At most 64 credential sets — also the protocol's listCredentials array cap. */
const MAX_CREDENTIALS = 64;
/**
 * The kernel accepts a timestamp within ±30 s of wall time (the CLOB documents no tolerance —
 * research.md §2); the window bounds how far ahead a compromised runtime can pre-sign while the
 * vault happens to be unlocked.
 */
const TIMESTAMP_WINDOW_S = 30;
const MAX_BODY_CHARS = 65_536;

/**
 * The signed-path allow-list — an exact (method, path) pair must match, so a query string or a
 * trailing slash never signs (docs.polymarket.com getting-started/api.md §Authentication; query
 * strings are not part of the signed path — trading/wallets-auth.md §Sync CLOB Allowances). `{id}`
 * is `0x` + 64 hex chars, either case (an order hash).
 */
const L2_ROUTES: ReadonlyArray<{
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: RegExp;
}> = [
  { method: "POST", path: /^\/order$/ }, // place an order
  { method: "DELETE", path: /^\/order$/ }, // cancel one order
  { method: "DELETE", path: /^\/orders$/ }, // cancel a batch of orders
  { method: "DELETE", path: /^\/cancel-all$/ }, // cancel every order
  { method: "DELETE", path: /^\/cancel-market-orders$/ }, // cancel a market's orders
  { method: "GET", path: /^\/data\/orders$/ }, // open orders
  { method: "GET", path: /^\/data\/order\/0x[0-9a-fA-F]{64}$/ }, // one order by hash
  { method: "GET", path: /^\/data\/trades$/ }, // trades / reconcile by order hash
  { method: "GET", path: /^\/balance-allowance$/ }, // balance and allowance
  { method: "GET", path: /^\/balance-allowance\/update$/ }, // refresh the allowance cache
  { method: "GET", path: /^\/auth\/ban-status\/closed-only$/ }, // close-only flag
  { method: "DELETE", path: /^\/auth\/api-key$/ }, // revoke the key server-side on disable
];

export const importCredentials: Handler<"polymarket.importCredentials"> = async (
  ctx,
  params,
  session,
) => {
  const { dek } = ctx.session.require(session);
  const key = decodeSecret(params.secret);
  if (key === undefined) {
    throw new KernelError("invalid-input", "secret is not decodable credentials material");
  }
  wipe(key);
  const id = credsRecordId(params.owner);
  const owned = ctx.image.records.filter((record) => record.kind === PM_CREDS_KIND);
  if (!owned.some((record) => record.id === id) && owned.length >= MAX_CREDENTIALS) {
    throw new KernelError("conflict", "credentials limit reached");
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
  const plaintext = encodeCredentialsPlaintext({
    secret: params.secret,
    passphrase: params.passphrase,
  });
  try {
    const header = encodeCredentialsHeader({
      walletId: params.owner.walletId,
      groupIndex: params.owner.groupIndex,
      owner,
      apiKey: params.apiKey.toLowerCase(),
      createdAt: ctx.platform.now(),
    });
    const record = sealRecord(ctx.platform, dek, PM_CREDS_KIND, id, header, plaintext);
    // One commit replaces a previous set for the same group (put-record upserts by kind+id).
    await ctx.commit([{ op: "put-record", record }]);
    return { owner };
  } finally {
    wipe(plaintext);
  }
};

export const listCredentials: Handler<"polymarket.listCredentials"> = (ctx, _params, session) => {
  ctx.session.require(session);
  return ctx.image.records
    .filter((record) => record.kind === PM_CREDS_KIND)
    .map((record) => parseCredentialsHeader(record.header));
};

export const deleteCredentials: Handler<"polymarket.deleteCredentials"> = async (
  ctx,
  params,
  session,
) => {
  ctx.session.require(session);
  /* No factor verification on purpose: the CLOB-side revoke is signL2 `DELETE /auth/api-key`;
     deleting locally only loses the ability to sign — the user re-derives the same set. */
  const record = findRecord(ctx.image, PM_CREDS_KIND, credsRecordId(params));
  await ctx.commit([{ op: "delete-record", kind: record.kind, id: record.id }]);
  return null;
};

export const signL2: Handler<"polymarket.signL2"> = (ctx, params, session) => {
  const { dek } = ctx.session.require(session);
  const nowSeconds = Math.floor(ctx.platform.now() / 1000);
  if (Math.abs(params.timestamp - nowSeconds) > TIMESTAMP_WINDOW_S) {
    throw new KernelError("invalid-input", "timestamp outside the signing window");
  }
  if (!L2_ROUTES.some((route) => route.method === params.method && route.path.test(params.path))) {
    throw new KernelError("invalid-input", "request path is not allow-listed");
  }
  if (params.method === "GET" && params.body !== undefined) {
    throw new KernelError("invalid-input", "a GET request carries no body");
  }
  if (params.body !== undefined && params.body.length > MAX_BODY_CHARS) {
    throw new KernelError("invalid-input", "body too large");
  }
  /* Only pm-creds records can serve this method — an HD or imported account without imported
     credentials is not-found, so the kernel-derived owner in the header always names the signer. */
  const record = findCreds(ctx.image, params.owner);
  if (record === undefined) {
    throw new KernelError("not-found", "no credentials for this account");
  }
  const header = parseCredentialsHeader(record.header);
  const plaintext = openRecord(dek, record);
  try {
    // Defense in depth past the AEAD binding: the sealed credentials must satisfy the same
    // invariants import enforced — a malformed plaintext latches the vault corrupted.
    const credentials = parseCredentialsPlaintext(plaintext);
    const key = decodeSecret(credentials.secret);
    if (key === undefined) {
      throw new KernelError("integrity", "invalid pm-creds plaintext", undefined, true);
    }
    try {
      const message = `${params.timestamp}${params.method}${params.path}${params.body ?? ""}`;
      return {
        headers: {
          POLY_ADDRESS: header.owner,
          POLY_SIGNATURE: base64url.encode(hmac(sha256, key, utf8ToBytes(message))),
          POLY_TIMESTAMP: `${params.timestamp}`,
          POLY_API_KEY: header.apiKey,
          POLY_PASSPHRASE: credentials.passphrase,
        },
      };
    } finally {
      wipe(key);
    }
  } finally {
    wipe(plaintext);
  }
};
