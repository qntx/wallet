/**
 * The shared `chain.sign` / `hardware.sign` / card `sign` result verification: a result whose kind
 * is not the request's is refused for every request kind, then the family's check verifies the
 * signature (or signed content) against the account. Fails closed with `integrity`. Internal —
 * reached through chains(), hardware() and card() only.
 */
import { base58 } from "@scure/base";

import { ChainError } from "@qntx/wallet-chains";
import {
  bitcoinAddressFromXpub,
  bitcoinNetwork,
  samePsbtContent,
  verifyBitcoinMessage,
  verifyLegacyBitcoinMessage,
  verifyBitcoinPsbtSignatures,
} from "@qntx/wallet-chains/bitcoin";
import { evmAddressFromPublicKey, recoverEvmSigner } from "@qntx/wallet-chains/evm";
import { solanaAddressFromPublicKey, verifySolanaSignature } from "@qntx/wallet-chains/solana";
import {
  tronAddressFromPublicKey,
  verifyTronMessageSignature,
  verifyTronTransactionSignature,
  verifyTronTypedDataSignature,
} from "@qntx/wallet-chains/tron";

import { integrity } from "../channel.ts";
import type { WalletInternals } from "../internal.ts";
import type {
  ChainAccount,
  ChainExportedKey,
  ChainExportNode,
  ChainExportParams,
  ChainExportResult,
  ChainSignRequest,
  ChainSignResult,
} from "../protocol/chains.ts";

/**
 * The PSBT check: each sign entry names its template, so the account is fetched once per distinct
 * template and each group's signatures verify against that template's xpub.
 */
const checkPsbt = async (
  internals: WalletInternals,
  request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }>,
  result: ChainSignResult,
): Promise<void> => {
  if (result.kind !== request.kind) {
    throw integrity("result kind does not match the request");
  }
  if (!samePsbtContent(request.psbt, result.signedPsbt)) {
    throw integrity("signed psbt does not match the request");
  }
  const byTemplate = new Map<"btc.bip44" | "btc.bip49" | "btc.bip84" | "btc.bip86", number[]>();
  for (const { index, template } of request.sign) {
    const group = byTemplate.get(template) ?? [];
    group.push(index);
    byTemplate.set(template, group);
  }
  for (const [template, indices] of byTemplate) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one wallet.accounts call per template.
    const account = await internals.call("wallet.accounts", {
      walletId: request.account.walletId,
      groupIndex: request.account.groupIndex,
      template,
      network: request.network,
    });
    if (!("xpub" in account)) {
      throw integrity("chain account has no xpub");
    }
    if (
      !verifyBitcoinPsbtSignatures(
        result.signedPsbt,
        indices,
        account.xpub,
        template,
        request.network,
      )
    ) {
      throw integrity("psbt signatures do not verify for the account");
    }
  }
};

/**
 * The account the request names: the hd template account via `wallet.accounts`, or the imported
 * key's address via `keys.list` — a keyId the vault does not list is refused.
 */
const signAccount = async (
  internals: WalletInternals,
  request: Exclude<ChainSignRequest, { kind: "bitcoin.psbt" }>,
): Promise<ChainAccount | { readonly address: string }> => {
  if (request.account.kind === "hd") {
    return internals.call("wallet.accounts", {
      walletId: request.account.walletId,
      groupIndex: request.account.groupIndex,
      template: request.account.template,
      network: request.network,
    });
  }
  const { keyId } = request.account;
  const keys = await internals.call("keys.list", null);
  const key = keys.find((k) => k.keyId === keyId);
  if (key === undefined) {
    throw integrity("chain.sign answered for a key not in the vault");
  }
  return { address: key.address };
};

const checkEvm = async (
  internals: WalletInternals,
  request: Extract<ChainSignRequest, { kind: `evm.${string}` }>,
  result: ChainSignResult,
): Promise<void> => {
  if (result.kind !== request.kind) {
    throw integrity("result kind does not match the request");
  }
  const account = await signAccount(internals, request);
  if (!("address" in account)) {
    throw integrity("chain account has no address");
  }
  let signer: string;
  try {
    signer = recoverEvmSigner(request, result);
  } catch (error) {
    if (error instanceof ChainError) {
      throw integrity("signed content does not match the request");
    }
    throw error;
  }
  if (signer.toLowerCase() !== account.address.toLowerCase()) {
    throw integrity("signer does not match the account");
  }
};

