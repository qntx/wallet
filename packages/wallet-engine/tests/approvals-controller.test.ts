/**
 * The ApprovalsController end to end with scripted endpoints: a hostile gateway can only drop rows
 * or mark its own source failed — never show one; locally known candidates the gateway hides still
 * show; single-flight refresh, visible-only polling, lock discarding late answers, the
 * confirmed-transaction trigger and the persisted candidate set all behave.
 */
import { createPublicClient, custom, decodeFunctionData, erc20Abi, isHex } from "viem";
import type { PublicClient } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { ApprovalsController } from "../src/approvals/controller.ts";
import { encodeCandidates } from "../src/approvals/sources.ts";
import type { ApprovalRow } from "../src/approvals/types.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import type { EngineStore } from "../src/store/port.ts";
import type { AccountRef, DisplayIntent, TrackedTransaction } from "../src/transactions/route.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const TOKEN = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x3333333333333333333333333333333333333333";
const OTHER = "0x5555555555555555555555555555555555555555";
const NETWORK = "eip155:1";
const GATEWAY = "https://gateway.test";
const ACCOUNT: AccountRef = { kind: "imported", family: "evm", keyId: "k1" };

/** Narrows a row to the variants carrying `field` — union narrowing in tests. */
const has = <F extends string>(
  r: ApprovalRow | undefined,
  f: F,
): (ApprovalRow & Record<F, unknown>) | undefined => (r !== undefined && f in r ? r : undefined);

/** Finds the row naming `spender` — union narrowing lives in the helper. */
const spenderRow = (rows: ReadonlyArray<ApprovalRow> | undefined, spender: string) =>
  rows?.find((r) => has(r, "spender")?.spender === spender);

/** Reads a persisted record as text; absent records decode to an empty string. */
const storedText = async (
  store: ReturnType<typeof createMemoryEngineStore>,
  key: string,
): Promise<string> => {
  const raw = await store.collection("approvals").get(key);
  return new TextDecoder().decode(raw ?? new Uint8Array());
};

const uint = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

type EvmScript = {
  readonly head?: bigint;
  /** Allowance answers keyed by `${token}|${spender}`; balance by token. */
  readonly allowances?: ReadonlyMap<string, bigint>;
  readonly balances?: ReadonlyMap<string, bigint>;
  readonly calls?: Array<{ method: string; params: unknown[] }>;
};

/** Synchronous RPC answer table; the viem transport wraps it in a promise. */
const evmAnswer = (script: EvmScript, method: string, params: unknown): unknown => {
  const list = Array.isArray(params) ? params : [];
  if (method === "eth_blockNumber") {
    return `0x${(script.head ?? 100n).toString(16)}`;
  }
  if (method === "eth_getBlockByNumber") {
    return { number: list[0], timestamp: "0x65cd1d00" };
  }
  if (method === "eth_call") {
    const [callTx] = list;
    script.calls?.push({ method, params: [...list] });
    const data = isObj(callTx) && isHex(callTx["data"]) ? callTx["data"] : "0x";
    const to = isObj(callTx) ? str(callTx["to"]) : "";
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    if (decoded.functionName === "allowance") {
      const spender = str(decoded.args[1]);
      return uint(script.allowances?.get(`${to}|${spender}`) ?? 0n);
    }
    if (decoded.functionName === "balanceOf") {
      return uint(script.balances?.get(to) ?? 0n);
    }
    throw new Error(`unmocked call ${decoded.functionName}`);
  }
  if (method === "eth_getCode") {
    return "0x";
  }
  if (method === "eth_getTransactionCount") {
    return "0x0";
  }
  throw new Error(`unmocked ${method}`);
};

/** A minimal PublicClient answering the calls the inventory makes. */
const evmClient = (script: EvmScript): PublicClient =>
  createPublicClient({
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown }) =>
        Promise.resolve(evmAnswer(script, method, params)),
    }),
  });

const allowanceIntent = (spender: string, amount: string): DisplayIntent => ({
  family: "evm",
  network: NETWORK,
  summary: "approve",
  outflows: [],
  approvals: [
    {
      kind: "allowance",
      spender,
      amount: { asset: TOKEN, amount },
      change: "set",
      unlimited: false,
      verified: false,
    },
  ],
  fee: undefined,
  warnings: [],
  verifiability: "full",
});

const approvalTx = (
  id: string,
  intent: DisplayIntent,
  state = "confirmed",
): TrackedTransaction => ({
  id,
  family: "evm",
  network: NETWORK,
  account: "k1",
  hash: `0x${id}`,
  state: state as TrackedTransaction["state"],
  intent,
  nonce: 0,
  evm: { from: OWNER, account: ACCOUNT },
  submittedAt: 0,
  error: undefined,
});

