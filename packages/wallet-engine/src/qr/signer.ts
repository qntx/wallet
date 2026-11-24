/**
 * `qrSigner` — the QR signing facade. `prepare` binds a decoded `QrRequest` to the selected
 * account's authenticated facts and hands it to the request pipeline as one more request origin;
 * `respond` awaits the pipeline's outcome and encodes the counterpart's answer UR; `exportAccount`
 * encodes the wallet's public account material for a watch-only wallet to show. Nothing here holds
 * secrets — the kernel remains the final authority over every signature.
 */
import type { VerifyFactor, Wallet } from "@qntx/wallet";
import { parseCompiledMessage } from "@qntx/wallet-chains/solana";
import type { ChainsApi } from "@qntx/wallet/chains";
import type { QrPayload } from "@qntx/wallet/hardware";
import type { ChainAccount, ChainExportNode, ChainSignResult } from "@qntx/wallet/protocol";

import type { NetworkController } from "../networks/controller.ts";
import type { PendingRequest, RequestController, RequestResult } from "../requests/controller.ts";
import { SolanaClusterBindingError, TronBindingError } from "../transactions/binding.ts";
import { bindQrRequest } from "./bind.ts";
import type { QrAccountFacts } from "./bind.ts";
import { QrError, qrGuard } from "./errors.ts";
import { qrExport } from "./export.ts";
import type { QrExport } from "./export.ts";
import { BITCOIN_MAINNET } from "./link.ts";
import type { QrRequest } from "./request.ts";
import { qrResponse } from "./response.ts";
import type { QrSigner } from "./response.ts";

/** The account a QR request is bound to: a wallet group the request must have been built for. */
export type QrAccount = { readonly walletId: string; readonly groupIndex: number };

const isBindingRefusal = (error: unknown): boolean =>
  error instanceof SolanaClusterBindingError || error instanceof TronBindingError;

/**
 * The slice of the engine a QR signer drives: the request pipeline every origin feeds and the
 * enabled networks a request may be bound to. A `WalletEngine` satisfies it structurally.
 */
export type QrEngineSurface = {
  readonly requests: Pick<RequestController, "prepare" | "outcome">;
  readonly networks: Pick<NetworkController, "enabled">;
  /**
   * The one account seam — the engine's `signers.apis`: vault material derives in the kernel, card
   * and hardware wallets read their pinned material.
   */
  readonly signers: { readonly apis: Pick<ChainsApi, "account" | "exportAccount"> };
};

/** The networks a QR counterpart can address: mainnet first for the binding-fallback order. */
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TRON_MAINNET = "tron:728126428";
const EVM_ACCOUNT_NETWORK = "eip155:1";

const mainnetFirst = (ids: ReadonlyArray<string>, mainnet: string): ReadonlyArray<string> => [
  ...ids.filter((id) => id === mainnet),
  ...ids.filter((id) => id !== mainnet),
];

/** The account template and account-network the request family's leaf address comes from. */
const LEAF_ACCOUNT = {
  evm: { template: "evm.bip44", network: EVM_ACCOUNT_NETWORK },
  tron: { template: "tron.bip44", network: TRON_MAINNET },
  solana: { template: "solana.bip44-change", network: SOLANA_MAINNET },
} as const;

type Bound = { readonly request: QrRequest; readonly signer: QrSigner | undefined };

/** A chain account's address — a reply without one is never bound against an empty string. */
const accountAddress = (chain: ChainAccount, family: "evm" | "tron" | "solana"): string => {
  if (!("address" in chain)) {
    throw new QrError(
      "wallet-unsupported",
      `the account has no ${family} address — never bind a request against an empty one`,
    );
  }
  return chain.address;
};

/**
 * The account's authenticated facts for binding: a hardware fingerprint comes from the device's
 * attested wallet info, a vault's or card's from its Bitcoin account material; the address comes
 * from `chain.account` — never from the request. Only the request's own family resolves: a card or
 * hardware wallet missing another family's pinned material must not blind this request. A missing
 * node surfaces the kernel's typed `device-required` unwrapped so the host can fetch accounts and
 * retry; nothing here wraps it in a QrError.
 */
