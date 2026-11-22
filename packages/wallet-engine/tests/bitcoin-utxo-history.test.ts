/**
 * `utxosFromHistory` derives an address's UTXO set from its already-fetched Esplora `/txs` page
 * when the page is complete (fewer than 50 mempool / 25 confirmed rows — Esplora's truncation
 * bounds) and well-formed; anything else falls back to `/scripthash/:h/utxo`.
 *
 * The oracle is a global transaction graph: the expected UTXO set is every output paying an owned
 * script minus every outpoint any tx in the graph spends. The fake serves each address's `/txs`
 * view (txs touching the script — a spend of its output touches it through the prevout — mempool
 * first, confirmed newest-first, truncated to 50 mempool + 25 confirmed) and `/utxo` straight from
 * the global model, so both the derive and the fallback path must agree with it.
 */
import { HDKey } from "@scure/bip32";
import { NETWORK, p2wpkh } from "@scure/btc-signer";
import * as fc from "fast-check";
// oxlint-disable vitest/no-conditional-in-test -- property oracles and mocked fetches are inherently conditional
import { describe, expect, it } from "vite-plus/test";

import { hexOf, scriptPubKey, scripthash, utxosFromHistory } from "../src/chains/bitcoin-scan.ts";
import type { ScannedAddress } from "../src/chains/bitcoin-scan.ts";
import { esplora as esploraClient, EsploraError } from "../src/chains/bitcoin.ts";
import type { Esplora, EsploraFetch, EsploraResponse } from "../src/chains/bitcoin.ts";
import { esploraDeps } from "./send-helpers.ts";

const ACCOUNT = HDKey.fromMasterSeed(new Uint8Array(64).fill(7)).derive("m/84'/0'/0'");
const OURS = [0, 1, 2].map((i) => {
  const { address } = p2wpkh(ACCOUNT.deriveChild(0).deriveChild(i).publicKey!, NETWORK);
  if (address === undefined) {
    throw new Error("could not derive the test address");
  }
  return address;
});
const OURS_HEX = OURS.map((a) => hexOf(scriptPubKey(a, NETWORK)));
const FOREIGN_HEX = [`76a914${"ab".repeat(20)}88ac`, `5120${"cd".repeat(32)}`];
const SCRIPTS = [...OURS_HEX, ...FOREIGN_HEX];

type ModelTx = {
  readonly txid: string;
  readonly vin: ReadonlyArray<{ txid: string; vout: number; is_coinbase?: boolean }>;
  readonly vout: ReadonlyArray<{ scriptpubkey: string; value: number }>;
  readonly status: { confirmed: boolean; block_height?: number };
};

type RawTx = {
  readonly spends: ReadonlyArray<number>;
  readonly outs: ReadonlyArray<{ script: string; value: number }>;
  readonly confirmed: boolean;
  readonly height: number;
};

/** Resolve the raw choices into a tx graph: each spend points at an earlier tx's output. */
const buildModel = (raw: ReadonlyArray<RawTx>): ReadonlyArray<ModelTx> => {
  const txs: ModelTx[] = [];
  for (const [i, r] of raw.entries()) {
    const seen = new Set<string>();
    const vin = r.spends.flatMap((choice) => {
      if (i === 0) {
        return [];
      }
      const j = choice % i;
      const vout = Math.floor(choice / 256) % txs[j]!.vout.length;
      if (seen.has(`${j}:${vout}`)) {
        return [];
      }
      seen.add(`${j}:${vout}`);
      return [{ txid: txs[j]!.txid, vout }];
    });
    txs.push({
      txid: i.toString(16).padStart(64, "0"),
      vin: i === 0 ? [{ txid: "", vout: 0, is_coinbase: true }, ...vin] : vin,
      vout: r.outs.map((o) => ({ scriptpubkey: o.script, value: o.value })),
      status: r.confirmed ? { confirmed: true, block_height: r.height } : { confirmed: false },
    });
  }
  return txs;
};

const scriptOf = (txs: ReadonlyArray<ModelTx>, txid: string, vout: number): string | undefined =>
  txs.find((tx) => tx.txid === txid)?.vout[vout]?.scriptpubkey;

const touches = (txs: ReadonlyArray<ModelTx>, tx: ModelTx, script: string): boolean =>
  tx.vout.some((o) => o.scriptpubkey === script) ||
  tx.vin.some((v) => scriptOf(txs, v.txid, v.vout) === script);

/** The address's Esplora `/txs` page: mempool first, confirmed newest-first, Esplora-truncated. */
const view = (txs: ReadonlyArray<ModelTx>, script: string): ModelTx[] => {
  const hitting = txs.filter((tx) => touches(txs, tx, script));
  const mempool = hitting.filter((tx) => !tx.status.confirmed).slice(0, 50);
  const confirmed = hitting
    .filter((tx) => tx.status.confirmed)
    .toSorted((a, b) => (b.status.block_height ?? 0) - (a.status.block_height ?? 0))
    .slice(0, 25);
  return [...mempool, ...confirmed];
};

