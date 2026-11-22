import { numberToHex, toFunctionSelector } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import type { chains } from "@qntx/wallet/chains";

import { L1_SLOT_MS, l1FeeBound } from "../src/chains/evm.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import { approval } from "./approval.ts";
import { fakeSignedEvm, idleNetworkDeps, requestsFor } from "./send-helpers.ts";

const HOST = "http://host.local";
const ADDR = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const BASE = "eip155:8453";
const SCROLL = "eip155:534352";
const VERIFY = { kind: "password" as const, password: "pw" };
const GET_L1_FEE = toFunctionSelector("getL1Fee(bytes)");
const GET_OPERATOR_FEE = toFunctionSelector("getOperatorFee(uint256)");

type Node = {
  l1: bigint | "fail";
  operator: bigint;
  calls: Array<{ to: string; data: string }>;
  methods: string[];
};
const newNode = (l1: bigint | "fail" = 0n, operator = 0n): Node => ({
  l1,
  operator,
  calls: [],
  methods: [],
});

const answer = (node: Node, method: string, params: unknown[]): unknown => {
  switch (method) {
    case "eth_getTransactionCount":
      return "0x0";
    case "eth_estimateGas":
      return "0x5208";
    case "eth_gasPrice":
      return "0x7";
    case "eth_feeHistory":
      return {
        baseFeePerGas: ["0x1", "0x1"],
        reward: [
          ["0x1", "0x2", "0x3"],
          ["0x1", "0x2", "0x3"],
        ],
      };
    case "eth_sendRawTransaction":
      return `0x${"ab".repeat(32)}`;
    case "eth_call": {
      const { to, data } = params[0] as { to: string; data: string };
      node.calls.push({ to, data });
      if (node.l1 === "fail") {
        throw new Error("oracle unavailable");
      }
      if (data.startsWith(GET_L1_FEE)) {
        return numberToHex(node.l1, { size: 32 });
      }
      if (data.startsWith(GET_OPERATOR_FEE)) {
        return numberToHex(node.operator, { size: 32 });
      }
      throw new Error("unexpected call");
    }
    default:
      throw new Error(`unmocked ${method}`);
  }
};

/**
 * The l1-fee world with a clock the test controls: `now` starts at 1000 and `signDelay` is added to
 * it inside the sign call — the signature takes that long.
 */
const world = (options: { signDelay?: number } = {}) => {
  const primary = newNode();
  let now = 1000;

  const fetchImpl: typeof fetch = async (input, init) => {
    void input;
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      method: string;
      params?: unknown[];
    };
    primary.methods.push(body.method);
    const reply = ((): { result: unknown } | { error: { code: number; message: string } } => {
      try {
        return { result: answer(primary, body.method, body.params ?? []) };
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed";
        return { error: { code: message.startsWith("unmocked") ? -32601 : -1, message } };
      }
    })();
    return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, ...reply }));
  };

  const signed: Array<Parameters<typeof fakeSignedEvm>[0]> = [];
  const apis = {
    account: async () => Promise.resolve({ template: "evm.bip44", network: BASE, address: ADDR }),
    sign: async ({ request }: { request: Parameters<typeof fakeSignedEvm>[0] }) => {
      signed.push(request);
      now += options.signDelay ?? 0;
      return Promise.resolve(fakeSignedEvm(request));
    },
  } as unknown as ReturnType<typeof chains>;

  const boot = async () => {
    const networks = new NetworkController({
      ...idleNetworkDeps,
      fetch: fetchImpl,
      rpc: {
        [BASE]: [HOST],
        [SCROLL]: [HOST],
      },
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      logger: { warn: () => {} },
    });
    const ctl = new TransactionController({
      wallet: {} as Wallet,
      networks,
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      random: (n) => new Uint8Array(n).fill(7),
      setTimer: () => () => {},
      now: () => now,
      logger: { warn: () => {} },
      pollMs: 1,
      chains: apis,
    });
    await ctl.init();
    return ctl;
  };
  return { primary, signed, boot };
};