const checkSolana = async (
  internals: WalletInternals,
  request: Extract<ChainSignRequest, { kind: `solana.${string}` }>,
  result: ChainSignResult,
): Promise<void> => {
  if (result.kind !== request.kind) {
    throw integrity("result kind does not match the request");
  }
  const account = await signAccount(internals, request);
  if (!("address" in account)) {
    throw integrity("chain account has no address");
  }
  if (!verifySolanaSignature(request.message, result.signature, account.address)) {
    throw integrity("signature does not verify for the account");
  }
};

const checkTron = async (
  internals: WalletInternals,
  request: Extract<ChainSignRequest, { kind: `tron.${string}` }>,
  result: ChainSignResult,
): Promise<void> => {
  if (result.kind !== request.kind) {
    throw integrity("result kind does not match the request");
  }
  const account = await signAccount(internals, request);
  if (!("address" in account)) {
    throw integrity("chain account has no address");
  }
  const verified =
    request.kind === "tron.transaction"
      ? verifyTronTransactionSignature(request.rawData, result.signature, account.address)
      : request.kind === "tron.message"
        ? verifyTronMessageSignature(request.message, result.signature, account.address)
        : verifyTronTypedDataSignature(request.typedData, result.signature, account.address);
  if (!verified) {
    throw integrity("signature does not verify for the account");
  }
};

const checkBitcoinMessage = async (
  internals: WalletInternals,
  request: Extract<ChainSignRequest, { kind: "bitcoin.message" }>,
  result: ChainSignResult,
): Promise<void> => {
  if (result.kind !== request.kind) {
    throw integrity("result kind does not match the request");
  }
  const account = await signAccount(internals, request);
  if (!("xpub" in account)) {
    throw integrity("chain account has no xpub");
  }
  const derived = bitcoinAddressFromXpub(
    account.xpub,
    account.template,
    request.network,
    request.change,
    request.index,
  );
  if (
    derived !== request.address ||
    !(request.format === "legacy" ? verifyLegacyBitcoinMessage : verifyBitcoinMessage)(
      request.address,
      request.message,
      result.signature,
      request.network,
    )
  ) {
    throw integrity("message signature does not verify for the account");
  }
};

/**
 * The `chain.sign` result check: a result whose kind is not the request's is refused for every
 * request kind, then the family's check verifies the signature (or signed content) against the
 * account. The switch is exhaustive over the request union; a trailing return is unreachable
 * (TS7027).
 */
export const checkSignResult = async (
  internals: WalletInternals,
  request: ChainSignRequest,
  result: ChainSignResult,
): Promise<void> => {
  switch (request.kind) {
    case "evm.transaction":
    case "evm.personal-message":
    case "evm.fiat24-session":
    case "evm.typed-data":
      return checkEvm(internals, request, result);
    case "solana.transaction":
    case "solana.message":
      return checkSolana(internals, request, result);
    case "tron.transaction":
    case "tron.message":
    case "tron.typed-data":
      return checkTron(internals, request, result);
    case "bitcoin.message":
      return checkBitcoinMessage(internals, request, result);
    case "bitcoin.psbt":
      return checkPsbt(internals, request, result);
  }
};

const HARDENED = 0x80000000;

const sameNode = (a: ChainExportNode, b: ChainExportNode): boolean => {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "leaf" && b.kind === "leaf") {
    return a.template === b.template;
  }
  if (a.kind === "btc.account" && b.kind === "btc.account") {
    return a.template === b.template && a.network === b.network;
  }
  return a.kind === "evm.account";
};

/**
 * The network `wallet.accounts` is asked with for a network-free leaf node — a mainnet per family;
 * the address is network-independent, the id only has to be a valid one.
 */
const LEAF: Readonly<
  Record<
    "evm.bip44" | "tron.bip44" | "solana.bip44-change",
    {
      readonly network: string;
      readonly curve: "secp256k1" | "ed25519";
      readonly path: (groupIndex: number) => string;
      readonly address: (publicKey: Uint8Array) => string;
    }
  >
> = {
  "evm.bip44": {
    network: "eip155:1",
    curve: "secp256k1",
    path: (g) => `m/44'/60'/0'/0/${String(g)}`,
    address: evmAddressFromPublicKey,
  },
  "tron.bip44": {
    network: "tron:728126428",
    curve: "secp256k1",
    path: (g) => `m/44'/195'/0'/0/${String(g)}`,
    address: tronAddressFromPublicKey,
  },
  "solana.bip44-change": {
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    curve: "ed25519",
    path: (g) => `m/44'/501'/${String(g)}'/0'`,
    address: solanaAddressFromPublicKey,
  },
};

