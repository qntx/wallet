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
import {
  verifyTronMessageSignature,
  verifyTronTransactionSignature,
  verifyTronTypedDataSignature,
} from "@qntx/wallet-chains/tron";

import { integrity } from "../channel.ts";
import { internalsOf } from "../internal.ts";
import type { WalletInternals } from "../internal.ts";
import type {
  ChainAccount,
  ChainAccountsParams,
  ChainSignRequest,
  ChainSignResult,
} from "../protocol/chains.ts";
import type { VerifyFactor, Wallet } from "../types.ts";

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
    readonly verify: VerifyFactor;
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
const checkResult = async (
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

function createChainsApi(internals: WalletInternals): ChainsApi {
  return {
    account: async (params) => internals.call("wallet.accounts", params),
    sign: async (params) =>
      internals.withVerifying(async () => {
        const result = await internals.secretCall("chain.sign", async (wire) => ({
          request: params.request,
          verify: await internals.resolveVerifyFactor(params.verify, wire),
        }));
        await checkResult(internals, params.request, result);
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
