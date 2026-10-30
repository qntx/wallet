/**
 * The chains module's method table and wire validators. `wallet.accounts` derives the public
 * account for a template at the wallet's group index — the EVM/Solana arm returns the address; the
 * Bitcoin arm returns the account-level extended public key plus the master fingerprint and account
 * path (both needed to build the PSBT `bip32Derivation` entries later). The protocol is free of
 *
 * @qntx/wallet-chains imports; template names and path shapes are declared here.
 */
import type { Factor } from "./core.ts";
import { factor, groupIndex, walletId } from "./core.ts";
import type { MethodSpec } from "./index.ts";
import type { Validator } from "./validate.ts";
import { arr, bytes, int, literal, obj, opt, str, union } from "./validate.ts";

export type ChainTemplate = "evm.bip44" | "solana.bip44-change" | "btc.bip84" | "btc.bip86";

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
    }
  | {
      readonly template: "solana.bip44-change";
      readonly network: string;
      readonly address: string;
    }
  | {
      readonly template: "btc.bip84" | "btc.bip86";
      readonly network: string;
      readonly xpub: string;
      /** Master-key fingerprint as 8 lowercase hex chars (PSBT bip32Derivation). */
      readonly fingerprint: string;
      /** Account derivation path, e.g. "m/84'/0'/0'". */
      readonly path: string;
    };

const template: Validator<ChainTemplate> = union(
  literal("evm.bip44"),
  literal("solana.bip44-change"),
  literal("btc.bip84"),
  literal("btc.bip86"),
);

const caip2: Validator<string> = str(200, /^[a-z0-9-]{3,64}:[0-9a-zA-Z-]{1,128}$/);
const addressResult = (t: "evm.bip44" | "solana.bip44-change"): Validator<ChainAccount> =>
  obj({
    template: literal(t),
    network: caip2,
    address: str(128, /^[0-9a-zA-Z-]{20,128}$/),
  });

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
      readonly family: "evm" | "solana" | "bitcoin";
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
      readonly account: AccountRef;
      readonly psbt: Uint8Array;
      readonly sign: ReadonlyArray<number>;
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
    };

export type ChainSignResult =
  | { readonly kind: "evm.transaction"; readonly signedTransaction: Uint8Array }
  | { readonly kind: "evm.personal-message" | "evm.typed-data"; readonly signature: Uint8Array }
  | { readonly kind: "solana.transaction" | "solana.message"; readonly signature: Uint8Array }
  | { readonly kind: "bitcoin.psbt"; readonly signedPsbt: Uint8Array }
  | { readonly kind: "bitcoin.message"; readonly signature: string };

export type ChainSignParams = { readonly request: ChainSignRequest; readonly verify: Factor };

const accountRef: Validator<AccountRef> = union(
  obj({ kind: literal("hd"), walletId, groupIndex, template }),
  obj({
    kind: literal("imported"),
    keyId: str(64, /^[0-9a-f]{8,64}$/),
    family: union(literal("evm"), literal("solana"), literal("bitcoin")),
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
);

const signRequest: Validator<ChainSignRequest> = union(
  obj({ kind: literal("evm.transaction"), network: caip2, account: accountRef, tx: evmTx }),
  obj({
    kind: literal("evm.personal-message"),
    network: caip2,
    account: accountRef,
    message: bytes(0, 65536),
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
    message: bytes(1, 1232),
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
    account: accountRef,
    psbt: bytes(1, 131072),
    sign: arr(int(0, 1024), 1024),
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
);

const signResult: Validator<ChainSignResult> = union(
  obj({ kind: literal("evm.transaction"), signedTransaction: bytes(1, 65536) }),
  obj({
    kind: union(literal("evm.personal-message"), literal("evm.typed-data")),
    signature: bytes(65, 65),
  }),
  obj({
    kind: union(literal("solana.transaction"), literal("solana.message")),
    signature: bytes(64, 64),
  }),
  obj({ kind: literal("bitcoin.psbt"), signedPsbt: bytes(1, 131072) }),
  obj({ kind: literal("bitcoin.message"), signature: str(512) }),
);

export const CHAINS_METHODS: {
  readonly "wallet.accounts": MethodSpec<ChainAccountsParams, ChainAccount>;
  readonly "chain.sign": MethodSpec<ChainSignParams, ChainSignResult>;
} = {
  "wallet.accounts": {
    session: true,
    presence: false,
    params: obj({ walletId, groupIndex, template, network: caip2 }),
    result: union(
      addressResult("evm.bip44"),
      addressResult("solana.bip44-change"),
      obj({
        template: union(literal("btc.bip84"), literal("btc.bip86")),
        network: caip2,
        xpub: str(111, /^[a-zA-Z0-9]{111}$/),
        fingerprint: str(8, /^[0-9a-f]{8}$/),
        path: str(11, /^m\/[0-9'/]+$/),
      }),
    ),
  },
  "chain.sign": {
    session: true,
    presence: true,
    params: obj({ request: signRequest, verify: factor }),
    result: signResult,
  },
};
