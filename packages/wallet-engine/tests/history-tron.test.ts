/**
 * TRON history: indexer feed rows become unverified entries, then every leg is cross-checked on the
 * node — TRX/TRC-10 against the pinned raw contract (sha256 of raw_data_hex is the txid), TRC-20
 * against receipt Transfer logs — with the recorded TronGrid bodies as the oracle.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { buildTronRawData, tronAddressToHex } from "@qntx/wallet-chains/tron";

import { compose } from "../src/history/merge.ts";
import { tronHistoryStream } from "../src/history/tron.ts";
import type { HistoryEntry } from "../src/history/types.ts";

const DIR = "mainnet-trongrid";
const NETWORK = "tron:728126428";
/** The recorded holder — every feed row and node body below is this account's real history. */
const OWNER = "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb";
const OWNER_HEX20 = "e28b3cfd4e0e909077821478e9fcb86b84be786e";
const SENDER = "TNK8zKwz3GKVxk2jWKkFDiJjADDobd2EA8";
const SENDER_HEX20 = "87667aa513257aca1cff26c5dc87897dcbc58762";
const DDYS = "TU8TtTf1g51Eu48NMYirNKzQoF3eHMT11r";
const DDYS_HEX20 = "c7326f255d14e30f7e9c5aad4355be72dd5e4c69";
const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const FIXTURES = resolve(import.meta.dirname, "../../../apps/gateway/tests/fixtures/tron");
const fixture = (name: string): Record<string, unknown> =>
  (
    JSON.parse(readFileSync(resolve(FIXTURES, DIR, `${name}.json`), "utf8")) as {
      body: Record<string, unknown>;
    }
  ).body;

type Row = Record<string, unknown>;

const page = (data: ReadonlyArray<Row>, fingerprint?: string): Row => ({
  success: true,
  data,
  meta: fingerprint === undefined ? {} : { fingerprint },
});

const txRow = (
  txid: string,
  opts: { ts: number; block?: number; from: string; to: string; amount: number; asset?: string },
): Row => ({
  txID: txid,
  block_timestamp: opts.ts,
  blockNumber: opts.block ?? 87000000,
  raw_data: {
    contract: [
      {
        type: opts.asset === undefined ? "TransferContract" : "TransferAssetContract",
        parameter: {
          value: {
            owner_address: `41${opts.from}`,
            to_address: `41${opts.to}`,
            amount: opts.amount,
            ...(opts.asset === undefined ? {} : { asset_name: opts.asset }),
          },
        },
      },
    ],
  },
});

const trc20Row = (
  txid: string,
  opts: {
    ts: number;
    from: string;
    to: string;
    value: string;
    symbol?: string;
    decimals?: number;
    contract?: string;
  },
): Row => ({
  transaction_id: txid,
  token_info: {
    address: opts.contract ?? DDYS,
    symbol: opts.symbol ?? "DDYS",
    decimals: opts.decimals ?? 6,
    name: "token",
  },
  block_timestamp: opts.ts,
  from: opts.from,
  to: opts.to,
  type: "Transfer",
  value: opts.value,
});

const transferLog = (opts: {
  contract?: string;
  from: string;
  to: string;
  amount: bigint;
}): Row => ({
  address: opts.contract ?? DDYS_HEX20,
  topics: [
    TRANSFER_TOPIC,
    `000000000000000000000000${opts.from}`,
    `000000000000000000000000${opts.to}`,
  ],
  data: opts.amount.toString(16).padStart(64, "0"),
});

/** A node's `gettransactioninfobyid` answer for a TRC-20 tx. */
const trc20Info = (opts: {
  block: number;
  ts: number;
  fee?: number;
  failed?: boolean;
  logs: ReadonlyArray<Row>;
}): Row => ({
  blockNumber: opts.block,
  blockTimeStamp: opts.ts,
  ...(opts.fee === undefined ? {} : { fee: opts.fee }),
  receipt: { result: opts.failed === true ? "OUT_OF_ENERGY" : "SUCCESS" },
  log: [...opts.logs],
});

