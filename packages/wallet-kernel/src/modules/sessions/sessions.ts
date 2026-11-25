/**
 * The sessions.* handlers: session-key lifecycle and scheme-document signing (design.md §命令语义).
 *
 * Sessions exist only for HD main accounts (evm.bip44): the owner address is derived from the seed
 * inside the kernel, never trusted from the host. Imported keys cannot own sessions — `keys.remove`
 * has no module hooks, so a deleted imported key would leave an orphaned session.
 *
 * A value-moving scheme (one that declares `metering`) is bound to the limits the user approved:
 * create and `open` verify a factor against the scheme's approval prompt, `sign` refuses until the
 * session is opened in this kernel's memory and charges every action into the record's `spent` —
 * the updated header is committed before the signature leaves the kernel, so a killed kernel never
 * signs past what the vault records. On a keystore host whose vault still carries a `device` factor
 * the app lock is off and presence cannot be enforced at all: every presence-bound operation
 * answers `app-lock-required`.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";

import { checksumEvmAddress, evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import { signEvmTypedData } from "@qntx/wallet-chains/evm/sign";
import { isProtocolValue } from "@qntx/wallet/protocol";
import type { ProtocolValue, SessionInfo } from "@qntx/wallet/protocol";

import type { Handler } from "../../commands/context.ts";
import { withWalletSeed } from "../../commands/vault.ts";
import { KernelError } from "../../errors.ts";
import type { KeystorePrompt, KernelPlatform } from "../../platform.ts";
import { PROMPT_BOUNDS, promptFits, promptLocale, sessionApprovalCode } from "../../prompts.ts";
import { wipe } from "../../secret/secret.ts";
import type { StoredRecord, VaultImage } from "../../vault/store.ts";
import {
  EXTERNAL_CUSTODY_KINDS,
  findRecord,
  findSeedWallet,
  findWalletRecord,
  openRecord,
  sealRecord,
  verifyFactor,
} from "../../vault/vault.ts";
import { encodeSessionHeader, findSession, parseSessionHeader, SESSION_KIND } from "./record.ts";
import type { SessionHeader } from "./record.ts";
import type { SessionMetering } from "./scheme.ts";
import { isSchemeId, schemeOf } from "./schemes/index.ts";

/** At most 64 live session keys across schemes — also the protocol's sessions.list array cap. */
const MAX_SESSIONS = 64;
/* At most this many unexpired metered sessions may share one owner and scope: the engine keeps one
   agent per account and network plus one more during renewal. Each session's limits are separately
   approved, so the aggregate exposure per account and network is the sum of at most two approvals —
   the venue's own allowance (1 unnamed + 3 named agents per account plus 2 named per sub-account,
   docs exchange-endpoint §Approve an API wallet) is too loose to rely on. */
const MAX_METERED_PER_OWNER = 2;
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

/* External custody never owns a session: the scheme signs with a seed only the vault holds, so a
   card or hardware owner refuses `unsupported` at the top — before the app-lock gate, before any
   limits text is generated or bounded, before the session-approval input and before a factor
   ceremony. Enabling the app lock cannot change a custody the scheme cannot serve. */
const assertSeedCustody = (image: VaultImage, walletId: string): void => {
  const record = findWalletRecord(image, walletId);
  if (record !== undefined && EXTERNAL_CUSTODY_KINDS.has(record.kind)) {
    throw new KernelError("unsupported", "this wallet is signed outside the vault");
  }
};

/**
 * On a keystore host a `device` factor means the app lock is off: the vault — and any session in it
 * — can be used without presence. A value-moving session must never run in that state, so
 * create/open/sign refuse before any factor verification happens.
 */
const assertAppLock = (
  platform: KernelPlatform,
  image: VaultImage,
  metering: SessionMetering | undefined,
): void => {
  if (
    metering !== undefined &&
    platform.keystore !== undefined &&
    image.factors.some((stored) => stored.kind === "device")
  ) {
    throw new KernelError(
      "app-lock-required",
      "enable the app lock before using this session scheme",
    );
  }
};

/* The canonical metering state of a metered session record. The kernel seals `limits` and `spent`
   together at create, so a record of a metered scheme that lacks either — or whose limits the
   scheme's own validator rejects — is tampered: latched `integrity`, like a mismatched key. */
const meteredHeader = (
  metering: SessionMetering,
  header: SessionHeader,
): { limits: unknown; spent: unknown } => {
  if (header.limits === undefined || header.spent === undefined) {
    throw new KernelError("integrity", "the session record carries no metering", undefined, true);
  }
  try {
    const limits = metering.parseLimits(header.limits);
    return { limits, spent: metering.parseSpent(header.spent, limits) };
  } catch {
    throw new KernelError("integrity", "invalid session metering in the vault", undefined, true);
  }
};

/** The approval prompt a scheme renders — shared by create and open. */
const approvalPrompt =
  (
    platform: KernelPlatform,
    metering: SessionMetering,
    session: { scope: string; name: string; validUntil: number; limits: unknown; spent: unknown },
    open: boolean,
  ) =>
  (): KeystorePrompt =>
    metering.prompt(session, open, promptLocale(platform.keystore?.locale ?? "en"));

