/**
 * The chains module: `wallet.accounts` — the public account for a template at the wallet's group
 * index, derived from the wallet's entropy record. No records, no cache: seed and every node are
 * wiped in `finally` on every path. Signing is not in this module — `chain.sign` arrives in E2-b.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { HDKey } from "@scure/bip32";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";

import { ChainError } from "@qntx/wallet-chains";
import { BITCOIN_NETWORKS, bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import { decodeEvm, normalizeEvm, evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import {
  signEvmPersonalMessage,
  signEvmTransaction,
  signEvmTypedData,
} from "@qntx/wallet-chains/evm/sign";
import {
  decodeSolana,
  normalizeSolana,
  solanaAddressFromPublicKey,
  SOLANA_NETWORKS,
} from "@qntx/wallet-chains/solana";
import { signSolanaMessage } from "@qntx/wallet-chains/solana/sign";
import type {
  ChainAccount,
  ChainTemplate,
  CHAINS_METHODS,
  MethodName,
} from "@qntx/wallet/protocol";

import type { Handler, VaultHooks } from "../../commands/context.ts";
import { KernelError } from "../../errors.ts";
import { wipe } from "../../secret/secret.ts";
import { seedFromEntropy } from "../../seed/seed.ts";
import { openRecord, verifyFactor } from "../../vault/vault.ts";

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
  if (template !== "btc.bip84" && template !== "btc.bip86") {
    throw new KernelError("invalid-input", `unknown template ${String(template)}`);
  }
  const purpose = template === "btc.bip84" ? 84 : 86;
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

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

/** Order-insensitive deep equality over wire values (Uint8Array, arrays, plain objects, scalars). */
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) {
    return true;
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return (
      a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      a.length === b.length &&
      a.every((byte, i) => byte === b[i])
    );
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => deepEqual(v, b[i]))
    );
  }
  if (!isObj(a) || !isObj(b)) {
    return false;
  }
  const ka = Object.keys(a);
  const kb = new Set(Object.keys(b));
  return ka.length === kb.size && ka.every((k) => kb.has(k) && deepEqual(a[k], b[k]));
};

const mapChainError = (error: unknown): never => {
  if (error instanceof ChainError) {
    throw new KernelError("invalid-input", "invalid sign request");
  }
  throw error;
};

export function createChainsModule(): ChainsModule {
  const vault: VaultHooks = {
    ownsRecord: () => false,
    claimUnlocked: (records) => records,
    forget: () => undefined,
    lock: () => undefined,
    backupSecrets: () => [],
    backupRecords: () => [],
    walletDeleteOps: () => [],
  };

  const handlers: { [M in keyof typeof CHAINS_METHODS & MethodName]: Handler<M> } = {
    "wallet.accounts": async (ctx, params, session) => {
      const { dek } = ctx.session.require(session);
      const record = ctx.image.records.find(
        (entry) => entry.kind === "entropy" && entry.id === params.walletId,
      );
      if (record === undefined) {
        throw new KernelError("not-found", "no such wallet");
      }
      checkNetwork(params.template, params.network);
      const entropy = openRecord(dek, record);
      let seed: Uint8Array;
      try {
        seed = await seedFromEntropy(entropy, ctx.platform.pbkdf2);
      } finally {
        wipe(entropy);
      }
      try {
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
      } finally {
        wipe(seed);
      }
    },
    "chain.sign": async (ctx, params, session) => {
      const { dek } = ctx.session.require(session);
      const { request, verify } = params;
      const { account } = request;
      if (account.kind !== "hd") {
        throw new KernelError("unsupported", "imported accounts are not yet supported");
      }
      const evm =
        request.kind === "evm.transaction" ||
        request.kind === "evm.personal-message" ||
        request.kind === "evm.typed-data";
      if (account.template !== (evm ? "evm.bip44" : "solana.bip44-change")) {
        throw new KernelError(
          "invalid-input",
          "account template does not match the request family",
        );
      }
      const record = ctx.image.records.find(
        (entry) => entry.kind === "entropy" && entry.id === account.walletId,
      );
      if (record === undefined) {
        throw new KernelError("not-found", "no such wallet");
      }
      const entropy = openRecord(dek, record);
      let seed: Uint8Array;
      try {
        seed = await seedFromEntropy(entropy, ctx.platform.pbkdf2);
      } finally {
        wipe(entropy);
      }
      try {
        if (evm) {
          const master = HDKey.fromMasterSeed(seed);
          try {
            const child = master.derive(`m/44'/60'/0'/0/${account.groupIndex}`);
            try {
              const priv = child.privateKey;
              if (priv === null) {
                throw new KernelError("integrity", "no private key at account path");
              }
              let normalized;
              try {
                normalized = normalizeEvm(request);
              } catch (error) {
                mapChainError(error);
              }
              if (!deepEqual(normalized, request)) {
                throw new KernelError("invalid-input", "request is not normalized");
              }
              try {
                decodeEvm(request);
              } catch (error) {
                mapChainError(error);
              }
              await verifyFactor(ctx.platform, ctx.image, verify, dek);
              if (request.kind === "evm.transaction") {
                return {
                  kind: "evm.transaction",
                  signedTransaction: signEvmTransaction(request.tx, priv),
                };
              }
              if (request.kind === "evm.personal-message") {
                return {
                  kind: "evm.personal-message",
                  signature: signEvmPersonalMessage(request.message, priv),
                };
              }
              return {
                kind: "evm.typed-data",
                signature: signEvmTypedData(request.typedData, priv),
              };
            } finally {
              child.wipePrivateData();
            }
          } finally {
            master.wipePrivateData();
          }
        }
        const root = Slip10.fromMasterSeed(seed);
        const child = root.derive(`m/44'/501'/${account.groupIndex}'/0'`);
        try {
          const priv = child.privateKey;
          const signer = solanaAddressFromPublicKey(ed25519.getPublicKey(priv));
          let normalized;
          try {
            normalized = normalizeSolana(request, signer);
          } catch (error) {
            mapChainError(error);
          }
          if (!deepEqual(normalized, request)) {
            throw new KernelError("invalid-input", "request is not normalized");
          }
          if (request.kind === "solana.transaction") {
            try {
              decodeSolana(request, signer);
            } catch (error) {
              mapChainError(error);
            }
          }
          await verifyFactor(ctx.platform, ctx.image, verify, dek);
          return {
            kind: request.kind,
            signature: signSolanaMessage(request.message, priv),
          };
        } finally {
          wipe(child.privateKey);
          wipe(root.privateKey);
        }
      } finally {
        wipe(seed);
      }
    },
  };

  return { vault, handlers };
}
