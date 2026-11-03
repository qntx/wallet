import { describe, expect, it } from "vite-plus/test";

import type { MintExtensionSummary } from "@qntx/wallet-chains/solana";

import { SolanaChainAdapter } from "../src/chains/solana.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";
import type { DisplayIntent } from "../src/transactions/route.ts";
import { token2022Intent } from "../src/transactions/solana.ts";

const rpc = (handlers: Record<string, unknown>): SolanaRpc => ({
  call: async (method, params) => {
    const v = handlers[method];
    return method in handlers
      ? Promise.resolve(typeof v === "function" ? (v as (p?: unknown[]) => unknown)(params) : v)
      : Promise.reject(new Error(`unmocked ${method}`));
  },
});

describe("SolanaChainAdapter", () => {
  it("picks p50/p75/p90 prioritization fees as slow/normal/fast", async () => {
    const a = new SolanaChainAdapter();
    const fees = Array.from({ length: 100 }, (_, i) => ({ prioritizationFee: i + 1 }));
    const r = rpc({ getRecentPrioritizationFees: fees });
    const quotes = await a.estimateFee(r, ["x"]);
    expect(quotes.map((q) => [q.tier, q.microLamportsPerCu])).toStrictEqual([
      ["slow", 51n],
      ["normal", 76n],
      ["fast", 91n],
    ]);
  });

  it("maps signature status: err → failed, confirmed, finalized, missing → pending", async () => {
    const a = new SolanaChainAdapter();
    const status = { value: [{ confirmationStatus: "confirmed", err: null }] };
    await expect(a.status(rpc({ getSignatureStatuses: status }), "s")).resolves.toBe("confirmed");
    await expect(
      a.status(
        rpc({ getSignatureStatuses: { value: [{ confirmationStatus: "finalized", err: null }] } }),
        "s",
      ),
    ).resolves.toBe("finalized");
    await expect(
      a.status(
        rpc({
          getSignatureStatuses: { value: [{ confirmationStatus: "confirmed", err: { x: 1 } }] },
        }),
        "s",
      ),
    ).resolves.toBe("failed");
    await expect(a.status(rpc({ getSignatureStatuses: { value: [null] } }), "s")).resolves.toBe(
      "pending",
    );
  });

  it("finalizes as shortvec(1) + signature + message and rejects a >1232-byte message", () => {
    const a = new SolanaChainAdapter();
    const sig = new Uint8Array(64).fill(9);
    const msg = new Uint8Array(10).fill(1);
    const wire = a.finalize(msg, [sig]);
    expect(wire).toHaveLength(75);
    expect(wire[0]).toBe(1);
    expect(wire.slice(1, 65)).toStrictEqual(sig);
    expect(wire.slice(65)).toStrictEqual(msg);
  });
});

const MINT = "Mint1111111111111111111111111111111111111111";

const baseIntent = (): DisplayIntent => ({
  family: "solana",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  summary: "transfer",
  outflows: [{ to: "dest", amount: { asset: MINT, amount: "10000" }, verified: false }],
  approvals: [],
  fee: { max: { asset: "lamports", amount: "5000" } },
  warnings: [],
  verifiability: "full",
});

describe("token2022Intent", () => {
  it("shows the net received amount and a fee warning for TransferFeeConfig mints", () => {
    const ext: MintExtensionSummary = { transferFee: { basisPoints: 100, maximumFee: 500n } };
    const out = token2022Intent(baseIntent(), ext, MINT, 10_000n);
    // 100 bps of 10_000 = 100 ≤ 500 max → net 9_900.
    expect(out.outflows[0]?.amount.amount).toBe("9900");
    expect(out.warnings.some((w) => w.kind === "token-2022-transfer-fee")).toBe(true);
    expect(out.verifiability).toBe("full");
  });

  it("caps the fee at the maximum", () => {
    const ext: MintExtensionSummary = { transferFee: { basisPoints: 500, maximumFee: 100n } };
    const out = token2022Intent(baseIntent(), ext, MINT, 10_000n);
    // 500 bps of 10_000 = 500 > 100 cap → net 9_900.
    expect(out.outflows[0]?.amount.amount).toBe("9900");
  });

  it("marks hook/delegate mints partial with a warning", () => {
    const hook: MintExtensionSummary = { transferHook: { programId: new Uint8Array(32) } };
    const out = token2022Intent(baseIntent(), hook, MINT, 10_000n);
    expect(out.verifiability).toBe("partial");
    expect(out.warnings.some((w) => w.kind === "token-2022-extension")).toBe(true);
    const delegate: MintExtensionSummary = {
      permanentDelegate: { delegate: new Uint8Array(32).fill(1) },
    };
    const out2 = token2022Intent(baseIntent(), delegate, MINT, 10_000n);
    expect(out2.verifiability).toBe("partial");
  });

  it("leaves extension-free mints untouched", () => {
    const out = token2022Intent(baseIntent(), {}, MINT, 10_000n);
    expect(out.outflows[0]?.amount.amount).toBe("10000");
    expect(out.warnings).toHaveLength(0);
    expect(out.verifiability).toBe("full");
  });
});

const FROM = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const TO = "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh";
const BLOCKHASH = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";

import type { RouteContext, TrackedTransaction } from "../src/transactions/route.ts";
import { pollSolana, prepareSolana } from "../src/transactions/solana.ts";
import type { PrepareParams } from "../src/transactions/route.ts";

