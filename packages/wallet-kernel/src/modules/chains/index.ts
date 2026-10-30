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
import { Transaction } from "@scure/btc-signer/transaction.js";
import { p2tr, p2wpkh } from "@scure/btc-signer/payment.js";
import {
  decodeBitcoinPsbt,
  decodeMessageTarget,
  normalizeBitcoin,
} from "@qntx/wallet-chains/bitcoin";
import { signBitcoinMessage, signBitcoinPsbt } from "@qntx/wallet-chains/bitcoin/sign";
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
      const family = request.kind.split(".", 1)[0];
      const expected =
        family === "evm"
          ? ["evm.bip44"]
          : family === "solana"
            ? ["solana.bip44-change"]
            : ["btc.bip84", "btc.bip86"];
      if (!expected.includes(account.template)) {
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
        if (
          request.kind === "evm.transaction" ||
          request.kind === "evm.personal-message" ||
          request.kind === "evm.typed-data"
        ) {
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
        if (request.kind === "bitcoin.psbt" || request.kind === "bitcoin.message") {
          const net = bitcoinNetwork(request.network);
          const master = HDKey.fromMasterSeed(seed, net.bip32);
          try {
            const purpose = account.template === "btc.bip86" ? 86 : 84;
            const coinType = net.coinType;
            const hardened = 0x80000000;
            const accountNode = master.derive(
              `m/${purpose}'/${coinType}'/${account.groupIndex}'`,
            );
            const children: HDKey[] = [];
            const derivation = (
              owner: { bip32Derivation?: unknown; tapBip32Derivation?: unknown },
            ): { pubkey: Uint8Array; fingerprint: number; path: ReadonlyArray<number> } | undefined => {
              const entries: Array<readonly [unknown, unknown]> = [];
              const collect = (map: unknown): void => {
                if (map instanceof Map) {
                  for (const [k, v] of map) {
                    entries.push([k, v]);
                  }
                } else if (Array.isArray(map)) {
                  for (const e of map) {
                    if (Array.isArray(e) && e.length === 2) {
                      entries.push([e[0], e[1]]);
                    }
                  }
                }
              };
              collect(purpose === 86 ? owner.tapBip32Derivation : owner.bip32Derivation);
              for (const [key, value] of entries) {
                const der = isObj(value) && isObj(value["der"]) ? value["der"] : value;
                if (!isObj(der) || !(key instanceof Uint8Array)) {
                  continue;
                }
                const { fingerprint, path } = der;
                if (
                  fingerprint === master.fingerprint &&
                  Array.isArray(path) &&
                  path.every((p) => typeof p === "number")
                ) {
                  return { pubkey: key, fingerprint, path };
                }
              }
              return undefined;
            };
            const childAt = (path: ReadonlyArray<number>): HDKey => {
              const change = path[3];
              const index = path[4];
              if (
                path.length !== 5 ||
                path[0] !== purpose + hardened ||
                path[1] !== coinType + hardened ||
                path[2] !== account.groupIndex + hardened ||
                change === undefined ||
                index === undefined ||
                (change !== 0 && change !== 1) ||
                index < 0 ||
                index >= hardened
              ) {
                throw new KernelError("invalid-input", "derivation path is not this account's");
              }
              const child = accountNode.deriveChild(change).deriveChild(index);
              children.push(child);
              return child;
            };
            const expectedPub = (pub: Uint8Array): Uint8Array =>
              purpose === 86 ? pub.slice(1) : pub;
            const expectedScript = (pub: Uint8Array): Uint8Array =>
              purpose === 86 ? p2tr(pub.slice(1)).script : p2wpkh(pub).script;
            try {
              if (request.kind === "bitcoin.psbt") {
                const tx = Transaction.fromPSBT(request.psbt);
                const inputs: Array<{ index: number; privateKey: Uint8Array }> = [];
                for (const idx of request.sign) {
                  const input = tx.getInput(idx);
                  const entry = derivation(input);
                  if (entry === undefined) {
                    throw new KernelError(
                      "invalid-input",
                      `input ${idx}: derivation entry is not this account's`,
                    );
                  }
                  const child = childAt(entry.path);
                  const pub = child.publicKey;
                  const priv = child.privateKey;
                  if (pub === null || priv === null) {
                    throw new KernelError("integrity", "no key at derivation path");
                  }
                  if (!deepEqual(entry.pubkey, expectedPub(pub))) {
                    throw new KernelError(
                      "invalid-input",
                      `input ${idx}: derivation pubkey is not ours`,
                    );
                  }
                  const prevout = input.witnessUtxo;
                  if (prevout === undefined || !deepEqual(prevout.script, expectedScript(pub))) {
                    throw new KernelError(
                      "invalid-input",
                      `input ${idx}: prevout script is not this key's`,
                    );
                  }
                  inputs.push({ index: idx, privateKey: priv });
                }
                const ownScripts = new Set<string>();
                const hex = (bytes: Uint8Array): string =>
                  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
                for (let i = 0; i < tx.outputsLength; i++) {
                  const output = tx.getOutput(i);
                  if (output.script === undefined) {
                    continue;
                  }
                  const entry = derivation(output);
                  if (entry === undefined) {
                    continue;
                  }
                  try {
                    const child = childAt(entry.path);
                    const pub = child.publicKey;
                    if (pub !== null && deepEqual(output.script, expectedScript(pub))) {
                      ownScripts.add(hex(output.script));
                    }
                  } catch {
                    continue;
                  }
                }
                let normalized;
                try {
                  normalized = normalizeBitcoin(request);
                } catch (error) {
                  mapChainError(error);
                }
                if (!deepEqual(normalized, request)) {
                  throw new KernelError("invalid-input", "request is not normalized");
                }
                try {
                  decodeBitcoinPsbt(request, ownScripts);
                } catch (error) {
                  mapChainError(error);
                }
                await verifyFactor(ctx.platform, ctx.image, verify, dek);
                return {
                  kind: "bitcoin.psbt",
                  signedPsbt: signBitcoinPsbt(
                    request.psbt,
                    inputs,
                    () => ctx.platform.random(32),
                  ),
                };
              }
              if (request.format === "legacy") {
                throw new KernelError("unsupported", "legacy message format is not supported");
              }
              const child = childAt([
                purpose + hardened,
                coinType + hardened,
                account.groupIndex + hardened,
                request.change,
                request.index,
              ]);
              const pub = child.publicKey;
              const priv = child.privateKey;
              if (pub === null || priv === null) {
                throw new KernelError("integrity", "no key at derivation path");
              }
              const derived =
                purpose === 86
                  ? p2tr(pub.slice(1), undefined, net.params).address
                  : p2wpkh(pub, net.params).address;
              if (derived !== request.address) {
                throw new KernelError("invalid-input", "address is not ours");
              }
              let normalized;
              try {
                normalized = normalizeBitcoin(request);
              } catch (error) {
                mapChainError(error);
              }
              if (!deepEqual(normalized, request)) {
                throw new KernelError("invalid-input", "request is not normalized");
              }
              try {
                decodeMessageTarget(request);
              } catch (error) {
                mapChainError(error);
              }
              await verifyFactor(ctx.platform, ctx.image, verify, dek);
              return {
                kind: "bitcoin.message",
                signature: signBitcoinMessage(request, priv, () => ctx.platform.random(32)),
              };
            } finally {
              for (const child of children) {
                child.wipePrivateData();
              }
              accountNode.wipePrivateData();
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
