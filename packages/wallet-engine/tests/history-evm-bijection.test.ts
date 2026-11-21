/**
 * Provider claims verify against the chain one-to-one: identical claims collapse into a single
 * change and a single check, each chain movement binds at most one claim, and an ERC-1155 batch
 * claims the per-id sum — a duplicated id's values included — so no listed movement can be
 * double-counted or under-counted. Chain logs are built with viem's own encoders as the independent
 * oracle.
 */
import { encodeAbiParameters, encodeEventTopics, erc20Abi, erc1155Abi } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { HistoryItem } from "../src/gateway/contract/index.ts";
import { evmHistoryStream } from "../src/history/evm.ts";
import type { HistoryEntry } from "../src/history/types.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const OTHER = "0x3333333333333333333333333333333333333333";
const ROUTER = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x1111111111111111111111111111111111111111";

type RpcAnswers = { readonly receipt: unknown; readonly tx?: unknown };

const erc20Log = (
  contract: string,
  from: string,
  to: string,
  value: bigint,
  logIndex: number,
): Record<string, unknown> => ({
  address: contract,
  topics: encodeEventTopics({
    abi: erc20Abi,
    eventName: "Transfer",
    args: { from: from as `0x${string}`, to: to as `0x${string}` },
  }),
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
  logIndex: `0x${logIndex.toString(16)}`,
});

const batchLog = (
  contract: string,
  from: string,
  to: string,
  ids: ReadonlyArray<bigint>,
  values: ReadonlyArray<bigint>,
  logIndex: number,
): Record<string, unknown> => ({
  address: contract,
  topics: encodeEventTopics({
    abi: erc1155Abi,
    eventName: "TransferBatch",
    args: {
      operator: ROUTER as `0x${string}`,
      from: from as `0x${string}`,
      to: to as `0x${string}`,
    },
  }),
  data: encodeAbiParameters(
    [{ type: "uint256[]" }, { type: "uint256[]" }],
    [[...ids], [...values]],
  ),
  logIndex: `0x${logIndex.toString(16)}`,
});

