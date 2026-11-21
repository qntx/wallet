/**
 * EVM history: provider items become unverified entries; every item is then checked against the
 * chain — receipt log by pinned logIndex for tokens, tx from/to/value for natives, internal claims
 * left unverifiable — with the recorded receipts as the oracle.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { HistoryItem } from "../src/gateway/contract/index.ts";
import { evmHistoryStream } from "../src/history/evm.ts";
import { compose } from "../src/history/merge.ts";
import type { HistoryEntry } from "../src/history/types.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ZERO = "0x0000000000000000000000000000000000000000";

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/history/evm-rpc.json"), "utf8"),
) as Record<string, Record<string, { receipt: unknown; tx?: unknown }>>;

type RpcCall = { readonly method: string; readonly params: unknown[] };

/** A `PublicClient`-shaped transport answering receipts/txs from the recorded fixture. */
const rpcClient = (network: string, calls: RpcCall[]) =>
  ({
    transport: {
      request: async ({ method, params }: { method: string; params: unknown[] }) => {
        calls.push({ method, params });
        const hash = params[0] as string;
        const record = fixture[network]?.[hash];
        if (method === "eth_getTransactionReceipt") {
          return Promise.resolve(record?.receipt ?? null);
        }
        if (method === "eth_getTransactionByHash") {
          return Promise.resolve(record?.tx ?? null);
        }
        return Promise.reject(new Error(`unmocked ${method}`));
      },
    },
  }) as never;

const stream = (options: {
  network: string;
  page?: unknown;
  /** When set, each gateway request pops the next page instead of replaying `page`. */
  pages?: ReadonlyArray<unknown>;
  client: unknown;
  independent?: unknown;
  /** When set, every gateway request answers this status with the `error` body. */
  status?: number;
  error?: unknown;
  requests?: Array<Record<string, unknown>>;
  onTruncated?: () => void;
  onUnsupported?: () => void;
}) => {
  const requests = options.requests ?? [];
  const queue = [...(options.pages ?? [options.page])];
  const fetch = (async (_input: unknown, init?: { body?: string }) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (options.status !== undefined) {
      return Promise.resolve(Response.json(options.error ?? {}, { status: options.status }));
    }
    return Promise.resolve(Response.json(queue.shift()));
  }) as typeof globalThis.fetch;
  const s = evmHistoryStream(
    {
      gateway: { url: "https://gateway.test", fetch },
      networks: {
        client: () => options.client,
        independentClient: () => options.independent ?? { kind: "not-needed" },
      },
      setTimer: () => () => {},
    } as never,
    options.network,
    OWNER,
    new Map(),
    options.onTruncated ?? (() => {}),
    options.onUnsupported ?? (() => {}),
  );
  return { stream: s, requests };
};

const item = (hash: string, block: number, transfers: HistoryItem["transfers"]): HistoryItem => ({
  hash,
  block: String(block),
  timestamp: 1700000000000,
  transfers,
});

const page = (items: HistoryItem[], cursor: string | null = null, truncated = false) => ({
  items,
  cursor,
  truncated,
});

const NATIVE_ZERO = {
  kind: "native",
  from: "0xfa5180956e87bff2d1fce8423d2e755846ac3b24",
  to: OWNER,
  contract: null,
  tokenId: null,
  amount: "0",
  decimals: null,
  symbol: null,
  logIndex: null,
} as const;

const ERC20_IN = {
  kind: "erc20",
  from: "0xD152f549545093347a162Dce210e7293f1452150",
  to: OWNER,
  contract: "0x72e4f9F808C49A2a61dE9C5896298920Dc4EEEa9",
  tokenId: null,
  amount: "923842391",
  decimals: 8,
  symbol: "BITCOIN",
  logIndex: 1000,
} as const;

const erc721 = (tokenId: string, logIndex: number) =>
  ({
    kind: "erc721",
    from: ZERO,
    to: OWNER,
    contract: "0xb86b68Bca287AfD48f81d1F792DB69368664A120",
    tokenId,
    amount: "1",
    decimals: null,
    symbol: null,
    logIndex,
  }) as const;

