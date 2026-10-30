/**
 * The chains module's method table and wire validators. `wallet.accounts` derives the public
 * account for a template at the wallet's group index — the EVM/Solana arm returns the address; the
 * Bitcoin arm returns the account-level extended public key plus the master fingerprint and account
 * path (both needed to build the PSBT `bip32Derivation` entries later). The protocol is free of
 *
 * @qntx/wallet-chains imports; template names and path shapes are declared here.
 */
import { groupIndex, walletId } from "./core.ts";
import type { MethodSpec } from "./index.ts";
import type { Validator } from "./validate.ts";
import { literal, obj, str, union } from "./validate.ts";

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

const caip2: Validator<string> = str(8, /^[a-z0-9-]{3,64}:[0-9a-zA-Z-]{1,128}$/);
const addressResult = (t: "evm.bip44" | "solana.bip44-change"): Validator<ChainAccount> =>
  obj({
    template: literal(t),
    network: caip2,
    address: str(1, /^[0-9a-zA-Z-]{20,128}$/),
  });

export const CHAINS_METHODS: {
  readonly "wallet.accounts": MethodSpec<ChainAccountsParams, ChainAccount>;
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
};
