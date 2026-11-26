/**
 * The chains module's method table and wire validators. `wallet.accounts` derives the public
 * account for a template at the wallet's group index — the EVM/Solana/TRON arm returns the address;
 * the Bitcoin arm returns the account xpub plus the master fingerprint and account path (both
 * needed to build the PSBT `bip32Derivation` entries later). The protocol is free of
 *
 * @qntx/wallet-chains imports; template names and path shapes are declared here.
 */
import type { VerifyFactor, MethodSpec } from "./core.ts";
import { verifier, groupIndex, walletId } from "./core.ts";
import type { Validator } from "./validate.ts";
import { arr, bool, bytes, int, literal, obj, opt, str, union } from "./validate.ts";

export type ChainTemplate =
  | "evm.bip44"
  | "solana.bip44-change"
  | "tron.bip44"
  | "btc.bip44"
  | "btc.bip49"
  | "btc.bip84"
  | "btc.bip86";

export type ChainAccountsParams = {
  readonly walletId: string;
  readonly groupIndex: number;
  readonly template: ChainTemplate;
  readonly network: string;
};

export type ChainAccount =
  | {
      readonly template: "evm.bip44";
      readonly network: string;
      readonly address: string;
      /** The serving entry passed an on-device check — always true for seed-custody wallets. */
      readonly confirmed: boolean;
    }
  | {
      readonly template: "solana.bip44-change";
      readonly network: string;
      readonly address: string;
      readonly confirmed: boolean;
    }
  | {
      readonly template: "tron.bip44";
      readonly network: string;
      readonly address: string;
      readonly confirmed: boolean;
    }
  | {
      readonly template: "btc.bip44" | "btc.bip49" | "btc.bip84" | "btc.bip86";
      readonly network: string;
      readonly xpub: string;
      /** Master-key fingerprint as 8 lowercase hex chars (PSBT bip32Derivation). */
      readonly fingerprint: string;
      /** Account derivation path, e.g. "m/84'/0'/0'". */
      readonly path: string;
      /** Highest proven change-chain index — the sealed mark the change scan reaches beyond. */
      readonly changeMark: number;
      readonly confirmed: boolean;
    };

export const template: Validator<ChainTemplate> = union(
  literal("evm.bip44"),
  literal("solana.bip44-change"),
  literal("tron.bip44"),
  union(literal("btc.bip44"), literal("btc.bip49"), literal("btc.bip84")),
  literal("btc.bip86"),
);

const btcTemplate = union(
  literal("btc.bip44"),
  literal("btc.bip49"),
  literal("btc.bip84"),
  literal("btc.bip86"),
);

export const caip2: Validator<string> = str(200, /^[a-z0-9-]{3,64}:[0-9a-zA-Z-]{1,128}$/);
const addressResult = (
  t: "evm.bip44" | "solana.bip44-change" | "tron.bip44",
  address: Validator<string> = str(128, /^[0-9a-zA-Z-]{20,128}$/),
): Validator<ChainAccount> =>
  obj({ template: literal(t), network: caip2, address, confirmed: bool });

export type AccountRef =
  | {
      readonly kind: "hd";
      readonly walletId: string;
      readonly groupIndex: number;
      readonly template: ChainTemplate;
    }
  | {
      readonly kind: "imported";
      readonly keyId: string;
      readonly family: "evm" | "solana" | "bitcoin" | "tron";
    };

export type EvmAccessListEntryWire = {
  readonly address: string;
  readonly storageKeys: ReadonlyArray<string>;
};

type EvmTransactionBase = {
  readonly chainId: number;
  readonly nonce: number;
  readonly gas: string;
  readonly value: string;
  readonly data: string;
  readonly to?: string;
};

export type EvmTransactionWire =
  | (EvmTransactionBase & { readonly type: "legacy"; readonly gasPrice: string })
  | (EvmTransactionBase & {
      readonly type: "eip2930";
      readonly gasPrice: string;
      readonly accessList: ReadonlyArray<EvmAccessListEntryWire>;
    })
  | (EvmTransactionBase & {
      readonly type: "eip1559";
      readonly maxFeePerGas: string;
      readonly maxPriorityFeePerGas: string;
      readonly accessList: ReadonlyArray<EvmAccessListEntryWire>;
    })
  | (EvmTransactionBase & {
      readonly type: "eip7702";
      readonly to: string;
      readonly maxFeePerGas: string;
      readonly maxPriorityFeePerGas: string;
      readonly accessList: ReadonlyArray<EvmAccessListEntryWire>;
      readonly authorization: { readonly address: string };
    });