const ETH_PAGE = page([
  item("0xda98151f32d7fb8c8daad5849363590ca179c6511b3f7d7e6d613d50072b0533", 26440576, [
    NATIVE_ZERO,
  ]),
  item("0x979e19a53feb2c15122009b523c48f66df025de6ff54db5290c567eac324f181", 26436309, [ERC20_IN]),
  item("0x865952a53a753b3900906186fe6e24c19a1af6ab14f389575b390c6b5c03d92c", 26429715, [
    erc721("109", 628),
    erc721("110", 629),
  ]),
]);

const entryOf = (items: ReadonlyArray<HistoryEntry>, hash: string) =>
  items.find((e) => e.hash === hash);

describe("evmHistoryStream verification", () => {
  it("verifies the recorded page against the chain: erc20, zero-value native, two erc721 mints", async () => {
    const calls: RpcCall[] = [];
    const { stream: s, requests } = stream({
      network: "eip155:1",
      page: ETH_PAGE,
      client: rpcClient("eip155:1", calls),
    });
    const { items, done } = await s.next();
    expect(done).toBe(true);
    expect(requests[0]).toStrictEqual({ address: OWNER, limit: 25 });

    const erc20 = entryOf(
      items,
      "0x979e19a53feb2c15122009b523c48f66df025de6ff54db5290c567eac324f181",
    );
    expect(erc20?.verified).toBe(true);
    expect(erc20?.direction).toBe("in");
    expect(erc20?.counterparties).toStrictEqual(["0xD152f549545093347a162Dce210e7293f1452150"]);
    expect(erc20?.changes[0]?.amount).toBe("923842391");
    expect(erc20?.changes[0]?.asset).toBe("0x72e4f9F808C49A2a61dE9C5896298920Dc4EEEa9");

    const zero = entryOf(
      items,
      "0xda98151f32d7fb8c8daad5849363590ca179c6511b3f7d7e6d613d50072b0533",
    );
    expect(zero?.verified).toBe(true);
    expect(zero?.flags).toContain("zero-value-transfer");

    const mint = entryOf(
      items,
      "0x865952a53a753b3900906186fe6e24c19a1af6ab14f389575b390c6b5c03d92c",
    );
    expect(mint?.verified).toBe(true);
    expect(mint?.changes.map((c) => c.tokenId)).toStrictEqual(["109", "110"]);

    expect(calls.some((c) => c.method === "eth_getTransactionReceipt")).toBe(true);
    expect(calls.some((c) => c.method === "eth_getTransactionByHash")).toBe(true);
  });

  it("prefers the independent host client for verification when the network has one", async () => {
    const hostCalls: RpcCall[] = [];
    const primaryCalls: RpcCall[] = [];
    const { stream: s } = stream({
      network: "eip155:1",
      page: ETH_PAGE,
      client: rpcClient("eip155:1", primaryCalls),
      independent: { kind: "available", client: rpcClient("eip155:1", hostCalls) },
    });
    await s.next();
    expect(hostCalls.length).toBeGreaterThan(0);
    expect(primaryCalls).toHaveLength(0);
  });

  it("treats a contract-less token claim as uncheckable — skipped for changes, no mismatch", async () => {
    const hash = "0x979e19a53feb2c15122009b523c48f66df025de6ff54db5290c567eac324f181";
    const { stream: s } = stream({
      network: "eip155:1",
      page: page([item(hash, 26436309, [{ ...ERC20_IN, contract: null }])]),
      client: rpcClient("eip155:1", []),
    });
    const { items } = await s.next();
    const e = entryOf(items, hash);
    expect(e?.changes).toStrictEqual([]);
    expect(e?.verified).toBe(false);
    expect(e?.flags).not.toContain("chain-mismatch");
  });

  it("leaves an internal claim unverified without flagging a mismatch", async () => {
    const hash = "0xda98151f32d7fb8c8daad5849363590ca179c6511b3f7d7e6d613d50072b0533";
    const { stream: s } = stream({
      network: "eip155:1",
      page: page([item(hash, 26440576, [{ ...NATIVE_ZERO, kind: "internal", amount: "5" }])]),
      client: rpcClient("eip155:1", []),
    });
    const { items } = await s.next();
    const e = entryOf(items, hash);
    expect(e?.verified).toBe(false);
    expect(e?.flags).not.toContain("chain-mismatch");
  });

  it("marks a provider-amount lie chain-mismatch, not verified", async () => {
    const hash = "0x979e19a53feb2c15122009b523c48f66df025de6ff54db5290c567eac324f181";
    const { stream: s } = stream({
      network: "eip155:1",
      page: page([item(hash, 26399445, [{ ...ERC20_IN, amount: "923842392" }])]),
      client: rpcClient("eip155:1", []),
    });
    const { items } = await s.next();
    const e = entryOf(items, hash);
    expect(e?.verified).toBe(false);
    expect(e?.flags).toContain("chain-mismatch");
  });

  it("keeps an unreceipted provider item unverified", async () => {
    const missing = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const { stream: s } = stream({
      network: "eip155:1",
      page: page([item(missing, 26401664, [NATIVE_ZERO])]),
      client: rpcClient("eip155:1", []),
    });
    const { items } = await s.next();
    const e = entryOf(items, missing);
    expect(e?.verified).toBe(false);
    expect(e?.flags).toStrictEqual(["zero-value-transfer"]);
  });

  it("computes the sender fee including the OP-stack l1Fee", async () => {
    const hash = "0x2222222222222222222222222222222222222222222222222222222222222222";
    const network = "eip155:10";
    fixture[network] = {
      [hash]: {
        receipt: {
          blockNumber: "0x10",
          status: "0x1",
          from: OWNER,
          to: "0xfa5180956e87bff2d1fce8423d2e755846ac3b24",
          gasUsed: "0x5208",
          effectiveGasPrice: "0x3b9aca00",
          l1Fee: "0x10",
          logs: [],
        },
        tx: {
          from: OWNER,
          to: "0xfa5180956e87bff2d1fce8423d2e755846ac3b24",
          value: "0x5",
        },
      },
    };
    const { stream: s } = stream({
      network,
      page: page([
        item(hash, 16, [
          {
            kind: "native",
            from: OWNER,
            to: "0xfa5180956e87bff2d1fce8423d2e755846ac3b24",
            contract: null,
            tokenId: null,
            amount: "5",
            decimals: null,
            symbol: null,
            logIndex: null,
          },
        ]),
      ]),
      client: rpcClient(network, []),
    });
    const { items } = await s.next();
    const e = entryOf(items, hash);
    expect(e?.verified).toBe(true);
    expect(e?.direction).toBe("out");
    expect(e?.fee).toBe("21000000000016");
  });

  it("flags an impersonating or domain-looking symbol on an unlisted contract", async () => {
    const contract = "0x9999999999999999999999999999999999999999";
    const hash = "0x3333333333333333333333333333333333333333333333333333333333333333";
    const transfer = (symbol: string): HistoryItem["transfers"][number] => ({
      kind: "erc20",
      from: "0xfa5180956e87bff2d1fce8423d2e755846ac3b24",
      to: OWNER,
      contract,
      tokenId: null,
      amount: "1",
      decimals: 6,
      symbol,
      logIndex: null,
    });
    const { stream: s } = stream({
      network: "eip155:1",
      page: page([item(hash, 26401664, [transfer("USDC"), transfer("claim-usdc.com")])]),
      client: rpcClient("eip155:1", []),
    });
    const { items } = await s.next();
    const e = entryOf(items, hash);
    expect(e?.flags).toContain("token-impersonation");
    expect(e?.flags).toContain("suspicious-token-symbol");
  });

  it("fires onTruncated for each truncated page and keeps paging with the cursor", async () => {
    let truncated = 0;
    const { stream: s, requests } = stream({
      network: "eip155:1",
      pages: [
        page([item("0x".padEnd(66, "a"), 200, [ERC20_IN])], "99", true),
        page([item("0x".padEnd(66, "b"), 90, [ERC20_IN])], null, true),
        page([], null),
      ],
      client: rpcClient("eip155:1", []),
      onTruncated: () => {
        truncated += 1;
      },
    });
    const first = await s.next();
    expect(first.done).toBe(false);
    const second = await s.next();
    expect(requests[1]).toStrictEqual({ address: OWNER, cursor: "99", limit: 25 });
    expect(second.done).toBe(true);
    expect(truncated).toBe(2);
  });
});