const spentKeys = (txs: ReadonlyArray<ModelTx>): Set<string> =>
  new Set(
    txs.flatMap((tx) =>
      tx.vin.filter((v) => v.is_coinbase !== true).map((v) => `${v.txid}:${v.vout}`),
    ),
  );

/** The global oracle: outputs to `script` that no tx in the graph spends. */
const expectedUtxos = (
  txs: ReadonlyArray<ModelTx>,
  script: string,
  address: string,
): ReadonlyArray<unknown> => {
  const spent = spentKeys(txs);
  return txs.flatMap((tx) =>
    tx.vout.flatMap((o, vout) =>
      o.scriptpubkey === script && !spent.has(`${tx.txid}:${vout}`)
        ? [
            {
              txid: tx.txid,
              vout,
              value: o.value,
              address,
              height: tx.status.confirmed ? tx.status.block_height : 0,
            },
          ]
        : [],
    ),
  );
};

const normal = (
  utxos: ReadonlyArray<{ txid: string; vout: number; value: number; height: number }>,
): ReadonlyArray<string> =>
  utxos.map((u) => `${u.txid}:${u.vout}:${u.value}:${u.height}`).toSorted();

/** One fake Esplora per graph: `/txs` serves the truncated view, `/utxo` the global model. */
const modelEsplora = (txs: ReadonlyArray<ModelTx>, utxoCalls: number[]): Esplora => ({
  get: async (path) => {
    const m = /^\/scripthash\/([0-9a-f]+)\/(txs|utxo)$/.exec(path);
    if (m === null) {
      return Promise.reject(new Error(`unmocked ${path}`));
    }
    const script = OURS_HEX[OURS.findIndex((a) => scripthash(a, NETWORK) === m[1])];
    if (m[2] === "txs") {
      return Promise.resolve(view(txs, script ?? ""));
    }
    utxoCalls.push(1);
    const spent = spentKeys(txs);
    return Promise.resolve(
      txs.flatMap((tx) =>
        tx.vout.flatMap((o, vout) =>
          o.scriptpubkey === script && !spent.has(`${tx.txid}:${vout}`)
            ? [
                {
                  txid: tx.txid,
                  vout,
                  value: o.value,
                  status: tx.status,
                },
              ]
            : [],
        ),
      ),
    );
  },
  post: async () => Promise.reject(new Error("unmocked")),
});

const numRuns = Number(process.env["FUZZ_RUNS"] ?? "100");