/** A real raw_data_hex for a TransferContract; its sha256 is the txid. `from`/`to` are base58. */
const trxBody = (opts: {
  from: string;
  to: string;
  amount: bigint;
  block: number;
  ts: number;
  fee?: number;
}): { body: Row; info: Row; txid: string } => {
  const raw = buildTronRawData(
    {
      refBlock: {
        number: opts.block - 1,
        id: "00000000000000000000000000000000000000000000000000000000000000ff",
      },
      expiration: opts.ts + 60_000,
      timestamp: opts.ts,
    },
    { type: "TransferContract", owner: opts.from, to: opts.to, amount: opts.amount },
  );
  const hex = bytesToHex(raw);
  const txid = bytesToHex(sha256(raw));
  return {
    txid,
    body: {
      txID: txid,
      block_timestamp: opts.ts,
      raw_data_hex: hex,
      raw_data: {
        contract: [
          {
            type: "TransferContract",
            parameter: {
              value: {
                owner_address: tronAddressToHex(opts.from),
                to_address: tronAddressToHex(opts.to),
                amount: Number(opts.amount),
              },
            },
          },
        ],
      },
    },
    info: {
      blockNumber: opts.block,
      blockTimeStamp: opts.ts,
      ...(opts.fee === undefined ? {} : { fee: opts.fee }),
      receipt: { net_usage: 267 },
    },
  };
};

type Bodies = Readonly<Record<string, { readonly tx?: Row; readonly info?: Row }>>;

/** A `TronApi` answering `gettransactionbyid`/`gettransactioninfobyid` from `bodies`. */
const nodeApi = (bodies: Bodies, calls?: string[]) => ({
  post: async (path: string, body: unknown): Promise<unknown> => {
    const id = String((body as { value?: string }).value);
    calls?.push(`${path} ${id.slice(0, 8)}`);
    if (path === "/wallet/gettransactionbyid") {
      return Promise.resolve(bodies[id]?.tx ?? {});
    }
    if (path === "/wallet/gettransactioninfobyid") {
      return Promise.resolve(bodies[id]?.info ?? {});
    }
    if (path === "/walletsolidity/gettransactioninfobyid") {
      return Promise.resolve(bodies[id]?.info ?? {});
    }
    return Promise.reject(new Error(`unmocked ${path}`));
  },
});

/** Node bodies replayed from the recorded `history-tx-*`/`history-info-*` fixtures. */
const recordedBodies = (txids: ReadonlyArray<string>): Bodies =>
  Object.fromEntries(
    txids.map((txid) => [
      txid,
      { tx: fixture(`history-tx-${txid}`), info: fixture(`history-info-${txid}`) },
    ]),
  );

const stream = (options: {
  tx?: ReadonlyArray<Row>;
  trc20?: ReadonlyArray<Row>;
  api: { readonly post: (path: string, body: unknown) => Promise<unknown> };
  independent?: unknown;
  cached?: ReadonlyMap<string, HistoryEntry>;
  onTruncated?: () => void;
}) => {
  const queues = new Map<string, Row[]>([
    ["/v1/accounts/transactions", [...(options.tx ?? [])]],
    ["/v1/accounts/transactions/trc20", [...(options.trc20 ?? [])]],
  ]);
  const requests: Array<{ url: string; body: Row }> = [];
  const fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Row;
    requests.push({ url, body });
    const path = url.slice(url.indexOf("/v1/accounts"));
    const queue = queues.get(path) ?? [];
    const next = queue.length > 0 ? queue.shift() : page([]);
    return Promise.resolve(Response.json(next));
  }) as typeof globalThis.fetch;
  const s = tronHistoryStream(
    {
      gateway: { url: "https://gateway.test", fetch },
      networks: {
        tronApi: () => options.api,
        independentTronApi: () => options.independent ?? { kind: "available", client: options.api },
      },
      setTimer: () => () => {},
    } as never,
    NETWORK,
    OWNER,
    options.cached ?? new Map(),
    options.onTruncated ?? (() => {}),
  );
  return { stream: s, requests };
};

const flagsOf = (e: HistoryEntry | undefined): ReadonlyArray<string> => e?.flags ?? [];

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

