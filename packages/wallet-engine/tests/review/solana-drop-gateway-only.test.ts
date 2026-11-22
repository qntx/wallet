/**
 * PoC for finding R-1 (solana-drop-gateway-only).
 *
 * Property that should hold: a Solana `dropped` verdict — like the EVM (`independentClient` receipt
 * check) and TRON (`independentPinnedTronApi`) drop proofs — is reached only after the host
 * endpoint, the configured cross-check, is consulted.
 *
 * Current behaviour pinned here: `pollSolana` (src/transactions/solana.ts) reads only
 * `ctx.options.networks.solanaRpc(network)`, the gateway-first per-call failover client, and never
 * touches `networks.independentSolanaRpc`. A gateway that reports the lifetime bound expired, the
 * blockhash invalid (or the durable nonce advanced) and no signature entry settles `dropped` while
 * the host endpoint — which would report the transaction finalized — is never asked.
 *
 * These assertions pin the buggy behaviour: they pass today and must be revisited by the fix.
 */
import { base64 } from "@scure/base";
import {
  getNonceEncoder,
  getTransferSolInstruction,
  NonceState,
  SYSTEM_PROGRAM_ADDRESS,
} from "@solana-program/system";
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import type { Nonce } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import type { SolanaRpc } from "../../src/networks/controller.ts";
import type { RouteContext, TrackedTransaction } from "../../src/transactions/route.ts";
import { pollSolana, submitDappSolana } from "../../src/transactions/solana.ts";

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const NONCE_VALUE = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const ADVANCED_VALUE = "6vN9k1dQ3bBqM2qKf8k8tF4Hh8K5vN9k1dQ3bBqM2qKM";
const DAPP_INTENT = {
  family: "solana" as const,
  network: NETWORK,
  summary: "transfer" as const,
  outflows: [],
  approvals: [],
  fee: undefined,
  warnings: [],
  verifiability: "full" as const,
};

/** Mirrors tests/solana-durable.test.ts — a signed v0 wire with a blockhash lifetime bound. */
const blockhashWire = async (): Promise<Uint8Array> => {
  const payer = await generateKeyPairSigner();
  const recipient = await generateKeyPairSigner();
  const message = appendTransactionMessageInstructions(
    [
      getTransferSolInstruction({
        source: payer,
        destination: recipient.address,
        amount: 1000,
      }),
    ],
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(NONCE_VALUE), lastValidBlockHeight: 1000n },
      setTransactionMessageFeePayer(payer.address, createTransactionMessage({ version: 0 })),
    ),
  );
  return new Uint8Array(
    getTransactionEncoder().encode(await signTransactionMessageWithSigners(message)),
  );
};

/** Mirrors tests/solana-durable.test.ts — a signed v0 wire whose first instruction advances a nonce. */
const durableWire = async (): Promise<{ wire: Uint8Array; nonceAccount: string }> => {
  const payer = await generateKeyPairSigner();
  const nonceAccount = await generateKeyPairSigner();
  const recipient = await generateKeyPairSigner();
  const message = setTransactionMessageLifetimeUsingDurableNonce(
    {
      nonce: NONCE_VALUE as Nonce,
      nonceAccountAddress: nonceAccount.address,
      nonceAuthorityAddress: payer.address,
    },
    appendTransactionMessageInstructions(
      [
        getTransferSolInstruction({
          source: payer,
          destination: recipient.address,
          amount: 1000,
        }),
      ],
      setTransactionMessageFeePayerSigner(payer, createTransactionMessage({ version: 0 })),
    ),
  );
  const wire = new Uint8Array(
    getTransactionEncoder().encode(await signTransactionMessageWithSigners(message)),
  );
  return { wire, nonceAccount: nonceAccount.address };
};

/** `getNonceEncoder` is the oracle for what the endpoint's base64 account data carries. */
const nonceAccountValue = (value: string): string =>
  base64.encode(
    new Uint8Array(
      getNonceEncoder().encode({
        version: 1,
        state: NonceState.Initialized,
        authority: address("4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM"),
        blockhash: address(value),
        lamportsPerSignature: 5000n,
      }),
    ),
  );

type Answers = {
  readonly account?: { value: unknown; slot?: number } | undefined;
  readonly status?: { entry?: unknown; slot?: number } | undefined;
  readonly tip?: { slot: number; height: number } | undefined;
  readonly blockhashValid?: { valid: boolean; slot?: number } | undefined;
  readonly signatures?: unknown[] | undefined;
};