/** `chain.sign`'s request — the wire mirror of @qntx/wallet-chains `SignRequest`. */
export type ChainSignRequest =
  | {
      readonly kind: "evm.transaction";
      readonly network: string;
      readonly account: AccountRef;
      readonly tx: EvmTransactionWire;
    }
  | {
      readonly kind: "evm.personal-message";
      readonly network: string;
      readonly account: AccountRef;
      readonly message: Uint8Array;
    }
  | {
      readonly kind: "evm.fiat24-session";
      readonly network: string;
      readonly account: AccountRef;
      /** The Fiat24 account token's decimal id. */
      readonly tokenId: string;
      /** Session expiry, Unix seconds. */
      readonly deadline: number;
    }
  | {
      readonly kind: "evm.typed-data";
      readonly network: string;
      readonly account: AccountRef;
      readonly typedData: string;
    }
  | {
      readonly kind: "solana.transaction";
      readonly network: string;
      readonly account: AccountRef;
      readonly message: Uint8Array;
      readonly lookupTables?: ReadonlyArray<{
        readonly address: string;
        readonly addresses: ReadonlyArray<string>;
      }>;
    }
  | {
      readonly kind: "solana.message";
      readonly network: string;
      readonly account: AccountRef;
      readonly message: Uint8Array;
      readonly format: "raw";
    }
  | {
      readonly kind: "bitcoin.psbt";
      readonly network: string;
      /** The wallet group whose keys sign; each signed input names its template. */
      readonly account: {
        readonly kind: "hd";
        readonly walletId: string;
        readonly groupIndex: number;
      };
      /** Who built this request — only "internal" requests may raise the change mark. */
      readonly origin: "internal" | "external";
      readonly psbt: Uint8Array;
      readonly sign: ReadonlyArray<{
        readonly index: number;
        readonly template: "btc.bip44" | "btc.bip49" | "btc.bip84" | "btc.bip86";
      }>;
    }
  | {
      readonly kind: "bitcoin.message";
      readonly network: string;
      readonly account: AccountRef;
      readonly address: string;
      readonly message: string;
      readonly format: "bip322-simple" | "legacy";
      readonly change: 0 | 1;
      readonly index: number;
    }
  | {
      readonly kind: "tron.transaction";
      readonly network: string;
      readonly account: AccountRef;
      readonly rawData: Uint8Array;
    }
  | {
      readonly kind: "tron.message";
      readonly network: string;
      readonly account: AccountRef;
      readonly message: Uint8Array;
    }
  | {
      readonly kind: "tron.typed-data";
      readonly network: string;
      readonly account: AccountRef;
      /** The canonical TIP-712 document, as JSON text. */
      readonly typedData: string;
    };

export type ChainSignResult =
  | { readonly kind: "evm.transaction"; readonly signedTransaction: Uint8Array }
  | {
      readonly kind: "evm.personal-message" | "evm.fiat24-session" | "evm.typed-data";
      readonly signature: Uint8Array;
    }
  | { readonly kind: "solana.transaction" | "solana.message"; readonly signature: Uint8Array }
  | { readonly kind: "bitcoin.psbt"; readonly signedPsbt: Uint8Array }
  | { readonly kind: "bitcoin.message"; readonly signature: string }
  | {
      readonly kind: "tron.transaction" | "tron.message" | "tron.typed-data";
      readonly signature: Uint8Array;
    };

export type ChainSignParams = {
  readonly request: ChainSignRequest;
  readonly verify: VerifyFactor;
};

const accountRef: Validator<AccountRef> = union(
  obj({ kind: literal("hd"), walletId, groupIndex, template }),
  obj({
    kind: literal("imported"),
    keyId: str(64, /^[0-9a-f]{8,64}$/),
    family: union(literal("evm"), literal("solana"), literal("bitcoin"), literal("tron")),
  }),
);