describe("tronHistoryStream", () => {
  it("turns recorded feed rows into node-verified entries", async () => {
    // The txids the recorder captured node evidence for; the rest stay claimed-but-unverified.
    const bodies = recordedBodies([
      "165b6f74e249b2e7c7879bc4d83cd9f65abaf9f449aa12295ba50cc09c07d688",
      "320e3599e4a19ca334544abad07bc676ea186561b5edebbd62559dc1c109a994",
      "4f9d5e70ddd91ecb7d58e2180792ce99afa9dfe375ee4bbff7535fc5ef63246a",
      "75774f059f8bb7e0cfc17bf918b6d9d706c9d02dd64d8a7ba22cd34fbe6da698",
      "84f3db5b0de568b0b9eac2a39d2fe9738a159ec4e622cf5cb601cb229ed13991",
      "e3bd48bbb404b2a9d9200439a00294131e83e9f9e9403847314fb0d38e8db0c6",
      "114efbba5fec4cccd7ab610c131a42ae63996c5607c7301dd17045760fe17760",
      "207062a02a0fb20ebe0b6fd77aca71d7f58da7a7947cf7a2f0eb02a33916d811",
      "233865496ea98325b7af9103e63dcac708df75069f0c42cfa87068f8e9476938",
      "50535400e21159ce2e1de653014de333e9bb2465d5374a9558c3edbe49d705d6",
      "b92e8c79af65b08fd938afa34a96c364d0121ce1e8c563c7d1feb8746fe629f3",
    ]);
    const { stream: s } = stream({
      tx: [fixture("history-transactions-0"), fixture("history-transactions-1")],
      trc20: [fixture("history-trc20-0")],
      api: nodeApi(bodies),
    });
    const entries = await drain(s);
    const byId = new Map(entries.map((e) => [e.id, e]));

    const trx = byId.get(
      `${NETWORK}:165b6f74e249b2e7c7879bc4d83cd9f65abaf9f449aa12295ba50cc09c07d688`,
    );
    expect(trx).toMatchObject({
      family: "tron",
      direction: "in",
      status: "confirmed",
      verified: true,
      block: 87839822,
      changes: [{ direction: "in", asset: "sun", amount: "6", listed: true }],
      flags: [],
    });
    const trc10 = byId.get(
      `${NETWORK}:114efbba5fec4cccd7ab610c131a42ae63996c5607c7301dd17045760fe17760`,
    );
    expect(trc10).toMatchObject({
      direction: "in",
      verified: true,
      block: 87634871,
      changes: [{ direction: "in", asset: "trc10:1005208", amount: "6666666", listed: false }],
    });
    // Assert on the recorded DDYS rows: every page-0 trc20 row produces an entry.
    const trc20Rows = (fixture("history-trc20-0")["data"] as Row[]).filter(
      (r) => r["type"] === "Transfer",
    );
    const trc20Entries = entries.filter((e) =>
      trc20Rows.some((r) => e.hash === r["transaction_id"]),
    );
    expect(trc20Entries).toHaveLength(trc20Rows.length);
    // The four txids with recorded node bodies verify; the rest stay claimed-unverified.
    const verified20 = trc20Entries.filter((e) => e.verified);
    expect(verified20).toHaveLength(4);
    expect(verified20[0]).toMatchObject({
      direction: "in",
      changes: [
        {
          direction: "in",
          asset: DDYS,
          amount: "44766592",
          decimals: 6,
          symbol: "DDYS",
          listed: false,
        },
      ],
    });
  });

  it("flags a provider leg that the node contract contradicts", async () => {
    const made = trxBody({ from: SENDER, to: OWNER, amount: 7n, block: 87000001, ts: 1000 });
    const row = txRow(made.txid, {
      ts: 1000,
      from: SENDER_HEX20,
      to: OWNER_HEX20,
      amount: 9, // the indexer lies about the amount
    });
    const { stream: s } = stream({
      tx: [page([row])],
      api: nodeApi({ [made.txid]: { tx: made.body, info: made.info } }),
    });
    const [entry] = await drain(s);
    expect(entry?.flags).toContain("chain-mismatch");
    expect(entry?.verified).toBe(false);
  });

  it("flags a Transfer log the indexer never reported", async () => {
    const txid = "a1".repeat(32);
    const row = trc20Row(txid, { ts: 2000, from: SENDER, to: OWNER, value: "44766592" });
    const info = trc20Info({
      block: 87000002,
      ts: 2000,
      logs: [
        transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 44766592n }),
        // A second wallet-touching Transfer the indexer hid.
        transferLog({
          from: "1234567890abcdef1234567890abcdef12345678",
          to: OWNER_HEX20,
          amount: 1n,
        }),
      ],
    });
    const { stream: s } = stream({
      trc20: [page([row])],
      api: nodeApi({ [txid]: { info } }),
    });
    const [entry] = await drain(s);
    expect(entry?.flags).toContain("chain-mismatch");
    expect(entry?.verified).toBe(false);
  });

  it("a non-hex log data word is not a Transfer — the claim mismatches, the stream never throws", async () => {
    const txid = "a3".repeat(32);
    const row = trc20Row(txid, { ts: 2000, from: SENDER, to: OWNER, value: "44766592" });
    const info = trc20Info({
      block: 87000002,
      ts: 2000,
      logs: [
        {
          address: DDYS_HEX20,
          topics: [
            TRANSFER_TOPIC,
            `000000000000000000000000${SENDER_HEX20}`,
            `000000000000000000000000${OWNER_HEX20}`,
          ],
          data: "not-hex!",
        },
      ],
    });
    const { stream: s } = stream({
      trc20: [page([row])],
      api: nodeApi({ [txid]: { info } }),
    });
    const [entry] = await drain(s);
    expect(entry?.flags).toContain("chain-mismatch");
    expect(entry?.verified).toBe(false);
  });

  it("a non-hex raw_data_hex leaves the entry unverified instead of throwing", async () => {
    const made = trxBody({ from: SENDER, to: OWNER, amount: 5n, block: 87000001, ts: 1000 });
    const row = txRow(made.txid, {
      ts: 1000,
      from: SENDER_HEX20,
      to: OWNER_HEX20,
      amount: 5,
    });
    const { stream: s } = stream({
      tx: [page([row])],
      api: nodeApi({
        [made.txid]: { tx: { ...made.body, raw_data_hex: "zz-not-hex" }, info: made.info },
      }),
    });
    const [entry] = await drain(s);
    expect(entry?.verified).toBe(false);
    expect(flagsOf(entry)).not.toContain("chain-mismatch");
  });

  it("arbitrary node strings in Transfer logs and raw_data_hex classify, never throw", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (data, hex) => {
        const txid = "b1".repeat(32);
        const row = trc20Row(txid, { ts: 2000, from: SENDER, to: OWNER, value: "7" });
        const info = trc20Info({
          block: 87000002,
          ts: 2000,
          logs: [
            {
              address: DDYS_HEX20,
              topics: [
                TRANSFER_TOPIC,
                `000000000000000000000000${SENDER_HEX20}`,
                `000000000000000000000000${OWNER_HEX20}`,
              ],
              data,
            },
          ],
        });
        const { stream: s1 } = stream({
          trc20: [page([row])],
          api: nodeApi({ [txid]: { info } }),
        });
        await expect(drain(s1)).resolves.toHaveLength(1);
        const made = trxBody({ from: SENDER, to: OWNER, amount: 5n, block: 87000001, ts: 1000 });
        const trx = txRow(made.txid, {
          ts: 1000,
          from: SENDER_HEX20,
          to: OWNER_HEX20,
          amount: 5,
        });
        const { stream: s2 } = stream({
          tx: [page([trx])],
          api: nodeApi({
            [made.txid]: { tx: { ...made.body, raw_data_hex: hex }, info: made.info },
          }),
        });
        await expect(drain(s2)).resolves.toHaveLength(1);
      }),
      { numRuns: 25 },
    );
  });

  it("flags a zero-value TRC-20 leg and still verifies it on the node", async () => {
    /* Verification needs the pinned body — a real trigger contract whose sha256 is the txid. */
    const made = triggerBody({ owner: SENDER, contract: DDYS, block: 87000003, ts: 3000 });
    const row = trc20Row(made.txid, { ts: 3000, from: SENDER, to: OWNER, value: "0" });
    const info = trc20Info({
      block: 87000003,
      ts: 3000,
      logs: [transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 0n })],
    });
    const { stream: s } = stream({
      trc20: [page([row])],
      api: nodeApi({ [made.txid]: { tx: made.body, info } }),
    });
    const [entry] = await drain(s);
    expect(entry?.flags).toContain("zero-value-transfer");
    expect(entry?.verified).toBe(true);
  });

  it("flags a fake-USDT symbol on an unlisted contract", async () => {
    const txid = "a3".repeat(32);
    const row = trc20Row(txid, {
      ts: 4000,
      from: SENDER,
      to: OWNER,
      value: "1",
      symbol: "USDT",
      contract: DDYS, // a real, unlisted contract address carrying the built-in symbol
    });
    const info = trc20Info({
      block: 87000004,
      ts: 4000,
      logs: [transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 1n })],
    });
    const { stream: s } = stream({
      trc20: [page([row])],
      api: nodeApi({ [txid]: { info } }),
    });
    const [entry] = await drain(s);
    expect(entry?.flags).toContain("token-impersonation");
    expect(entry?.flags).not.toContain("suspicious-token-symbol");
  });

  it("merges a txid whose trc20 rows split across a page boundary", async () => {
    const made = triggerBody({ owner: SENDER, contract: DDYS, block: 87000005, ts: 5000 });
    const { txid } = made;
    const leg1 = trc20Row(txid, { ts: 5000, from: SENDER, to: OWNER, value: "10" });
    const leg2 = trc20Row(txid, {
      ts: 5000,
      from: "TSu7TeaLYFJ72kTH2qYtV553wjoxs2K98A",
      to: OWNER,
      value: "20",
    });
    const older = trc20Row("a5".repeat(32), { ts: 4000, from: SENDER, to: OWNER, value: "1" });
    const info = trc20Info({
      block: 87000005,
      ts: 5000,
      logs: [
        transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 10n }),
        transferLog({
          contract: DDYS_HEX20,
          from: "b9b3d93f02ca5a2be33ccbb3ab2a4fb9b5f1bca1",
          to: OWNER_HEX20,
          amount: 20n,
        }),
      ],
    });
    const otherInfo = trc20Info({
      block: 87000004,
      ts: 4000,
      logs: [transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 1n })],
    });
    const { stream: s } = stream({
      trc20: [page([leg1], "fp1"), page([leg2, older])],
      api: nodeApi({ [txid]: { tx: made.body, info }, ["a5".repeat(32)]: { info: otherInfo } }),
    });
    const entries = await drain(s);
    const merged = entries.find((e) => e.id === `${NETWORK}:${txid}`);
    expect(merged).toBeDefined();
    expect(merged?.changes).toHaveLength(2);
    expect(merged?.changes.map((c) => c.amount)).toStrictEqual(["10", "20"]);
    expect(merged?.verified).toBe(true);
  });

  it("merges legs a txid claims in both feeds into one entry", async () => {
    const txid = "a6".repeat(32);
    const tx = txRow(txid, { ts: 6000, from: SENDER_HEX20, to: OWNER_HEX20, amount: 5 });
    const t20 = trc20Row(txid, { ts: 6000, from: SENDER, to: OWNER, value: "33" });
    const made = trxBody({ from: SENDER, to: OWNER, amount: 5n, block: 87000006, ts: 6000 });
    const info = trc20Info({
      block: 87000006,
      ts: 6000,
      logs: [transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 33n })],
    });
    const { stream: s } = stream({
      tx: [page([tx])],
      trc20: [page([t20])],
      api: nodeApi({ [txid]: { tx: made.body, info } }),
    });
    const entries = await drain(s);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.changes.map((c) => c.asset)).toStrictEqual(["sun", DDYS]);
  });

  it("leaves matching entries unverified when no independent host exists", async () => {
    const txid = "a7".repeat(32);
    const row = trc20Row(txid, { ts: 7000, from: SENDER, to: OWNER, value: "12" });
    const info = trc20Info({
      block: 87000007,
      ts: 7000,
      logs: [transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 12n })],
    });
    const api = nodeApi({ [txid]: { info } });
    const { stream: s } = stream({
      trc20: [page([row])],
      api,
      independent: { kind: "unavailable" },
    });
    const [entry] = await drain(s);
    expect(entry?.flags).not.toContain("chain-mismatch");
    expect(entry?.verified).toBe(false);
  });

  it("reuses a cached verified entry instead of re-reading the node", async () => {
    const txid = "a8".repeat(32);
    const cached: HistoryEntry = {
      id: `${NETWORK}:${txid}`,
      family: "tron",
      network: NETWORK,
      hash: txid,
      direction: "in",
      counterparties: [SENDER],
      changes: [
        { direction: "in", asset: DDYS, amount: "9", decimals: 6, symbol: "DDYS", listed: false },
      ],
      status: "confirmed",
      timestamp: 8000,
      block: 87000008,
      verified: true,
      origin: "provider",
      flags: [],
    };
    const calls: string[] = [];
    const api = nodeApi({}, calls);
    const { stream: s } = stream({
      tx: [
        page([
          txRow(txid, {
            ts: 8000,
            block: 87000008,
            from: SENDER_HEX20,
            to: OWNER_HEX20,
            amount: 9,
          }),
        ]),
      ],
      api,
      cached: new Map([[cached.id, cached]]),
    });
    const [entry] = await drain(s);
    expect(entry).toBe(cached);
    expect(calls).toHaveLength(0);
  });

  it("signals truncation on a malformed feed page and still drains the other feed", async () => {
    const txid = "a9".repeat(32);
    const row = trc20Row(txid, { ts: 9000, from: SENDER, to: OWNER, value: "4" });
    const info = trc20Info({
      block: 87000009,
      ts: 9000,
      logs: [transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 4n })],
    });
    let truncated = false;
    const { stream: s } = stream({
      tx: [{ garbage: true }],
      trc20: [page([row])],
      api: nodeApi({ [txid]: { info } }),
      onTruncated: () => {
        truncated = true;
      },
    });
    const entries = await drain(s);
    expect(truncated).toBe(true);
    expect(entries.map((e) => e.id)).toStrictEqual([`${NETWORK}:${txid}`]);
  });

  it("counts malformed rows without throwing", async () => {
    const txid = "ab".repeat(32);
    const bad = { nope: true };
    const row = trc20Row(txid, { ts: 10000, from: SENDER, to: OWNER, value: "3" });
    const info = trc20Info({
      block: 87000010,
      ts: 10000,
      logs: [transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 3n })],
    });
    const { stream: s } = stream({
      trc20: [page([bad, row])],
      api: nodeApi({ [txid]: { info } }),
    });
    const entries = await drain(s);
    expect(s.skipped()).toBe(1);
    expect(entries).toHaveLength(1);
  });

  it("shows the burn fee only when the wallet signed the transaction", async () => {
    const made = trxBody({
      from: OWNER,
      to: SENDER,
      amount: 8n,
      block: 87000011,
      ts: 11000,
      fee: 268000,
    });
    const row = txRow(made.txid, { ts: 11000, from: OWNER_HEX20, to: SENDER_HEX20, amount: 8 });
    const api = nodeApi({ [made.txid]: { tx: made.body, info: made.info } });
    const { stream: s } = stream({ tx: [page([row])], api });
    const [entry] = await drain(s);
    expect(entry?.direction).toBe("out");
    expect(entry?.fee).toBe("268000");
    expect(entry?.verified).toBe(true);
  });
});