const accountFacts = async (
  deps: { readonly engine: QrEngineSurface; readonly wallet: Wallet },
  account: QrAccount,
  family: QrRequest["family"],
): Promise<QrAccountFacts> => {
  const info = deps.wallet.getSnapshot().wallets.find((w) => w.walletId === account.walletId);
  if (info === undefined) {
    throw new QrError(
      "wallet-unsupported",
      "a QR signer must be a vault, card or hardware wallet — imported keys cannot sign",
    );
  }
  const { apis } = deps.engine.signers;
  const { walletId, groupIndex } = account;
  const [chain, bitcoin] = await Promise.all([
    family === "bitcoin"
      ? Promise.resolve(undefined)
      : apis.account({ walletId, groupIndex, ...LEAF_ACCOUNT[family] }),
    info.custody === "hardware"
      ? Promise.resolve(undefined)
      : apis.account({ walletId, groupIndex, template: "btc.bip84", network: BITCOIN_MAINNET }),
  ]);
  const fingerprint =
    info.custody === "hardware"
      ? Number.parseInt(info.fingerprint, 16)
      : bitcoin === undefined || !("fingerprint" in bitcoin) || bitcoin.fingerprint === undefined
        ? Number.NaN
        : Number.parseInt(bitcoin.fingerprint, 16);
  if (!Number.isSafeInteger(fingerprint)) {
    throw new QrError("wallet-unsupported", "the wallet's master fingerprint is unavailable");
  }
  return {
    walletId,
    groupIndex,
    fingerprint,
    addresses:
      chain === undefined || family === "bitcoin"
        ? {}
        : { [family]: accountAddress(chain, family) },
    networks: {
      evm: deps.engine.networks.enabled("evm"),
      solana: mainnetFirst(deps.engine.networks.enabled("solana"), SOLANA_MAINNET),
      tron: mainnetFirst(deps.engine.networks.enabled("tron"), TRON_MAINNET),
      bitcoin: deps.engine.networks.enabled("bitcoin"),
    },
  };
};

/* The address `qrResponse` verifies the signature against — the request's family decides which.
   Bitcoin responses carry no signer (the PSBT itself is the answer), so they bind nothing. */
const signerOf = (request: QrRequest, facts: QrAccountFacts): QrSigner | undefined => {
  if (request.family === "bitcoin") {
    return undefined;
  }
  const address = facts.addresses[request.family];
  if (address === undefined) {
    /* `accountFacts` resolves the request's own family or already refused — this is the
       integrity floor, not a reachable wallet state. */
    throw new QrError("wallet-unsupported", `the account has no ${request.family} address`);
  }
  return { address };
};

/** The 64-byte ed25519 signature this account contributed to a signed transaction wire. */
const solanaSignature = (wire: Uint8Array, address: string): Uint8Array => {
  const [count] = wire;
  if (count === undefined || wire.length < 1 + 64 * count) {
    throw new QrError("result-mismatch", "the signed wire is truncated");
  }
  const message = qrGuard("result-mismatch", () =>
    parseCompiledMessage(wire.subarray(1 + 64 * count)),
  );
  const index = message.staticAccounts.slice(0, count).indexOf(address);
  if (index === -1) {
    throw new QrError("result-mismatch", "the signed wire carries no signature of this account");
  }
  const signature = wire.subarray(1 + 64 * index, 1 + 64 * (index + 1));
  if (signature.length !== 64 || signature.every((byte) => byte === 0)) {
    throw new QrError("result-mismatch", "this account's signature slot is empty");
  }
  return signature;
};

/** A pipeline outcome as the `chain.sign` result `qrResponse` verifies against the request. */
const toChainResult = (result: RequestResult, signer: QrSigner | undefined): ChainSignResult => {
  if (!("kind" in result)) {
    throw new QrError("result-mismatch", "a QR request never produces a tracked transaction");
  }
  switch (result.kind) {
    case "evm.signed-transaction":
      return { kind: "evm.transaction", signedTransaction: result.signedTransaction };
    case "evm.personal-message":
    case "evm.typed-data":
      return { kind: result.kind, signature: result.signature };
    case "tron.signed-transaction":
      return { kind: "tron.transaction", signature: result.signature };
    case "tron.message":
      return { kind: "tron.message", signature: result.signature };
    case "solana.message":
      return { kind: "solana.message", signature: result.signature };
    case "solana.transactions": {
      const wires = result.signedTransactions;
      if (
        result.send ||
        result.stopped !== undefined ||
        wires === undefined ||
        wires.length !== 1 ||
        signer === undefined
      ) {
        throw new QrError("result-mismatch", "a QR request signs exactly one transaction");
      }
      const [wire] = wires;
      if (wire === undefined) {
        throw new QrError("result-mismatch", "a QR request signs exactly one transaction");
      }
      return { kind: "solana.transaction", signature: solanaSignature(wire, signer.address) };
    }
    case "bitcoin.psbts": {
      const [signed] = result.signedPsbts;
      if (result.stopped !== undefined || result.signedPsbts.length !== 1 || signed === undefined) {
        throw new QrError("result-mismatch", "a QR request signs exactly one PSBT");
      }
      return { kind: "bitcoin.psbt", signedPsbt: signed };
    }
    default:
      throw new QrError("result-mismatch", "the request produced an unexpected result");
  }
};