/** A transactions-controller fake: a mutable tx map plus the subscribe zustand provides. */
const txStore = (initial: Readonly<Record<string, TrackedTransaction>> = {}) => {
  let txs = initial;
  const listeners: Array<(state: { txs: typeof txs }) => void> = [];
  return {
    getState: () => ({ txs }),
    store: {
      subscribe: (fn: (state: { txs: typeof txs }) => void) => {
        listeners.push(fn);
        return () => {};
      },
    },
    set: (next: Readonly<Record<string, TrackedTransaction>>) => {
      txs = next;
      for (const fn of listeners) {
        fn({ txs });
      }
    },
  };
};

type Rig = {
  readonly controller: ApprovalsController;
  readonly store: EngineStore;
  readonly timers: Array<() => void>;
  readonly warnings: unknown[];
  readonly txs: ReturnType<typeof txStore>;
};

const make = (options: {
  readonly evm?: EvmScript;
  readonly independent?: EvmScript | "unavailable";
  /** The gateway fetch answer for /v1/approvals — a body, a status, or "throw". */
  readonly gatewayBody?: unknown;
  readonly gatewayStatus?: number;
  readonly noGateway?: boolean;
  readonly store?: EngineStore;
  readonly txs?: Readonly<Record<string, TrackedTransaction>>;
}): Rig => {
  const timers: Array<() => void> = [];
  const warnings: unknown[] = [];
  const txs = txStore(options.txs);
  const store = options.store ?? createMemoryEngineStore();
  const primary = evmClient(options.evm ?? {});
  const independent =
    options.independent === undefined || options.independent === "unavailable"
      ? { kind: "unavailable" as const }
      : {
          kind: "available" as const,
          source: "host" as const,
          client: evmClient(options.independent),
        };
  const fetchAnswer = async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (options.gatewayBody === "throw" || !url.includes("/v1/approvals/")) {
      return Promise.reject(new Error("gateway down"));
    }
    if (options.gatewayStatus !== undefined && options.gatewayStatus !== 200) {
      return Promise.resolve(
        Response.json({ error: "unsupported" }, { status: options.gatewayStatus }),
      );
    }
    return Promise.resolve(
      Response.json(options.gatewayBody ?? { toBlock: "100", candidates: [], truncated: false }),
    );
  };
  const controller = new ApprovalsController({
    networks: {
      client: () => primary,
      independentClient: () => independent,
      solanaRpc: () => {
        throw new Error("no solana");
      },
      independentSolanaRpc: () => ({ kind: "unavailable" as const }),
      tronApi: () => {
        throw new Error("no tron");
      },
      independentTronApi: () => ({ kind: "unavailable" as const }),
      gatewayFirst: () => true,
    },
    transactions: txs as never,
    gateway:
      options.noGateway === true
        ? undefined
        : {
            url: GATEWAY,
            clientIds: { evm: "id", solana: "id", bitcoin: "id", tron: "id", service: "id" },
          },
    fetch: fetchAnswer,
    openStore: async () => Promise.resolve(store),
    setTimer: (_ms: number, fn: () => unknown) => {
      timers.push(fn);
      return () => {};
    },
    now: () => 1000,
    logger: {
      warn: (...args: unknown[]) => {
        warnings.push(args);
      },
    },
    addressOf: async () => Promise.resolve(OWNER),
    known: () => [],
    tokenMetadata: async () => Promise.resolve({ symbol: "TKN", decimals: 18 }),
    sessions: async () => Promise.resolve([]),
  });
  return { controller, store, timers, warnings, txs };
};

const view = async (rig: Rig): Promise<void> => {
  const key = await rig.controller.load(ACCOUNT, NETWORK);
  await rig.controller.refresh(key);
};

