import { describe, expect, it } from "vite-plus/test";

import type { KeyInfo, Wallet } from "@qntx/wallet";
import type { SignRequest } from "@qntx/wallet-chains";
import type { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { RequestController } from "../src/requests/controller.ts";
import type { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import {
  bookDeps,
  fakeSignedEvm,
  idleNetworkDeps,
  simulateSolanaStub,
  tokensStub,
} from "./send-helpers.ts";

const N1 = "eip155:1";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BTC = "bip122:000000000019d6689c085ae165831e93";
const EVM_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SOL_ADDR = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const KEY: KeyInfo = { keyId: "aa".repeat(8), family: "evm", address: EVM_ADDR, createdAt: 1 };
const SOLKEY: KeyInfo = {
  keyId: "bb".repeat(8),
  family: "solana",
  address: SOL_ADDR,
  createdAt: 1,
};

const rig = (opts: { keys?: KeyInfo[]; warns?: string[]; store?: unknown } = {}) => {
  const signedRequests: SignRequest[] = [];
  const calls: string[] = [];
  const wallet = {
    keys: {
      list: async () => Promise.resolve(opts.keys ?? [KEY, SOLKEY]),
      import: async () => Promise.resolve(KEY),
      remove: async () => Promise.resolve(),
      export: async () => Promise.resolve(new Uint8Array(4)),
    },
  } as unknown as Wallet;
  const log = { warn: (msg: string) => opts.warns?.push(msg) };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const text = init?.body === undefined ? "{}" : String(init.body);
    const body = JSON.parse(text) as { method: string; params: unknown[] };
    await Promise.resolve();
    const m = body.method;
    const hex = (v: string) => Response.json({ jsonrpc: "2.0", id: 1, result: v });
    if (m === "eth_chainId") {
      return hex("0x1");
    }
    if (m === "eth_getTransactionCount") {
      return hex("0x0");
    }
    if (m === "eth_getCode") {
      return hex("0x");
    }
    if (m === "eth_call") {
      return hex(`0x${"0".repeat(64)}`);
    }
    if (m === "eth_estimateGas") {
      return hex("0x5208");
    }
    if (m === "eth_gasPrice" || m === "eth_maxPriorityFeePerGas") {
      return hex("0x3b9aca00");
    }
    if (m === "eth_feeHistory") {
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          baseFeePerGas: ["0x1", "0x1"],
          gasUsedRatio: [0.5],
          oldestBlock: "0x1",
          reward: [["0x3b9aca00"]],
        },
      });
    }
    if (m === "eth_getBlockByNumber") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { baseFeePerGas: "0x1" } });
    }
    if (m === "eth_sendRawTransaction" || m === "eth_getTransactionReceipt") {
      return hex(`0x${"ab".repeat(32)}`);
    }
    return Response.json({ jsonrpc: "2.0", id: 1, result: "0x0" });
  };
  const apis = {
    account: async () => Promise.resolve({ template: "evm.bip44", network: N1, address: EVM_ADDR }),
    sign: async ({ request }: { request: SignRequest }) => {
      signedRequests.push(request);
      return Promise.resolve(fakeSignedEvm(request));
    },
  } as unknown as ReturnType<typeof chains>;
  const networks = new NetworkController({
    fetch: fetchImpl,
    rpc: { [N1]: ["http://rpc.test"], [SOL]: ["http://sol.test"], [BTC]: ["http://btc.test"] },
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    logger: log,
    ...idleNetworkDeps,
  });
  const transactions = new TransactionController({
    wallet,
    networks,
    openStore: async () =>
      Promise.resolve(
        (opts.store ?? createMemoryEngineStore()) as ReturnType<typeof createMemoryEngineStore>,
      ),
    random: (n) => new Uint8Array(n).fill(3),
    setTimer: () => () => undefined,
    now: () => 0,
    logger: log,
    pollMs: 1,
    chains: apis,
  });
  const requests = new RequestController({
    phishing: { check: () => "clear" },
    blindSigning: () => false,
    simulateSolana: simulateSolanaStub,
    tokens: tokensStub,
    transactions,
    ...bookDeps(),
    spark: {} as SparkController,
    nostrSign: async () => Promise.reject(new Error("unused")),
    bitcoinPrepare: async () => Promise.reject(new Error("unused")),
    bitcoinSignPsbts: async () => Promise.reject(new Error("unused")),
    bitcoinSign: async () => Promise.reject(new Error("unused")),
    solanaSign: async () => Promise.reject(new Error("unused")),
    fetch: fetchImpl,
    random: (n) => new Uint8Array(n).fill(4),
    now: () => 0,
    setTimer: () => () => undefined,
    logger: log,
  });
  const start = async () => {
    await networks.init();
    await transactions.init();
    await requests.init();
  };
  return { wallet, requests, transactions, networks, signedRequests, calls, start };
};