/** An indexer `TriggerSmartContract` row: `from`/`to` are the 20-byte hex tails. */
const triggerRow = (
  txid: string,
  opts: {
    ts: number;
    block?: number;
    from: string;
    to: string;
    callValue?: number;
    callTokenValue?: number;
    tokenId?: number;
  },
): Row => ({
  txID: txid,
  block_timestamp: opts.ts,
  blockNumber: opts.block ?? 87000000,
  raw_data: {
    contract: [
      {
        type: "TriggerSmartContract",
        parameter: {
          value: {
            owner_address: `41${opts.from}`,
            contract_address: `41${opts.to}`,
            ...(opts.callValue === undefined ? {} : { call_value: opts.callValue }),
            ...(opts.callTokenValue === undefined ? {} : { call_token_value: opts.callTokenValue }),
            ...(opts.tokenId === undefined ? {} : { token_id: opts.tokenId }),
          },
        },
      },
    ],
  },
});

/** A real raw_data_hex for a wallet-signed TriggerSmartContract; fields are base58. */
const triggerBody = (opts: {
  owner: string;
  contract: string;
  callValue?: bigint;
  callTokenValue?: bigint;
  tokenId?: bigint;
  block: number;
  ts: number;
  failed?: boolean;
}): { body: Row; info: Row; txid: string } => {
  const raw = buildTronRawData(
    {
      refBlock: {
        number: opts.block - 1,
        id: "00000000000000000000000000000000000000000000000000000000000000ff",
      },
      expiration: opts.ts + 60_000,
      timestamp: opts.ts,
      feeLimit: 100_000_000n,
    },
    {
      type: "TriggerSmartContract",
      owner: opts.owner,
      contract: opts.contract,
      callValue: opts.callValue ?? 0n,
      data: new Uint8Array([0x38, 0xed, 0x17, 0x39]),
      callTokenValue: opts.callTokenValue ?? 0n,
      tokenId: opts.tokenId ?? 0n,
    },
  );
  const hex = bytesToHex(raw);
  const txid = bytesToHex(sha256(raw));
  return {
    txid,
    body: {
      txID: txid,
      block_timestamp: opts.ts,
      raw_data_hex: hex,
      raw_data: {
        contract: [
          {
            type: "TriggerSmartContract",
            parameter: {
              value: {
                owner_address: tronAddressToHex(opts.owner),
                contract_address: tronAddressToHex(opts.contract),
                ...(opts.callValue === undefined ? {} : { call_value: Number(opts.callValue) }),
                ...(opts.callTokenValue === undefined
                  ? {}
                  : { call_token_value: Number(opts.callTokenValue) }),
                ...(opts.tokenId === undefined ? {} : { token_id: Number(opts.tokenId) }),
              },
            },
          },
        ],
      },
    },
    info: trc20Info({
      block: opts.block,
      ts: opts.ts,
      ...(opts.failed === undefined ? {} : { failed: opts.failed }),
      logs: [],
    }),
  };
};