const receiptOf = (from: string, to: string, block: number, logs: unknown[]) => ({
  blockNumber: `0x${block.toString(16)}`,
  status: "0x1",
  from,
  to,
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

const item = (hash: string, block: number, transfers: HistoryItem["transfers"]): HistoryItem => ({
  hash,
  block: String(block),
  timestamp: 1700000000000,
  transfers,
});

const entryOf = (items: ReadonlyArray<HistoryEntry>, hash: string): HistoryEntry | undefined =>
  items.find((e) => e.hash === hash);

/** A stream whose verification reads go to an "independent" host endpoint — `trusted` is true. */
const verifiedStream = (options: { items: HistoryItem[]; answers: Record<string, RpcAnswers> }) => {
  const rpc = {
    transport: {
      request: async ({ method, params }: { method: string; params: unknown[] }) => {
        const record = options.answers[String(params[0])];
        if (method === "eth_getTransactionReceipt") {
          return Promise.resolve(record?.receipt ?? null);
        }
        if (method === "eth_getTransactionByHash") {
          return Promise.resolve(record?.tx ?? null);
        }
        if (method === "eth_getCode") {
          return Promise.resolve("0x");
        }
        return Promise.reject(new Error(`unmocked ${method}`));
      },
    },
  };
  const fetch = (async () =>
    Promise.resolve(
      Response.json({ items: options.items, cursor: null, truncated: false }),
    )) as typeof globalThis.fetch;
  return evmHistoryStream(
    {
      gateway: { url: "https://gateway.test", fetch },
      networks: {
        client: () => rpc,
        independentClient: () => ({ kind: "available", client: rpc }),
      },
      setTimer: () => () => {},
    } as never,
    "eip155:1",
    OWNER,
    new Map(),
    () => undefined,
    () => undefined,
  );
};

describe("claims verify one-to-one against the chain", () => {
  it("an ERC-20 inflow claimed twice shows one change and verifies", async () => {
    const hash = `0x${"a1".repeat(32)}`;
    const claim = transfer({
      kind: "erc20",
      from: OTHER,
      to: OWNER,
      contract: TOKEN,
      amount: "1000",
      decimals: 18,
      logIndex: 3,
    });
    const s = verifiedStream({
      items: [item(hash, 0x1937400, [claim, { ...claim }])],
      answers: {
        [hash]: {
          receipt: receiptOf(OTHER, ROUTER, 0x1937400, [erc20Log(TOKEN, OTHER, OWNER, 1000n, 3)]),
          tx: txOf(OTHER, ROUTER, 0n),
        },
      },
    });
    const { items } = await s.next();
    const e = entryOf(items, hash);
    expect(e?.verified).toBe(true);
    expect(e?.changes).toStrictEqual([
      expect.objectContaining({ direction: "in", amount: "1000" }),
    ]);
  });

  it("a native leg claimed twice shows one change and verifies", async () => {
    const hash = `0x${"b2".repeat(32)}`;
    const claim = transfer({
      kind: "native",
      from: OTHER,
      to: OWNER,
      amount: "1000000000000000000",
    });
    const s = verifiedStream({
      items: [item(hash, 0x1937401, [claim, { ...claim }])],
      answers: {
        [hash]: {
          receipt: receiptOf(OTHER, OWNER, 0x1937401, []),
          tx: txOf(OTHER, OWNER, 0xde0b6b3a7640000n),
        },
      },
    });
    const { items } = await s.next();
    const e = entryOf(items, hash);
    expect(e?.verified).toBe(true);
    expect(e?.changes).toStrictEqual([
      expect.objectContaining({ direction: "in", asset: "native", amount: "1000000000000000000" }),
    ]);
  });

  it("a duplicated id in a TransferBatch is claimed by its sum, not one occurrence", async () => {
    const hash = `0x${"c3".repeat(32)}`;
    const answers = {
      [hash]: {
        // The chain moved token 7 twice in one batch: 1 unit, then 1000 units — 1001 in total.
        receipt: receiptOf(OWNER, ROUTER, 0x1937402, [
          batchLog(TOKEN, OWNER, OTHER, [7n, 7n], [1n, 1000n], 5),
        ]),
        tx: txOf(OWNER, ROUTER, 0n),
      },
    };
    const claimAt = (amount: string) =>
      transfer({
        kind: "erc1155",
        from: OWNER,
        to: OTHER,
        contract: TOKEN,
        tokenId: "7",
        amount,
        logIndex: 5,
      });
    // One occurrence of the id's value: the chain moved 1001, not 1 — a mismatch.
    const under = verifiedStream({ items: [item(hash, 0x1937402, [claimAt("1")])], answers });
    const underPage = await under.next();
    const underEntry = entryOf(underPage.items, hash);
    expect(underEntry?.verified).toBe(false);
    expect(underEntry?.flags).toContain("chain-mismatch");

    // The per-id sum binds the movement and the entry shows what actually moved.
    const full = verifiedStream({ items: [item(hash, 0x1937402, [claimAt("1001")])], answers });
    const fullPage = await full.next();
    const fullEntry = entryOf(fullPage.items, hash);
    expect(fullEntry?.verified).toBe(true);
    expect(fullEntry?.changes).toStrictEqual([
      expect.objectContaining({ direction: "out", tokenId: "7", amount: "1001" }),
    ]);
  });

  it("a zero-value native claim over a logless contract call is uncheckable, not a mismatch", async () => {
    const hash = `0x${"d4".repeat(32)}`;
    const s = verifiedStream({
      items: [
        item(hash, 0x1937403, [transfer({ kind: "native", from: OWNER, to: ROUTER, amount: "0" })]),
      ],
      answers: {
        [hash]: {
          receipt: receiptOf(OWNER, ROUTER, 0x1937403, []),
          tx: txOf(OWNER, ROUTER, 0n),
        },
      },
    });
    const { items } = await s.next();
    const e = entryOf(items, hash);
    // Consistent with the tx but backed by no native movement: uncheckable — unverified, never
    // chain-mismatch.
    expect(e?.verified).toBe(false);
    expect(e?.flags).not.toContain("chain-mismatch");
  });

  it("two different claims at one log index cannot both bind — the wrong one is a mismatch", async () => {
    const hash = `0x${"e5".repeat(32)}`;
    const s = verifiedStream({
      items: [
        item(hash, 0x1937404, [
          transfer({
            kind: "erc20",
            from: OTHER,
            to: OWNER,
            contract: TOKEN,
            amount: "1000",
            decimals: 18,
            logIndex: 3,
          }),
          transfer({
            kind: "erc20",
            from: OTHER,
            to: OWNER,
            contract: TOKEN,
            amount: "5000",
            decimals: 18,
            logIndex: 3,
          }),
        ]),
      ],
      answers: {
        [hash]: {
          receipt: receiptOf(OTHER, ROUTER, 0x1937404, [erc20Log(TOKEN, OTHER, OWNER, 1000n, 3)]),
          tx: txOf(OTHER, ROUTER, 0n),
        },
      },
    });
    const { items } = await s.next();
    const e = entryOf(items, hash);
    expect(e?.verified).toBe(false);
    expect(e?.flags).toContain("chain-mismatch");
  });

  it("a native claim with the right legs but a wrong amount is a mismatch", async () => {
    const hash = `0x${"a7".repeat(32)}`;
    const s = verifiedStream({
      items: [
        item(hash, 0x1937406, [transfer({ kind: "native", from: OTHER, to: OWNER, amount: "5" })]),
      ],
      answers: {
        [hash]: {
          receipt: receiptOf(OTHER, OWNER, 0x1937406, []),
          tx: txOf(OTHER, OWNER, 0xde0b6b3a7640000n),
        },
      },
    });
    const { items } = await s.next();
    const e = entryOf(items, hash);
    expect(e?.verified).toBe(false);
    expect(e?.flags).toContain("chain-mismatch");
  });

  it("a TransferBatch's distinct ids each bind their own claim and verify", async () => {
    const hash = `0x${"f6".repeat(32)}`;
    const s = verifiedStream({
      items: [
        item(hash, 0x1937405, [
          transfer({
            kind: "erc1155",
            from: OTHER,
            to: OWNER,
            contract: TOKEN,
            tokenId: "7",
            amount: "1",
            logIndex: 5,
          }),
          transfer({
            kind: "erc1155",
            from: OTHER,
            to: OWNER,
            contract: TOKEN,
            tokenId: "9",
            amount: "1000",
            logIndex: 5,
          }),
        ]),
      ],
      answers: {
        [hash]: {
          receipt: receiptOf(OTHER, ROUTER, 0x1937405, [
            batchLog(TOKEN, OTHER, OWNER, [7n, 9n], [1n, 1000n], 5),
          ]),
          tx: txOf(OTHER, ROUTER, 0n),
        },
      },
    });
    const { items } = await s.next();
    const e = entryOf(items, hash);
    expect(e?.verified).toBe(true);
    expect(e?.changes).toStrictEqual([
      expect.objectContaining({ direction: "in", tokenId: "7", amount: "1" }),
      expect.objectContaining({ direction: "in", tokenId: "9", amount: "1000" }),
    ]);
  });
});