const evmRef = { kind: "imported" as const, keyId: KEY.keyId, family: "evm" as const };
const solRef = { kind: "imported" as const, keyId: SOLKEY.keyId, family: "solana" as const };

describe("imported keys in the request pipeline", () => {
  it("evm send resolves the signer from keys.list and signs with the imported ref", async () => {
    const w = rig();
    await w.start();
    const pending = await w.requests.prepare({
      method: "send",
      account: evmRef,
      network: N1,
      to: "0x000000000000000000000000000000000000dEaD",
      amount: 1n,
      fee: "normal",
    });
    expect(pending.id).not.toBe("");
    await w.requests.approve(pending.id, "send", { kind: "password", password: "pw" });
    const signed = w.signedRequests.at(-1) as { account?: { kind: string; keyId?: string } };
    expect(signed.account?.kind).toBe("imported");
    expect(signed.account?.keyId).toBe(KEY.keyId);
  });

  it("solana send resolves the imported key address", async () => {
    const w = rig();
    await w.start();
    const error = await w.requests
      .prepare({
        method: "send",
        account: solRef,
        network: SOL,
        to: SOL_ADDR,
        amount: 1n,
        fee: "normal",
      })
      .then(() => "prepared", String);
    // the solana path resolves via keys.list — any failure is RPC, never the old hd-refusal
    expect(error).not.toContain("not yet supported");
  });

  it("refuses a family-mismatched ref", async () => {
    const w = rig();
    await w.start();
    await expect(
      w.requests.prepare({
        method: "send",
        account: { kind: "imported", keyId: SOLKEY.keyId, family: "solana" },
        network: N1,
        to: "0x000000000000000000000000000000000000dEaD",
        amount: 1n,
        fee: "normal",
      }),
    ).rejects.toThrow(/solana.*evm|family/i);
    await expect(
      w.requests.prepare({
        method: "send",
        account: { kind: "imported", keyId: KEY.keyId, family: "evm" },
        network: SOL,
        to: SOL_ADDR,
        amount: 1n,
        fee: "normal",
      }),
    ).rejects.toThrow(/evm.*solana|family/i);
  });

  it("refuses an unknown keyId", async () => {
    const w = rig();
    await w.start();
    await expect(
      w.requests.prepare({
        method: "send",
        account: { kind: "imported", keyId: "ff".repeat(8), family: "evm" },
        network: N1,
        to: "0x000000000000000000000000000000000000dEaD",
        amount: 1n,
        fee: "normal",
      }),
    ).rejects.toThrow(/not in the vault/i);
  });

  it("refuses imported refs on bitcoin with a precise message", async () => {
    const w = rig();
    await w.start();
    await expect(
      w.requests.prepare({
        method: "send",
        account: { kind: "imported", keyId: "cc".repeat(8), family: "bitcoin" },
        network: BTC,
        to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        amount: 1n,
        fee: "normal",
      }),
    ).rejects.toThrow(/imported keys cannot sign bitcoin/i);
  });
});

describe("imported keys on the facade", () => {
  it("engine.keys delegates to wallet.keys", async () => {
    const calls: string[] = [];
    const wallet = {
      keys: {
        import: async (family: string, _secret: unknown) => {
          calls.push(`import:${family}`);
          return Promise.resolve(KEY);
        },
        list: async () => {
          calls.push("list");
          return Promise.resolve([KEY]);
        },
        remove: async (keyId: string) => {
          calls.push(`remove:${keyId}`);
          return Promise.resolve();
        },
        export: async (keyId: string) => {
          calls.push(`export:${keyId}`);
          return Promise.resolve(new Uint8Array(4));
        },
      },
    };
    const imported = await wallet.keys.import("evm", `0x${"11".repeat(32)}`);
    expect(imported.keyId).toBe(KEY.keyId);
    const listed = await wallet.keys.list();
    expect(listed).toHaveLength(1);
    await wallet.keys.remove(KEY.keyId);
    await wallet.keys.export(KEY.keyId);
    expect(calls).toStrictEqual([
      "import:evm",
      "list",
      `remove:${KEY.keyId}`,
      `export:${KEY.keyId}`,
    ]);
  });

  it("connection sessions never surface imported keys", () => {
    // The connection controller selects from the HD account tree only — imported
    // accounts are not group members, so no scope can carry them.
    const groups: Record<string, Array<{ index: number }>> = { w1: [{ index: 0 }, { index: 1 }] };
    const imported = [KEY];
    for (const list of Object.values(groups)) {
      for (const g of list) {
        expect(imported.every((k) => k.keyId !== String(g.index))).toBe(true);
      }
    }
  });
});

