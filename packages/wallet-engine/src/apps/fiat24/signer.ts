/**
 * The SDK's `Fiat24Signer` over the engine's request pipeline. `sendTransaction` opens an app
 * request carrying the SDK's exact `to`/`data`/`value` and pins the SDK-chosen `nonce`: the engine
 * rebuilds the transaction with fresh fees but refuses — `NonceConflictError`, before anything is
 * shown — when the sender's next free nonce differs. A refusal surfaces to the SDK only while it
 * can prove nothing was broadcast: an outcome that ended before the `signed` stage — mapped to a
 * `Fiat24Refusal` — becomes `Fiat24Error("signer-rejected")` (the SDK returns the record to
 * `ready`); a request that reached `signed` gets a plain non-rejection error so the SDK records
 * `unknown` and reconciles by nonce rather than risking a second send. `signSessionGrant` does the
 * same for `evm.fiat24-session`: the grant is validated against the SDK's own `sessionLabel`/
 * `sessionMessage` and the chain decoder's `fiat24SessionMessage` before any request opens. No call
 * data, hashes, grants or signatures ever enter an error message, `opened`/`refused` or the
 * returned values beyond what the SDK contract itself returns.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { isAddressEqual, isHash } from "viem";
import type { Address, Hash, Hex } from "viem";

import { Fiat24Error, arbitrum } from "@qntx/fiat24";
import type { Fiat24SessionGrant, Fiat24Signer, Fiat24TransactionRequest } from "@qntx/fiat24";
import { sessionLabel, sessionMessage } from "@qntx/fiat24/api";
import { fiat24SessionMessage } from "@qntx/wallet-chains/evm";

import { NonceConflictError, RequestEndedError } from "../spi.ts";
import type { AppGroup, AppRequests, SignatureResult } from "../spi.ts";

const NETWORK = "eip155:42161";
const CHAIN_ID = 42161;

/** Every contract address the SDK's call builders may target on the pinned deployment. */
const CALL_TARGETS: ReadonlySet<string> = new Set(
  [
    arbitrum.account.proxy,
    ...Object.values(arbitrum.tokens).map((token) => token.proxy),
    arbitrum.deposit.proxy,
    arbitrum.card.proxy,
    arbitrum.priceList.proxy,
    arbitrum.f24Sales.proxy,
    arbitrum.f24.address,
    arbitrum.usdc,
  ].map((address) => address.toLowerCase()),
);

/**
 * Why a signer call refused without producing a request or a signature — the app's flow surface
 * reports it to the caller; it never carries request payloads.
 */
export type Fiat24Refusal =
  /** The user rejected the request. */
  | "rejected"
  /** The request's TTL elapsed before approval. */
  | "expired"
  /** The vault locked or the account group changed while the request was open. */
  | "invalidated"
  /** The request failed before the `signed` stage — nothing was broadcast. */
  | "failed-before-signing"
  /** The sender's next free nonce differs from the nonce the SDK chose. */
  | "nonce-conflict"
  /** `prepare` threw for another reason — nothing was shown. */
  | "prepare-failed"
  /** The call itself fails validation — no request was opened. */
  | "invalid-call";

type Requests = Pick<AppRequests, "prepare" | "outcome">;

const accountRef = (group: AppGroup) => ({
  kind: "hd" as const,
  walletId: group.walletId,
  groupIndex: group.groupIndex,
  template: "evm.bip44" as const,
});

const REFUSED = "the request was refused";
const PREPARE_FAILED = "the transaction could not be prepared";
const SESSION_FAILED = "the session grant could not be prepared";

const rejected = (message: string): Fiat24Error => new Fiat24Error("signer-rejected", message);

const refusalOf = (stage: RequestEndedError["stage"]): Fiat24Refusal =>
  stage === "failed" ? "failed-before-signing" : stage;

const isTransactionOutcome = (outcome: unknown): outcome is { readonly hash: string } =>
  typeof outcome === "object" &&
  outcome !== null &&
  "hash" in outcome &&
  typeof outcome.hash === "string" &&
  isHash(outcome.hash);

const isSessionOutcome = (outcome: unknown): outcome is SignatureResult =>
  typeof outcome === "object" &&
  outcome !== null &&
  "kind" in outcome &&
  outcome.kind === "evm.fiat24-session" &&
  "signature" in outcome &&
  outcome.signature instanceof Uint8Array &&
  outcome.signature.length === 65;

