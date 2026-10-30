/**
 * The chains module of @qntx/wallet: `chains(wallet)` returns the wallet's chain API. `account`
 * calls the kernel's `wallet.accounts`; `sign` calls `chain.sign` and then verifies the returned
 * signature against the account address — a kernel that answers with someone else's signature fails
 * closed with `integrity`.
 */
import {
  bitcoinAddressFromXpub,
  verifyBitcoinMessage,
  verifyBitcoinPsbtSignatures,
} from "@qntx/wallet-chains/bitcoin";
import { recoverEvmSigner } from "@qntx/wallet-chains/evm";
import { verifySolanaSignature } from "@qntx/wallet-chains/solana";

import { integrity } from "../channel.ts";
import { internalsOf } from "../internal.ts";
import type { WalletInternals } from "../internal.ts";
import type {
  ChainAccount,
  ChainAccountsParams,
  ChainSignRequest,
  ChainSignResult,
} from "../protocol/chains.ts";
import type { UnlockFactor, Wallet } from "../types.ts";

export type {
  ChainAccount,
  ChainAccountsParams,
  ChainSignRequest,
  ChainSignResult,
  ChainTemplate,
} from "../protocol/chains.ts";

export type ChainsApi = {
  readonly account: (params: ChainAccountsParams) => Promise<ChainAccount>;
  readonly sign: (params: {
    readonly request: ChainSignRequest;
    readonly verify: UnlockFactor;
  }) => Promise<ChainSignResult>;
};

/** Whether the kernel's signature belongs to the account it was asked to sign for. */
const checkSigner = (request: ChainSignRequest, result: ChainSignResult, account: ChainAccount) => {
  if (request.kind === "bitcoin.psbt" || request.kind === "bitcoin.message") {
    if (!("xpub" in account)) {
      throw integrity("chain account has no xpub");
    }
    if (request.kind === "bitcoin.psbt" && result.kind === "bitcoin.psbt") {
      if (
        !verifyBitcoinPsbtSignatures(
          result.signedPsbt,
          request.sign,
          account.xpub,
          account.template,
          request.network,
        )
      ) {
        throw integrity("psbt signatures do not verify for the account");
      }
      return;
    }
    if (request.kind === "bitcoin.message" && result.kind === "bitcoin.message") {
      const derived = bitcoinAddressFromXpub(
        account.xpub,
        account.template,
        request.network,
        request.change,
        request.index,
      );
      if (
        derived !== request.address ||
        !verifyBitcoinMessage(request.address, request.message, result.signature, request.network)
      ) {
        throw integrity("message signature does not verify for the account");
      }
      return;
    }
    throw integrity("result kind does not match the request");
  }
  if (!("address" in account)) {
    throw integrity("chain account has no address");
  }
  if (request.kind.startsWith("evm.")) {
    if (
      result.kind !== "evm.transaction" &&
      result.kind !== "evm.personal-message" &&
      result.kind !== "evm.typed-data"
    ) {
      throw integrity("result kind does not match the request");
    }
    const signer = recoverEvmSigner(request, result);
    if (signer.toLowerCase() !== account.address.toLowerCase()) {
      throw integrity("signer does not match the account");
    }
    return;
  }
  if (
    (request.kind === "solana.transaction" || request.kind === "solana.message") &&
    (result.kind === "solana.transaction" || result.kind === "solana.message") &&
    !verifySolanaSignature(request.message, result.signature, account.address)
  ) {
    throw integrity("signature does not verify for the account");
  }
};

function createChainsApi(internals: WalletInternals): ChainsApi {
  return {
    account: async (params) => internals.call("wallet.accounts", params),
    sign: async (params) =>
      internals.withVerifying(async () => {
        const transfer: ArrayBuffer[] = [];
        const verify = await internals.resolveFactor(params.verify, transfer);
        const result = await internals.call("chain.sign", { request: params.request, verify });
        if (params.request.account.kind === "hd") {
          const account = await internals.call("wallet.accounts", {
            walletId: params.request.account.walletId,
            groupIndex: params.request.account.groupIndex,
            template: params.request.account.template,
            network: params.request.network,
          });
          checkSigner(params.request, result, account);
        }
        return result;
      }),
  };
}

const apis = new WeakMap<Wallet, ChainsApi>();

export function chains(wallet: Wallet): ChainsApi {
  const internals = internalsOf(wallet);
  let api = apis.get(wallet);
  if (api === undefined) {
    api = createChainsApi(internals);
    apis.set(wallet, api);
  }
  return api;
}