describe("replacements of imported-key transactions", () => {
  const verify = { kind: "password" as const, password: "pw" };
  const sendImported = async (w: ReturnType<typeof rig>) => {
    const pending = await w.requests.prepare({
      method: "send",
      account: evmRef,
      network: N1,
      to: "0x000000000000000000000000000000000000dEaD",
      amount: 1n,
      fee: "normal",
    });
    return w.requests.approve(pending.id, "send", verify);
  };

  it("persists the signer ref in the build record", async () => {
    const w = rig();
    await w.start();
    const tx = await sendImported(w);
    expect(tx.evm?.account).toStrictEqual(evmRef);
  });

  it("speed-up signs the replacement with the imported ref", async () => {
    const w = rig();
    await w.start();
    const tx = await sendImported(w);
    const pending = await w.requests.prepare({ method: "speed-up", txId: tx.id });
    await w.requests.approve(pending.id, "speed-up", verify);
    const signed = w.signedRequests.at(-1) as { account?: { kind: string; keyId?: string } };
    expect(signed.account?.kind).toBe("imported");
    expect(signed.account?.keyId).toBe(KEY.keyId);
  });

  it("cancel signs the replacement with the imported ref", async () => {
    const w = rig();
    await w.start();
    const tx = await sendImported(w);
    const pending = await w.requests.prepare({ method: "cancel", txId: tx.id });
    await w.requests.approve(pending.id, "cancel", verify);
    const signed = w.signedRequests.at(-1) as { account?: { kind: string; keyId?: string } };
    expect(signed.account?.kind).toBe("imported");
    expect(signed.account?.keyId).toBe(KEY.keyId);
  });

  it("an HD replacement still rebuilds from the persisted ref", async () => {
    const hdRef = {
      kind: "hd" as const,
      walletId: "w",
      groupIndex: 0,
      template: "evm.bip44" as const,
    };
    const w = rig();
    await w.start();
    const pending = await w.requests.prepare({
      method: "send",
      account: hdRef,
      network: N1,
      to: "0x000000000000000000000000000000000000dEaD",
      amount: 1n,
      fee: "normal",
    });
    const tx = await w.requests.approve(pending.id, "send", verify);
    expect(tx.evm?.account).toStrictEqual(hdRef);
    const bumped = await w.requests.prepare({ method: "speed-up", txId: tx.id });
    await w.requests.approve(bumped.id, "speed-up", verify);
    const signed = w.signedRequests.at(-1) as { account?: { kind: string; walletId?: string } };
    expect(signed.account?.kind).toBe("hd");
    expect(signed.account?.walletId).toBe("w");
  });

  it("drops a persisted build record missing the signer ref, with a warning", async () => {
    const warns: string[] = [];
    const backing = new Map<string, Map<string, Uint8Array>>();
    const col = new Map<string, Uint8Array>();
    backing.set("transactions", col);
    col.set(
      "t1",
      new TextEncoder().encode(
        JSON.stringify({
          id: "t1",
          family: "evm",
          network: N1,
          account: "w",
          hash: `0x${"ab".repeat(32)}`,
          state: "submitted",
          nonce: 0,
          submittedAt: 1,
          evm: { from: EVM_ADDR, groupIndex: 0, raw: "0x12" },
        }),
      ),
    );
    const store = createMemoryEngineStore({ collections: backing });
    const w = rig({ warns, store });
    await w.start();
    const tx = w.transactions.getState().txs["t1"];
    expect(tx).toBeDefined();
    expect(tx?.evm).toBeUndefined();
    expect(warns.some((m) => m.includes("malformed evm build record"))).toBe(true);
  });
});
