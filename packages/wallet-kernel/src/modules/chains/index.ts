/**
 * The chains module: `wallet.accounts` — the public account for a template at the wallet's group
 * index, derived from the wallet's entropy record. No records, no cache: seed and every node are
 * wiped in `finally` on every path. Signing is not in this module — `chain.sign` arrives in E2-b.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { HDKey } from "@scure/bip32";
import { HDKey as Slip10 } from "micro-key-producer/slip10.js";

import { BITCOIN_NETWORKS } from "@qntx/wallet-chains/bitcoin";
import { evmAddressFromPublicKey } from "@qntx/wallet-chains/evm";
import { solanaAddressFromPublicKey, SOLANA_NETWORKS } from "@qntx/wallet-chains/solana";
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
import { openRecord } from "../../vault/vault.ts";

export type ChainsModule = {
  readonly vault: VaultHooks;
  readonly handlers: { [M in keyof typeof CHAINS_METHODS & MethodName]: Handler<M> };
};

const BIP32_TPBK = { public: 0x04358394, private: 0x043587cf };

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
    const child = Slip10.fromMasterSeed(seed).derive(`m/44'/501'/${groupIndex}'/0'`);
    const pub = ed25519.getPublicKey(child.privateKey);
    return { template, network, address: solanaAddressFromPublicKey(pub) };
  }
  if (template !== "btc.bip84" && template !== "btc.bip86") {
    throw new KernelError("invalid-input", `unknown template ${String(template)}`);
  }
  const purpose = template === "btc.bip84" ? 84 : 86;
  const coin = network === "bip122:000000000019d6689c085ae165831e93" ? 0 : 1;
  const path = `m/${purpose}'/${coin}'/${groupIndex}'`;
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
      const seed = await seedFromEntropy(entropy, ctx.platform.pbkdf2);
      wipe(entropy);
      try {
        const master = HDKey.fromMasterSeed(
          seed,
          params.template.startsWith("btc.") &&
            params.network !== "bip122:000000000019d6689c085ae165831e93"
            ? BIP32_TPBK
            : undefined,
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
  };

  return { vault, handlers };
}
