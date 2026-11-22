// When the gateway fails on the poll's first read, `pinnedSolanaRpc` silently pins the host
// endpoint — the same endpoint `settleSolanaDrop` then "independently" re-proves the claim on.
// The host's `dropped` claim is corroborated by itself, so the row ends `dropped` on the first
// poll, skipping the corroboration streak a host-only configuration needs for identical answers.

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
import { pinnedSolanaCaller } from "../../src/networks/controller.ts";
import type { RouteContext, TrackedTransaction } from "../../src/transactions/route.ts";
import { pollSolana, submitDappSolana } from "../../src/transactions/solana.ts";

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const LIFETIME = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const GATEWAY_URL = "https://gateway.test/solana";
const HOST_URL = "https://host.invalid";
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

type Call = { readonly url: string; readonly method: string };

const staleResult = (method: string, signature: string): unknown => {
  switch (method) {
    case "sendTransaction":
      return signature;
    case "getEpochInfo":
      return { absoluteSlot: 2_000_000, blockHeight: 1_900_000 };
    case "isBlockhashValid":
      return { context: { slot: 2_000_000 }, value: false };
    case "getSignatureStatuses":
      return { context: { slot: 2_000_001 }, value: [null] };
    default:
      throw new Error(`unmocked ${method}`);
  }
};

/* Every URL in `dead` answers HTTP 503 with a non-JSON body; the rest answer like a node whose
   ledger no longer reaches the landing slot — tip far past the bound, dead blockhash, no status
   entry — the identical picture on every endpoint. */
const fetchStub = (
  calls: Call[],
  dead: ReadonlySet<string>,
  signature: string,
): typeof globalThis.fetch => {
  return async (input, init) => {
    await Promise.resolve();
    const url = String(input);
    const body: unknown = JSON.parse(String(init?.body));
    const method = (body as { method?: string }).method ?? "";
    calls.push({ url, method });
    if (dead.has(url)) {
      return new Response("upstream unavailable", { status: 503 });
    }
    return Response.json({ jsonrpc: "2.0", id: 1, result: staleResult(method, signature) });
  };
};

const rig = (networks: {
  solanaRpc: () => SolanaRpc;
  pinnedSolanaRpc: () => SolanaRpc;
  independentPinnedSolanaRpc: () => unknown;
}) => {
  const rows = new Map<string, TrackedTransaction>();
  const ctx: RouteContext = {
    options: {
      wallet: {} as Wallet,
      networks: networks as unknown as RouteContext["options"]["networks"],
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

const submitAged = async (
  ctx: RouteContext,
  rows: Map<string, TrackedTransaction>,
  wire: Uint8Array,
  signature: string,
): Promise<TrackedTransaction> => {
  const sig = await submitDappSolana(ctx, {
    network: NETWORK,
    walletId: "w",
    wire,
    lastValidBlockHeight: 1000n,
    intent: DAPP_INTENT,
  });
  expect(sig).toBe(signature);
  const tx = rows.get("tx-1");
  if (tx === undefined) {
    throw new Error("the dApp send did not track its transaction");
  }
  /* Tracked three days ago; the transaction in fact landed then. */
  return { ...tx, submittedAt: NOW - THREE_DAYS_MS };
};

describe("a poll that fails over to the host the drop proof then consults", () => {
  it("ends dropped on the first poll — the host corroborates its own claim", async () => {
    const wire = await blockhashWire();
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(wire));
    const calls: Call[] = [];
    const fetchFn = fetchStub(calls, new Set([GATEWAY_URL]), signature);
    /* The real failover clients over the real endpoint lists — gateway first, host behind it. */
    const { ctx, rows } = rig({
      solanaRpc: () => pinnedSolanaCaller([GATEWAY_URL, HOST_URL], fetchFn),
      pinnedSolanaRpc: () => pinnedSolanaCaller([GATEWAY_URL, HOST_URL], fetchFn),
      independentPinnedSolanaRpc: () => ({
        kind: "available",
        client: pinnedSolanaCaller([HOST_URL], fetchFn),
      }),
    });
    const tx = await submitAged(ctx, rows, wire, signature);
    /* The gateway dies on the poll's first read; the pinned client fails over to the host and
       every subsequent read — and then the whole "independent" re-proof — hits that same host. */
    const state = await pollSolana(ctx, tx, new Map());
    expect(state).toStrictEqual({ kind: "ended", state: "dropped" });
    expect(calls).toStrictEqual([
      { url: GATEWAY_URL, method: "sendTransaction" },
      { url: HOST_URL, method: "sendTransaction" },
      { url: GATEWAY_URL, method: "getEpochInfo" },
      { url: HOST_URL, method: "getEpochInfo" },
      { url: HOST_URL, method: "isBlockhashValid" },
      { url: HOST_URL, method: "getSignatureStatuses" },
      /* The "independent" corroboration: the identical three reads on the identical upstream. */
      { url: HOST_URL, method: "getEpochInfo" },
      { url: HOST_URL, method: "isBlockhashValid" },
      { url: HOST_URL, method: "getSignatureStatuses" },
    ]);
  });

  it("the same answers with the host as the only endpoint stay tracked", async () => {
    const wire = await blockhashWire();
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(wire));
    const calls: Call[] = [];
    const fetchFn = fetchStub(calls, new Set(), signature);
    /* Host-only configuration: no gateway heads the list, so there is no second vantage point
       and the same claim must earn the corroboration streak instead. */
    const { ctx, rows } = rig({
      solanaRpc: () => pinnedSolanaCaller([HOST_URL], fetchFn),
      pinnedSolanaRpc: () => pinnedSolanaCaller([HOST_URL], fetchFn),
      independentPinnedSolanaRpc: () => ({ kind: "not-needed" }),
    });
    const tx = await submitAged(ctx, rows, wire, signature);
    const evidence = new Map();
    /* Identical reads, identical claim — but the streak needs three polls spanning more than
       one processing age, so this poll and the next two settle nothing. */
    await expect(pollSolana(ctx, tx, evidence)).resolves.toBeUndefined();
    await expect(pollSolana(ctx, tx, evidence)).resolves.toBeUndefined();
    await expect(pollSolana(ctx, tx, evidence)).resolves.toBeUndefined();
    expect(evidence.get("tx-1")).toStrictEqual({ since: NOW, polls: 3 });
    expect(rows.get("tx-1")?.state).toBe("submitted");
  });
});