const params = (network: string, amount: bigint) => ({
  account: { kind: "hd" as const, walletId: "w", groupIndex: 0, template: "evm.bip44" as const },
  network,
  to: "0x00000000000000000000000000000000deadbeef",
  amount,
  fee: "normal" as const,
});

const nonceOf = (request: Parameters<typeof fakeSignedEvm>[0] | undefined): bigint => {
  if (request === undefined || request.kind !== "evm.transaction") {
    throw new Error("expected an evm transaction request");
  }
  return BigInt(request.tx.nonce);
};

describe("l1FeeBound", () => {
  it("is ceil(raw × (9/8)^updates)", () => {
    expect(l1FeeBound(0n, 0)).toBe(0n);
    expect(l1FeeBound(0n, 5)).toBe(0n);
    expect(l1FeeBound(1000n, 0)).toBe(1000n);
    expect(l1FeeBound(1000n, 1)).toBe(1125n);
    expect(l1FeeBound(1000n, 2)).toBe(1266n);
    expect(l1FeeBound(1000n, 3)).toBe(1424n);
    expect(l1FeeBound(512n, 3)).toBe(729n);
    expect(l1FeeBound(1001n, 3)).toBe(1426n);
  });

  it("always rounds up", () => {
    expect(l1FeeBound(1n, 1)).toBe(2n);
    expect(l1FeeBound(8n, 1)).toBe(9n);
    expect(l1FeeBound(9n, 1)).toBe(11n);
  });

  it("counts one L1 slot as 12 seconds", () => {
    expect(L1_SLOT_MS).toBe(12_000);
  });
});

describe("the shown L1 fee bound", () => {
  it("displays l1FeeBound(raw, 3) plus the operator fee on OP Stack", async () => {
    const w = world();
    w.primary.l1 = 1000n;
    w.primary.operator = 234n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    expect(prepared.intent.fee?.l1Data).toStrictEqual({
      asset: "native",
      amount: (l1FeeBound(1000n, 3) + 234n).toString(10),
    });
  });

  it("displays l1FeeBound(raw, 3) on Scroll", async () => {
    const w = world();
    w.primary.l1 = 1000n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(SCROLL, 1n), "req-1");
    expect(prepared.intent.fee?.l1Data?.amount).toBe(l1FeeBound(1000n, 3).toString(10));
  });
});