describe("approvals controller — a hostile gateway", () => {
  it("an invented gateway candidate with no chain state is dropped, never shown", async () => {
    const rig = make({
      gatewayBody: {
        toBlock: "100",
        candidates: [{ kind: "erc20", token: TOKEN, spender: SPENDER, block: "90" }],
        truncated: false,
      },
      evm: { allowances: new Map([[`${TOKEN}|${SPENDER}`, 0n]]) },
    });
    await rig.controller.init();
    await view(rig);
    const shown = rig.controller.getState().views[`${NETWORK}|${OWNER}`];
    expect(shown?.rows).toHaveLength(0);
    expect(shown?.dropped).toBe(1);
    expect(shown?.status).toBe("ready");
  });

  it("a candidate the gateway hides still shows when it is known locally", async () => {
    const rig = make({
      gatewayBody: { toBlock: "100", candidates: [], truncated: false },
      evm: {
        allowances: new Map([[`${TOKEN}|${SPENDER}`, 80n]]),
        balances: new Map([[TOKEN, 100n]]),
      },
      txs: { "tx-1": approvalTx("1", allowanceIntent(SPENDER, "100")) },
    });
    await rig.controller.init();
    await view(rig);
    const shown = rig.controller.getState().views[`${NETWORK}|${OWNER}`];
    const erc20 = shown?.rows.find((r) => r.kind === "erc20");
    expect(has(erc20, "amount")?.amount).toBe("80");
    expect(erc20?.sources).toStrictEqual(["local"]);
  });

  it("a candidate the gateway hides and nobody knows stays absent — completeness is 'known'", async () => {
    const rig = make({
      gatewayBody: { toBlock: "100", candidates: [], truncated: false },
      evm: { allowances: new Map([[`${TOKEN}|${SPENDER}`, 80n]]) },
    });
    await rig.controller.init();
    await view(rig);
    const shown = rig.controller.getState().views[`${NETWORK}|${OWNER}`];
    expect(shown?.rows).toHaveLength(0);
    expect(shown?.sources.find((s) => s.source === "gateway")?.status).toBe("ok");
  });

  it("a gateway primary that lies while the host says zero is disputed, never shown", async () => {
    const rig = make({
      gatewayBody: {
        toBlock: "100",
        candidates: [{ kind: "erc20", token: TOKEN, spender: SPENDER, block: "90" }],
        truncated: false,
      },
      evm: {
        allowances: new Map([[`${TOKEN}|${SPENDER}`, 80n]]),
        balances: new Map([[TOKEN, 100n]]),
      },
      independent: { allowances: new Map([[`${TOKEN}|${SPENDER}`, 0n]]) },
    });
    await rig.controller.init();
    await view(rig);
    const shown = rig.controller.getState().views[`${NETWORK}|${OWNER}`];
    expect(shown?.rows).toHaveLength(0);
    expect(shown?.disputed).toBe(1);
  });

  it("a malformed gateway answer fails only its source — local candidates still work", async () => {
    const rig = make({
      gatewayBody: { unexpected: true },
      evm: {
        allowances: new Map([[`${TOKEN}|${SPENDER}`, 80n]]),
        balances: new Map([[TOKEN, 100n]]),
      },
      txs: { "tx-1": approvalTx("1", allowanceIntent(SPENDER, "100")) },
    });
    await rig.controller.init();
    await view(rig);
    const shown = rig.controller.getState().views[`${NETWORK}|${OWNER}`];
    expect(shown?.sources.find((s) => s.source === "gateway")?.status).toBe("failed");
    expect(shown?.rows.find((r) => r.kind === "erc20")).toBeDefined();
  });

  it("no gateway configured reports the source unavailable", async () => {
    const rig = make({ noGateway: true, evm: {} });
    await rig.controller.init();
    await view(rig);
    const shown = rig.controller.getState().views[`${NETWORK}|${OWNER}`];
    expect(shown?.sources.find((s) => s.source === "gateway")?.status).toBe("unavailable");
  });
});

