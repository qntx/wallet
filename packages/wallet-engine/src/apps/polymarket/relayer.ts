/**
 * The Polymarket relayer (`relayer-v2.polymarket.com`) — deposit-wallet deploys and gasless WALLET
 * batches. Every submission is HMAC'd by the host's Remote Builder Signing hook over the exact
 * serialized body; confirmation is the unauthenticated `GET /transaction` poll, on the injected
 * timer so tests drive it. Nothing here holds a secret: the builder's server owns the API key.
 *
 * A lost submit (timeout/network/5xx) is never re-sent — the caller's step stays resumable and
 * reconcile re-reads the facts (`/deployed`, `/v2/approvals`). A `STATE_CONFIRMED` answer whose
 * `proxyAddress` disagrees with our own CREATE2 derivation is refused (`unavailable`): the
 * relayer's address is never adopted over ours.
 */
import type { SetTimer } from "../../timer.ts";
import { DEPOSIT_WALLET_FACTORY, RELAYER_HOST } from "./constants.ts";
import { PolymarketError } from "./errors.ts";
import type { PolymarketHttp } from "./http.ts";
import type { PolymarketBuilderHeaders } from "./provider.ts";
import { relayerNonce, relayerSubmitResponse, relayerTransactions } from "./schemas.ts";

/** `/transaction` is polled every 2 s for up to 120 s (docs trading/wallets-auth.md §Deploy). */
const POLL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;

/** The relayer's stale-nonce refusal (SDK `Ts()` — research.md §1). */
const NONCE_MISMATCH = /batch nonce\s+\d+\s+does not match on-chain nonce\s+\d+/i;

export type RelayerCall = {
  readonly target: `0x${string}`;
  readonly value: string;
  readonly data: `0x${string}`;
};

export type PolymarketRelayer = {
  /** `GET /nonce?type=WALLET` — the deposit wallet's batch nonce (unauthenticated). */
  readonly nonce: (signer: `0x${string}`) => Promise<bigint>;
  /**
   * `WALLET-CREATE` then poll until `STATE_CONFIRMED` — the confirmed `proxyAddress` must equal
   * `expected` (our beacon derivation) or the answer is refused.
   */
  readonly deploy: (signer: `0x${string}`, expected: `0x${string}`) => Promise<void>;
  /**
   * A `WALLET` batch: the owner's raw `Batch` signature, then poll to `STATE_CONFIRMED`. A 400
   * nonce mismatch is `rejected` — the caller retries the whole step, never re-signs here.
   */
  readonly submitBatch: (input: {
    readonly signer: `0x${string}`;
    readonly wallet: `0x${string}`;
    readonly calls: ReadonlyArray<RelayerCall>;
    /** The owner's 65-byte `Batch` signature, 0x-prefixed. */
    readonly signature: `0x${string}`;
    readonly nonce: bigint;
    readonly deadline: number;
    readonly metadata: string;
  }) => Promise<void>;
};

const isHeaders = (value: unknown): value is PolymarketBuilderHeaders => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "POLY_BUILDER_API_KEY" in value &&
    typeof value.POLY_BUILDER_API_KEY === "string" &&
    value.POLY_BUILDER_API_KEY !== "" &&
    "POLY_BUILDER_PASSPHRASE" in value &&
    typeof value.POLY_BUILDER_PASSPHRASE === "string" &&
    value.POLY_BUILDER_PASSPHRASE !== "" &&
    "POLY_BUILDER_SIGNATURE" in value &&
    typeof value.POLY_BUILDER_SIGNATURE === "string" &&
    value.POLY_BUILDER_SIGNATURE !== "" &&
    "POLY_BUILDER_TIMESTAMP" in value &&
    typeof value.POLY_BUILDER_TIMESTAMP === "string" &&
    /^[0-9]+$/.test(value.POLY_BUILDER_TIMESTAMP)
  );
};

