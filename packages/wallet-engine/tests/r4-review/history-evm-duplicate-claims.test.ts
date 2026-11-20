/**
 * R4 PoC — finding: "a duplicated provider claim is verified as two movements". The entry's
 * `changes` are built one-per-claim and `verifyEntry` only asks that every claim match the chain
 * and every chain movement be claimed — it never asks that each movement be claimed exactly once.
 * So a gateway that lists one ERC-20 log (or one native leg) twice produces a `verified` entry
 * showing twice the value that moved; one ERC-1155 claim likewise covers every duplicated id in
 * a TransferBatch. Expected-correct behaviour: each chain movement must be claimed distinctly —
 * the displayed changes must never exceed what the receipt proves. The rig mirrors
 * tests/history-evm.test.ts with an independent host endpoint so `trusted` is true.
 */
import { describe, expect, it } from "vite-plus/test";

import type { HistoryItem } from "../../src/gateway/contract/index.ts";
import { evmHistoryStream } from "../../src/history/evm.ts";
import type { HistoryEntry } from "../../src/history/types.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ATTACKER = "0x3333333333333333333333333333333333333333";
const ROUTER = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x1111111111111111111111111111111111111111";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BATCH_TOPIC = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

const addrTopic = (a: string): string => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const word = (v: bigint): string => v.toString(16).padStart(64, "0");

const erc20Log = (
  contract: string,
  from: string,
  to: string,
  amount: string,
  index: number,
): Record<string, unknown> => ({
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
): Record<string, unknown> => ({
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

type ChainAnswers = { readonly receipt: unknown; readonly tx?: unknown };

/**
 * A stream whose verification reads go to an "independent" host endpoint answering from
 * `answers`, so `trusted` is true and entries can verify.
 */
const verifiedStream = (options: {
  page: { items: HistoryItem[]; cursor: string | null };
  answers: Record<string, ChainAnswers>;
}) => {
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
        return Promise.reject(new Error(`unmocked ${method}`));
      },
    },
  };
  const fetch = (() => Promise.resolve(Response.json(options.page))) as typeof globalThis.fetch;
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
  );
};

const show = (label: string, e: HistoryEntry | undefined): void => {
  console.log(`${label}:`, JSON.stringify(e, null, 2));
};

describe("duplicate provider claims verify as duplicated movements", () => {
  it("one ERC-20 log claimed twice verifies as two incoming 1000 changes", async () => {
    const hash = `0x${"a1".repeat(32)}`;
    const claim = transfer({
      kind: "erc20",
      from: ATTACKER,
      to: OWNER,
      contract: TOKEN,
      amount: "1000",
      decimals: 18,
      logIndex: 3,
    });
    const s = verifiedStream({
      page: { items: [item(hash, 0x1937400, [claim, { ...claim }])], cursor: null },
      answers: {
        [hash]: {
          receipt: receiptOf(ATTACKER, ROUTER, 0x1937400, [
            erc20Log(TOKEN, ATTACKER, OWNER, "1000", 3),
          ]),
          tx: txOf(ATTACKER, ROUTER, 0n),
        },
      },
    });
    const { items } = await s.next();
    const e = entryOf(items, hash);
    show("erc20 claimed twice", e);
    expect(e?.verified).toBe(true);
    // The chain moved 1000 once; the verified entry shows it twice.
    expect(e?.changes).toStrictEqual([
      expect.objectContaining({ direction: "in", amount: "1000" }),
      expect.objectContaining({ direction: "in", amount: "1000" }),
    ]);
  });

  it("one native leg claimed twice verifies as two incoming native changes", async () => {
    const hash = `0x${"b2".repeat(32)}`;
    const claim = transfer({
      kind: "native",
      from: ATTACKER,
      to: OWNER,
      amount: "1000000000000000000",
    });
    const s = verifiedStream({
      page: { items: [item(hash, 0x1937401, [claim, { ...claim }])], cursor: null },
      answers: {
        [hash]: {
          receipt: receiptOf(ATTACKER, OWNER, 0x1937401, []),
          tx: txOf(ATTACKER, OWNER, 0xde0b6b3a7640000n),
        },
      },
    });
    const { items } = await s.next();
    const e = entryOf(items, hash);
    show("native leg claimed twice", e);
    expect(e?.verified).toBe(true);
    expect(e?.changes).toStrictEqual([
      expect.objectContaining({ direction: "in", asset: "native", amount: "1000000000000000000" }),
      expect.objectContaining({ direction: "in", asset: "native", amount: "1000000000000000000" }),
    ]);
  });

  it("one ERC-1155 claim covers a batch that moved the same id twice, amounts 1 and 1000", async () => {
    const hash = `0x${"c3".repeat(32)}`;
    const s = verifiedStream({
      page: {
        items: [
          item(hash, 0x1937402, [
            transfer({
              kind: "erc1155",
              from: OWNER,
              to: ATTACKER,
              contract: TOKEN,
              tokenId: "7",
              amount: "1",
              logIndex: 5,
            }),
          ]),
        ],
        cursor: null,
      },
      answers: {
        [hash]: {
          // The chain moved token 7 twice in one batch: 1 unit, then 1000 units.
          receipt: receiptOf(OWNER, ROUTER, 0x1937402, [
            batchLog(TOKEN, OWNER, ATTACKER, [7n, 7n], [1n, 1000n], 5),
          ]),
          tx: txOf(OWNER, ROUTER, 0n),
        },
      },
    });
    const { items } = await s.next();
    const e = entryOf(items, hash);
    show("erc1155 batch under-claimed", e);
    expect(e?.verified).toBe(true);
    // Both decoded movements at logIndex 5 are "claimed" by the single id-7 claim; the entry
    // shows only the 1-unit outflow, hiding the 1000-unit one.
    expect(e?.changes).toStrictEqual([
      expect.objectContaining({ direction: "out", tokenId: "7", amount: "1" }),
    ]);
  });

  it("a zero-value call to a contract verifies — an internal move by the callee is invisible", async () => {
    const hash = `0x${"d4".repeat(32)}`;
    const s = verifiedStream({
      // The gateway contract requires ≥1 transfer per item, so "claims nothing" is the
      // provider's own encoding of a valueless call: the zero-amount native leg only.
      page: {
        items: [
          item(hash, 0x1937403, [
            transfer({ kind: "native", from: OWNER, to: ROUTER, amount: "0" }),
          ]),
        ],
        cursor: null,
      },
      answers: {
        [hash]: {
          receipt: receiptOf(OWNER, ROUTER, 0x1937403, []),
          tx: txOf(OWNER, ROUTER, 0n),
        },
      },
    });
    const { items } = await s.next();
    const e = entryOf(items, hash);
    show("zero-value contract call", e);
    // Nothing the wallet moved is provable from the receipt, so nothing further is required of
    // the provider: an internal value move by the callee would be invisible either way.
    expect(e?.verified).toBe(true);
    expect(e?.flags).toContain("zero-value-transfer");
    expect(e?.changes).toStrictEqual([
      expect.objectContaining({ direction: "out", asset: "native", amount: "0" }),
    ]);
  });
});