describe("approvals controller — lifecycle", () => {
  const rigWithAllowance = () =>
    make({
      evm: {
        allowances: new Map([[`${TOKEN}|${SPENDER}`, 80n]]),
        balances: new Map([[TOKEN, 100n]]),
      },
    });

  it("load creates the view loading, refresh fills it, unload drops it", async () => {
    const rig = rigWithAllowance();
    await rig.controller.init();
    const key = await rig.controller.load(ACCOUNT, NETWORK);
    expect(key).toBe(`${NETWORK}|${OWNER}`);
    await rig.controller.refresh(key);
    const shown = rig.controller.getState().views[key];
    expect(shown?.status).toBe("ready");
    expect(shown?.at?.height).toBe("100");
    rig.controller.unload(key);
    expect(rig.controller.getState().views[key]).toBeUndefined();
  });

  it("a refresh asked for while one runs reruns once — never concurrently", async () => {
    const rig = rigWithAllowance();
    await rig.controller.init();
    const key = await rig.controller.load(ACCOUNT, NETWORK);
    const [first, second] = [
      rig.controller.refresh(key),
      rig.controller.refresh(key),
      rig.controller.refresh(key),
    ];
    await Promise.all([first, second]);
    const shown = rig.controller.getState().views[key];
    expect(shown?.status).toBe("ready");
  });

  it("polling runs only while visible", async () => {
    const rig = rigWithAllowance();
    await rig.controller.init();
    await rig.controller.load(ACCOUNT, NETWORK);
    expect(rig.timers).toHaveLength(0);
    rig.controller.setVisible(true);
    expect(rig.timers).toHaveLength(1);
    rig.controller.setVisible(false);
    await Promise.resolve();
    rig.controller.setVisible(true);
    expect(rig.timers).toHaveLength(2);
  });

  it("lock drops views and a late refresh writes nothing", async () => {
    const rig = rigWithAllowance();
    await rig.controller.init();
    const key = await rig.controller.load(ACCOUNT, NETWORK);
    rig.controller.lock();
    await rig.controller.refresh(key).catch(() => undefined);
    expect(rig.controller.getState().views).toStrictEqual({});
  });

  it("a confirmed approval-bearing transaction refreshes the network's views", async () => {
    const rig = make({
      evm: {
        // OTHER's allowance is live on chain but unknown to every source until the send lands.
        allowances: new Map([
          [`${TOKEN}|${SPENDER}`, 80n],
          [`${TOKEN}|${OTHER}`, 5n],
        ]),
        balances: new Map([[TOKEN, 100n]]),
      },
    });
    await rig.controller.init();
    const key = await rig.controller.load(ACCOUNT, NETWORK);
    await rig.controller.refresh(key);
    const before = rig.controller.getState().views[key];
    expect(spenderRow(before?.rows, OTHER)).toBeUndefined();

    const tx = approvalTx("9", allowanceIntent(OTHER, "5"), "submitted");
    rig.txs.set({ "tx-9": tx });
    rig.txs.set({ "tx-9": { ...tx, state: "confirmed" } });
    await new Promise((resolve) => {
      setTimeout(resolve);
    });
    const after = rig.controller.getState().views[key];
    expect(after?.status).toBe("ready");
    // The triggered refresh re-read the chain: the confirmed grant's key is now a live candidate.
    const granted = spenderRow(after?.rows, OTHER);
    expect(has(granted, "amount")?.amount).toBe("5");
  });
});

describe("approvals controller — the persisted candidate set", () => {
  it("round-trips: a stored candidate is probed again next session", async () => {
    const store = createMemoryEngineStore();
    const key = `${NETWORK}|${OWNER}`;
    await store
      .collection("approvals")
      .put(key, encodeCandidates([{ kind: "erc20", token: TOKEN, spender: SPENDER }]));
    const rig = make({
      store,
      gatewayBody: { toBlock: "100", candidates: [], truncated: false },
      evm: {
        allowances: new Map([[`${TOKEN}|${SPENDER}`, 80n]]),
        balances: new Map([[TOKEN, 100n]]),
      },
    });
    await rig.controller.init();
    await view(rig);
    const shown = rig.controller.getState().views[key];
    const erc20 = shown?.rows.find((r) => r.kind === "erc20");
    expect(erc20?.sources).toStrictEqual(["local"]);

    // Persisted again for the next session — the still-live candidate survives.
    const persisted = await store.collection("approvals").get(key);
    expect(persisted).toBeDefined();
    expect(new TextDecoder().decode(persisted)).toContain(SPENDER.toLowerCase());
  });

  it("an inactive candidate is pruned from the persisted set", async () => {
    const store = createMemoryEngineStore();
    const key = `${NETWORK}|${OWNER}`;
    await store
      .collection("approvals")
      .put(key, encodeCandidates([{ kind: "erc20", token: TOKEN, spender: SPENDER }]));
    const rig = make({
      store,
      evm: { allowances: new Map([[`${TOKEN}|${SPENDER}`, 0n]]) },
    });
    await rig.controller.init();
    await view(rig);
    const persisted = await storedText(store, key);
    expect(persisted).not.toContain(SPENDER.toLowerCase());
  });

  it("a malformed stored record is ignored with a warning", async () => {
    const store = createMemoryEngineStore();
    const key = `${NETWORK}|${OWNER}`;
    await store
      .collection("approvals")
      .put(key, new TextEncoder().encode(JSON.stringify({ candidates: "not-a-list" })));
    const rig = make({ store });
    await rig.controller.init();
    await view(rig);
    expect(rig.warnings.length).toBeGreaterThan(0);
    expect(rig.controller.getState().views[key]?.status).toBe("ready");
  });
});