/* On iOS the factor ceremony (Face ID) never displays the prompt text, so the limits are proven
   seen on the secure-input view instead: the label is the same kernel prompt plus a 4-digit
   confirmation code as its last line — a clipped label drops the code first, and without it the
   user cannot confirm. The main runtime sees only idle/empty/filled/submitted and cannot know the
   code, so a submitted code proves the user read the kernel-rendered limits; a compromised main
   runtime can still draw over part of the view, so the code is the last line and the factor
   verification itself still runs. Android's BiometricPrompt shows the bounded text and keystore-
   less hosts show no system dialog, so neither requests the code. */
const confirmLimits = async (
  platform: KernelPlatform,
  prompt: () => KeystorePrompt,
): Promise<void> => {
  const { keystore } = platform;
  if (keystore?.platform !== "ios") {
    return;
  }
  const { secureInput } = platform;
  if (secureInput === undefined) {
    throw new KernelError("unsupported", "this host cannot display the session limits");
  }
  /* Uniform 0..9999 by rejection: a 16-bit draw under 60000 wraps the code space exactly six
     times. */
  let code = "";
  while (code === "") {
    const draw = platform.random(2);
    const value = (draw[0] ?? 0) * 256 + (draw[1] ?? 0);
    wipe(draw);
    if (value < 60_000) {
      code = String(value % 10_000).padStart(4, "0");
    }
  }
  const { title, description } = prompt();
  const label = `${title}\n${description}\n${sessionApprovalCode(promptLocale(keystore.locale), code)}`;
  const result = await secureInput.request("session-approval", label);
  if (!result.ok) {
    throw new KernelError(result.failure, `session approval input: ${result.failure}`);
  }
  const entered = result.value;
  try {
    if (entered.length !== 4 || !entered.every((byte, index) => byte === code.codePointAt(index))) {
      throw new KernelError("cancelled", "the confirmation code did not match");
    }
  } finally {
    wipe(entered);
  }
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
    limits: header.limits ?? null,
    spent: header.spent ?? null,
  };
}

export const createSession: (opened: Set<string>) => Handler<"sessions.create"> =
  (opened) => async (ctx, params, session) => {
    const { dek } = ctx.session.require(session);
    assertSeedCustody(ctx.image, params.owner.walletId);
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
    const { metering } = scheme;
    let limits: ProtocolValue | undefined;
    if (metering !== undefined) {
      let parsed: unknown;
      try {
        parsed = metering.parseLimits(params.limits);
      } catch {
        throw new KernelError("invalid-input", "invalid session limits");
      }
      /* The record header only stores JSON — a scheme whose limits do not encode as a plain
         object is broken, not the caller. */
      if (
        !isProtocolValue(parsed) ||
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        parsed instanceof Uint8Array
      ) {
        throw new KernelError("integrity", "the scheme's limits are not a JSON object");
      }
      limits = parsed;
    } else if (params.limits !== null) {
      throw new KernelError("invalid-input", "the scheme takes no limits");
    }
    const records = ctx.image.records.filter((record) => record.kind === SESSION_KIND);
    let perOwner = 0;
    let perScheme = 0;
    for (const record of records) {
      const header = parseSessionHeader(record.header);
      if (header.scheme !== scheme.id) {
        continue;
      }
      perScheme++;
      if (
        header.walletId === params.owner.walletId &&
        header.groupIndex === params.owner.groupIndex &&
        header.scope === scope &&
        now < header.validUntil
      ) {
        perOwner++;
      }
    }
    if (
      records.length >= MAX_SESSIONS ||
      perScheme >= scheme.maxPerVault ||
      (metering !== undefined && perOwner >= MAX_METERED_PER_OWNER)
    ) {
      throw new KernelError("conflict", "session limit reached");
    }
    /* Presence before the expensive derivations: on an app-lock-less keystore host the scheme
       refuses here, before any verification prompt could appear. */
    assertAppLock(ctx.platform, ctx.image, metering);
    if (metering !== undefined && limits !== undefined) {
      const approval = {
        scope,
        name: params.name,
        validUntil: params.validUntil,
        limits,
      };
      /* On a keystore host the approval text goes to a bounded system dialog: the create variant
         and the open variant at its longest must both fit, so no later open can overflow. A host
         without a keystore shows no system dialog. */
      const { keystore } = ctx.platform;
      if (keystore !== undefined) {
        const locale = promptLocale(keystore.locale);
        const bound = PROMPT_BOUNDS[keystore.platform];
        if (
          !promptFits(
            metering.prompt({ ...approval, spent: metering.fresh(limits) }, false, locale),
            bound,
          ) ||
          !promptFits(
            metering.prompt({ ...approval, spent: metering.worstSpent(limits) }, true, locale),
            bound,
          )
        ) {
          throw new KernelError(
            "invalid-input",
            "the session limits do not fit the approval dialog",
          );
        }
      }
      const prompt = approvalPrompt(
        ctx.platform,
        metering,
        { ...approval, spent: metering.fresh(limits) },
        false,
      );
      await confirmLimits(ctx.platform, prompt);
      await verifyFactor(ctx, params.verify, dek, prompt);
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
        ...(metering === undefined || limits === undefined
          ? {}
          : { limits, spent: metering.fresh(limits) }),
      });
      const record = sealRecord(
        ctx.platform,
        dek,
        SESSION_KIND,
        address.toLowerCase(),
        header,
        priv,
      );
      await ctx.commit([{ op: "put-record", record }]);
      /* A session born under an approval prompt starts opened — the verification just happened. */
      if (metering !== undefined) {
        opened.add(record.id);
      }
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