describe("evm history gateway coverage", () => {
  it("a 404 'unsupported' ends the stream empty and fires onUnsupported", async () => {
    const unsupported: string[] = [];
    const { stream: s, requests } = stream({
      network: "eip155:1",
      status: 404,
      error: { error: "unsupported" },
      client: rpcClient("eip155:1", []),
      onUnsupported: () => unsupported.push("eip155:1"),
    });
    await expect(s.next()).resolves.toStrictEqual({ items: [], done: true });
    await expect(s.next()).resolves.toStrictEqual({ items: [], done: true });
    expect(unsupported).toStrictEqual(["eip155:1"]);
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["unknown-network", { error: "unknown-network" }],
    ["not-found", { error: "not-found" }],
    ["a plain 404", { nope: true }],
  ])("a 404 %s still throws like any non-2xx", async (_name, error) => {
    const { stream: s } = stream({
      network: "eip155:1",
      status: 404,
      error,
      client: rpcClient("eip155:1", []),
    });
    await expect(s.next()).rejects.toThrow("status 404");
  });

  it("a 503 still throws like any non-2xx", async () => {
    const { stream: s } = stream({
      network: "eip155:1",
      status: 503,
      error: { error: "unavailable" },
      client: rpcClient("eip155:1", []),
    });
    await expect(s.next()).rejects.toThrow("status 503");
  });
});