describe("TRON claims bind one-to-one to the node contract", () => {
  it("a TransferContract row repeated across pages counts once and verifies", async () => {
    const made = trxBody({ from: SENDER, to: OWNER, amount: 7n, block: 87000001, ts: 1000 });
    const row = txRow(made.txid, { ts: 1000, from: SENDER_HEX20, to: OWNER_HEX20, amount: 7 });
    const { stream: s } = stream({
      tx: [page([row], "f1"), page([row])],
      api: nodeApi({ [made.txid]: { tx: made.body, info: made.info } }),
    });
    const [entry] = await drain(s);
    expect(entry?.hash).toBe(made.txid);
    expect(entry?.changes).toStrictEqual([
      { direction: "in", asset: "sun", amount: "7", listed: true },
    ]);
    expect(entry?.verified).toBe(true);
  });

  it("two distinct TRX claims on one txid cannot bind one contract — chain-mismatch", async () => {
    const made = trxBody({ from: SENDER, to: OWNER, amount: 7n, block: 87000001, ts: 1000 });
    const rows = [
      txRow(made.txid, { ts: 1000, from: SENDER_HEX20, to: OWNER_HEX20, amount: 7 }),
      txRow(made.txid, { ts: 1000, from: SENDER_HEX20, to: OWNER_HEX20, amount: 9 }),
    ];
    const { stream: s } = stream({
      tx: [page(rows)],
      api: nodeApi({ [made.txid]: { tx: made.body, info: made.info } }),
    });
    const [entry] = await drain(s);
    expect(flagsOf(entry)).toContain("chain-mismatch");
    expect(entry?.verified).toBe(false);
  });

  it("a wallet swap paying TRX shows the call_value outflow and verifies", async () => {
    const made = triggerBody({
      owner: OWNER,
      contract: DDYS,
      callValue: 5_000_000n,
      block: 87000002,
      ts: 2000,
    });
    const trigger = triggerRow(made.txid, {
      ts: 2000,
      from: OWNER_HEX20,
      to: DDYS_HEX20,
      callValue: 5_000_000,
    });
    const leg = trc20Row(made.txid, { ts: 2000, from: SENDER, to: OWNER, value: "44766592" });
    const info = trc20Info({
      block: 87000002,
      ts: 2000,
      logs: [transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 44766592n })],
    });
    const { stream: s } = stream({
      tx: [page([trigger])],
      trc20: [page([leg])],
      api: nodeApi({ [made.txid]: { tx: made.body, info } }),
    });
    const [entry] = await drain(s);
    expect(entry?.changes).toStrictEqual([
      { direction: "out", asset: "sun", amount: "5000000", listed: true },
      {
        direction: "in",
        asset: DDYS,
        amount: "44766592",
        decimals: 6,
        symbol: "DDYS",
        listed: false,
      },
    ]);
    expect(entry?.direction).toBe("self");
    expect(entry?.verified).toBe(true);
    expect(flagsOf(entry)).not.toContain("chain-mismatch");
  });

  it("a call_value outflow missing from the indexer but present in the raw contract mismatches", async () => {
    const made = triggerBody({
      owner: OWNER,
      contract: DDYS,
      callValue: 5_000_000n,
      block: 87000002,
      ts: 2000,
    });
    // The indexer's row hides the movement: it renders the trigger without its call_value.
    const trigger = triggerRow(made.txid, { ts: 2000, from: OWNER_HEX20, to: DDYS_HEX20 });
    const leg = trc20Row(made.txid, { ts: 2000, from: SENDER, to: OWNER, value: "44766592" });
    const info = trc20Info({
      block: 87000002,
      ts: 2000,
      logs: [transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 44766592n })],
    });
    const { stream: s } = stream({
      tx: [page([trigger])],
      trc20: [page([leg])],
      api: nodeApi({ [made.txid]: { tx: made.body, info } }),
    });
    const [entry] = await drain(s);
    expect(flagsOf(entry)).toContain("chain-mismatch");
    expect(entry?.verified).toBe(false);
  });

  it("a call_token_value TRC-10 outflow shows and binds the raw contract", async () => {
    const made = triggerBody({
      owner: OWNER,
      contract: DDYS,
      callTokenValue: 123n,
      tokenId: 1_002_000n,
      block: 87000003,
      ts: 3000,
    });
    const trigger = triggerRow(made.txid, {
      ts: 3000,
      from: OWNER_HEX20,
      to: DDYS_HEX20,
      callTokenValue: 123,
      tokenId: 1_002_000,
    });
    const { stream: s } = stream({
      tx: [page([trigger])],
      api: nodeApi({ [made.txid]: { tx: made.body, info: made.info } }),
    });
    const [entry] = await drain(s);
    expect(entry?.changes).toStrictEqual([
      { direction: "out", asset: "trc10:1002000", amount: "123", listed: false },
    ]);
    expect(entry?.direction).toBe("out");
    expect(entry?.verified).toBe(true);
  });

  it("a failed transaction moves no value — no completeness check on its trigger", async () => {
    const made = triggerBody({
      owner: OWNER,
      contract: DDYS,
      callValue: 5_000_000n,
      block: 87000002,
      ts: 2000,
      failed: true,
    });
    const trigger = triggerRow(made.txid, {
      ts: 2000,
      from: OWNER_HEX20,
      to: DDYS_HEX20,
      callValue: 5_000_000,
    });
    const { stream: s } = stream({
      tx: [page([trigger])],
      api: nodeApi({ [made.txid]: { tx: made.body, info: made.info } }),
    });
    const [entry] = await drain(s);
    expect(entry?.status).toBe("failed");
    expect(flagsOf(entry)).not.toContain("chain-mismatch");
  });

  it("a duplicated TRC-20 row with only one Transfer log is a chain-mismatch", async () => {
    const txid = "c4".repeat(32);
    const leg = trc20Row(txid, { ts: 4000, from: SENDER, to: OWNER, value: "44766592" });
    const info = trc20Info({
      block: 87000004,
      ts: 4000,
      logs: [transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 44766592n })],
    });
    const { stream: s } = stream({
      trc20: [page([leg, leg])],
      api: nodeApi({ [txid]: { info } }),
    });
    const [entry] = await drain(s);
    expect(flagsOf(entry)).toContain("chain-mismatch");
    expect(entry?.verified).toBe(false);
  });

  it("two identical TRC-20 rows bind two identical logs — two changes, verified", async () => {
    const made = triggerBody({ owner: SENDER, contract: DDYS, block: 87000004, ts: 4000 });
    const leg = trc20Row(made.txid, { ts: 4000, from: SENDER, to: OWNER, value: "44766592" });
    const info = trc20Info({
      block: 87000004,
      ts: 4000,
      logs: [
        transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 44766592n }),
        transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 44766592n }),
      ],
    });
    const { stream: s } = stream({
      trc20: [page([leg, leg])],
      api: nodeApi({ [made.txid]: { tx: made.body, info } }),
    });
    const [entry] = await drain(s);
    expect(entry?.changes).toHaveLength(2);
    expect(entry?.verified).toBe(true);
  });

  it("a TRC-20-only entry without a body is claimed, not verified", async () => {
    const made = triggerBody({ owner: SENDER, contract: DDYS, block: 87000004, ts: 4000 });
    const leg = trc20Row(made.txid, { ts: 4000, from: SENDER, to: OWNER, value: "44766592" });
    const info = trc20Info({
      block: 87000004,
      ts: 4000,
      logs: [transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 44766592n })],
    });
    const { stream: s } = stream({
      trc20: [page([leg])],
      api: nodeApi({ [made.txid]: { info } }),
    });
    const [entry] = await drain(s);
    expect(entry?.verified).toBe(false);
    expect(flagsOf(entry)).not.toContain("chain-mismatch");
  });

  it("a body the decoder cannot read is claimed, not verified — never a mismatch", async () => {
    /* Bytes whose sha256 is the txid but that fail the phase-1 decode. */
    const raw = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const txid = bytesToHex(sha256(raw));
    const leg = trc20Row(txid, { ts: 4000, from: SENDER, to: OWNER, value: "44766592" });
    const info = trc20Info({
      block: 87000004,
      ts: 4000,
      logs: [transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 44766592n })],
    });
    const { stream: s } = stream({
      trc20: [page([leg])],
      api: nodeApi({
        [txid]: {
          tx: { txID: txid, block_timestamp: 4000, raw_data_hex: bytesToHex(raw) },
          info,
        },
      }),
    });
    const [entry] = await drain(s);
    expect(entry?.verified).toBe(false);
    expect(flagsOf(entry)).not.toContain("chain-mismatch");
  });

  it("a body whose sha256 is not the txid mismatches even without transfer claims", async () => {
    const made = triggerBody({ owner: SENDER, contract: DDYS, block: 87000004, ts: 4000 });
    const txid = "c6".repeat(32);
    const leg = trc20Row(txid, { ts: 4000, from: SENDER, to: OWNER, value: "44766592" });
    const info = trc20Info({
      block: 87000004,
      ts: 4000,
      logs: [transferLog({ from: SENDER_HEX20, to: OWNER_HEX20, amount: 44766592n })],
    });
    const { stream: s } = stream({
      trc20: [page([leg])],
      api: nodeApi({ [txid]: { tx: { ...made.body, txID: txid }, info } }),
    });
    const [entry] = await drain(s);
    expect(flagsOf(entry)).toContain("chain-mismatch");
    expect(entry?.verified).toBe(false);
  });
});

describe("tron history flags", () => {
  it("compose flags a look-alike counterparty for tron", () => {
    const entry: HistoryEntry = {
      id: `${NETWORK}:${"b1".repeat(32)}`,
      family: "tron",
      network: NETWORK,
      hash: "b1".repeat(32),
      direction: "in",
      counterparties: ["TSu7TeaLYFJ72kTH2qYtV553wjoxs2K98A"],
      changes: [{ direction: "in", asset: "sun", amount: "1", listed: true }],
      status: "confirmed",
      timestamp: 1,
      verified: false,
      origin: "provider",
      flags: [],
    };
    const known = ["TSu7zzzzzzzzzzzzzzzzzzzzzzzzzzK98A"];
    const merged = compose(
      [entry],
      [],
      { evm: [], solana: [], bitcoin: [], tron: known, spark: [] },
      true,
    );
    expect(merged[0]?.flags).toContain("lookalike-counterparty");
  });
});