const hexQuantity = str(66, /^0x[0-9a-fA-F]+$/);
const hexData = str(40000, /^0x[0-9a-fA-F]*$/);
const evmAddress = str(42, /^0x[0-9a-fA-F]{40}$/);
const solanaAddress = str(44, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const bitcoinAddress = str(90, /^(bc1|tb1|bcrt1|[13mn2])[a-zA-Z0-9]{4,87}$/);
const safeInt = int(0, 9007199254740991);
const accessList = arr(
  obj({ address: evmAddress, storageKeys: arr(str(66, /^0x[0-9a-fA-F]{64}$/), 256) }),
  256,
);
const txBase = {
  chainId: safeInt,
  nonce: safeInt,
  gas: hexQuantity,
  value: hexQuantity,
  data: hexData,
  to: opt(evmAddress),
};
const evmTx: Validator<EvmTransactionWire> = union(
  obj({ ...txBase, type: literal("legacy"), gasPrice: hexQuantity }),
  obj({ ...txBase, type: literal("eip2930"), gasPrice: hexQuantity, accessList }),
  obj({
    ...txBase,
    type: literal("eip1559"),
    maxFeePerGas: hexQuantity,
    maxPriorityFeePerGas: hexQuantity,
    accessList,
  }),
  obj({
    ...txBase,
    type: literal("eip7702"),
    to: evmAddress,
    maxFeePerGas: hexQuantity,
    maxPriorityFeePerGas: hexQuantity,
    accessList,
    authorization: obj({ address: evmAddress }),
  }),
);

export const signRequest: Validator<ChainSignRequest> = union(
  obj({ kind: literal("evm.transaction"), network: caip2, account: accountRef, tx: evmTx }),
  obj({
    kind: literal("evm.personal-message"),
    network: caip2,
    account: accountRef,
    message: bytes(0, 65536),
  }),
  obj({
    kind: literal("evm.fiat24-session"),
    network: caip2,
    account: accountRef,
    tokenId: str(78, /^[1-9][0-9]{0,77}$/),
    deadline: int(1, 9007199254740991),
  }),
  obj({
    kind: literal("evm.typed-data"),
    network: caip2,
    account: accountRef,
    typedData: str(1048576),
  }),
  obj({
    kind: literal("solana.transaction"),
    network: caip2,
    account: accountRef,
    message: bytes(1, 4096),
    lookupTables: opt(arr(obj({ address: solanaAddress, addresses: arr(solanaAddress, 256) }), 64)),
  }),
  obj({
    kind: literal("solana.message"),
    network: caip2,
    account: accountRef,
    message: bytes(1, 65536),
    format: literal("raw"),
  }),
  obj({
    kind: literal("bitcoin.psbt"),
    network: caip2,
    account: obj({ kind: literal("hd"), walletId, groupIndex }),
    origin: union(literal("internal"), literal("external")),
    psbt: bytes(1, 131072),
    sign: arr(obj({ index: int(0, 1024), template: btcTemplate }), 1024),
  }),
  obj({
    kind: literal("bitcoin.message"),
    network: caip2,
    account: accountRef,
    address: bitcoinAddress,
    message: str(1048576),
    format: union(literal("bip322-simple"), literal("legacy")),
    change: union(literal(0), literal(1)),
    index: int(0, 2147483647),
  }),
  obj({
    kind: literal("tron.transaction"),
    network: caip2,
    account: accountRef,
    // java-tron TRANSACTION_MAX_BYTE_SIZE is 500 KiB.
    rawData: bytes(1, 512000),
  }),
  obj({
    kind: literal("tron.message"),
    network: caip2,
    account: accountRef,
    message: bytes(1, 65536),
  }),
  obj({
    kind: literal("tron.typed-data"),
    network: caip2,
    account: accountRef,
    typedData: str(1048576),
  }),
);

export const signResult: Validator<ChainSignResult> = union(
  obj({ kind: literal("evm.transaction"), signedTransaction: bytes(1, 65536) }),
  obj({
    kind: union(
      literal("evm.personal-message"),
      literal("evm.fiat24-session"),
      literal("evm.typed-data"),
    ),
    signature: bytes(65, 65),
  }),
  obj({
    kind: union(literal("solana.transaction"), literal("solana.message")),
    signature: bytes(64, 64),
  }),
  obj({ kind: literal("bitcoin.psbt"), signedPsbt: bytes(1, 131072) }),
  obj({ kind: literal("bitcoin.message"), signature: str(512) }),
  obj({
    kind: union(literal("tron.transaction"), literal("tron.message"), literal("tron.typed-data")),
    signature: bytes(65, 65),
  }),
);

export const chainAccount: Validator<ChainAccount> = union(
  addressResult("evm.bip44"),
  addressResult("solana.bip44-change"),
  addressResult("tron.bip44", str(34, /^T[1-9A-HJ-NP-Za-km-z]{33}$/)),
  obj({
    template: union(
      literal("btc.bip44"),
      literal("btc.bip49"),
      literal("btc.bip84"),
      literal("btc.bip86"),
    ),
    network: caip2,
    xpub: str(111, /^[a-zA-Z0-9]{111}$/),
    fingerprint: str(8, /^[0-9a-f]{8}$/),
    path: str(11, /^m\/[0-9'/]+$/),
    confirmed: bool,
    changeMark: int(0, 2147483647),
  }),
);

/**
 * A node `chain.exportAccount` can serve: the EVM account xpub (`m/44'/60'/0'`, MetaMask's
 * crypto-hdkey), a group's signing leaf, or a Bitcoin account xpub (`m/p'/coin'/group'`).
 */
export type ChainExportNode =
  | { readonly kind: "evm.account" }
  | {
      readonly kind: "leaf";
      readonly template: "evm.bip44" | "tron.bip44" | "solana.bip44-change";
    }
  | {
      readonly kind: "btc.account";
      readonly template: "btc.bip44" | "btc.bip49" | "btc.bip84" | "btc.bip86";
      readonly network: string;
    };

export type ChainExportParams = {
  readonly walletId: string;
  readonly groupIndex: number;
  readonly nodes: ReadonlyArray<ChainExportNode>;
  readonly verify: VerifyFactor;
  /**
   * Acknowledge exporting nodes a device never confirmed on-screen — the prompt shows one danger
   * row per unconfirmed node. Absent, an unconfirmed node refuses with `approval-required`.
   */
  readonly acknowledgeUnconfirmed?: true;
};

export type ChainExportedKey = {
  readonly node: ChainExportNode;
  readonly path: string;
  readonly curve: "secp256k1" | "ed25519";
  readonly publicKey: Uint8Array;
  /** 32 bytes — present iff the node is an account (evm.account / btc.account). */
  readonly chainCode?: Uint8Array;
  /** 8 lowercase hex chars — present iff `chainCode` is. */
  readonly parentFingerprint?: string;
};

export type ChainExportResult = {
  /** Master-key fingerprint as 8 lowercase hex chars. */
  readonly fingerprint: string;
  /** One key per requested node, in the same order. */
  readonly keys: ReadonlyArray<ChainExportedKey>;
};

export const exportNode: Validator<ChainExportNode> = union(
  obj({ kind: literal("evm.account") }),
  obj({
    kind: literal("leaf"),
    template: union(literal("evm.bip44"), literal("tron.bip44"), literal("solana.bip44-change")),
  }),
  obj({ kind: literal("btc.account"), template: btcTemplate, network: caip2 }),
);

const fingerprint = str(8, /^[0-9a-f]{8}$/);

const exportedKey: Validator<ChainExportedKey> = obj({
  node: exportNode,
  path: str(32, /^m\/[0-9'/]+$/),
  curve: union(literal("secp256k1"), literal("ed25519")),
  publicKey: union(bytes(33), bytes(32)),
  chainCode: opt(bytes(32)),
  parentFingerprint: opt(fingerprint),
});

export const CHAINS_METHODS: {
  readonly "wallet.accounts": MethodSpec<ChainAccountsParams, ChainAccount>;
  readonly "chain.sign": MethodSpec<ChainSignParams, ChainSignResult>;
  readonly "chain.exportAccount": MethodSpec<ChainExportParams, ChainExportResult>;
} = {
  "wallet.accounts": {
    session: true,
    presence: false,
    params: obj({ walletId, groupIndex, template, network: caip2 }),
    result: chainAccount,
  },
  "chain.sign": {
    session: true,
    presence: true,
    params: obj({
      request: signRequest,
      verify: verifier,
    }),
    result: signResult,
  },
  "chain.exportAccount": {
    session: true,
    presence: true,
    params: obj({
      walletId,
      groupIndex,
      nodes: arr(exportNode, 4, 1),
      verify: verifier,
      acknowledgeUnconfirmed: opt(literal(true)),
    }),
    result: obj({ fingerprint, keys: arr(exportedKey, 4, 1) }),
  },
};