describe("evm history completeness", () => {
  const ATTACKER = "0x3333333333333333333333333333333333333333";
  const ROUTER = "0x4444444444444444444444444444444444444444";
  const TOKEN_A = "0x1111111111111111111111111111111111111111";
  const TOKEN_B = "0x2222222222222222222222222222222222222222";
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const BATCH_TOPIC = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

  const addrTopic = (a: string) => `0x000000000000000000000000${a.slice(2).toLowerCase()}`;
  const word = (v: bigint) => v.toString(16).padStart(64, "0");

  const erc20Log = (contract: string, from: string, to: string, amount: string, index: number) => ({
    address: contract,
    topics: [TRANSFER_TOPIC, addrTopic(from), addrTopic(to)],
    data: `0x${word(BigInt(amount))}`,
    logIndex: `0x${index.toString(16)}`,
  });

  const batchLog = (
    contract: string,
    from: string,
    to: string,
    ids: ReadonlyArray<bigint>,
    values: ReadonlyArray<bigint>,
    index: number,
  ) => ({
    address: contract,
    topics: [BATCH_TOPIC, addrTopic(ROUTER), addrTopic(from), addrTopic(to)],
    data: `0x${[
      word(0x40n),
      word(BigInt(96 + ids.length * 32)),
      word(BigInt(ids.length)),
      ...ids.map(word),
      word(BigInt(values.length)),
      ...values.map(word),
    ].join("")}`,
    logIndex: `0x${index.toString(16)}`,
  });

  const receiptOf = (from: string, block: number, logs: unknown[]) => ({
    blockNumber: `0x${block.toString(16)}`,
    status: "0x1",
    from,
    to: ROUTER,
    gasUsed: "0x5208",
    effectiveGasPrice: "0x3b9aca00",
    logs,
  });

  const txOf = (from: string, to: string, value: bigint) => ({
    from,
    to,
    value: `0x${value.toString(16)}`,
  });

  const transfer = (
    over: Partial<HistoryItem["transfers"][number]> & {
      readonly kind: string;
      readonly from: string;
      readonly to: string;
    },
  ): HistoryItem["transfers"][number] => ({
    contract: null,
    tokenId: null,
    amount: "0",
    decimals: null,
    symbol: null,
    logIndex: null,
    ...over,
  });

  const erc20In = (contract: string, amount: string, logIndex: number) =>
    transfer({ kind: "erc20", from: ATTACKER, to: OWNER, contract, amount, logIndex });

  const verify = (
    hash: string,
    block: number,
    transfers: HistoryItem["transfers"],
    calls: RpcCall[] = [],
  ) =>
    stream({
      network: "eip155:1",
      page: page([item(hash, block, transfers)]),
      client: rpcClient("eip155:1", calls),
    });

  it("flags chain-mismatch when the receipt proves an outflow the provider omitted", async () => {
    const hash = `0x${"aa".repeat(32)}`;
    fixture["eip155:1"] = {
      ...fixture["eip155:1"],
      [hash]: {
        receipt: receiptOf(ATTACKER, 0x1937400, [
          erc20Log(TOKEN_A, ATTACKER, OWNER, "1000", 0),
          erc20Log(TOKEN_B, OWNER, ATTACKER, "500", 1),
        ]),
        tx: txOf(ATTACKER, ROUTER, 0n),
      },
    };
    const { stream: s } = verify(hash, 0x1937400, [erc20In(TOKEN_A, "1000", 0)]);
    const { items } = await s.next();
    const e = entryOf(items, hash);
    expect(e?.verified).toBe(false);
    expect(e?.flags).toContain("chain-mismatch");
  });

  it("fetches the tx object without a native claim and flags an omitted native outflow", async () => {
    const calls: RpcCall[] = [];
    const hash = `0x${"bb".repeat(32)}`;
    fixture["eip155:1"] = {
      ...fixture["eip155:1"],
      [hash]: {
        receipt: receiptOf(OWNER, 0x1937401, [erc20Log(TOKEN_A, ATTACKER, OWNER, "1000", 0)]),
        tx: txOf(OWNER, ATTACKER, 0xde0b6b3a7640000n),
      },
    };
    const { stream: s } = verify(hash, 0x1937401, [erc20In(TOKEN_A, "1000", 0)], calls);
    const { items } = await s.next();
    const e = entryOf(items, hash);
    expect(e?.verified).toBe(false);
    expect(e?.flags).toContain("chain-mismatch");
    expect(calls.map((c) => c.method)).toContain("eth_getTransactionByHash");
  });

  it("verifies an entry whose claim covers every wallet-touching movement", async () => {
    const hash = `0x${"cc".repeat(32)}`;
    fixture["eip155:1"] = {
      ...fixture["eip155:1"],
      [hash]: {
        receipt: receiptOf(ATTACKER, 0x1937402, [
          erc20Log(TOKEN_A, ATTACKER, OWNER, "1000", 0),
          erc20Log(TOKEN_B, OWNER, ATTACKER, "500", 1),
        ]),
        tx: txOf(ATTACKER, ROUTER, 0n),
      },
    };
    const { stream: s } = verify(hash, 0x1937402, [
      erc20In(TOKEN_A, "1000", 0),
      transfer({
        kind: "erc20",
        from: OWNER,
        to: ATTACKER,
        contract: TOKEN_B,
        amount: "500",
        logIndex: 1,
      }),
    ]);
    const { items } = await s.next();
    expect(entryOf(items, hash)?.verified).toBe(true);
  });

  it("flags chain-mismatch when the receipt was mined in a different block than claimed", async () => {
    const hash = `0x${"ce".repeat(32)}`;
    fixture["eip155:1"] = {
      ...fixture["eip155:1"],
      [hash]: {
        receipt: receiptOf(ATTACKER, 0x1937404, [erc20Log(TOKEN_A, ATTACKER, OWNER, "1000", 0)]),
        tx: txOf(ATTACKER, ROUTER, 0n),
      },
    };
    // The claim is otherwise complete: only the block number contradicts the chain.
    const { stream: s } = verify(hash, 0x1937405, [erc20In(TOKEN_A, "1000", 0)]);
    const { items } = await s.next();
    expect(entryOf(items, hash)?.verified).toBe(false);
    expect(entryOf(items, hash)?.flags).toContain("chain-mismatch");
  });

  it("flags an unclaimed id inside an erc1155 batch the provider listed only once", async () => {
    const hash = `0x${"dd".repeat(32)}`;
    fixture["eip155:1"] = {
      ...fixture["eip155:1"],
      [hash]: {
        receipt: receiptOf(ATTACKER, 0x1937403, [
          batchLog(TOKEN_A, ATTACKER, OWNER, [7n, 8n], [1n, 1n], 0),
        ]),
        tx: txOf(ATTACKER, ROUTER, 0n),
      },
    };
    const { stream: s } = verify(hash, 0x1937403, [
      transfer({
        kind: "erc1155",
        from: ATTACKER,
        to: OWNER,
        contract: TOKEN_A,
        tokenId: "7",
        amount: "1",
        logIndex: 0,
      }),
    ]);
    const { items } = await s.next();
    const e = entryOf(items, hash);
    expect(e?.verified).toBe(false);
    expect(e?.flags).toContain("chain-mismatch");
  });

  it("leaves entries unverified when the verification reads went to the gateway", async () => {
    const { stream: s } = stream({
      network: "eip155:1",
      page: ETH_PAGE,
      client: rpcClient("eip155:1", []),
      independent: { kind: "unavailable" },
    });
    const { items } = await s.next();
    const erc20 = entryOf(
      items,
      "0x979e19a53feb2c15122009b523c48f66df025de6ff54db5290c567eac324f181",
    );
    expect(erc20?.verified).toBe(false);
    expect(erc20?.flags).not.toContain("chain-mismatch");
  });

  it("leaves an entry unverified when the tx object does not arrive", async () => {
    const hash = `0x${"ee".repeat(32)}`;
    fixture["eip155:1"] = {
      ...fixture["eip155:1"],
      [hash]: {
        receipt: receiptOf(ATTACKER, 0x1937404, [erc20Log(TOKEN_A, ATTACKER, OWNER, "1000", 0)]),
      },
    };
    const { stream: s } = verify(hash, 0x1937404, [erc20In(TOKEN_A, "1000", 0)]);
    const { items } = await s.next();
    const e = entryOf(items, hash);
    expect(e?.verified).toBe(false);
    expect(e?.flags).not.toContain("chain-mismatch");
  });

  it("leaves an entry unverified when a receipt log has no pinned index", async () => {
    const hash = `0x${"f1".repeat(32)}`;
    fixture["eip155:1"] = {
      ...fixture["eip155:1"],
      [hash]: {
        receipt: receiptOf(ATTACKER, 0x1937405, [
          erc20Log(TOKEN_A, ATTACKER, OWNER, "1000", 0),
          {
            address: TOKEN_B,
            topics: [
              "0x735dd1911323e2b3dc250cd074b96d1bf7c46f12d289fed7c5f885ed8295d8d7",
              addrTopic(OWNER),
              addrTopic(ATTACKER),
            ],
            data: "0x",
          },
        ]),
        tx: txOf(ATTACKER, ROUTER, 0n),
      },
    };
    const { stream: s } = verify(hash, 0x1937405, [erc20In(TOKEN_A, "1000", 0)]);
    const { items } = await s.next();
    const e = entryOf(items, hash);
    expect(e?.verified).toBe(false);
    expect(e?.flags).not.toContain("chain-mismatch");
  });
});