/** One endpoint: every method recorded, answering from `answers`. */
const endpointRpc = (signature: string, answers: Answers): SolanaRpc & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    call: async (method, _params) => {
      calls.push(method);
      switch (method) {
        case "sendTransaction":
          return Promise.resolve(signature);
        case "getAccountInfo":
          return Promise.resolve({
            context: { slot: answers.account?.slot ?? 5000 },
            value: answers.account?.value ?? null,
          });
        case "getSignatureStatuses":
          return Promise.resolve({
            context: { slot: answers.status?.slot ?? 5000 },
            value: [answers.status?.entry ?? null],
          });
        case "getEpochInfo":
          return Promise.resolve({
            absoluteSlot: answers.tip?.slot ?? 5000,
            blockHeight: answers.tip?.height ?? 900_000,
          });
        case "isBlockhashValid":
          return Promise.resolve({
            context: { slot: answers.blockhashValid?.slot ?? 6000 },
            value: answers.blockhashValid?.valid ?? false,
          });
        case "getSignaturesForAddress":
          return Promise.resolve(answers.signatures ?? []);
        default:
          return Promise.reject(new Error(`unmocked ${method}`));
      }
    },
  };
};

/**
 * A signature-history entry that provably reaches back before the row's `submittedAt` (0 in this
 * rig) — same shape as tests/solana-durable.test.ts.
 */
const HISTORY_BEFORE_SUBMISSION = {
  signature: "4xother",
  slot: 4900,
  err: null,
  confirmationStatus: "finalized",
  blockTime: -1_000_000,
};

/**
 * The poll's view of the world: `solanaRpc` is the gateway-first failover client (here the gateway
 * answers, so the failover never walks further — as it would not in production), and
 * `independentSolanaRpc` is the host endpoint cross-check TRON and EVM consult before `dropped`.
 */
const world = (gateway: SolanaRpc & { calls: string[] }, host: SolanaRpc & { calls: string[] }) => {
  const rows = new Map<string, TrackedTransaction>();
  const ctx: RouteContext = {
    options: {
      wallet: {} as Wallet,
      networks: {
        solanaRpc: () => gateway,
        independentSolanaRpc: () => ({ kind: "available", client: host }),
      } as unknown as RouteContext["options"]["networks"],
      openStore: async () => {
        await Promise.resolve();
        throw new Error("no store in this rig");
      },
      random: (n) => new Uint8Array(n).fill(9),
      setTimer: () => () => undefined,
      now: () => 0,
      logger: { warn: () => undefined },
    },
    transition: async (tx, next, _durable) => {
      await Promise.resolve();
      const updated: TrackedTransaction = { ...tx, ...next };
      rows.set(tx.id, updated);
      return updated;
    },
    track: () => undefined,
    txs: () => Object.fromEntries(rows),
    newId: () => "tx-1",
  };
  return { ctx, rows };
};

const track = async (
  gateway: SolanaRpc & { calls: string[] },
  host: SolanaRpc & { calls: string[] },
  wire: Uint8Array,
): Promise<{ ctx: RouteContext; tx: TrackedTransaction; sig: string }> => {
  const { ctx, rows } = world(gateway, host);
  const sig = await submitDappSolana(ctx, {
    network: NETWORK,
    walletId: "w",
    wire,
    lastValidBlockHeight: 1000n,
    intent: DAPP_INTENT,
  });
  const tx = rows.get("tx-1");
  if (tx === undefined) {
    throw new Error("the dApp send did not track its transaction");
  }
  return { ctx, tx, sig };
};

const FINALIZED_ENTRY = { slot: 5001, confirmationStatus: "finalized", err: null };

describe("R-1: a Solana drop is proven by the gateway alone", () => {
  it("blockhash path: gateway answers 'expired, invalid, no entry' — host, which sees it finalized, is never asked", async () => {
    const wire = await blockhashWire();
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(wire));
    /* The gateway says the tip passed the bound, the blockhash is dead and no entry exists on a
       fresh bank — the whole `dropped` case. The host would answer the entry finalized. */
    const gateway = endpointRpc(signature, {
      tip: { slot: 6000, height: 2000 },
      blockhashValid: { valid: false, slot: 6000 },
      status: { entry: null, slot: 6000 },
    });
    const host = endpointRpc(signature, {
      status: { entry: FINALIZED_ENTRY, slot: 6000 },
    });
    const { ctx, tx } = await track(gateway, host, wire);

    await expect(pollSolana(ctx, tx)).resolves.toStrictEqual({
      kind: "ended",
      state: "dropped",
    });
    // The finding: the host endpoint — holding the contradicting evidence — was never consulted.
    expect(host.calls).toStrictEqual([]);
  });

  it("durable-nonce path: gateway answers 'nonce advanced, no entry, covering history' — host never asked", async () => {
    const { wire } = await durableWire();
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(wire));
    const gateway = endpointRpc(signature, {
      account: {
        value: {
          owner: SYSTEM_PROGRAM_ADDRESS,
          data: [nonceAccountValue(ADVANCED_VALUE), "base64"],
        },
        slot: 5000,
      },
      status: { entry: null, slot: 5000 },
      signatures: [HISTORY_BEFORE_SUBMISSION],
    });
    const host = endpointRpc(signature, {
      status: { entry: FINALIZED_ENTRY, slot: 6000 },
    });
    const { ctx, tx } = await track(gateway, host, wire);

    await expect(pollSolana(ctx, tx)).resolves.toStrictEqual({
      kind: "ended",
      state: "dropped",
    });
    expect(host.calls).toStrictEqual([]);
  });
});