export const createFiat24Signer = (options: {
  readonly requests: Requests;
  readonly group: AppGroup;
  /** The group's `evm.bip44` address on Arbitrum One — the only `from` the signer accepts. */
  readonly owner: Address;
  /** The Fiat24 account this signer may grant sessions for; grants are refused without it. */
  readonly tokenId?: bigint;
  /** A request opened for this signer — the app records it for display. */
  readonly opened: (requestId: string) => void;
  /** The signer refused before producing a result — the app records the reason. */
  readonly refused: (reason: Fiat24Refusal) => void;
}): Fiat24Signer => {
  const { requests, group, owner, opened, refused } = options;

  const invalid = (message: string): never => {
    refused("invalid-call");
    throw rejected(message);
  };

  const sendTransaction = async (request: Fiat24TransactionRequest): Promise<Hash> => {
    if (request.chainId !== CHAIN_ID) {
      invalid("the call is for another chain");
    }
    if (!isAddressEqual(request.from, owner)) {
      invalid("the call is not from this account");
    }
    if (!CALL_TARGETS.has(request.to.toLowerCase())) {
      invalid("the call targets an unknown contract");
    }
    if (!Number.isSafeInteger(request.nonce) || request.nonce < 0) {
      invalid("the call carries an invalid nonce");
    }
    const account = accountRef(group);
    let pending: Awaited<ReturnType<Requests["prepare"]>>;
    try {
      pending = await requests.prepare({
        method: "evm-sign",
        account,
        network: NETWORK,
        request: {
          kind: "evm.transaction",
          network: NETWORK,
          account,
          /* The pipeline rebuilds nonce and fees; the skeleton only carries `to`/`data`/`value`
             (plus a zero gas floor) — `nonce` pins the nonce the build must land on. */
          tx: {
            type: "eip1559",
            chainId: CHAIN_ID,
            nonce: 0,
            gas: "0x0",
            to: request.to,
            value: `0x${request.value.toString(16)}`,
            data: request.data,
            accessList: [],
            maxFeePerGas: "0x0",
            maxPriorityFeePerGas: "0x0",
          },
        },
        nonce: request.nonce,
      });
    } catch (error) {
      refused(error instanceof NonceConflictError ? "nonce-conflict" : "prepare-failed");
      throw rejected(PREPARE_FAILED);
    }
    opened(pending.id);
    let outcome: unknown;
    try {
      outcome = await requests.outcome(pending.id);
    } catch (error) {
      if (error instanceof RequestEndedError) {
        if (!error.signed) {
          refused(refusalOf(error.stage));
          throw rejected(REFUSED);
        }
        /* Past `signed` the signature may already be broadcast — a non-rejection error so the
           SDK records `unknown` and reconciles by nonce instead of sending again. */
        throw new Error("the request was signed but its outcome is unknown", { cause: error });
      }
      throw error;
    }
    if (isTransactionOutcome(outcome)) {
      const hash = outcome.hash.toLowerCase();
      if (isHash(hash)) {
        return hash;
      }
    }
    throw new Error("the request ended without a transaction hash");
  };

  const signSessionGrant = async (grant: Fiat24SessionGrant): Promise<Hex> => {
    const tokenId = options.tokenId ?? invalid("the session grant does not match this account");
    const sessionArgs = { chainId: CHAIN_ID as 42161, tokenId, deadline: grant.deadline };
    if (
      grant.chainId !== CHAIN_ID ||
      grant.tokenId !== tokenId ||
      grant.deadline < 1n ||
      grant.deadline > BigInt(Number.MAX_SAFE_INTEGER) ||
      grant.hash !== sessionLabel(sessionArgs) ||
      grant.message !== sessionMessage(sessionArgs) ||
      grant.message !== fiat24SessionMessage(CHAIN_ID, tokenId.toString(10), Number(grant.deadline))
    ) {
      invalid("the session grant does not match this account");
    }
    const account = accountRef(group);
    let pending: Awaited<ReturnType<Requests["prepare"]>>;
    try {
      pending = await requests.prepare({
        method: "evm-sign",
        account,
        network: NETWORK,
        request: {
          kind: "evm.fiat24-session",
          network: NETWORK,
          account,
          tokenId: tokenId.toString(10),
          deadline: Number(grant.deadline),
        },
      });
    } catch {
      refused("prepare-failed");
      throw rejected(SESSION_FAILED);
    }
    opened(pending.id);
    let outcome: unknown;
    try {
      outcome = await requests.outcome(pending.id);
    } catch (error) {
      if (error instanceof RequestEndedError) {
        refused(refusalOf(error.stage));
        throw rejected(REFUSED);
      }
      throw error;
    }
    if (isSessionOutcome(outcome)) {
      return `0x${bytesToHex(outcome.signature)}`;
    }
    throw new Error("the request ended without a signature");
  };

  return { address: owner, sendTransaction, signSessionGrant };
};