/**
 * The QR signing surface: `prepare` feeds the pipeline, `respond` encodes the result back into the
 * counterpart's UR, `exportAccount` encodes public account material for a watch-only wallet.
 */
export const qrSigner = (deps: {
  readonly engine: QrEngineSurface;
  readonly wallet: Wallet;
}): {
  readonly prepare: (request: QrRequest, account: QrAccount) => Promise<PendingRequest>;
  readonly respond: (id: string) => Promise<QrPayload>;
  readonly exportAccount: (params: QrExportParams) => Promise<QrExport>;
} => {
  const bound = new Map<string, Bound>();
  return {
    prepare: async (request, account) => {
      const facts = await accountFacts(deps, account, request.family);
      const candidates = bindQrRequest(request, facts);
      for (const candidate of candidates) {
        try {
          /* Candidates are tried in order — a later one binds only after the earlier refused. */
          // oxlint-disable-next-line eslint/no-await-in-loop -- the try order is the binding rule
          const pending = await deps.engine.requests.prepare(candidate);
          bound.set(pending.id, { request, signer: signerOf(request, facts) });
          /* A request that ended without a result frees its entry — one `respond` can never
             consume it. An approved one keeps the entry until `respond` answers the UR. */
          const { id } = pending;
          const releaseOnEnd = async (): Promise<void> => {
            try {
              await deps.engine.requests.outcome(id);
            } catch {
              bound.delete(id);
            }
          };
          void releaseOnEnd();
          return pending;
        } catch (error) {
          if (isBindingRefusal(error)) {
            continue;
          }
          throw error;
        }
      }
      throw new QrError("unbound", "the request could not be bound to any enabled network");
    },
    respond: async (id) => {
      /* `outcome` rejects with the pipeline's own RequestEndedError for a request that ended —
         it reaches the caller unchanged. */
      const result = await deps.engine.requests.outcome(id);
      const entry = bound.get(id);
      if (entry === undefined) {
        throw new QrError("result-mismatch", "the request was not prepared by this signer");
      }
      bound.delete(id);
      return qrResponse(entry.request, toChainResult(result, entry.signer), entry.signer);
    },
    exportAccount: async (params) => {
      const { apis } = deps.engine.signers;
      const nodes: ChainExportNode[] = exportNodes(params);
      const result = await apis.exportAccount({
        walletId: params.account.walletId,
        groupIndex: params.account.groupIndex,
        nodes,
        verify: params.verify,
      });
      return qrExport(result, params.form);
    },
  };
};

/** The export forms the facade maps onto `chain.exportAccount` nodes. */
export type QrExportParams =
  | {
      readonly account: QrAccount;
      readonly form: "crypto-hdkey";
      readonly verify: VerifyFactor;
    }
  | {
      readonly account: QrAccount;
      readonly form: "crypto-account";
      readonly bitcoin: {
        readonly template: "btc.bip44" | "btc.bip49" | "btc.bip84" | "btc.bip86";
        readonly network: string;
      };
      readonly verify: VerifyFactor;
    }
  | {
      readonly account: QrAccount;
      readonly form: "crypto-multi-accounts";
      readonly families: ReadonlyArray<"evm" | "tron" | "solana">;
      readonly bitcoin?: {
        readonly template: "btc.bip44" | "btc.bip49" | "btc.bip84" | "btc.bip86";
        readonly network: string;
      };
      readonly verify: VerifyFactor;
    };

const LEAF_TEMPLATES = {
  evm: "evm.bip44",
  tron: "tron.bip44",
  solana: "solana.bip44-change",
} as const;

const exportNodes = (params: QrExportParams): ChainExportNode[] =>
  params.form === "crypto-hdkey"
    ? [{ kind: "evm.account" }]
    : params.form === "crypto-account"
      ? [
          {
            kind: "btc.account",
            template: params.bitcoin.template,
            network: params.bitcoin.network,
          },
        ]
      : [
          ...params.families.map((family): ChainExportNode => ({
            kind: "leaf",
            template: LEAF_TEMPLATES[family],
          })),
          ...(params.bitcoin === undefined
            ? []
            : [
                {
                  kind: "btc.account",
                  template: params.bitcoin.template,
                  network: params.bitcoin.network,
                } satisfies ChainExportNode,
              ]),
        ];
