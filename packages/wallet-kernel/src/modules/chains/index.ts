/**
 * The chains module: `wallet.accounts` — the public account for a template at the wallet's group
 * index, derived from the wallet's entropy record once per session and then served from a cache of
 * public data only. No records: seed and every node are wiped in `finally` on every path.
 * `chain.sign` prepares, verifies and signs through the per-family executors in `./evm.ts`,
 * `./bitcoin.ts` and `./solana.ts`.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { HDKey } from "@scure/bip32";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";

import { isBlindIntent } from "@qntx/wallet-chains";
import { BITCOIN_NETWORKS, bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import { solanaAddressFromPublicKey, SOLANA_NETWORKS } from "@qntx/wallet-chains/solana";
import type {
  ChainAccount,
  ChainTemplate,
  CHAINS_METHODS,
  MethodName,
} from "@qntx/wallet/protocol";

import type { Handler, VaultHooks } from "../../commands/context.ts";
import { withWalletSeed } from "../../commands/vault.ts";
import { KernelError } from "../../errors.ts";
import { promptLocale } from "../../prompts.ts";
import type { Secret } from "../../secret/secret.ts";
import { wipe } from "../../secret/secret.ts";
import { parseKeyHeader } from "../../vault/headers.ts";
import { BLIND_SIGNING, policyEnabled } from "../../vault/policy.ts";
import type { StoredRecord } from "../../vault/store.ts";
import { openRecord, verifyFactor } from "../../vault/vault.ts";
import { executeBitcoin } from "./bitcoin.ts";
import { executeEvm } from "./evm.ts";
import { chainPrompt } from "./prompt.ts";
import type { PromptIntent } from "./prompt.ts";
import type { ExecuteResult, SignRequest } from "./shared.ts";
import { BTC_PURPOSE } from "./shared.ts";
import { executeSolana } from "./solana.ts";

export type ChainsModule = {
  readonly vault: VaultHooks;
  readonly handlers: { [M in keyof typeof CHAINS_METHODS & MethodName]: Handler<M> };
};

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
};

const accountFor = (
  master: HDKey,
  seed: Uint8Array,
  template: ChainTemplate,
  network: string,
  groupIndex: number,
): ChainAccount => {
  if (template === "evm.bip44") {
    const child = master.derive(`m/44'/60'/0'/0/${groupIndex}`);
    try {
      const pub = child.publicKey;
      if (pub === null) {
        throw new KernelError("integrity", "no public key at account path");
      }
      return { template, network, address: evmAddressFromPublicKey(pub) };
    } finally {
      child.wipePrivateData();
    }
  }
  if (template === "solana.bip44-change") {
    const root = Slip10.fromMasterSeed(seed);
    const child = root.derive(`m/44'/501'/${groupIndex}'/0'`);
    try {
      return {
        template,
        network,
        address: solanaAddressFromPublicKey(ed25519.getPublicKey(child.privateKey)),
      };
    } finally {
      wipe(child.privateKey);
      wipe(root.privateKey);
    }
  }
  const purpose = BTC_PURPOSE[template];
  if (purpose === undefined) {
    throw new KernelError("invalid-input", `unknown template ${template}`);
  }
  const path = `m/${purpose}'/${bitcoinNetwork(network).coinType}'/${groupIndex}'`;
  const account = master.derive(path);
  try {
    return {
      template,
      network,
      xpub: account.publicExtendedKey,
      fingerprint: master.fingerprint.toString(16).padStart(8, "0"),
      path,
    };
  } finally {
    account.wipePrivateData();
  }
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
  const record = ctx.image.records.find(
    (entry) => entry.kind === "entropy" && entry.id === params.walletId,
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
  const account = await withWalletSeed(ctx.platform.pbkdf2, dek, record, (seed) => {
    // Bitcoin account keys serialize with the network's version bytes (xpub or tpub).
    const master = HDKey.fromMasterSeed(
      seed,
      params.template.startsWith("btc.") ? bitcoinNetwork(params.network).bip32 : undefined,
    );
    try {
      return accountFor(master, seed, params.template, params.network, params.groupIndex);
    } finally {
      master.wipePrivateData();
    }
  });
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

/** One pass over the request with its signing secret, which exists only for the call. */
type SignPass = (intentOnly: boolean) => ExecuteResult | Promise<ExecuteResult>;

