/**
 * The dApp signing lanes `createWalletEngine` hands its RequestController: `solanaSign` (the
 * transactions and message kinds), `bitcoinPrepare`, `bitcoinSignPsbts` and `bitcoinSign`. Every
 * lane submits through `signers.apis`, the one signing seam. The e2e harness wires the same lanes
 * over a test world so the matrix exercises production code, not a copy.
 */
import {
  addSolanaSignature,
  decodeSolana,
  decodeSolanaTransaction,
  normalizeSolana,
} from "@qntx/wallet-chains/solana";

import type { NetworkController } from "../networks/controller.ts";
import type { RequestControllerOptions } from "../requests/controller.ts";
import type { SignersController } from "../signers/controller.ts";
import { submitInOrder } from "../transactions/broadcast.ts";
import type { TransactionController } from "../transactions/controller.ts";
import type { DisplayIntent } from "../transactions/route.ts";
import { prepareDappPsbts, signDappPsbts } from "./bitcoin-dapp.ts";
import { SOLANA_MAX_PROCESSING_AGE, SolanaChainAdapter } from "./solana.ts";

export const dappLanes = (deps: {
  readonly signers: Pick<SignersController, "apis">;
  readonly networks: Pick<NetworkController, "solanaRpc" | "esplora">;
  readonly transactions: Pick<
    TransactionController,
    "frozenUtxos" | "submitDappBitcoin" | "submitDappSolana"
  >;
}): Pick<
  RequestControllerOptions,
  "solanaSign" | "bitcoinSign" | "bitcoinPrepare" | "bitcoinSignPsbts"
> => ({
  solanaSign: async (account, network, request, verify, commit) => {
    const rpc = deps.networks.solanaRpc(network);
    const adapter = new SolanaChainAdapter();
    const hdAccount = {
      kind: "hd" as const,
      walletId: account.walletId,
      groupIndex: account.groupIndex,
      template: "solana.bip44-change" as const,
    };
    if (request.kind === "transactions") {
      const wires: Uint8Array[] = [];
      const messages: Uint8Array[] = [];
      for (const wire of request.transactions) {
        const { message } = decodeSolanaTransaction(wire, account.address);
        // oxlint-disable-next-line eslint/no-await-in-loop -- signing is sequential: each prompts.
        const result = await deps.signers.apis.sign({
          request: {
            kind: "solana.transaction",
            network,
            account: hdAccount,
            message,
          },
          verify,
        });
        if (result.kind !== "solana.transaction" || !(result.signature instanceof Uint8Array)) {
          throw new Error("unexpected solana sign result");
        }
        wires.push(addSolanaSignature(wire, account.address, result.signature));
        messages.push(message);
      }
      if (!request.send) {
        return { kind: "solana.transactions" as const, send: false, signedTransactions: wires };
      }
      const intents = messages.map((message): DisplayIntent =>
        decodeSolana(
          { kind: "solana.transaction", network, account: hdAccount, message },
          account.address,
        ),
      );
      /* The message carries only a blockhash: bound its expiry by the processed height at
         request time plus Agave's processing age. The dApp fetched the blockhash earlier, at
         any commitment, so the processed height is the bound that never comes in too low — a
         low bound would let the poll prove a drop while the bytes can still land. Read once,
         before commit: a failed read sends nothing. */
      const lastValidBlockHeight =
        (await adapter.blockHeight(rpc, "processed")) + SOLANA_MAX_PROCESSING_AGE;
      commit();
      const batch = await submitInOrder(wires.length, async (index) => {
        const wire = wires[index];
        const intent = intents[index];
        if (wire === undefined || intent === undefined) {
          throw new Error("signed transaction without its input");
        }
        return deps.transactions.submitDappSolana(
          network,
          account.walletId,
          wire,
          lastValidBlockHeight,
          intent,
        );
      });
      return {
        kind: "solana.transactions" as const,
        send: true,
        signatures: batch.ids,
        ...(batch.stopped === undefined ? {} : { stopped: batch.stopped }),
      };
    }
    normalizeSolana(
      {
        kind: "solana.message",
        format: "raw",
        network,
        account: hdAccount,
        message: request.message,
      },
      account.address,
    );
    const result = await deps.signers.apis.sign({
      request: {
        kind: "solana.message",
        format: "raw",
        network,
        account: hdAccount,
        message: request.message,
      },
      verify,
    });
    if (result.kind !== "solana.message" || !(result.signature instanceof Uint8Array)) {
      throw new Error("unexpected solana sign result");
    }
    return { kind: "solana.message" as const, signature: result.signature };
  },
  bitcoinPrepare: async (account, network, psbts) =>
    prepareDappPsbts(
      deps.signers.apis,
      deps.networks.esplora(network),
      account,
      network,
      psbts,
      new Set(
        deps.transactions.frozenUtxos(
          { walletId: account.walletId, groupIndex: account.groupIndex },
          network,
        ),
      ),
    ),
  bitcoinSignPsbts: async (account, network, prepared, send, verify, commit) => {
    const { signedPsbts, txids, stopped } = await signDappPsbts(
      deps.signers.apis,
      prepared,
      send,
      verify,
      commit,
      async (p, r) => deps.transactions.submitDappBitcoin(network, account.walletId, p, r),
    );
    return {
      kind: "bitcoin.psbts" as const,
      signedPsbts,
      txids,
      ...(stopped === undefined ? {} : { stopped }),
    };
  },
  bitcoinSign: async (account, network, request, verify) => {
    const result = await deps.signers.apis.sign({
      request: {
        kind: "bitcoin.message",
        network,
        account: {
          kind: "hd",
          walletId: account.walletId,
          groupIndex: account.groupIndex,
          template: account.template,
        },
        address: account.address,
        message: request.message,
        format: "bip322-simple",
        change: 0,
        index: 0,
      },
      verify,
    });
    if (result.kind !== "bitcoin.message") {
      throw new Error("unexpected bitcoin sign result");
    }
    return { kind: "bitcoin.message" as const, signature: result.signature };
  },
});
