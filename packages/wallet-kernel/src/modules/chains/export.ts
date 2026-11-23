/**
 * `chain.exportAccount` — the verified export of the public account material a watch-only wallet
 * needs to pair with this signer: per requested node, the public key plus — for the account-level
 * nodes a watch-only wallet derives every address under — the chain code and parent fingerprint.
 * The verify factor is consumed exactly like `chain.sign` consumes it. An imported-key record has
 * no HD material and is refused; a hardware wallet answers only what its pin serves — anything else
 * is `device-required`, never a device exchange. Only public material leaves the kernel.
 */
import type { KeyPath } from "@qntx/wallet-chains";
import { bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import type { ChainExportedKey, ChainExportNode, ChainExportResult } from "@qntx/wallet/protocol";

import type { Handler } from "../../commands/context.ts";
import { withWalletSeed } from "../../commands/vault.ts";
import { KernelError } from "../../errors.ts";
import { corePromptFor } from "../../prompts.ts";
import { findWalletRecord, verifyFactor } from "../../vault/vault.ts";
import { accountKey, pathString, seedKeys } from "./keys.ts";
import type { PublicMaterial } from "./keys.ts";
import { BTC_PURPOSE, checkNetwork, HARDENED, leafPath } from "./shared.ts";
import type { ExternalMaterial } from "./shared.ts";

const EVM_ACCOUNT: KeyPath = [44 + HARDENED, 60 + HARDENED, HARDENED];
const MAINNET_VERSIONS = { public: 0x0488b21e, private: 0x0488ade4 } as const;

type Params = Parameters<Handler<"chain.exportAccount">>[1];

const nodeId = (node: ChainExportNode): string =>
  node.kind === "evm.account"
    ? "evm.account"
    : node.kind === "leaf"
      ? `leaf/${node.template}`
      : `btc.account/${node.template}/${node.network}`;

const nodePath = (node: ChainExportNode, groupIndex: number): KeyPath => {
  if (node.kind === "evm.account") {
    return EVM_ACCOUNT;
  }
  if (node.kind === "leaf") {
    return leafPath(
      node.template === "evm.bip44" ? "evm" : node.template === "tron.bip44" ? "tron" : "solana",
      groupIndex,
    );
  }
  const purpose = BTC_PURPOSE[node.template];
  if (purpose === undefined) {
    throw new KernelError("invalid-input", `unknown template ${node.template}`);
  }
  const { coinType } = bitcoinNetwork(node.network);
  return [purpose + HARDENED, coinType + HARDENED, groupIndex + HARDENED];
};

const fp8 = (value: number): string => value.toString(16).padStart(8, "0");

const fpHex = (bytes: Uint8Array): string =>
  bytes.reduce((acc, b) => acc + b.toString(16).padStart(2, "0"), "");

/**
 * The node's exported key. Account nodes go through the extended public key — the same node the
 * `wallet.accounts` xpub serializes — so the chain code and parent fingerprint travel with it;
 * leaves carry the bare public key only.
 */
const exportKey = async (
  material: PublicMaterial,
  node: ChainExportNode,
  groupIndex: number,
): Promise<ChainExportedKey> => {
  const path = nodePath(node, groupIndex);
  if (node.kind === "leaf") {
    return {
      node,
      path: pathString(path),
      curve: node.template === "solana.bip44-change" ? "ed25519" : "secp256k1",
      publicKey:
        node.template === "solana.bip44-change"
          ? await material.ed25519(path)
          : await material.secp256k1(path),
    };
  }
  const versions =
    node.kind === "evm.account" ? MAINNET_VERSIONS : bitcoinNetwork(node.network).bip32;
  const account = await accountKey(material, path, versions);
  return {
    node,
    path: pathString(path),
    curve: "secp256k1",
    publicKey: account.publicKey,
    chainCode: account.chainCode,
    parentFingerprint: fp8(account.parentFingerprint),
  };
};

const result = async (material: PublicMaterial, params: Params): Promise<ChainExportResult> => ({
  fingerprint: fpHex(await material.fingerprint()),
  keys: await Promise.all(
    params.nodes.map(async (node) => exportKey(material, node, params.groupIndex)),
  ),
});

export const exportAccount =
  (external: ExternalMaterial): Handler<"chain.exportAccount"> =>
  async (ctx, params, session) => {
    const { dek } = ctx.session.require(session);
    const record = findWalletRecord(ctx.image, params.walletId);
    if (record === undefined) {
      if (ctx.image.records.some((r) => r.kind === "key" && r.id === params.walletId)) {
        throw new KernelError("invalid-input", "an imported key has no account material");
      }
      throw new KernelError("not-found", "no such wallet");
    }
    const seen = new Set<string>();
    for (const node of params.nodes) {
      if (node.kind === "btc.account") {
        checkNetwork(node.template, node.network);
      }
      if (seen.has(nodeId(node))) {
        throw new KernelError("invalid-input", "duplicate export node");
      }
      seen.add(nodeId(node));
    }
    await verifyFactor(
      ctx.platform,
      ctx.image,
      params.verify,
      dek,
      ctx.commit,
      corePromptFor(ctx.platform.keystore, "export-account"),
    );
    // The session may have ended while the prompt was up, exactly as in chain.sign.
    ctx.session.require(session);
    if (record.kind !== "entropy") {
      return result(external(ctx.image, record), params);
    }
    return withWalletSeed(ctx.platform.pbkdf2, dek, record, async (seed) => {
      const keys = seedKeys(seed, ctx.platform.random);
      try {
        return await result(keys.material, params);
      } finally {
        keys.wipe();
      }
    });
  };