export const deleteSession: (opened: Set<string>) => Handler<"sessions.delete"> =
  (opened) => async (ctx, params, session) => {
    ctx.session.require(session);
    /* No factor verification on purpose: losing a session key loses nothing — the user re-approves
       a new one. Any scheme's record goes, known or not. */
    const record = findRecord(ctx.image, SESSION_KIND, params.address.toLowerCase());
    await ctx.commit([{ op: "delete-record", kind: record.kind, id: record.id }]);
    opened.delete(record.id);
    return null;
  };

export const openSession: (opened: Set<string>) => Handler<"sessions.open"> =
  (opened) => async (ctx, params, session) => {
    const { dek } = ctx.session.require(session);
    const { record, header } = sessionOf(ctx.image, params.address);
    assertSeedCustody(ctx.image, header.walletId);
    const scheme = schemeOf(header.scheme);
    if (scheme === undefined) {
      throw new KernelError("unsupported", "this kernel does not support the session's scheme");
    }
    const { metering } = scheme;
    if (metering === undefined) {
      throw new KernelError("unsupported", "the session's scheme is not presence-bound");
    }
    if (ctx.platform.now() >= header.validUntil) {
      throw new KernelError("invalid-input", "the session has expired");
    }
    const { limits, spent } = meteredHeader(metering, header);
    assertAppLock(ctx.platform, ctx.image, metering);
    const { keystore } = ctx.platform;
    if (
      keystore !== undefined &&
      !promptFits(
        metering.prompt(
          {
            scope: header.scope,
            name: header.name,
            validUntil: header.validUntil,
            limits,
            spent,
          },
          true,
          promptLocale(keystore.locale),
        ),
        PROMPT_BOUNDS[keystore.platform],
      )
    ) {
      throw new KernelError("invalid-input", "the session limits do not fit the approval dialog");
    }
    const prompt = approvalPrompt(
      ctx.platform,
      metering,
      {
        scope: header.scope,
        name: header.name,
        validUntil: header.validUntil,
        limits,
        spent,
      },
      true,
    );
    await confirmLimits(ctx.platform, prompt);
    await verifyFactor(ctx, params.verify, dek, prompt);
    opened.add(record.id);
    return null;
  };

/** Shared by open and sign: the record under `params.address` and its parsed header. */
const sessionOf = (image: VaultImage, address: string) => {
  /* Only session-key records can serve these methods — an HD or imported address is not-found, so
     a session can never be reached through an account path that bypasses its checks. */
  const record = findSession(image, address);
  if (record === undefined) {
    throw new KernelError("not-found", "no such session");
  }
  return { record, header: parseSessionHeader(record.header) };
};

export const signSession: (opened: Set<string>) => Handler<"sessions.sign"> =
  (opened) => async (ctx, params, session) => {
    const { dek } = ctx.session.require(session);
    const { record, header } = sessionOf(ctx.image, params.address);
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
    const { metering } = scheme;
    if (metering !== undefined) {
      /* App lock first: a device-factor vault answers app-lock-required even for a session that
         was never opened — presence is the precondition, approval the next gate. */
      assertAppLock(ctx.platform, ctx.image, metering);
      if (!opened.has(record.id)) {
        throw new KernelError(
          "approval-required",
          "the session is not open — approve it with sessions.open",
        );
      }
    }
    const typedData = scheme.document(params.params, header, now);
    let spent: ProtocolValue | undefined;
    if (metering !== undefined) {
      const metered = meteredHeader(metering, header);
      spent = metering.meter(params.params, metered.limits, metered.spent);
    }
    const priv = openRecord(dek, record);
    try {
      /* Defense in depth past the AEAD id binding: the sealed key must derive the record's address
         — a mismatch latches the vault corrupted. */
      if (
        priv.length !== 32 ||
        !secp256k1.utils.isValidSecretKey(priv) ||
        evmAddressFromPublicKey(secp256k1.getPublicKey(priv, true)).toLowerCase() !== record.id
      ) {
        throw new KernelError(
          "integrity",
          "session key does not match its record",
          undefined,
          true,
        );
      }
      if (spent !== undefined) {
        /* Commit the charged header before the signature exists to return: a commit failure
           leaves `spent` untouched in the vault and hands back nothing. */
        const updated = sealRecord(
          ctx.platform,
          dek,
          SESSION_KIND,
          record.id,
          encodeSessionHeader({ ...header, spent }),
          priv,
        );
        await ctx.commit([{ op: "put-record", record: updated }]);
      }
      return { signature: signEvmTypedData(typedData, priv) };
    } finally {
      wipe(priv);
    }
  };
