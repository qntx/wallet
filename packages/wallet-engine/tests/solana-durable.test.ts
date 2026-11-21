/**
 * A Solana transaction whose first instruction advances a durable nonce has no blockhash expiry:
 * it is tracked without `lastValidBlockHeight` and the poll proves `dropped` from the nonce
 * account's finalized value — advanced (or gone) plus no entry on a bank at least as fresh. While
 * the nonce still holds the transaction's value it is rebroadcast like any live transaction.
 */
import { base64 } from "@scure/base";
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageEncoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  signTransactionMessageWithSigners,
  blockhash,
  compileTransactionMessage,
} from "@solana/kit";
import type { Nonce } from "@solana/kit";
import {
  getAdvanceNonceAccountInstruction,
  getNonceEncoder,
  getTransferSolInstruction,
  NonceState,
  SYSTEM_PROGRAM_ADDRESS,
} from "@solana-program/system";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import type { SolanaRpc } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type { RouteContext, TrackedTransaction } from "../src/transactions/route.ts";
import { durableNonceOfMessage, pollSolana, submitDappSolana } from "../src/transactions/solana.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { idleNetworkDeps } from "./send-helpers.ts";
import { manualTimers } from "./support/timers.ts";

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
      setTransactionMessageFeePayerSigner(
        payer,
        createTransactionMessage({ version: 0 }),
      ),
    ),
  );
  const wire = new Uint8Array(
    getTransactionEncoder().encode(await signTransactionMessageWithSigners(message)),
  );
  return { wire, nonceAccount: nonceAccount.address };
};

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

type MockRpc = SolanaRpc & { calls: string[] };

const mockRpc = (
  signature: string,
  answers: {
    account?: { value: unknown; slot?: number };
    status?: { entry?: unknown; slot?: number };
    tip?: { slot: number; height: number };
  },
): MockRpc => {
  const calls: string[] = [];
  return {
    calls,
    call: (method, _params) => {
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
        default:
          return Promise.reject(new Error(`unmocked ${method}`));
      }
    },
  };
};