describe("the L1 fee re-read at approval", () => {
  it("signs after a 10% rise the shown bound still covers", async () => {
    const w = world();
    w.primary.l1 = 1000n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    w.primary.l1 = 1100n;
    await expect(prepared.staleReason()).resolves.toBeUndefined();
    const tx = await prepared.submit(VERIFY, () => undefined);
    expect(w.signed).toHaveLength(1);
    expect(tx.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(w.primary.methods).toContain("eth_sendRawTransaction");
  });

  it("fails the request after a 13% rise the bound cannot cover — nothing is signed", async () => {
    const w = world();
    w.primary.l1 = 1000n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    w.primary.l1 = 1130n;
    await expect(prepared.staleReason()).resolves.toBe("the L1 data fee rose — start over");
    expect(w.signed).toHaveLength(0);
    expect(w.primary.methods).not.toContain("eth_sendRawTransaction");
  });

  it("ends the request with the stale reason through approve", async () => {
    const w = world();
    w.primary.l1 = 1000n;
    const ctl = await w.boot();
    const requests = await requestsFor(ctl);
    const request = await requests.prepare({ method: "send", ...params(BASE, 1n) });
    w.primary.l1 = 1130n;
    await expect(requests.approve(request.id, "send", approval(request, VERIFY))).rejects.toThrow(
      "the L1 data fee rose — start over",
    );
    expect(w.signed).toHaveLength(0);
  });

  it("refuses a signature on an unverifiable re-read", async () => {
    const w = world();
    w.primary.l1 = 1000n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    w.primary.l1 = "fail";
    await expect(prepared.staleReason()).resolves.toBe(
      "the L1 data fee could not be re-read — start over",
    );
    expect(w.signed).toHaveLength(0);
  });

  /* The blob-spike PoC: a quote read at prepare (1.0 unit) is signed over an L1 price of 1.3.
     The old once-read 5/4 bound displayed 1250 < the actual 1300 and signed it. */
  it("refuses the blob-spike reprice the once-read 5/4 bound signed", async () => {
    const w = world();
    w.primary.l1 = 1000n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    w.primary.l1 = 1300n;
    await expect(prepared.staleReason()).resolves.toBe("the L1 data fee rose — start over");
    expect(w.signed).toHaveLength(0);
    expect(w.primary.methods).not.toContain("eth_sendRawTransaction");
  });

  it("applies the same approval rule to a replacement", async () => {
    const w = world();
    w.primary.l1 = 1000n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    const original = await prepared.submit(VERIFY, () => undefined);
    const replacement = await ctl.prepareReplacement(
      { method: "speed-up", txId: original.id },
      "req-2",
    );
    w.primary.l1 = 1130n;
    await expect(replacement.staleReason()).resolves.toBe("the L1 data fee rose — start over");
  });
});

describe("the L1 fee check before broadcast", () => {
  it("trusts a fresh approval read when the signature took under one L1 slot", async () => {
    const w = world({ signDelay: 11_000 });
    w.primary.l1 = 1000n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    await expect(prepared.staleReason()).resolves.toBeUndefined();
    const callsAtSign = w.primary.calls.length;
    const tx = await prepared.submit(VERIFY, () => undefined);
    expect(tx.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(w.primary.calls).toHaveLength(callsAtSign);
  });

  it("re-reads once when the signature took longer than one L1 slot, then broadcasts", async () => {
    const w = world({ signDelay: 13_000 });
    w.primary.l1 = 1000n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    await expect(prepared.staleReason()).resolves.toBeUndefined();
    const callsAtSign = w.primary.calls.length;
    const tx = await prepared.submit(VERIFY, () => undefined);
    expect(tx.hash).toMatch(/^0x[0-9a-f]{64}$/);
    /* One extra oracle read (getL1Fee + getOperatorFee) between the signature and broadcast. */
    expect(w.primary.calls).toHaveLength(callsAtSign + 2);
    expect(w.primary.methods).toContain("eth_sendRawTransaction");
  });

  it("fails without broadcasting when the re-read priced a rise — the nonce is free again", async () => {
    const w = world({ signDelay: 13_000 });
    w.primary.l1 = 1000n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    await expect(prepared.staleReason()).resolves.toBeUndefined();
    w.primary.l1 = 1130n;
    await expect(prepared.submit(VERIFY, () => undefined)).rejects.toThrow(
      "the L1 data fee rose — start over",
    );
    expect(w.primary.methods).not.toContain("eth_sendRawTransaction");
    const failed = ctl.getState().txs[prepared.txId];
    expect(failed?.state).toBe("failed");
    expect(failed?.hash).toBeUndefined();

    w.primary.l1 = 1000n;
    const next = await ctl.prepareSend(params(BASE, 1n), "req-2");
    await next.submit(VERIFY, () => undefined);
    expect(w.signed).toHaveLength(2);
    const [, second] = w.signed;
    expect(nonceOf(second)).toBe(0n);
    expect(w.primary.methods).toContain("eth_sendRawTransaction");
  });

  it("fails without broadcasting when the late re-read fails", async () => {
    const w = world({ signDelay: 13_000 });
    w.primary.l1 = 1000n;
    const ctl = await w.boot();
    const prepared = await ctl.prepareSend(params(BASE, 1n), "req-1");
    await expect(prepared.staleReason()).resolves.toBeUndefined();
    w.primary.l1 = "fail";
    await expect(prepared.submit(VERIFY, () => undefined)).rejects.toThrow(
      "the L1 data fee rose — start over",
    );
    expect(w.primary.methods).not.toContain("eth_sendRawTransaction");
  });
});
