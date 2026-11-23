/**
 * `qrExport` — the public material `chain.exportAccount` produced, encoded as the account UR a
 * watch-only wallet reads: `crypto-hdkey` for an EVM account node (MetaMask/Rabby),
 * `crypto-account` for a Bitcoin account descriptor (BlueWallet/Sparrow) and
 * `crypto-multi-accounts` for the Web wallet's per-leaf form. Only public fields are written;
 * `device`/`name`, where a reader expects one, is the constant `"qntx"`.
 */
import { cryptoMultiAccountsCodec } from "@qntx/ur/interop";
import type { DerivedHdKey, Keypath, MultiAccounts, MultiAccountsKey } from "@qntx/ur/interop";
import { CoinType, Network, cryptoAccountCodec, cryptoHdKeyCodec } from "@qntx/ur/registry";
import type { AccountDescriptor } from "@qntx/ur/registry";
import { toUr } from "@qntx/ur/typed";
import { bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import type { QrPayload } from "@qntx/wallet/hardware";
import type { ChainExportedKey, ChainExportResult } from "@qntx/wallet/protocol";

import { QrError, qrGuard } from "./errors.ts";

export type QrExportForm = "crypto-hdkey" | "crypto-account" | "crypto-multi-accounts";

export type QrExport = {
  readonly payload: QrPayload;
  readonly discloses: "evm-all-addresses" | "account-addresses" | "single-addresses";
};

function mismatch(detail: string): never {
  throw new QrError("result-mismatch", detail);
}

function unsupported(detail: string): never {
  throw new QrError("unsupported", detail);
}

const HARDENED = 0x80000000;

/** `"m/44'/60'/0'"` → the registry `Keypath`; a non-`m/` path or `*` step cannot appear here. */
const keypath = (path: string, sourceFingerprint: number): Keypath => {
  if (!path.startsWith("m/")) {
    mismatch("export path must start at the master");
  }
  const components = path
    .slice(2)
    .split("/")
    .map((step) => {
      const hardened = step.endsWith("'");
      const index = Number(hardened ? step.slice(0, -1) : step);
      if (!Number.isSafeInteger(index) || index < 0 || index >= HARDENED) {
        mismatch(`bad path step ${step}`);
      }
      return { kind: "index" as const, index, hardened };
    });
  return { components, sourceFingerprint, depth: components.length };
};

const fingerprint = (hex: string): number => {
  if (!/^[0-9a-f]{8}$/.test(hex)) {
    mismatch("fingerprint must be 8 lowercase hex digits");
  }
  return Number.parseInt(hex, 16);
};

const accountFields = (key: ChainExportedKey): { chainCode: Uint8Array; parent: number } => {
  const { chainCode, parentFingerprint } = key;
  if (chainCode === undefined || parentFingerprint === undefined) {
    mismatch("an account node carries a chain code and parent fingerprint");
  }
  if (key.publicKey.length !== 33 || chainCode.length !== 32) {
    mismatch("bad account node key lengths");
  }
  return { chainCode, parent: fingerprint(parentFingerprint) };
};

const single = (
  result: ChainExportResult,
  kind: ChainExportedKey["node"]["kind"],
  form: string,
): ChainExportedKey => {
  const [key] = result.keys;
  if (result.keys.length !== 1 || key === undefined || key.node.kind !== kind) {
    unsupported(`${form} exports exactly one ${kind} key`);
  }
  return key;
};

const hdkeyExport = (result: ChainExportResult): QrExport => {
  const key = single(result, "evm.account", "crypto-hdkey");
  const { chainCode, parent } = accountFields(key);
  const mfp = fingerprint(result.fingerprint);
  const hd: DerivedHdKey = {
    kind: "derived",
    isPrivate: false,
    keyData: key.publicKey,
    chainCode,
    origin: keypath(key.path, mfp),
    children: {
      components: [
        { kind: "index" as const, index: 0, hardened: false },
        { kind: "wildcard" as const, hardened: false },
      ],
    },
    parentFingerprint: parent,
    name: "qntx",
    note: "account.standard",
  };
  return {
    payload: qrGuard("result-mismatch", () => ({
      type: "crypto-hdkey",
      cbor: toUr(hd, cryptoHdKeyCodec).toCborData(),
    })),
    discloses: "evm-all-addresses",
  };
};

const DESCRIPTOR: Readonly<Record<string, string>> = {
  "btc.bip44": "pkh(@0)",
  "btc.bip49": "sh(wpkh(@0))",
  "btc.bip84": "wpkh(@0)",
  "btc.bip86": "tr(@0)",
};

const accountExport = (result: ChainExportResult): QrExport => {
  const key = single(result, "btc.account", "crypto-account");
  if (key.node.kind !== "btc.account") {
    unsupported("crypto-account exports a btc.account key");
  }
  const source = DESCRIPTOR[key.node.template];
  if (source === undefined) {
    unsupported(`account template ${key.node.template}`);
  }
  const { chainCode, parent } = accountFields(key);
  const mfp = fingerprint(result.fingerprint);
  const { network } = key.node;
  const net = qrGuard("result-mismatch", () => bitcoinNetwork(network));
  const account: AccountDescriptor = {
    masterFingerprint: mfp,
    outputDescriptors: [
      {
        source,
        keys: [
          {
            kind: "hdkey",
            key: {
              kind: "derived",
              isPrivate: false,
              keyData: key.publicKey,
              chainCode,
              useInfo: {
                type: CoinType.btc,
                network: net.coinType === 0 ? Network.mainnet : Network.btcTestnet,
              },
              origin: keypath(key.path, mfp),
              parentFingerprint: parent,
            },
          },
        ],
      },
    ],
  };
  return {
    payload: qrGuard("result-mismatch", () => ({
      type: "crypto-account",
      cbor: toUr(account, cryptoAccountCodec).toCborData(),
    })),
    discloses: "account-addresses",
  };
};

const multiKey = (key: ChainExportedKey, mfp: number): MultiAccountsKey => {
  if (key.node.kind === "evm.account") {
    unsupported("evm.account belongs in crypto-hdkey, not crypto-multi-accounts");
  }
  if (key.node.kind === "leaf") {
    if (key.node.template === "solana.bip44-change") {
      if (key.curve !== "ed25519" || key.publicKey.length !== 32) {
        mismatch("solana leaf must be a 32-byte ed25519 key");
      }
      return {
        curve: "ed25519",
        key: { keyData: key.publicKey, origin: keypath(key.path, mfp) },
      };
    }
    if (key.curve !== "secp256k1" || key.publicKey.length !== 33) {
      mismatch("a leaf must be a 33-byte secp256k1 key");
    }
    return {
      curve: "secp256k1",
      key: {
        kind: "derived",
        isPrivate: false,
        keyData: key.publicKey,
        origin: keypath(key.path, mfp),
      },
    };
  }
  if (key.node.kind === "btc.account") {
    const { chainCode, parent } = accountFields(key);
    return {
      curve: "secp256k1",
      key: {
        kind: "derived",
        isPrivate: false,
        keyData: key.publicKey,
        chainCode,
        origin: keypath(key.path, mfp),
        parentFingerprint: parent,
      },
    };
  }
  return unsupported("export node is not encodable as crypto-multi-accounts");
};

const multiExport = (result: ChainExportResult): QrExport => {
  if (result.keys.length === 0) {
    unsupported("crypto-multi-accounts exports at least one key");
  }
  const mfp = fingerprint(result.fingerprint);
  const accounts: MultiAccounts = {
    masterFingerprint: mfp,
    keys: result.keys.map((key) => multiKey(key, mfp)),
    device: "qntx",
  };
  return {
    payload: qrGuard("result-mismatch", () => ({
      type: "crypto-multi-accounts",
      cbor: toUr(accounts, cryptoMultiAccountsCodec).toCborData(),
    })),
    discloses: result.keys.some((key) => key.node.kind === "btc.account")
      ? "account-addresses"
      : "single-addresses",
  };
};

// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch, no fall-off
export const qrExport = (result: ChainExportResult, form: QrExportForm): QrExport => {
  switch (form) {
    case "crypto-hdkey":
      return hdkeyExport(result);
    case "crypto-account":
      return accountExport(result);
    case "crypto-multi-accounts":
      return multiExport(result);
  }
};