describe("evm lookalike counterparties", () => {
  it("flags the 0x984573e3… sender but not the known 0x9845636f… one", () => {
    const known = {
      evm: ["0x9845636fd55f620d18a2c7fd3e4e6bd8e4de173d"],
      solana: [],
      bitcoin: [],
      spark: [],
    };
    const entries: HistoryEntry[] = [
      {
        id: "eip155:999:0x58fa",
        family: "evm",
        network: "eip155:999",
        hash: "0x58fa",
        direction: "in",
        status: "confirmed",
        counterparties: ["0x984573e30a7db8575ba4d71c4af59d22933e173d"],
        changes: [],
        verified: true,
        origin: "provider",
        flags: [],
      },
      {
        id: "eip155:999:0x97fb",
        family: "evm",
        network: "eip155:999",
        hash: "0x97fb",
        direction: "in",
        status: "confirmed",
        counterparties: ["0x9845636fd55f620d18a2c7fd3e4e6bd8e4de173d"],
        changes: [],
        verified: true,
        origin: "provider",
        flags: [],
      },
    ];
    const merged = compose(entries, [], known, true);
    expect(merged.find((e) => e.id === "eip155:999:0x58fa")?.flags).toContain(
      "lookalike-counterparty",
    );
    expect(merged.find((e) => e.id === "eip155:999:0x97fb")?.flags).toStrictEqual([]);
  });
});