describe("utxosFromHistory", () => {
  it("derives the global UTXO set from random transaction graphs", async () => {
    const rawTx = fc.record({
      spends: fc.array(fc.integer({ min: 0, max: 2 ** 20 }), { minLength: 0, maxLength: 2 }),
      outs: fc.array(
        fc.record({
          script: fc.constantFrom(...SCRIPTS),
          value: fc.integer({ min: 600, max: 2_000_000 }),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      confirmed: fc.boolean(),
      height: fc.integer({ min: 800_000, max: 900_000 }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(rawTx, { minLength: 1, maxLength: 80 }), async (raw) => {
        const txs = buildModel(raw);
        const utxoCalls: number[] = [];
        const es = modelEsplora(txs, utxoCalls);
        const scanned: ScannedAddress[] = OURS.map((address, index) => {
          const txsView = view(txs, OURS_HEX[index]!);
          return { chain: 0, index, address, used: txsView.length > 0, txs: txsView };
        });
        const utxos = await utxosFromHistory(es, scanned, NETWORK);
        const expected = OURS.flatMap((address, index) =>
          expectedUtxos(txs, OURS_HEX[index]!, address).map(
            (u) => u as { txid: string; vout: number; value: number; height: number },
          ),
        );
        expect(normal(utxos)).toStrictEqual(
          normal(
            expected as ReadonlyArray<{
              txid: string;
              vout: number;
              value: number;
              height: number;
            }>,
          ),
        );
        // `/utxo` is asked exactly for the non-empty, truncated views — never for complete ones.
        const expectedCalls = scanned.filter((a) => {
          const page = a.txs as ReadonlyArray<ModelTx>;
          return (
            page.length > 0 &&
            !(
              page.filter((t) => t.status.confirmed).length < 25 &&
              page.filter((t) => !t.status.confirmed).length < 50
            )
          );
        }).length;
        expect(utxoCalls).toHaveLength(expectedCalls);
      }),
      { numRuns },
    );
  });

  const spent_ = (txid: string): ModelTx => ({
    txid,
    vin: [],
    vout: [{ scriptpubkey: OURS_HEX[0]!, value: 1000 }],
    status: { confirmed: true, block_height: 800_000 },
  });

  const servedEsplora = (
    txs: ReadonlyArray<unknown>,
    utxoRows: ReadonlyArray<unknown>,
    calls: string[],
  ): Esplora => ({
    get: async (path) => {
      calls.push(path);
      if (path.endsWith("/utxo")) {
        return Promise.resolve(utxoRows);
      }
      return Promise.resolve(txs);
    },
    post: async () => Promise.reject(new Error("unmocked")),
  });

  const candidate = (txs: ReadonlyArray<unknown>): ScannedAddress => ({
    chain: 0,
    index: 0,
    address: OURS[0]!,
    used: txs.length > 0,
    txs,
  });

  it("a complete well-formed history answers without a /utxo call", async () => {
    const calls: string[] = [];
    const es = servedEsplora([spent_("aa".repeat(32))], [], calls);
    const utxos = await utxosFromHistory(es, [candidate([spent_("aa".repeat(32))])], NETWORK);
    expect(calls).toStrictEqual([]);
    expect(normal(utxos)).toStrictEqual([`${"aa".repeat(32)}:0:1000:800000`]);
  });

  it("an empty history answers no UTXOs with no call at all", async () => {
    const calls: string[] = [];
    const es = servedEsplora([], [], calls);
    await expect(utxosFromHistory(es, [candidate([])], NETWORK)).resolves.toStrictEqual([]);
    expect(calls).toStrictEqual([]);
  });

  const utxoRow = { txid: "bb".repeat(32), vout: 1, value: 5000, status: { block_height: 0 } };
  const fallbackRows = [utxoRow];

  it.each([
    ["a malformed tx", [{ txid: "cc".repeat(32), vout: "not-an-array" }]],
    [
      "a tx with a non-hex scriptpubkey",
      [
        {
          txid: "cc".repeat(32),
          vin: [],
          vout: [{ scriptpubkey: "zz", value: 1 }],
          status: {},
        },
      ],
    ],
    [
      "a non-coinbase vin without txid/vout",
      [
        {
          txid: "cc".repeat(32),
          vin: [{ txid: "dd".repeat(32) }],
          vout: [],
          status: {},
        },
      ],
    ],
    [
      "a truncated confirmed page (25 rows)",
      Array.from({ length: 25 }, (_, i) => ({
        txid: (i + 1).toString(16).padStart(64, "0"),
        vin: [],
        vout: [],
        status: { confirmed: true, block_height: 800_000 },
      })),
    ],
    [
      "a truncated mempool page (50 rows)",
      Array.from({ length: 50 }, (_, i) => ({
        txid: (i + 1).toString(16).padStart(64, "0"),
        vin: [],
        vout: [],
        status: { confirmed: false },
      })),
    ],
    ["a duplicated txid", [spent_("ee".repeat(32)), spent_("ee".repeat(32))]],
    [
      "a tx spending one outpoint twice",
      [
        {
          txid: "ff".repeat(32),
          vin: [
            { txid: "dd".repeat(32), vout: 0 },
            { txid: "dd".repeat(32), vout: 0 },
          ],
          vout: [{ scriptpubkey: OURS_HEX[0]!, value: 1 }],
          status: {},
        },
      ],
    ],
  ])("falls back to /utxo on %s and parses it like scanUtxos", async (_name, txs) => {
    const calls: string[] = [];
    const es = servedEsplora(txs, fallbackRows, calls);
    const utxos = await utxosFromHistory(es, [candidate(txs)], NETWORK);
    expect(calls).toStrictEqual([`/scripthash/${scripthash(OURS[0]!, NETWORK)}/utxo`]);
    expect(utxos).toStrictEqual([
      {
        txid: utxoRow.txid,
        vout: utxoRow.vout,
        value: utxoRow.value,
        address: OURS[0],
        height: 0,
      },
    ]);
  });

  it("a stalled fallback /utxo read surfaces the esplora client's typed timeout", async () => {
    const hang: EsploraFetch = async (_url, init) => {
      const sig = init?.signal;
      if (sig === undefined) {
        return new Promise<EsploraResponse>(() => {});
      }
      return new Promise<EsploraResponse>((_resolve, reject) => {
        sig.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    const es = esploraClient(["http://electrs.test"], hang, esploraDeps(), 20);
    const malformed = candidate([{ txid: "cc".repeat(32) }]);
    await expect(utxosFromHistory(es, [malformed], NETWORK)).rejects.toMatchObject({
      transient: true,
    });
    await expect(utxosFromHistory(es, [malformed], NETWORK)).rejects.toThrow(EsploraError);
  });
});
