/**
 * TRON history trusts the indexer's leg count: the same `TransferContract` row repeated across a
 * page boundary lands in the txid's group twice and every leg is `every`-matched against the same
 * pinned contract — the entry verifies while showing the transfer twice. And a wallet-signed
 * `TriggerSmartContract` paying TRX (`call_value`) is verified from the TRC-20 logs alone — the
 * contract's TRX outflow is never examined.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { buildTronRawData, tronAddressToHex } from "@qntx/wallet-chains/tron";

import { tronHistoryStream } from "../../src/history/tron.ts";
import type { HistoryEntry } from "../../src/history/types.ts";

const NETWORK = "tron:728126428";
const OWNER = "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb";
const OWNER_HEX20 = "e28b3cfd4e0e909077821478e9fcb86b84be786e";
const SENDER = "TNK8zKwz3GKVxk2jWKkFDiJjADDobd2EA8";
const SENDER_HEX20 = "87667aa513257aca1cff26c5dc87897dcbc58762";
const DDYS = "TU8TtTf1g51Eu48NMYirNKzQoF3eHMT11r";
const DDYS_HEX20 = "c7326f255d14e30f7e9c5aad4355be72dd5e4c69";
const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

type Row = Record<string, unknown>;

const page = (data: ReadonlyArray<Row>, fingerprint?: string): Row => ({
  success: true,
  data,
  meta: fingerprint === undefined ? {} : { fingerprint },
});

const txRow = (
  txid: string,
  opts: { ts: number; block?: number; from: string; to: string; amount: number },
): Row => ({
  txID: txid,
  block_timestamp: opts.ts,
  blockNumber: opts.block ?? 87000000,
  raw_data: {
    contract: [
      {
        type: "TransferContract",
        parameter: {
          value: {
            owner_address: `41${opts.from}`,
            to_address: `41${opts.to}`,
            amount: opts.amount,
          },
        },
      },
    ],
  },
});

const trc20Row = (
  txid: string,
  opts: { ts: number; from: string; to: string; value: string },
): Row => ({
  transaction_id: txid,
  token_info: { address: DDYS, symbol: "DDYS", decimals: 6, name: "token" },
  block_timestamp: opts.ts,
  from: opts.from,
  to: opts.to,
  type: "Transfer",
  value: opts.value,
});

const transferLog = (opts: { from: string; to: string; amount: bigint }): Row => ({
  address: DDYS_HEX20,
  topics: [
    TRANSFER_TOPIC,
    `000000000000000000000000${opts.from}`,
    `000000000000000000000000${opts.to}`,
  ],
  data: opts.amount.toString(16).padStart(64, "0"),
});

type Bodies = Readonly<Record<string, { readonly tx?: Row; readonly info?: Row }>>;

const nodeApi = (bodies: Bodies) => ({
  post: async (path: string, body: unknown): Promise<unknown> => {
    const id = String((body as { value?: string }).value);
    if (path === "/wallet/gettransactionbyid") {
      return Promise.resolve(bodies[id]?.tx ?? {});
    }
    if (path === "/wallet/gettransactioninfobyid") {
      return Promise.resolve(bodies[id]?.info ?? {});
    }
    return Promise.reject(new Error(`unmocked ${path}`));
  },
});

const stream = (options: {
  tx?: ReadonlyArray<Row>;
  trc20?: ReadonlyArray<Row>;
  api: { readonly post: (path: string, body: unknown) => Promise<unknown> };
}) => {
  const queues = new Map<string, Row[]>([
    ["/v1/accounts/transactions", [...(options.tx ?? [])]],
    ["/v1/accounts/transactions/trc20", [...(options.trc20 ?? [])]],
  ]);
  const fetch = (async (input: unknown) => {
    const url = String(input);
    const path = url.slice(url.indexOf("/v1/accounts"));
    const queue = queues.get(path) ?? [];
    const next = queue.length > 0 ? queue.shift() : page([]);
    return Promise.resolve(Response.json(next));
  }) as typeof globalThis.fetch;
  return tronHistoryStream(
    {
      gateway: { url: "https://gateway.test", fetch },
      networks: {
        tronApi: () => options.api,
        independentTronApi: () => ({ kind: "available", client: options.api }),
      },
      setTimer: () => () => {},
    } as never,
    NETWORK,
    OWNER,
    new Map(),
    () => {},
  );
};

const drain = async (s: {
  next: () => Promise<{ items: ReadonlyArray<HistoryEntry>; done: boolean }>;
}): Promise<HistoryEntry[]> => {
  const out: HistoryEntry[] = [];
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- paging is sequential by construction.
    const { items, done } = await s.next();
    out.push(...items);
    if (done) {
      return out;
    }
  }
};

describe("TRON history claims the indexer's legs without binding them to the node contract", () => {
  it("a TransferContract row repeated across pages counts twice and still verifies", async () => {
    const raw = buildTronRawData(
      {
        refBlock: {
          number: 87_000_000,
          id: "ff".repeat(32),
        },
        expiration: 61_000,
        timestamp: 1000,
      },
      { type: "TransferContract", owner: SENDER, to: OWNER, amount: 7n },
    );
    const txid = bytesToHex(sha256(raw));
    const row = txRow(txid, { ts: 1000, from: SENDER_HEX20, to: OWNER_HEX20, amount: 7 });
    const body: Row = {
      txID: txid,
      block_timestamp: 1000,
      raw_data_hex: bytesToHex(raw),
      raw_data: {
        contract: [
          {
            type: "TransferContract",
            parameter: {
              value: {
                owner_address: tronAddressToHex(SENDER),
                to_address: tronAddressToHex(OWNER),
                amount: 7,
              },
            },
          },
        ],
      },
    };
    const info: Row = { blockNumber: 87_000_001, blockTimeStamp: 1000, receipt: { result: "SUCCESS" } };
    const s = stream({
      tx: [page([row], "f1"), page([row])],
      api: nodeApi({ [txid]: { tx: body, info } }),
    });
    const [entry] = await drain(s);
    expect(entry?.hash).toBe(txid);
    // The pinned contract says one 7-sun transfer; the indexer's duplicate becomes two.
    expect(entry?.changes).toStrictEqual([
      { direction: "in", asset: "sun", amount: "7", listed: true },
      { direction: "in", asset: "sun", amount: "7", listed: true },
    ]);
    expect(entry?.direction).toBe("in");
    expect(entry?.verified).toBe(true);
  });

  it("a wallet swap paying TRX verifies on the TRC-20 leg alone — the call_value outflow vanishes", async () => {
    const txid = "b2".repeat(32);
    // The tx feed reports the wallet's own swap: a TriggerSmartContract whose call_value is the
    // TRX it paid. History models no leg for it.
    const trigger: Row = {
      txID: txid,
      block_timestamp: 2000,
      blockNumber: 87_000_002,
      raw_data: {
        contract: [
          {
            type: "TriggerSmartContract",
            parameter: {
              value: {
                owner_address: `41${OWNER_HEX20}`,
                contract_address: "411111111111111111111111111111111111111111",
                call_value: 5_000_000,
                data: "38ed1739",
              },
            },
          },
        ],
      },
    };
    const leg = trc20Row(txid, { ts: 2000, from: SENDER, to: OWNER, value: "44766592" });
    const body: Row = {
      txID: txid,
      raw_data: {
        contract: [
          {
            type: "TriggerSmartContract",
            parameter: {
              value: {
                owner_address: `41${OWNER_HEX20}`,
                contract_address: "411111111111111111111111111111111111111111",
                call_value: 5_000_000,
                data: "38ed1739",
              },
            },
          },
        ],
      },
    };
    const info: Row = {
      blockNumber: 87_000_002,
      blockTimeStamp: 2000,
      fee: 265_000,
      receipt: { result: "SUCCESS" },
      log: [transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 44766592n })],
    };
    const s = stream({
      tx: [page([trigger])],
      trc20: [page([leg])],
      api: nodeApi({ [txid]: { tx: body, info } }),
    });
    const [entry] = await drain(s);
    expect(entry?.hash).toBe(txid);
    // 5 TRX left the wallet inside the swap; the entry shows only the token coming in.
    expect(entry?.changes).toStrictEqual([
      {
        direction: "in",
        asset: DDYS,
        amount: "44766592",
        decimals: 6,
        symbol: "DDYS",
        listed: false,
      },
    ]);
    expect(entry?.direction).toBe("in");
    expect(entry?.verified).toBe(true);
    expect(entry?.fee).toBe("265000"); // the wallet signed and burned a fee — and still no outflow
  });
});