const fakeCtx = (rpc: MockRpc) => {
  const rows = new Map<string, TrackedTransaction>();
  const wires: string[] = [];
  const ctx: RouteContext = {
    options: {
      wallet: {} as Wallet,
      networks: {
        solanaRpc: () => rpc,
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
  return { ctx, rows, wires };
};

const trackTx = async (
  rpc: MockRpc,
  wire: Uint8Array,
): Promise<{ ctx: RouteContext; tx: TrackedTransaction; rows: Map<string, TrackedTransaction> }> => {
  const { ctx, rows } = fakeCtx(rpc);
  await submitDappSolana(ctx, {
    network: NETWORK,
    walletId: "w",
    wire,
    lastValidBlockHeight: 1n,
    intent: DAPP_INTENT,
  });
  const tx = rows.get("tx-1");
  return { ctx, tx: tx as TrackedTransaction, rows };
};

describe("a durable-nonce transaction is tracked without a height bound", () => {
  it("a dApp send tracks durableNonce, ignores the caller's bound and never drops by height", async () => {
    const { wire, nonceAccount } = await durableWire();
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(wire));
    const rpc = mockRpc(signature, {
      account: {
        value: { owner: SYSTEM_PROGRAM_ADDRESS, data: [nonceAccountValue(NONCE_VALUE), "base64"] },
      },
      // The tip is far past any bound the caller could have stamped.
      tip: { slot: 9_000_000, height: 9_000_000 },
    });
    const { ctx, rows } = fakeCtx(rpc);
    const sig = await submitDappSolana(ctx, {
      network: NETWORK,
      walletId: "w",
      wire,
      // A caller-computed bound — meaningless for a durable nonce.
      lastValidBlockHeight: 1000n,
      intent: DAPP_INTENT,
    });
    expect(sig).toBe(signature);
    const tx = rows.get("tx-1");
    expect(tx?.durableNonce).toStrictEqual({ account: nonceAccount, value: NONCE_VALUE });
    expect(tx?.lastValidBlockHeight).toBeUndefined();

    const before = rpc.calls.filter((c) => c === "sendTransaction").length;
    const state = await pollSolana(ctx, tx as TrackedTransaction);
    expect(state).toBeUndefined();
    // Still ours: rebroadcast, never a tip read — a durable tx has no height bound.
    expect(rpc.calls.filter((c) => c === "sendTransaction").length).toBe(before + 1);
    expect(rpc.calls).not.toContain("getEpochInfo");
    // The finalized nonce read precedes the status read — an advance between them is never
    // finalised `dropped` from a stale-bank status.
    expect(rpc.calls.indexOf("getAccountInfo")).toBeLessThan(
      rpc.calls.indexOf("getSignatureStatuses"),
    );
  });

  it("an advanced nonce with no entry on a bank at least as fresh is dropped", async () => {
    const { wire } = await durableWire();
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(wire));
    const rpc = mockRpc(signature, {
      account: {
        value: { owner: SYSTEM_PROGRAM_ADDRESS, data: [nonceAccountValue(ADVANCED_VALUE), "base64"] },
        slot: 5000,
      },
      status: { entry: null, slot: 5000 },
    });
    const { ctx, tx } = await trackTx(rpc, wire);
    expect(await pollSolana(ctx, tx)).toStrictEqual({ kind: "ended", state: "dropped" });
  });

  it("an advanced nonce on a status bank behind the finalized read proves nothing", async () => {
    const { wire } = await durableWire();
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(wire));
    const rpc = mockRpc(signature, {
      account: {
        value: { owner: SYSTEM_PROGRAM_ADDRESS, data: [nonceAccountValue(ADVANCED_VALUE), "base64"] },
        slot: 5000,
      },
      status: { entry: null, slot: 4999 },
    });
    const { ctx, tx } = await trackTx(rpc, wire);
    expect(await pollSolana(ctx, tx)).toBeUndefined();
    // No rebroadcast either: the nonce may already be consumed.
    expect(rpc.calls.filter((c) => c === "sendTransaction")).toHaveLength(1);
  });

  it("an advanced nonce with a processed-only entry is not a drop", async () => {
    const { wire } = await durableWire();
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(wire));
    const rpc = mockRpc(signature, {
      account: {
        value: { owner: SYSTEM_PROGRAM_ADDRESS, data: [nonceAccountValue(ADVANCED_VALUE), "base64"] },
      },
      status: { entry: { confirmationStatus: "processed", err: null, slot: 5000 }, slot: 5000 },
    });
    const { ctx, tx } = await trackTx(rpc, wire);
    expect(await pollSolana(ctx, tx)).toBeUndefined();
  });

  it("a confirmed entry lands the transaction even while the nonce still holds", async () => {
    const { wire } = await durableWire();
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(wire));
    const rpc = mockRpc(signature, {
      account: {
        value: { owner: SYSTEM_PROGRAM_ADDRESS, data: [nonceAccountValue(NONCE_VALUE), "base64"] },
      },
      status: { entry: { confirmationStatus: "confirmed", err: null, slot: 5100 }, slot: 5100 },
    });
    const { ctx, tx } = await trackTx(rpc, wire);
    expect(await pollSolana(ctx, tx)).toStrictEqual({
      kind: "included",
      state: "confirmed",
      block: { height: 5100 },
      final: false,
    });
  });

  it("a closed nonce account reads as consumed and drops on a fresh status bank", async () => {
    const { wire } = await durableWire();
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(wire));
    const rpc = mockRpc(signature, {
      account: { value: null, slot: 5000 },
      status: { entry: null, slot: 5000 },
    });
    const { ctx, tx } = await trackTx(rpc, wire);
    expect(await pollSolana(ctx, tx)).toStrictEqual({ kind: "ended", state: "dropped" });
  });

  it("an unreadable nonce account keeps the poll open — the error is not a drop", async () => {
    const { wire } = await durableWire();
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(wire));
    const rpc = mockRpc(signature, {
      account: {
        value: { owner: "BPFLoaderUpgradeab1e11111111111111111111111", data: ["AA==", "base64"] },
      },
      status: { entry: null, slot: 5000 },
    });
    const { ctx, tx } = await trackTx(rpc, wire);
    await expect(pollSolana(ctx, tx)).rejects.toThrow("not owned by the System program");
  });
});