/** The 78-byte BIP-32 serialization of an account node's extended public key. */
const xpubPayload = (
  version: number,
  parentFingerprint: number,
  index: number,
  chainCode: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array => {
  const out = new Uint8Array(78);
  const view = new DataView(out.buffer);
  view.setUint32(0, version);
  out[4] = 3;
  view.setUint32(5, parentFingerprint);
  view.setUint32(9, index);
  out.set(chainCode, 13);
  out.set(publicKey, 45);
  return out;
};

type ExportRequest = Pick<ChainExportParams, "walletId" | "groupIndex" | "nodes">;

const checkExportLeaf = async (
  internals: WalletInternals,
  params: ExportRequest,
  node: Extract<ChainExportNode, { kind: "leaf" }>,
  key: ChainExportedKey,
): Promise<void> => {
  const spec = LEAF[node.template];
  if (
    key.curve !== spec.curve ||
    key.chainCode !== undefined ||
    key.parentFingerprint !== undefined ||
    key.path !== spec.path(params.groupIndex)
  ) {
    throw integrity("exported leaf does not match the node");
  }
  const account = await internals.call("wallet.accounts", {
    walletId: params.walletId,
    groupIndex: params.groupIndex,
    template: node.template,
    network: spec.network,
  });
  if (!("address" in account) || spec.address(key.publicKey) !== account.address) {
    throw integrity("exported public key does not match the account");
  }
};

const checkExportBtc = async (
  internals: WalletInternals,
  params: ExportRequest,
  node: Extract<ChainExportNode, { kind: "btc.account" }>,
  key: ChainExportedKey,
  fingerprint: string,
): Promise<void> => {
  const account = await internals.call("wallet.accounts", {
    walletId: params.walletId,
    groupIndex: params.groupIndex,
    template: node.template,
    network: node.network,
  });
  if (!("xpub" in account)) {
    throw integrity("chain account has no xpub");
  }
  const net = bitcoinNetwork(node.network);
  const expected =
    key.curve === "secp256k1" &&
    key.publicKey.length === 33 &&
    key.chainCode !== undefined &&
    key.parentFingerprint !== undefined
      ? xpubPayload(
          net.bip32.public,
          Number.parseInt(key.parentFingerprint, 16),
          params.groupIndex + HARDENED,
          key.chainCode,
          key.publicKey,
        )
      : undefined;
  const decoded = base58.decode(account.xpub);
  if (
    expected === undefined ||
    decoded.length !== 82 ||
    !expected.every((byte, i) => byte === decoded[i]) ||
    key.path !== account.path ||
    fingerprint !== account.fingerprint
  ) {
    throw integrity("exported account key does not match the account xpub");
  }
};

/**
 * The `chain.exportAccount` result check: keys echo the requested nodes in order, leaves hash to
 * the address `wallet.accounts` serves for the template, and the Bitcoin account key re-serializes
 * to the account xpub. `evm.account` carries the shared account node — re-deriving the group's leaf
 * from it needs `@scure/bip32`, which is not a runtime dependency of this package, so the main
 * runtime checks its fixed path, curve and account fields only. A mismatch is `integrity`.
 */
export const checkExportResult = async (
  internals: WalletInternals,
  params: ExportRequest,
  result: ChainExportResult,
): Promise<void> => {
  if (result.keys.length !== params.nodes.length) {
    throw integrity("export result does not match the request");
  }
  for (const [i, node] of params.nodes.entries()) {
    const key = result.keys[i];
    if (key === undefined || !sameNode(key.node, node)) {
      throw integrity("export result does not match the request");
    }
    if (node.kind === "leaf") {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one wallet.accounts call per node.
      await checkExportLeaf(internals, params, node, key);
    } else if (node.kind === "btc.account") {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one wallet.accounts call per node.
      await checkExportBtc(internals, params, node, key, result.fingerprint);
    } else if (
      key.curve !== "secp256k1" ||
      key.publicKey.length !== 33 ||
      key.chainCode === undefined ||
      key.parentFingerprint === undefined ||
      key.path !== "m/44'/60'/0'"
    ) {
      throw integrity("exported account key does not match the node");
    }
  }
};
