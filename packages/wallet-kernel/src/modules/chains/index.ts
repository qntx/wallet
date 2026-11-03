/**
 * The chains module: `wallet.accounts` — the public account for a template at the wallet's group
 * index, derived from the wallet's entropy record. No records, no cache: seed and every node are
 * wiped in `finally` on every path. `chain.sign` prepares, verifies and signs through the
 * per-family executors in `./evm.ts`, `./bitcoin.ts` and `./solana.ts`.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { HDKey } from "@scure/bip32";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";

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
import { wipe } from "../../secret/secret.ts";
import { verifyFactor } from "../../vault/vault.ts";
import { executeBitcoin } from "./bitcoin.ts";
import { executeEvm } from "./evm.ts";
import { chainPrompt } from "./prompt.ts";
import type { ExecuteResult } from "./shared.ts";
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

const walletAccounts: Handler<"wallet.accounts"> = async (ctx, params, session) => {
  const { dek } = ctx.session.require(session);
  const record = ctx.image.records.find(
    (entry) => entry.kind === "entropy" && entry.id === params.walletId,
  );
  if (record === undefined) {
    throw new KernelError("not-found", "no such wallet");
  }
  checkNetwork(params.template, params.network);
  return withWalletSeed(ctx.platform.pbkdf2, dek, record, (seed) => {
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
};

const chainSign: Handler<"chain.sign"> = async (ctx, params, session) => {
  const { dek } = ctx.session.require(session);
  const { request, verify } = params;
  const { account } = request;
  if (account.kind !== "hd") {
    throw new KernelError("unsupported", "imported accounts are not yet supported");
  }
  const [family] = request.kind.split(".", 1);
  const expected =
    family === "evm"
      ? ["evm.bip44"]
      : family === "solana"
        ? ["solana.bip44-change"]
        : ["btc.bip44", "btc.bip49", "btc.bip84", "btc.bip86"];
  if (!expected.includes(account.template)) {
    throw new KernelError("invalid-input", "account template does not match the request family");
  }
  const record = ctx.image.records.find(
    (entry) => entry.kind === "entropy" && entry.id === account.walletId,
  );
  if (record === undefined) {
    throw new KernelError("not-found", "no such wallet");
  }
  const execute = (seed: Uint8Array, intentOnly: boolean): ExecuteResult => {
    if (
      request.kind === "evm.transaction" ||
      request.kind === "evm.personal-message" ||
      request.kind === "evm.typed-data"
    ) {
      return executeEvm(request, account, seed, intentOnly);
    }
    if (request.kind === "bitcoin.psbt" || request.kind === "bitcoin.message") {
      return executeBitcoin(ctx.platform.random, request, account, seed, intentOnly);
    }
    return executeSolana(request, account, seed, intentOnly);
  };
  // Two passes over the seed: `prepare` checks ownership, normalizes and decodes, returning
  // only the intent; the seed and every key are wiped before the (possibly long) system
  // verification prompt. `sign` re-derives and signs only after verification passed.
  const withSeed = async <R>(run: (seed: Uint8Array) => R): Promise<R> =>
    withWalletSeed(ctx.platform.pbkdf2, dek, record, run);
  const prepared = await withSeed((seed) => execute(seed, true));
  if (!("prompt" in prepared)) {
    throw new KernelError("integrity", "unreachable: prepare pass signed");
  }
  await verifyFactor(ctx.platform, ctx.image, verify, dek, () =>
    chainPrompt(promptLocale(ctx.platform.keystore?.locale ?? "en"), prepared.prompt),
  );
  // The session may have ended while the prompt was up.
  ctx.session.require(session);
  const signed = await withSeed((seed) => execute(seed, false));
  if ("prompt" in signed) {
    throw new KernelError("integrity", "unreachable: sign pass did not sign");
  }
  return signed;
};

export function createChainsModule(): ChainsModule {
  const vault: VaultHooks = {
    ownsRecord: () => false,
    claimUnlocked: (records) => records,
    forget: () => undefined,
    lock: () => undefined,
    walletDeleteOps: () => [],
  };

  const handlers: { [M in keyof typeof CHAINS_METHODS & MethodName]: Handler<M> } = {
    "wallet.accounts": walletAccounts,
    "chain.sign": chainSign,
  };

  return { vault, handlers };
}
