/**
 * Polymarket funding — the only two movements this lane offers (research.md §4):
 *
 * - `deposit`: a pUSD `send` request from the owner's EOA to the located **deployed** deposit wallet.
 *   It is not eligibility-gated — a deposit opens nothing on the exchange.
 * - `withdraw`: a one-call relayer `Batch` `pUSD.transfer(owner, amount)` — the destination is always
 *   the owner's own EOA, so a lost submit is `unknown` and a user retry can never move funds out of
 *   the owner's control (the batch is never auto-resubmitted; the kernel-described request makes a
 *   duplicate deliberate, not accidental).
 *
 * USDC/USDC.e wrapping and cross-chain bridging are not offered: Polymarket's collateral is pUSD on
 * Polygon, and wrapping paths belong to the swap/bridge lanes, not this app.
 */
import { toHex } from "viem";

import type { EvmFeeTier } from "../../chains/evm.ts";
import { RequestEndedError } from "../../requests/controller.ts";
import type { RequestController } from "../../requests/controller.ts";
import type { SetTimer } from "../../timer.ts";
import type { AppGroup } from "../types.ts";
import type { PolymarketAccountReads } from "./account.ts";
import { PUSD } from "./constants.ts";
import { PolymarketError } from "./errors.ts";
import { batchTypedData } from "./relayer.ts";
import type { PolymarketRelayer, RelayerCall } from "./relayer.ts";

const BATCH_DEADLINE_S = 600;

const pad32 = (hex: `0x${string}`): string => hex.slice(2).toLowerCase().padStart(64, "0");
/** `transfer(address,uint256)` — the withdraw call's only spend. */
const transferData = (to: `0x${string}`, amount: bigint): `0x${string}` =>
  `0xa9059cbb${pad32(to)}${amount.toString(16).padStart(64, "0")}`;

export type PolymarketFundingOutcome = { readonly kind: "ok" } | { readonly kind: "unknown" };

export type PolymarketFunding = {
  /**
   * Move `amount` pUSD (6-decimal units) from the owner's EOA into the deposit wallet — a described
   * `send` request. Not eligibility-gated: a deposit opens nothing.
   */
  readonly deposit: (
    group: AppGroup,
    params: { readonly amount: bigint; readonly fee: EvmFeeTier },
  ) => Promise<{ readonly requestId: string; readonly outcome: Promise<PolymarketFundingOutcome> }>;
  /**
   * Move `amount` pUSD from the deposit wallet back to the owner's EOA — a relayer `Batch` of one
   * `transfer`. Needs the host's builder signer. `unknown` means the submit was lost; reconcile by
   * checking the balance, never by blind resubmission.
   */
  readonly withdraw: (
    group: AppGroup,
    params: { readonly amount: bigint },
  ) => Promise<{ readonly requestId: string; readonly outcome: Promise<PolymarketFundingOutcome> }>;
};

export type PolymarketFundingOptions = {
  readonly account: PolymarketAccountReads;
  readonly relayer: PolymarketRelayer;
  /** Presence gates withdraw — the relayer batch submits through the builder signer. */
  readonly builder?: unknown;
  readonly requests?: Pick<RequestController, "prepare" | "outcome">;
  readonly now: () => number;
  readonly setTimer: SetTimer;
};

const accountRef = (group: AppGroup) => ({
  kind: "hd" as const,
  walletId: group.walletId,
  groupIndex: group.groupIndex,
  template: "evm.bip44" as const,
});

const requireAmount = (amount: bigint): void => {
  if (amount <= 0n) {
    throw new PolymarketError("invalid-input", "the amount must be a positive pUSD quantity");
  }
};

export function createPolymarketFunding(options: PolymarketFundingOptions): PolymarketFunding {
  const requirePipeline = (): Pick<RequestController, "prepare" | "outcome"> => {
    if (options.requests === undefined) {
      throw new PolymarketError("not-enabled", "this provider has no request pipeline");
    }
    return options.requests;
  };

  /** A located, deployed deposit wallet is the only account funding moves for. */
  const requireWallet = async (group: AppGroup) => {
    const located = await options.account.locate(group);
    if (located.kind === "safe") {
      throw new PolymarketError(
        "needs-migration",
        "this account only has a legacy Safe — migrate it to a deposit wallet first",
      );
    }
    if (!located.deployed) {
      throw new PolymarketError("not-enabled", "the deposit wallet is not deployed yet");
    }
    return located;
  };

  const wrapOutcome = async (requestId: string): Promise<PolymarketFundingOutcome> => {
    const requests = requirePipeline();
    try {
      const result = await requests.outcome(requestId);
      if (!("family" in result) && !("kind" in result)) {
        throw new PolymarketError("unavailable", "the funding request resolved without a result");
      }
      return { kind: "ok" };
    } catch (error) {
      if (error instanceof RequestEndedError) {
        throw new PolymarketError("approval-rejected", `the request was ${error.stage}`, error);
      }
      throw error;
    }
  };

  return {
    deposit: async (group, { amount, fee }) => {
      const requests = requirePipeline();
      requireAmount(amount);
      const located = await requireWallet(group);
      const pending = await requests.prepare({
        method: "send",
        account: accountRef(group),
        network: "eip155:137",
        to: located.wallet,
        amount,
        token: PUSD,
        fee,
      });
      return { requestId: pending.id, outcome: wrapOutcome(pending.id) };
    },

    withdraw: async (group, { amount }) => {
      const requests = requirePipeline();
      requireAmount(amount);
      /* The batch submits through the builder-signed relayer — refuse before any request. */
      if (options.builder === undefined) {
        throw new PolymarketError(
          "builder-required",
          "withdrawing submits through the relayer, which needs the host's builder signer",
        );
      }
      const located = await requireWallet(group);
      const nonce = await options.relayer.nonce(located.signer);
      const deadline = Math.floor(options.now() / 1000) + BATCH_DEADLINE_S;
      const calls: ReadonlyArray<RelayerCall> = [
        { target: PUSD, value: "0", data: transferData(located.signer, amount) },
      ];
      const pending = await requests.prepare({
        method: "evm-sign",
        account: accountRef(group),
        network: "eip155:137",
        request: {
          kind: "evm.typed-data",
          network: "eip155:137",
          account: accountRef(group),
          typedData: batchTypedData({ wallet: located.wallet, nonce, deadline, calls }),
        },
      });
      const outcome = (async (): Promise<PolymarketFundingOutcome> => {
        let signature: `0x${string}`;
        try {
          const result = await requests.outcome(pending.id);
          if (
            !("kind" in result) ||
            result.kind !== "evm.typed-data" ||
            result.signature.length !== 65
          ) {
            throw new PolymarketError(
              "unavailable",
              "the request resolved without a typed-data signature",
            );
          }
          signature = toHex(result.signature);
        } catch (error) {
          if (error instanceof RequestEndedError) {
            throw new PolymarketError("approval-rejected", `the request was ${error.stage}`, error);
          }
          throw error;
        }
        try {
          await options.relayer.submitBatch({
            signer: located.signer,
            wallet: located.wallet,
            calls,
            signature,
            nonce,
            deadline,
            metadata: "Withdraw pUSD",
          });
          return { kind: "ok" };
        } catch (error) {
          if (error instanceof PolymarketError && error.category === "rejected") {
            throw error;
          }
          /* A lost submit (timeout/network/5xx/poll timeout) is `unknown`: the batch may still
             confirm — the destination is the owner's own address, so a retry is safe and never
             moves funds out of the owner's control. We never resubmit automatically. */
          return { kind: "unknown" };
        }
      })();
      return { requestId: pending.id, outcome };
    },
  };
}