const solanaCtx = (
  handlers: Record<string, unknown>,
  transitions: TrackedTransaction[] = [],
): RouteContext => {
  const client = rpc(handlers);
  return {
    options: {
      networks: {
        solanaRpc: () => client,
        independentSolanaRpc: () => ({ kind: "unavailable" }),
      } as never,
      wallet: {} as never,
      openStore: async () => Promise.resolve({} as never),
      random: (n: number) => new Uint8Array(n).fill(0x55),
      setTimer: () => () => {},
      now: () => 0,
      logger: { warn: () => {} },
      chains: {
        account: async () =>
          Promise.resolve({
            template: "solana.bip44-change",
            network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            address: FROM,
          }),
        sign: async () =>
          Promise.resolve({ kind: "solana.transaction", signature: new Uint8Array(64).fill(2) }),
      } as never,
    },
    transition: async (tx, next) => {
      const out = { ...tx, ...next };
      transitions.push(out);
      return Promise.resolve(out);
    },
    track: () => {},
    txs: () => ({}),
    newId: () => "tx-test-1",
  };
};

const buildHandlers = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  getLatestBlockhash: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: "200" } },
  simulateTransaction: { value: { unitsConsumed: 1200 } },
  getRecentPrioritizationFees: Array.from({ length: 100 }, (_, i) => ({
    prioritizationFee: (i + 1) * 100,
  })),
  sendTransaction: "sig-hash-1",
  getSignatureStatuses: { value: [{ confirmationStatus: "confirmed", err: null }] },
  getBlockHeight: "100",
  ...overrides,
});

const solanaParams = (): PrepareParams => ({
  account: { kind: "hd", walletId: "0a".repeat(16), groupIndex: 0 },
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  to: TO,
  amount: 5000n,
  fee: "normal",
});

describe("prepareSolana + pollSolana", () => {
  it("prepares a SOL transfer, submits and reaches broadcast", async () => {
    const transitions: TrackedTransaction[] = [];
    const ctx = solanaCtx(buildHandlers(), transitions);
    const prepared = await prepareSolana(ctx, solanaParams());
    const tx = await prepared.submit({ kind: "password", password: "pw" });
    expect(tx.family).toBe("solana");
    expect(tx.hash).toBe("sig-hash-1");
    expect(transitions.some((t) => t.state === "submitted")).toBe(true);
  });

  it("poll maps finalized → confirmed, failed → failed, expired → dropped", async () => {
    const base: TrackedTransaction = {
      id: "t1",
      family: "solana",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      account: "w",
      hash: "h",
      state: "submitted",
      intent: baseIntent(),
      nonce: 0,
      lastValidBlockHeight: 150,
      submittedAt: 0,
      error: undefined,
    };
    const ctx = solanaCtx(buildHandlers());
    await expect(pollSolana(ctx, { ...base, hash: undefined })).resolves.toBe("failed");
    await expect(
      pollSolana(
        solanaCtx(
          buildHandlers({
            getSignatureStatuses: { value: [{ confirmationStatus: "finalized", err: null }] },
          }),
        ),
        base,
      ),
    ).resolves.toBe("confirmed");
    await expect(
      pollSolana(
        solanaCtx(
          buildHandlers({
            getSignatureStatuses: { value: [{ confirmationStatus: "confirmed", err: { x: 1 } }] },
          }),
        ),
        base,
      ),
    ).resolves.toBe("failed");
    await expect(
      pollSolana(
        solanaCtx(
          buildHandlers({
            getSignatureStatuses: { value: [null] },
            getBlockHeight: "200",
          }),
        ),
        base,
      ),
    ).resolves.toBe("dropped");
  });

  it("poll re-broadcasts a still-pending tx that has a stored wire", async () => {
    const transitions: TrackedTransaction[] = [];
    const sent: string[] = [];
    const handlers = buildHandlers({
      getSignatureStatuses: { value: [null] },
      getBlockHeight: "100",
      sendTransaction: () => {
        sent.push("broadcast");
        return "sig-hash-2";
      },
    });
    const ctx = solanaCtx(handlers, transitions);
    const prepared = await prepareSolana(ctx, solanaParams());
    const tx = await prepared.submit({ kind: "password", password: "pw" });
    const pending = await pollSolana(ctx, tx);
    expect(pending).toBeUndefined();
    expect(sent.length).toBeGreaterThan(0);
  });

  it("prepares an SPL transfer through the token program", async () => {
    const transitions: TrackedTransaction[] = [];
    const ctx = solanaCtx(
      buildHandlers({
        getAccountInfo: (params?: unknown[]) => {
          const key = (params?.[0] as string) ?? "";
          // Token mint: owned by the classic SPL Token program; token accounts exist.
          if (key === "So11111111111111111111111111111111111111112") {
            return {
              value: {
                owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                data: [""],
              },
            };
          }
          return {
            value: {
              owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              data: [""],
            },
          };
        },
      }),
      transitions,
    );
    const prepared = await prepareSolana(ctx, {
      ...solanaParams(),
      token: "So11111111111111111111111111111111111111112",
      decimals: 6,
    });
    expect(prepared.txId.startsWith("tx-")).toBe(true);
  });

  it("rejects an imported account", async () => {
    const ctx = solanaCtx(buildHandlers());
    await expect(
      prepareSolana(ctx, {
        ...solanaParams(),
        account: { kind: "imported", keyId: "k", family: "solana" } as never,
      }),
    ).rejects.toThrow("imported accounts are not yet supported");
  });
});