/** The HD pass: template checks, the wallet's entropy record, and the seed via `withWalletSeed`. */
const hdPass = (
  ctx: Parameters<Handler<"chain.sign">>[0],
  request: SignRequest,
  dek: Secret,
): SignPass => {
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
    const expected =
      family === "evm"
        ? ["evm.bip44"]
        : family === "solana"
          ? ["solana.bip44-change"]
          : ["btc.bip44", "btc.bip49", "btc.bip84", "btc.bip86"];
    if (!("template" in account) || !expected.includes(account.template)) {
      throw new KernelError("invalid-input", "account template does not match the request family");
    }
  }
  const record = ctx.image.records.find(
    (entry) => entry.kind === "entropy" && entry.id === account.walletId,
  );
  if (record === undefined) {
    throw new KernelError("not-found", "no such wallet");
  }
  const execute = (seed: Uint8Array, intentOnly: boolean): ExecuteResult => {
    if (request.kind === "bitcoin.psbt") {
      return executeBitcoin(ctx.platform.random, request, account, seed, intentOnly);
    }
    if (request.kind === "bitcoin.message") {
      return executeBitcoin(ctx.platform.random, request, account, seed, intentOnly);
    }
    if (!("template" in account)) {
      throw new KernelError("invalid-input", "account template does not match the request family");
    }
    const source = { kind: "hd" as const, account, seed };
    if (
      request.kind === "evm.transaction" ||
      request.kind === "evm.personal-message" ||
      request.kind === "evm.typed-data"
    ) {
      return executeEvm(request, source, intentOnly);
    }
    return executeSolana(request, source, intentOnly);
  };
  return async (intentOnly) =>
    withWalletSeed(ctx.platform.pbkdf2, dek, record, (seed) => execute(seed, intentOnly));
};

/* The imported pass: the same two-pass shape, but the secret comes straight from the `key`
   record instead of an entropy derivation. Bitcoin requests have no imported path: WIF is out
   of scope. */
const importedPass = (
  ctx: Parameters<Handler<"chain.sign">>[0],
  request: SignRequest,
  dek: Secret,
): SignPass => {
  const { account } = request;
  if (account.kind !== "imported") {
    throw new KernelError("integrity", "unreachable: imported path with an hd account");
  }
  const isEvm =
    request.kind === "evm.transaction" ||
    request.kind === "evm.personal-message" ||
    request.kind === "evm.typed-data";
  const isSolana = request.kind === "solana.transaction" || request.kind === "solana.message";
  if (!isEvm && !isSolana) {
    throw new KernelError("unsupported", "imported accounts are not supported on bitcoin");
  }
  const record = ctx.image.records.find(
    (entry) => entry.kind === "key" && entry.id === account.keyId,
  );
  if (record === undefined) {
    throw new KernelError("not-found", "no such imported key");
  }
  const header = parseKeyHeader(record.header);
  if (header.family !== (isEvm ? "evm" : "solana")) {
    throw new KernelError("invalid-input", "the key's family does not match the request");
  }
  const execute = (secret: Uint8Array, intentOnly: boolean): ExecuteResult => {
    const source = { kind: "imported" as const, secret };
    if (
      request.kind === "evm.transaction" ||
      request.kind === "evm.personal-message" ||
      request.kind === "evm.typed-data"
    ) {
      return executeEvm(request, source, intentOnly);
    }
    if (request.kind === "solana.transaction" || request.kind === "solana.message") {
      return executeSolana(request, source, intentOnly);
    }
    throw new KernelError("integrity", "unreachable: bitcoin reached the imported executor");
  };
  return (intentOnly) => {
    const secret = openRecord(dek, record);
    try {
      return execute(secret, intentOnly);
    } finally {
      wipe(secret);
    }
  };
};

const chainSign: Handler<"chain.sign"> = async (ctx, params, session) => {
  const { dek } = ctx.session.require(session);
  const { request, verify } = params;
  const pass =
    request.account.kind === "imported"
      ? importedPass(ctx, request, dek)
      : hdPass(ctx, request, dek);
  // Two passes over the signing secret: `prepare` checks ownership, normalizes and decodes,
  // returning only the intent; the secret and every key are wiped before the (possibly long)
  // system verification prompt. `sign` re-opens the secret and signs only after verification
  // passed.
  const prepared = await pass(true);
  if (!("prompt" in prepared)) {
    throw new KernelError("integrity", "unreachable: prepare pass signed");
  }
  assertSignable(ctx, dek, prepared.prompt);
  await verifyFactor(ctx.platform, ctx.image, verify, dek, ctx.commit, () =>
    chainPrompt(promptLocale(ctx.platform.keystore?.locale ?? "en"), prepared.prompt),
  );
  // The session may have ended while the prompt was up.
  ctx.session.require(session);
  const signed = await pass(false);
  if ("prompt" in signed) {
    throw new KernelError("integrity", "unreachable: sign pass did not sign");
  }
  return signed;
};

export function createChainsModule(): ChainsModule {
  let accounts: AccountCache = new WeakMap();
  const vault: VaultHooks = {
    ownsRecord: () => false,
    claimUnlocked: (records) => records,
    forget: () => undefined,
    lock: () => {
      accounts = new WeakMap();
    },
    walletDeleteOps: () => [],
  };

  const handlers: { [M in keyof typeof CHAINS_METHODS & MethodName]: Handler<M> } = {
    "wallet.accounts": async (ctx, params, session) =>
      walletAccounts(ctx, params, session, accounts),
    "chain.sign": chainSign,
  };

  return { vault, handlers };
}