describe("durableNonceOfMessage", () => {
  it("detects the wire's durable nonce and leaves blockhash messages alone", async () => {
    const { wire, nonceAccount } = await durableWire();
    const messageBytes = new Uint8Array(getTransactionDecoder().decode(wire).messageBytes);
    expect(durableNonceOfMessage(messageBytes)).toStrictEqual({
      account: nonceAccount,
      value: NONCE_VALUE,
    });

    const plain = await blockhashWire();
    const plainBytes = new Uint8Array(getTransactionDecoder().decode(plain).messageBytes);
    expect(durableNonceOfMessage(plainBytes)).toBeUndefined();
  });

  it("AdvanceNonceAccount that is not instruction 0 does not make the message durable", async () => {
    const payer = await generateKeyPairSigner();
    const nonceAccount = await generateKeyPairSigner();
    const recipient = await generateKeyPairSigner();
    // Blockhash lifetime + a mid-list advance: instruction 0 is the transfer, not the nonce bump.
    const message = appendTransactionMessageInstructions(
      [
        getTransferSolInstruction({
          source: payer,
          destination: recipient.address,
          amount: 1,
        }),
        getAdvanceNonceAccountInstruction({
          nonceAccount: nonceAccount.address,
          nonceAuthority: payer,
        }),
      ],
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash(NONCE_VALUE), lastValidBlockHeight: 1000n },
        setTransactionMessageFeePayerSigner(
          payer,
          createTransactionMessage({ version: 0 }),
        ),
      ),
    );
    const compiled = new Uint8Array(
      getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message)),
    );
    expect(durableNonceOfMessage(compiled)).toBeUndefined();
  });
});

describe("a persisted durableNonce row", () => {
  const bootWith = async (row: Record<string, unknown>) => {
    const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
    backing.collections.set(
      "transactions",
      new Map([["tx-1", new TextEncoder().encode(JSON.stringify(row))]]),
    );
    const timers = manualTimers();
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks: new NetworkController({
        ...idleNetworkDeps,
        fetch: async () => Promise.reject(new Error("no fetch")),
        rpc: { [NETWORK]: ["http://host.local"] },
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        logger: { warn: () => {} },
      }),
      openStore: async () => Promise.resolve(createMemoryEngineStore(backing)),
      random: (n) => new Uint8Array(n).fill(1),
      setTimer: timers.setTimer,
      now: () => 0,
      logger: { warn: () => {} },
      pollMs: 4000,
    });
    await ctl.init();
    return ctl;
  };

  const ROW = {
    id: "tx-1",
    family: "solana",
    network: NETWORK,
    account: "w",
    hash: "sig",
    state: "submitted",
    nonce: 0,
    durableNonce: { account: "nonce-acc", value: NONCE_VALUE },
    submittedAt: 1,
  };

  it("round-trips through the store and drops a malformed record", async () => {
    const ctl = await bootWith(ROW);
    expect(ctl.getState().txs["tx-1"]?.durableNonce).toStrictEqual({
      account: "nonce-acc",
      value: NONCE_VALUE,
    });
    await ctl.destroy();

    const malformed = await bootWith({
      ...ROW,
      durableNonce: { account: "", value: NONCE_VALUE },
      lastValidBlockHeight: 7,
    });
    const tx = malformed.getState().txs["tx-1"];
    expect(tx?.durableNonce).toBeUndefined();
    expect(tx?.lastValidBlockHeight).toBe(7);
    await malformed.destroy();
  });
});
