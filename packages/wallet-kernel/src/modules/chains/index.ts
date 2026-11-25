/**
 * The chains module: `wallet.accounts` — the public account for a template at the wallet's group
 * index, derived from the wallet's entropy record once per session and then served from a cache of
 * public data only. The one record kind it owns is `change-marks` (./marks.ts) — the sealed
 * hidden-change bound; seed and every node are wiped in `finally` on every path. `chain.sign` runs
 * `validate → plan → backend → assemble`: a prepare function (./evm.ts, ./bitcoin.ts, ./solana.ts,
 * ./tron.ts) builds the serialisable plan through `PublicMaterial` (./keys.ts), the prompt is
 * verified, then `signPlan` (./run.ts) signs it against a fresh key source — the plan itself is
 * reused, never recomputed.
 */

import { isBlindIntent } from "@qntx/wallet-chains";
import type { KeyPath } from "@qntx/wallet-chains";
import { bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import { solanaAddressFromPublicKey } from "@qntx/wallet-chains/solana";
import { tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";
import type {
  ChainAccount,
  ChainTemplate,
  CHAINS_METHODS,
  MethodName,
  SessionSchemeId,
} from "@qntx/wallet/protocol";

import type { Handler, KernelContext, VaultHooks } from "../../commands/context.ts";
import { withWalletSeed } from "../../commands/vault.ts";
import type { PublicMaterial } from "../../derive/material.ts";
import { KernelError } from "../../errors.ts";
import type { KeystorePrompt } from "../../platform.ts";
import { PROMPT_BOUNDS, promptLocale } from "../../prompts.ts";
import type { Secret } from "../../secret/secret.ts";
import { wipe } from "../../secret/secret.ts";
import { parseKeyHeader } from "../../vault/headers.ts";
import { BLIND_SIGNING, policyEnabled } from "../../vault/policy.ts";
import type { StoredRecord } from "../../vault/store.ts";
import { findWalletRecord, openRecord, verifyFactor } from "../../vault/vault.ts";
import { findSession, parseSessionHeader } from "../sessions/record.ts";
import { prepareBitcoin } from "./bitcoin.ts";
import { assertFiat24Deadline, prepareEvm } from "./evm.ts";
import { exportAccount } from "./export.ts";
import { importedKeys, pathString, seedKeys } from "./keys.ts";
import type { KeySource } from "./keys.ts";
import { changeMark, commitChangeMarks, marksHooks } from "./marks.ts";
import { boundChainPrompt, chainPrompt } from "./prompt.ts";
import type { PromptIntent } from "./prompt.ts";
import { signPlan, taskSignerFor } from "./run.ts";
import type { ChainPlan } from "./run.ts";
import type { Prepared, SignRequest } from "./shared.ts";
import { BTC_PURPOSE, checkNetwork, HARDENED, leafPath } from "./shared.ts";
import { prepareSolana } from "./solana.ts";
import { prepareTron } from "./tron.ts";

export type ChainsModule = {
  readonly vault: VaultHooks;
  readonly handlers: { [M in keyof typeof CHAINS_METHODS & MethodName]: Handler<M> };
};

/** An imported account's only path is `[]`; an HD account's is its group's leaf. */
export const requestPath = (
  family: "evm" | "tron" | "solana",
  account: SignRequest["account"],
): KeyPath => (account.kind === "imported" ? [] : leafPath(family, account.groupIndex));

export { checkNetwork, leafPath } from "./shared.ts";

export const accountFor = async (
  material: KeySource["material"],
  template: ChainTemplate,
  network: string,
  groupIndex: number,
  mark: number,
): Promise<ChainAccount> => {
  if (template === "evm.bip44") {
    const pub = await material.secp256k1(leafPath("evm", groupIndex));
    return { template, network, address: evmAddressFromPublicKey(pub) };
  }
  if (template === "solana.bip44-change") {
    const pub = await material.ed25519(leafPath("solana", groupIndex));
    return { template, network, address: solanaAddressFromPublicKey(pub) };
  }
  if (template === "tron.bip44") {
    const pub = await material.secp256k1(leafPath("tron", groupIndex));
    return { template, network, address: tronAddressFromPublicKey(pub) };
  }
  const purpose = BTC_PURPOSE[template];
  if (purpose === undefined) {
    throw new KernelError("invalid-input", `unknown template ${template}`);
  }
  const net = bitcoinNetwork(network);
  const path = [purpose + HARDENED, net.coinType + HARDENED, groupIndex + HARDENED];
  const fingerprint = await material.fingerprint();
  return {
    template,
    network,
    // Bitcoin account keys serialize with the network's version bytes (xpub or tpub).
    xpub: await material.extendedPublicKey(path, net.bip32),
    fingerprint: fingerprint.reduce((acc, b) => acc + b.toString(16).padStart(2, "0"), ""),
    path: pathString(path),
    changeMark: mark,
  };
};

/**
 * Public account data per entropy record for the session: `wallet.accounts` derives each account
 * once, then answers without touching the seed. Keyed by the record object, so a reloaded image
 * (any commit, a removed wallet, a rotated vault) starts empty; lock drops it all.
 */
type AccountCache = WeakMap<StoredRecord, Map<string, ChainAccount>>;

const walletAccounts = async (
  ctx: Parameters<Handler<"wallet.accounts">>[0],
  params: Parameters<Handler<"wallet.accounts">>[1],
  session: string | undefined,
  cache: AccountCache,
): Promise<ChainAccount> => {
  const { dek } = ctx.session.require(session);
  const record = findWalletRecord(ctx.image, params.walletId);
  if (record === undefined) {
    throw new KernelError("not-found", "no such wallet");
  }
  checkNetwork(params.template, params.network);
  const purpose = BTC_PURPOSE[params.template];
  const mark =
    purpose === undefined
      ? 0
      : changeMark(ctx.image, params.walletId, params.groupIndex, purpose, params.network);
  const key = `${String(params.groupIndex)}/${params.template}/${params.network}`;
  const known = cache.get(record)?.get(key);
  if (known !== undefined) {
    // The cache freezes the public account, never the mark — it is read fresh on every call.
    return "xpub" in known ? { ...known, changeMark: mark } : known;
  }
  const account =
    record.kind === "entropy"
      ? await withWalletSeed(ctx.platform.pbkdf2, dek, record, async (seed) => {
          const keys = seedKeys(seed, ctx.platform.random);
          try {
            return await accountFor(
              keys.material,
              params.template,
              params.network,
              params.groupIndex,
              mark,
            );
          } finally {
            keys.wipe();
          }
        })
      : await accountFor(
          ctx.externalMaterial(record),
          params.template,
          params.network,
          params.groupIndex,
          mark,
        );
  const accounts = cache.get(record) ?? new Map<string, ChainAccount>();
  accounts.set(key, account);
  cache.set(record, accounts);
  return account;
};

/**
 * A request the decoder marked blind — or whose prompt overruns the platform's dialog bound — is
 * refused before any prompt unless the owner allowed it.
 */
export const assertSignable = (
  ctx: Parameters<Handler<"chain.sign">>[0],
  dek: Secret,
  intent: PromptIntent,
  oversize = false,
): void => {
  if ((isBlindIntent(intent) || oversize) && !policyEnabled(ctx.image, dek, BLIND_SIGNING)) {
    throw new KernelError("blind-signing-disabled", "blind signing is turned off for this vault");
  }
};

/**
 * Opens this request's key source for one use — the HD seed or the imported secret exists only
 * inside `use`, and the source is wiped on every exit path. chainSign opens it twice: once to
 * prepare, once to sign after verification.
 */
type OpenKeys = <T>(use: (keys: KeySource) => T | Promise<T>) => Promise<T>;

const TEMPLATES_BY_FAMILY: Readonly<Record<string, ReadonlyArray<string>>> = {
  evm: ["evm.bip44"],
  solana: ["solana.bip44-change"],
  tron: ["tron.bip44"],
  bitcoin: ["btc.bip44", "btc.bip49", "btc.bip84", "btc.bip86"],
};

/**
 * The request family must match the account's template — the same check every HD sign path runs
 * (local seed, card, external device). Imported keys have no template.
 */
export const assertHdTemplates = (request: SignRequest): void => {
  const { account } = request;
  if (account.kind !== "hd") {
    return;
  }
  if (request.kind === "bitcoin.psbt") {
    if (request.sign.some((s) => BTC_PURPOSE[s.template] === undefined)) {
      throw new KernelError("invalid-input", "sign template is not a bitcoin account template");
    }
  } else {
    const [family] = request.kind.split(".", 1);
    const expected = TEMPLATES_BY_FAMILY[family ?? ""] ?? [];
    if (!("template" in account) || !expected.includes(account.template)) {
      throw new KernelError("invalid-input", "account template does not match the request family");
    }
  }
};

/** The HD source: the wallet's entropy record, and the seed via `withWalletSeed`. */
const hdSource = (
  ctx: Parameters<Handler<"chain.sign">>[0],
  request: SignRequest,
  dek: Secret,
): OpenKeys => {
  const { account } = request;
  if (account.kind === "imported") {
    throw new KernelError("integrity", "unreachable: hd path with an imported account");
  }
  const record = findWalletRecord(ctx.image, account.walletId);
  if (record === undefined) {
    throw new KernelError("not-found", "no such wallet");
  }
  if (record.kind !== "entropy") {
    /* External custody never opens a key source here: cards sign through card.begin's tap
       pipeline, hardware through hardware.begin's host-step protocol. An inert record (a device
       kind this build does not know) reports `unsupported` instead. */
    ctx.externalMaterial(record);
    throw new KernelError("device-required", "this wallet signs on its device");
  }
  return async (use) =>
    withWalletSeed(ctx.platform.pbkdf2, dek, record, async (seed) => {
      const keys = seedKeys(seed, ctx.platform.random);
      try {
        return await use(keys);
      } finally {
        keys.wipe();
      }
    });
};

/* The imported source: the same two-open shape, but the secret comes straight from the `key`
   record instead of an entropy derivation. Bitcoin requests have no imported path: WIF is out
   of scope. */
const importedSource = (
  ctx: Parameters<Handler<"chain.sign">>[0],
  request: SignRequest,
  dek: Secret,
): OpenKeys => {
  const { account } = request;
  if (account.kind !== "imported") {
    throw new KernelError("integrity", "unreachable: imported path with an hd account");
  }
  const isEvm =
    request.kind === "evm.transaction" ||
    request.kind === "evm.personal-message" ||
    request.kind === "evm.fiat24-session" ||
    request.kind === "evm.typed-data";
  const isSolana = request.kind === "solana.transaction" || request.kind === "solana.message";
  const isTron =
    request.kind === "tron.transaction" ||
    request.kind === "tron.message" ||
    request.kind === "tron.typed-data";
  if (!isEvm && !isSolana && !isTron) {
    throw new KernelError("unsupported", "imported accounts are not supported on bitcoin");
  }
  const record = ctx.image.records.find(
    (entry) => entry.kind === "key" && entry.id === account.keyId,
  );
  if (record === undefined) {
    throw new KernelError("not-found", "no such imported key");
  }
  const header = parseKeyHeader(record.header);
  const expectedFamily = isEvm ? "evm" : isTron ? "tron" : "solana";
  if (header.family !== expectedFamily) {
    throw new KernelError("invalid-input", "the key's family does not match the request");
  }
  const curve = isSolana ? "ed25519" : "secp256k1";
  return async (use) => {
    const secret = openRecord(dek, record);
    const keys = importedKeys(secret, curve, ctx.platform.random);
    try {
      return await use(keys);
    } finally {
      keys.wipe();
      wipe(secret);
    }
  };
};

/**
 * The family's prepare on this request — `path` applies to evm/tron/solana; bitcoin derives
 * internally.
 */
export const prepareFor = async (
  request: SignRequest,
  material: KeySource["material"],
  now: number,
  storedMark: (purpose: number) => number,
): Promise<Prepared> => {
  const { account } = request;
  if (
    request.kind === "evm.transaction" ||
    request.kind === "evm.personal-message" ||
    request.kind === "evm.fiat24-session" ||
    request.kind === "evm.typed-data"
  ) {
    return prepareEvm(request, requestPath("evm", account), material, now);
  }
  if (
    request.kind === "tron.transaction" ||
    request.kind === "tron.message" ||
    request.kind === "tron.typed-data"
  ) {
    return prepareTron(request, requestPath("tron", account), material);
  }
  if (request.kind === "solana.transaction" || request.kind === "solana.message") {
    return prepareSolana(request, requestPath("solana", account), material);
  }
  if (account.kind === "imported") {
    throw new KernelError("integrity", "unreachable: bitcoin reached the imported executor");
  }
  return prepareBitcoin(request, account, material, storedMark);
};

/**
 * The approve-agent binding (design.md §ApproveAgent 绑定): when the decoded intent approves a
 * Hyperliquid agent, look the agent address up among this vault's session-key records. A
 * hyperliquid-l1-agent record whose owner, scope, name and validUntil all match the signed action
 * marks the prompt "held"; a record that exists but disagrees means the approval describes a
 * different agent under the same address and is refused; no record marks it "not held".
 */
export const bindAgent = (
  ctx: Parameters<Handler<"chain.sign">>[0],
  prompt: PromptIntent,
  signer: string | undefined,
): PromptIntent => {
  const { message } = prompt;
  if (message?.kind !== "typed-data" || message.hyperliquid?.kind !== "approve-agent") {
    return prompt;
  }
  const action = message.hyperliquid;
  const record = findSession(ctx.image, action.agent);
  if (record === undefined) {
    return { ...prompt, agentHeld: false };
  }
  const header = parseSessionHeader(record.header);
  if (
    header.scheme !== ("hyperliquid-l1-agent" satisfies SessionSchemeId) ||
    header.owner !== signer ||
    header.scope !== action.chain ||
    header.name !== action.name ||
    header.validUntil !== action.validUntil
  ) {
    throw new KernelError("invalid-input", "the approval does not match this wallet's agent");
  }
  return { ...prompt, agentHeld: true };
};

/**
 * Everything `chain.sign` prepares before the factor verify — shared with the card sign op (design
 * §8), which hands it the card's public material instead of the seed source.
 */
export type PreparedApproval = {
  readonly request: SignRequest;
  readonly prompt: PromptIntent;
  /* The prompt bounded to the platform's verification dialog — `undefined` off a keystore host.
     Callers render `shown?.prompt ?? chainPrompt(...)`; the hardware device line wraps it. */
  readonly shown: { readonly prompt: KeystorePrompt; readonly oversize: boolean } | undefined;
  readonly plan: ChainPlan;
  /** Raises to the sealed change marks — committed after verification, before signing. */
  readonly changeMarks?: ReadonlyArray<{ readonly purpose: number; readonly index: number }>;
};

export const prepareApproval = async (
  ctx: KernelContext,
  request: SignRequest,
  material: PublicMaterial,
  dek: Secret,
): Promise<PreparedApproval> => {
  assertHdTemplates(request);
  const storedMark =
    request.kind === "bitcoin.psbt"
      ? (purpose: number) =>
          changeMark(
            ctx.image,
            request.account.walletId,
            request.account.groupIndex,
            purpose,
            request.network,
          )
      : () => 0;
  const prepared = await prepareFor(request, material, ctx.platform.now(), storedMark);
  const prompt = bindAgent(ctx, prepared.prompt, prepared.signer);
  /* A keystore host shows this text in a bounded system dialog, so it is rendered and measured
     before the blind check: an over-long prompt counts as blind and, when allowed, reaches the
     keystore already truncated to whole lines. */
  const shown =
    ctx.platform.keystore === undefined
      ? undefined
      : boundChainPrompt(
          promptLocale(ctx.platform.keystore.locale),
          prompt,
          PROMPT_BOUNDS[ctx.platform.keystore.platform],
        );
  assertSignable(ctx, dek, prompt, shown?.oversize ?? false);
  return {
    request,
    prompt,
    shown,
    plan: prepared.plan,
    ...(prepared.changeMarks === undefined ? {} : { changeMarks: prepared.changeMarks }),
  };
};

const chainSign: Handler<"chain.sign"> = async (ctx, params, session) => {
  const { dek } = ctx.session.require(session);
  const { request, verify } = params;
  const openKeys =
    request.account.kind === "imported"
      ? importedSource(ctx, request, dek)
      : hdSource(ctx, request, dek);
  // The key source opens twice: `prepare` checks ownership, normalizes, decodes and plans — the
  // secret and every node are wiped before the (possibly long) system verification prompt; the
  // sign pass re-opens it and executes the prepared plan unchanged.
  const prepared = await openKeys(async (keys) =>
    prepareApproval(ctx, request, keys.material, dek),
  );
  await verifyFactor(
    ctx,
    verify,
    dek,
    () =>
      prepared.shown?.prompt ??
      chainPrompt(promptLocale(ctx.platform.keystore?.locale ?? "en"), prepared.prompt),
  );
  // The session may have ended while the prompt was up; the fiat24 window re-checks too, as the
  // old sign pass did.
  ctx.session.require(session);
  if (request.kind === "evm.fiat24-session") {
    assertFiat24Deadline(request, ctx.platform.now());
  }
  // The verified intent is committed before any signature exists: a failed commit aborts the
  // request, an aborted signing still leaves the mark raised (harmless — it only widens the
  // wallet's own scan).
  if (request.kind === "bitcoin.psbt" && prepared.changeMarks !== undefined) {
    await commitChangeMarks(
      ctx,
      dek,
      request.account.walletId,
      request.account.groupIndex,
      request.network,
      prepared.changeMarks,
    );
  }
  return openKeys(async (keys) =>
    signPlan(prepared.plan, keys.backend(taskSignerFor(prepared.plan))),
  );
};

export function createChainsModule(): ChainsModule {
  let accounts: AccountCache = new WeakMap();
  const vault: VaultHooks = {
    ownsRecord: marksHooks.ownsRecord,
    claimUnlocked: marksHooks.claimUnlocked,
    forget: () => undefined,
    lock: () => {
      accounts = new WeakMap();
    },
    walletDeleteOps: marksHooks.walletDeleteOps,
    parseHeader: marksHooks.parseHeader,
  };

  const handlers: { [M in keyof typeof CHAINS_METHODS & MethodName]: Handler<M> } = {
    "wallet.accounts": async (ctx, params, session) =>
      walletAccounts(ctx, params, session, accounts),
    "chain.sign": chainSign,
    "chain.exportAccount": exportAccount(),
  };

  return { vault, handlers };
}
