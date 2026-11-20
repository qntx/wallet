/**
 * R4 PoC — finding: "dApp-submitted Solana transactions are tracked as blockhash-expiring even
 * when the message uses a durable nonce". `submitDappSolana` stamps whatever
 * `lastValidBlockHeight` the caller computed and `pollSolana` declares `dropped` once the chain
 * tip passes it — but a durable-nonce transaction never expires by block height, so a live
 * transaction can be marked `dropped` while it is still executable. Expected-correct behaviour:
 * when the message's first instruction is System AdvanceNonceAccount the transaction must not
 * acquire blockhash expiry and must never be dropped by height. The test builds a real signed
 * transaction whose instruction 0 is AdvanceNonceAccount and whose lifetime constraint is a
 * durable nonce, submits it through `submitDappSolana` with a fake RouteContext, then polls.
 */
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingDurableNonce,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import type { Nonce } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import { decodeSolana, parseCompiledMessage } from "@qntx/wallet-chains/solana";

import type { SolanaRpc } from "../../src/networks/controller.ts";
import { pollSolana, submitDappSolana } from "../../src/transactions/solana.ts";
import type { RouteContext, TrackedTransaction } from "../../src/transactions/route.ts";

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
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

type MockRpc = SolanaRpc & { calls: Array<{ method: string; params: unknown[] }> };

/** Answers `sendTransaction` with the signature; epoch/status answers are wired per poll. */
const mockRpc = (signature: string): MockRpc => {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  return {
    calls,
    call: (method, params) => {
      calls.push({ method, params });
      switch (method) {
        case "sendTransaction":
          return Promise.resolve(signature);
        case "getEpochInfo":
          // The cluster tip: height 1001, one past the stored lastValidBlockHeight of 1000.
          return Promise.resolve({ absoluteSlot: 5000, blockHeight: 1001 });
        case "getSignatureStatuses":
          // No entry at any commitment — the poll reads it on a current bank (slot 5000).
          return Promise.resolve({ context: { slot: 5000 }, value: [null] });
        default:
          return Promise.reject(new Error(`unmocked ${method}`));
      }
    },
  };
};

const fakeCtx = (rpc: MockRpc) => {
  const rows = new Map<string, TrackedTransaction>();
  const tracked: string[] = [];
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
    track: (id) => {
      tracked.push(id);
    },
    txs: () => Object.fromEntries(rows),
    newId: () => "tx-1",
  };
  return { ctx, rows, tracked };
};

describe("a durable-nonce dApp transaction is treated as blockhash-expiring", () => {
  it("poll marks it dropped past lastValidBlockHeight although its lifetime cannot expire", async () => {
    const payer = await generateKeyPairSigner();
    const nonceAccount = await generateKeyPairSigner();
    const recipient = await generateKeyPairSigner();

    // A real message: [AdvanceNonceAccount(nonceAccount, authority=payer), Transfer(payer→dest)]
    // whose lifetime constraint is the durable nonce, not a blockhash.
    const message = setTransactionMessageLifetimeUsingDurableNonce(
      {
        nonce: nonceAccount.address as string as Nonce,
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

    // The message the dApp signed really does carry a System AdvanceNonceAccount first —
    // the wallet's own decoder could see the transaction's lifetime is a durable nonce.
    const compiled = getTransactionDecoder().decode(wire);
    const parsed = parseCompiledMessage(new Uint8Array(compiled.messageBytes));
    const ix0 = parsed.instructions[0];
    expect(ix0).toBeDefined();
    expect(parsed.staticAccounts[ix0?.programAddressIndex ?? -1]).toBe(SYSTEM_PROGRAM);
    expect(ix0?.data.length).toBe(4);
    expect(ix0?.data[0]).toBe(4); // SystemInstruction::AdvanceNonceAccount
    expect(parsed.staticAccounts[ix0?.accountIndices[0] ?? -1]).toBe(nonceAccount.address);
    expect(parsed.staticAccounts[ix0?.accountIndices[2] ?? -1]).toBe(payer.address);

    const decoded = decodeSolana(
      {
        kind: "solana.transaction",
        network: NETWORK,
        account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana.bip44" },
        message: new Uint8Array(compiled.messageBytes),
      },
      payer.address,
    );
    expect(decoded.verifiability).toBe("full"); // advance-nonce is a recognised full instruction

    // The engine submits it like any dApp transaction — with a blockhash-style expiry bound.
    const expectedSignature = getSignatureFromTransaction(compiled);
    const rpc = mockRpc(expectedSignature);
    const { ctx, rows } = fakeCtx(rpc);
    const signature = await submitDappSolana(ctx, {
      network: NETWORK,
      walletId: "w",
      wire,
      lastValidBlockHeight: 1000n,
      intent: DAPP_INTENT,
    });
    expect(signature).toBe(expectedSignature);
    expect(rpc.calls.some((c) => c.method === "sendTransaction")).toBe(true);

    const tx = rows.get("tx-1");
    expect(tx?.state).toBe("submitted");
    // The stored row carries the blockhash bound, although the wire message carries a nonce.
    expect(tx?.lastValidBlockHeight).toBe(1000);
    expect(tx?.hash).toBe(signature);

    // One poll past the bound with no status entry: declared `dropped` — yet a durable-nonce
    // transaction is still executable at any height; nothing on-chain invalidated it.
    const state = await pollSolana(ctx, tx ?? ({} as TrackedTransaction));
    expect(state).toBe("dropped");
    expect(
      rpc.calls.filter((c) => c.method === "getEpochInfo" || c.method === "getSignatureStatuses"),
    ).toHaveLength(2);
  });
});
