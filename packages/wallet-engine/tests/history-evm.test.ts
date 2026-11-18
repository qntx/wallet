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
  page: unknown;
  client: unknown;
  independent?: unknown;
  requests?: Array<Record<string, unknown>>;
}) => {
  const requests = options.requests ?? [];
  const fetch = (async (_input: unknown, init?: { body?: string }) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Promise.resolve(Response.json(options.page));
  }) as typeof globalThis.fetch;
  const s = evmHistoryStream(
    {
      gateway: { url: "https://gateway.test", fetch },
      networks: {
        client: () => options.client,
        independentClient: () => options.independent ?? { kind: "unavailable" },
      },
      setTimer: () => () => {},
    } as never,
    options.network,
    OWNER,
    new Map(),
  );
  return { stream: s, requests };
};

const item = (hash: string, block: number, transfers: HistoryItem["transfers"]): HistoryItem => ({
  hash,
  block: String(block),
  timestamp: 1700000000000,
  transfers,
});

const page = (items: HistoryItem[], cursor: string | null = null) => ({ items, cursor });

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
