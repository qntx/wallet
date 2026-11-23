/**
 * The chains module: `wallet.accounts` — the public account for a template at the wallet's group
 * index, derived from the wallet's entropy record once per session and then served from a cache of
 * public data only. No records: seed and every node are wiped in `finally` on every path.
 * `chain.sign` runs `validate → plan → backend → assemble`: a prepare function (./evm.ts,
 * ./bitcoin.ts, ./solana.ts, ./tron.ts) builds the serialisable plan through `PublicMaterial`
 * (./keys.ts), the prompt is verified, then `signPlan` (./run.ts) signs it against a fresh key
 * source — the plan itself is reused, never recomputed.
 */
import { hash160 } from "@scure/btc-signer/utils.js";

import { isBlindIntent } from "@qntx/wallet-chains";
import type { KeyPath } from "@qntx/wallet-chains";
import { BITCOIN_NETWORKS, bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import { solanaAddressFromPublicKey, SOLANA_NETWORKS } from "@qntx/wallet-chains/solana";
import { TRON_NETWORKS, tronAddressFromPublicKey } from "@qntx/wallet-chains/tron";
import type {
  ChainAccount,
  ChainTemplate,
  CHAINS_METHODS,
  MethodName,
  SessionSchemeId,
} from "@qntx/wallet/protocol";

import type { Handler, VaultHooks } from "../../commands/context.ts";
import { withWalletSeed } from "../../commands/vault.ts";
import type { PublicMaterial } from "../../derive/material.ts";
import { KernelError } from "../../errors.ts";
import { promptLocale } from "../../prompts.ts";
import type { Secret } from "../../secret/secret.ts";
import { wipe } from "../../secret/secret.ts";
import { parseKeyHeader } from "../../vault/headers.ts";
import { BLIND_SIGNING, policyEnabled } from "../../vault/policy.ts";
import type { StoredRecord } from "../../vault/store.ts";
import { openRecord, verifyFactor } from "../../vault/vault.ts";
import { CARD_WALLET_KIND, isCardWallet } from "../card/record.ts";
import { findSession, parseSessionHeader } from "../sessions/record.ts";
import { prepareBitcoin } from "./bitcoin.ts";
import { assertFiat24Deadline, prepareEvm } from "./evm.ts";
import { importedKeys, pathString, seedKeys } from "./keys.ts";
import type { KeySource } from "./keys.ts";
import { chainPrompt } from "./prompt.ts";
import type { PromptIntent } from "./prompt.ts";
import { signPlan, taskSignerFor } from "./run.ts";
import type { Prepared, SignRequest } from "./shared.ts";
import { BTC_PURPOSE } from "./shared.ts";
import { prepareSolana } from "./solana.ts";
import { prepareTron } from "./tron.ts";

export type ChainsModule = {
  readonly vault: VaultHooks;
  readonly handlers: { [M in keyof typeof CHAINS_METHODS & MethodName]: Handler<M> };
};

const HARDENED = 0x80000000;

/** The leaf path of group `g` — `m/44'/{coin}'/0'/0/{g}` or SLIP-10 `m/44'/501'/{g}'/0'`. */
const leafPath = (family: "evm" | "tron" | "solana", groupIndex: number): KeyPath => {
  if (family === "solana") {
    return [44 + HARDENED, 501 + HARDENED, groupIndex + HARDENED, HARDENED];
  }
  const coin = family === "tron" ? 195 : 60;
  return [44 + HARDENED, coin + HARDENED, HARDENED, 0, groupIndex];
};

/** An imported account's only path is `[]`; an HD account's is its group's leaf. */
const requestPath = (
  family: "evm" | "tron" | "solana",
  account: SignRequest["account"],
): KeyPath => (account.kind === "imported" ? [] : leafPath(family, account.groupIndex));

const checkNetwork = (template: string, network: string): void => {
  if (template.startsWith("evm.") && !network.startsWith("eip155:")) {
    throw new KernelError("invalid-input", "evm.bip44 requires an eip155 network");
  }
  if (template.startsWith("solana.") && !SOLANA_NETWORKS.includes(network)) {
    throw new KernelError("invalid-input", `unknown solana network ${network}`);
  }
  if (template.startsWith("btc.") && !(network in BITCOIN_NETWORKS)) {
    throw new KernelError("invalid-input", `unknown bitcoin network ${network}`);
  }
  if (template.startsWith("tron.") && !TRON_NETWORKS.includes(network)) {
    throw new KernelError("invalid-input", `unknown tron network ${network}`);
  }
};

export const accountFor = async (
  material: KeySource["material"],
  template: ChainTemplate,
  network: string,
  groupIndex: number,
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
  const pub = await material.secp256k1([]);
  return {
    template,
    network,
    // Bitcoin account keys serialize with the network's version bytes (xpub or tpub).
    xpub: await material.extendedPublicKey(path, net.bip32),
    fingerprint: hash160(pub)
      .subarray(0, 4)
      .reduce((acc, b) => acc + b.toString(16).padStart(2, "0"), ""),
    path: pathString(path),
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
  cardMaterial: (walletId: string) => PublicMaterial | undefined,
): Promise<ChainAccount> => {
  const { dek } = ctx.session.require(session);
  const record = ctx.image.records.find(
    (entry) =>
      entry.id === params.walletId && (entry.kind === "entropy" || entry.kind === CARD_WALLET_KIND),
  );
  if (record === undefined) {
    throw new KernelError("not-found", "no such wallet");
  }
  checkNetwork(params.template, params.network);
  const key = `${String(params.groupIndex)}/${params.template}/${params.network}`;
  const known = cache.get(record)?.get(key);
  if (known !== undefined) {
    return known;
  }
  let account: ChainAccount;
  if (record.kind === CARD_WALLET_KIND) {
    const material = cardMaterial(params.walletId);
    if (material === undefined) {
      // The record exists but its body was never claimed — an unlock that opened records but
      // skipped the card module should not be possible.
      throw new KernelError("integrity", "card wallet material is not loaded");
    }
    account = await accountFor(material, params.template, params.network, params.groupIndex);
  } else {
    account = await withWalletSeed(ctx.platform.pbkdf2, dek, record, async (seed) => {
      const keys = seedKeys(seed, ctx.platform.random);
      try {
        return await accountFor(keys.material, params.template, params.network, params.groupIndex);
      } finally {
        keys.wipe();
      }
    });
  }
  const accounts = cache.get(record) ?? new Map<string, ChainAccount>();
  accounts.set(key, account);
  cache.set(record, accounts);
  return account;
};

/** A request the decoder marked blind is refused before any prompt unless the owner allowed it. */
const assertSignable = (
  ctx: Parameters<Handler<"chain.sign">>[0],
  dek: Secret,
  intent: PromptIntent,
): void => {
  if (isBlindIntent(intent) && !policyEnabled(ctx.image, dek, BLIND_SIGNING)) {
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

/** The HD source: template checks, the wallet's entropy record, and the seed via `withWalletSeed`. */
const hdSource = (
  ctx: Parameters<Handler<"chain.sign">>[0],
  request: SignRequest,
  dek: Secret,
): OpenKeys => {
  const { account } = request;
  if (account.kind === "imported") {
    throw new KernelError("integrity", "unreachable: hd path with an imported account");
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
  if (isCardWallet(ctx.image, account.walletId)) {
    // Card wallets sign through card.begin's sign operation, never through this pipeline.
    throw new KernelError("card-required", "card wallets sign through card.begin");
  }
  const record = ctx.image.records.find(
    (entry) => entry.kind === "entropy" && entry.id === account.walletId,
  );
  if (record === undefined) {
    throw new KernelError("not-found", "no such wallet");
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
const prepareFor = async (
  request: SignRequest,
  material: KeySource["material"],
  now: number,
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
  return prepareBitcoin(request, account, material);
};

/**
 * The approve-agent binding (design.md §ApproveAgent 绑定): when the decoded intent approves a
 * Hyperliquid agent, look the agent address up among this vault's session-key records. A
 * hyperliquid-l1-agent record whose owner, scope, name and validUntil all match the signed action
 * marks the prompt "held"; a record that exists but disagrees means the approval describes a
 * different agent under the same address and is refused; no record marks it "not held".
 */
const bindAgent = (
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
    prepareFor(request, keys.material, ctx.platform.now()),
  );
  const prompt = bindAgent(ctx, prepared.prompt, prepared.signer);
  assertSignable(ctx, dek, prompt);
  await verifyFactor(ctx.platform, ctx.image, verify, dek, ctx.commit, () =>
    chainPrompt(promptLocale(ctx.platform.keystore?.locale ?? "en"), prompt),
  );
  // The session may have ended while the prompt was up; the fiat24 window re-checks too, as the
  // old sign pass did.
  ctx.session.require(session);
  if (request.kind === "evm.fiat24-session") {
    assertFiat24Deadline(request, ctx.platform.now());
  }
  return openKeys(async (keys) =>
    signPlan(prepared.plan, keys.backend(taskSignerFor(prepared.plan))),
  );
};

export function createChainsModule(
  cardMaterial: (walletId: string) => PublicMaterial | undefined,
): ChainsModule {
  let accounts: AccountCache = new WeakMap();
  const vault: VaultHooks = {
    ownsRecord: () => false,
    claimUnlocked: (records) => records,
    forget: () => undefined,
    lock: () => {
      accounts = new WeakMap();
    },
    walletDeleteOps: () => [],
    parseHeader: () => undefined,
  };

  const handlers: { [M in keyof typeof CHAINS_METHODS & MethodName]: Handler<M> } = {
    "wallet.accounts": async (ctx, params, session) =>
      walletAccounts(ctx, params, session, accounts, cardMaterial),
    "chain.sign": chainSign,
  };

  return { vault, handlers };
}
