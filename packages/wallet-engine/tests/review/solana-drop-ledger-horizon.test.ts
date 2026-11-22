// oxlint-disable vitest/no-conditional-in-test -- union narrowing and mocked fetches are inherent
// A blockhash-bound transaction is ended `dropped` on evidence a node can produce for a
// transaction that actually landed long ago: `getSignatureStatuses(searchTransactionHistory)`
// only reaches back as far as the node's ledger, so a node without BigTable answers `null` — and
// the host re-check runs the same query, so it "agrees". The durable-nonce proof guards exactly
// this with the nonce account's signature history; the blockhash proof has no equivalent.

import { getTransferSolInstruction } from "@solana-program/system";
import {
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import type { SolanaRpc } from "../../src/networks/controller.ts";
import type { RouteContext, TrackedTransaction } from "../../src/transactions/route.ts";
import { pollSolana, submitDappSolana } from "../../src/transactions/solana.ts";

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const LIFETIME = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const NOW = 1_800_000_000_000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
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
      { blockhash: blockhash(LIFETIME), lastValidBlockHeight: 1000n },
      setTransactionMessageFeePayer(payer.address, createTransactionMessage({ version: 0 })),
    ),
  );
  return new Uint8Array(
    getTransactionEncoder().encode(await signTransactionMessageWithSigners(message)),
  );
};

type MockRpc = SolanaRpc & { calls: string[] };

/* Every read the poll makes, answered like a node whose ledger no longer reaches the landing
   slot: the tip is far past the bound, the blockhash is dead, and the status lookup — bounded by
   the node's own history — has no entry even though the transaction did land. */
const staleLedgerRpc = (signature: string): MockRpc => {
  const calls: string[] = [];
  return {
    calls,
    call: async (method, _params) => {
      calls.push(method);
      switch (method) {
        case "sendTransaction":
          return Promise.resolve(signature);
        case "getEpochInfo":
          return Promise.resolve({ absoluteSlot: 2_000_000, blockHeight: 1_900_000 });
        case "isBlockhashValid":
          return Promise.resolve({ context: { slot: 2_000_000 }, value: false });
        case "getSignatureStatuses":
          return Promise.resolve({ context: { slot: 2_000_001 }, value: [null] });
        default:
          return Promise.reject(new Error(`unmocked ${method}`));
      }
    },
  };
};

const rig = (gateway: MockRpc, host: MockRpc) => {
  const rows = new Map<string, TrackedTransaction>();
  const ctx: RouteContext = {
    options: {
      wallet: {} as Wallet,
      networks: {
        solanaRpc: () => gateway,
        pinnedSolanaRpc: () => gateway,
        // The host endpoint exists and answers the same way — the re-check "agrees".
        independentPinnedSolanaRpc: () => ({ kind: "available", client: host }),
      } as unknown as RouteContext["options"]["networks"],
      openStore: async () => {
        await Promise.resolve();
        throw new Error("no store in this rig");
      },
      random: (n) => new Uint8Array(n).fill(9),
      setTimer: () => () => undefined,
      now: () => NOW,
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

describe("a blockhash-bound transaction dropped beyond the node's ledger horizon", () => {
  it("ends dropped on the first poll — the host re-check repeats the same blind query", async () => {
    const wire = await blockhashWire();
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(wire));
    const gateway = staleLedgerRpc(signature);
    const host = staleLedgerRpc(signature);
    const { ctx, rows } = rig(gateway, host);
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
    expect(sig).toBe(signature);
    /* Tracked three days ago; the transaction in fact landed then — every answer below is what a
       node without the ledger depth reports about it. */
    const old = { ...tx, submittedAt: NOW - THREE_DAYS_MS };
    const state = await pollSolana(ctx, old, new Map());
    expect(state).toStrictEqual({ kind: "ended", state: "dropped" });
    /* The claim was proven on the pinned upstream, then "corroborated" by the host running the
       identical reads — no second vantage point, just the same horizon. */
    expect(gateway.calls.filter((c) => c !== "sendTransaction")).toStrictEqual([
      "getEpochInfo",
      "isBlockhashValid",
      "getSignatureStatuses",
    ]);
    expect(host.calls).toStrictEqual(["getEpochInfo", "isBlockhashValid", "getSignatureStatuses"]);
  });
});
