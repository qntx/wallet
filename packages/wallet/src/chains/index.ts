/**
 * The chains module of @qntx/wallet: `chains(wallet)` returns the wallet's chain API. `account`
 * calls the kernel's `wallet.accounts`; `sign` calls `chain.sign` and then verifies the returned
 * signature against the request and the account address — a kernel that answers with someone else's
 * signature, or a signature over other content, fails closed with `integrity`.
 */
import { ChainError } from "@qntx/wallet-chains";
import {
  bitcoinAddressFromXpub,
  samePsbtContent,
  verifyBitcoinMessage,
  verifyLegacyBitcoinMessage,
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

/**
 * The PSBT check: each sign entry names its template, so the account is fetched once per distinct
 * template and each group's signatures verify against that template's xpub.
 */
const checkPsbt = async (
  internals: WalletInternals,
  request: Extract<ChainSignRequest, { kind: "bitcoin.psbt" }>,
  result: ChainSignResult,
): Promise<void> => {
  if (result.kind !== "bitcoin.psbt") {
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

/** Whether the kernel's signature belongs to the account it was asked to sign for. */
const checkSigner = (
  request: ChainSignRequest,
  result: ChainSignResult,
  account: ChainAccount | { readonly address: string },
) => {
  if (request.kind === "bitcoin.message") {
    if (!("xpub" in account)) {
      throw integrity("chain account has no xpub");
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
        !(request.format === "legacy" ? verifyLegacyBitcoinMessage : verifyBitcoinMessage)(
          request.address,
          request.message,
          result.signature,
          request.network,
        )
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
        if (params.request.kind === "bitcoin.psbt") {
          await checkPsbt(internals, params.request, result);
        } else if (params.request.account.kind === "hd") {
          const account = await internals.call("wallet.accounts", {
            walletId: params.request.account.walletId,
            groupIndex: params.request.account.groupIndex,
            template: params.request.account.template,
            network: params.request.network,
          });
          checkSigner(params.request, result, account);
        } else {
          const { keyId } = params.request.account;
          const keys = await internals.call("keys.list", null);
          const key = keys.find((k) => k.keyId === keyId);
          if (key === undefined) {
            throw integrity("chain.sign answered for a key not in the vault");
          }
          checkSigner(params.request, result, { address: key.address });
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