export function createPolymarketRelayer(options: {
  readonly http: PolymarketHttp;
  readonly builder?: {
    readonly code?: `0x${string}`;
    readonly sign: (request: {
      readonly method: string;
      readonly path: string;
      readonly body: string;
    }) => Promise<PolymarketBuilderHeaders>;
  };
  readonly now: () => number;
  readonly setTimer: SetTimer;
}): PolymarketRelayer {
  const sleep = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
      options.setTimer(ms, resolve);
    });

  /** The builder oracle must answer exactly the four header fields — anything else is refused. */
  const builderHeaders = async (body: string): Promise<PolymarketBuilderHeaders> => {
    if (options.builder === undefined) {
      throw new PolymarketError(
        "builder-required",
        "this step submits through the relayer, which needs the host's builder signer",
      );
    }
    const headers = await options.builder
      .sign({ method: "POST", path: "/submit", body })
      .catch((error: unknown) => {
        throw new PolymarketError("unavailable", "the builder signer failed", { cause: error });
      });
    if (!isHeaders(headers)) {
      throw new PolymarketError(
        "unavailable",
        "the builder signer returned malformed POLY_BUILDER_* headers",
      );
    }
    return headers;
  };

  /** POST `/submit` with the exact `body` the builder just signed — never reserialized. */
  const submit = async (body: string): Promise<{ transactionID: string; state: string }> => {
    const headers = await builderHeaders(body);
    try {
      return await options.http.request(
        {
          host: RELAYER_HOST,
          method: "POST",
          path: "/submit",
          headers: { ...headers, "content-type": "application/json" },
          body,
        },
        relayerSubmitResponse,
      );
    } catch (error) {
      if (
        error instanceof PolymarketError &&
        error.category === "unavailable" &&
        error.status === 400 &&
        typeof error.body?.["error"] === "string" &&
        NONCE_MISMATCH.test(error.body["error"])
      ) {
        /* A stale nonce is definitive but not fatal — the step retries from a fresh read. */
        throw new PolymarketError("rejected", error.body["error"], { cause: error });
      }
      throw error;
    }
  };

  /** Poll `GET /transaction?id=` to a terminal state; a lapse is `unavailable` (resumable). */
  const confirm = async (
    transactionID: string,
  ): Promise<{ state: string; proxyAddress?: string | undefined }> => {
    const deadline = options.now() + POLL_TIMEOUT_MS;
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the poll is deliberately sequential.
      const rows = await options.http.request(
        {
          host: RELAYER_HOST,
          method: "GET",
          path: "/transaction",
          query: { id: transactionID },
        },
        relayerTransactions,
      );
      const row = rows.find((r) => r.transactionID === transactionID);
      if (row !== undefined && row.state === "STATE_CONFIRMED") {
        return row;
      }
      if (row !== undefined && (row.state === "STATE_FAILED" || row.state === "STATE_INVALID")) {
        throw new PolymarketError(
          "rejected",
          `the relayer ${row.state === "STATE_FAILED" ? "failed" : "invalidated"} the transaction`,
        );
      }
      if (options.now() >= deadline) {
        throw new PolymarketError(
          "unavailable",
          "the relayer transaction did not confirm in time — retry to resume",
        );
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- the poll is deliberately sequential.
      await sleep(POLL_MS);
    }
  };

  return {
    nonce: async (signer) => {
      const answer = await options.http.request(
        {
          host: RELAYER_HOST,
          method: "GET",
          path: "/nonce",
          query: { address: signer, type: "WALLET" },
        },
        relayerNonce,
      );
      return BigInt(answer.nonce);
    },

    deploy: async (signer, expected) => {
      /* Serialized once — the builder HMACs this exact string (docs trading/wallets-auth.md
         §Deploy a Deposit Wallet). */
      const body = JSON.stringify({
        type: "WALLET-CREATE",
        from: signer,
        to: DEPOSIT_WALLET_FACTORY,
        metadata: "Deploy Deposit Wallet",
      });
      const { transactionID } = await submit(body);
      const confirmed = await confirm(transactionID);
      if (confirmed.proxyAddress?.toLowerCase() !== expected.toLowerCase()) {
        throw new PolymarketError(
          "unavailable",
          "the relayer reported a different deposit wallet than our derivation — refusing it",
        );
      }
    },

    submitBatch: async (input) => {
      const body = JSON.stringify({
        type: "WALLET",
        from: input.signer,
        to: DEPOSIT_WALLET_FACTORY,
        nonce: input.nonce.toString(10),
        signature: input.signature,
        metadata: input.metadata,
        depositWalletParams: {
          depositWallet: input.wallet,
          deadline: String(input.deadline),
          calls: input.calls.map((call) => ({
            target: call.target,
            value: call.value,
            data: call.data,
          })),
        },
      });
      const { transactionID } = await submit(body);
      await confirm(transactionID);
    },
  };
}

/**
 * The `DepositWallet` `Batch` typed-data document the owner signs — the exact shape the kernel's
 * `polymarket` recognizer describes (vectors/chains/polymarket.json Batch cases; docs
 * trading/wallets-auth.md "Create the Batch Typed Data").
 */
export const batchTypedData = (input: {
  readonly wallet: `0x${string}`;
  readonly nonce: bigint;
  readonly deadline: number;
  readonly calls: ReadonlyArray<RelayerCall>;
}): string =>
  JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Batch: [
        { name: "wallet", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "calls", type: "Call[]" },
      ],
      Call: [
        { name: "target", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
      ],
    },
    primaryType: "Batch",
    domain: {
      name: "DepositWallet",
      version: "1",
      chainId: 137,
      verifyingContract: input.wallet,
    },
    message: {
      wallet: input.wallet,
      nonce: Number(input.nonce),
      deadline: input.deadline,
      calls: input.calls.map((call) => ({
        target: call.target,
        value: Number(call.value),
        data: call.data,
      })),
    },
  });
