import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import type { NETWORK as BTC_MAINNET } from "@scure/btc-signer";
import { p2wpkh } from "@scure/btc-signer/payment.js";
/**
 * Bitcoin chain adapter — Esplora client, gap-20 address scanning, PSBT construction with
 *
 * @scure/btc-signer selectUTXO (bip69), fee tiers from /fee-estimates (targets 1/3/6/144),
 * dust floors per output type, frozen 546/330-sat UTXOs, and POST /tx broadcasting. Custom
 * endpoints are validated by the genesis block hash via /block-height/0. RBF/CPFP are out
 * of scope for this layer.
 */
import type { TransactionInputUpdate } from "@scure/btc-signer/psbt.js";
import { selectUTXO } from "@scure/btc-signer/utxo.js";

const GAP_LIMIT = 20;
export { GAP_LIMIT };
const DUST: Record<string, number> = { p2wpkh: 294, p2tr: 330, p2pkh: 546 };
const FROZEN_AMOUNTS = new Set([546, 330]);

export type BtcNetworkId = `bip122:${string}`;

export type BtcUtxo = {
  readonly txid: string;
  readonly vout: number;
  readonly value: number;
  readonly address: string;
  readonly status: "unconfirmed" | "confirmed" | "locked" | "frozen";
  readonly height: number;
};

export type BtcAddress = {
  readonly chain: 0 | 1;
  readonly index: number;
  readonly address: string;
  readonly used: boolean;
};

export type Esplora = {
  readonly get: (path: string) => Promise<unknown>;
  readonly post: (path: string, body: string) => Promise<unknown>;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export type EsploraResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get: (name: string) => string | undefined };
  readonly json: () => Promise<unknown>;
  readonly text: () => Promise<string>;
};
export type EsploraFetch = (
  url: string,
  init?: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<EsploraResponse>;

const MAX_IN_FLIGHT = 4;
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 2000;

/** Bounded-concurrency + 429-aware ordered failover over the endpoint list. */
export const esplora = (
  endpoints: ReadonlyArray<string>,
  fetchFn: EsploraFetch,
  sleep: (ms: number) => Promise<void>,
): Esplora => {
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (inFlight >= MAX_IN_FLIGHT) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
    inFlight += 1;
  };
  const release = (): void => {
    inFlight -= 1;
    const next = waiters.shift();
    next?.();
  };
  const backoff = async (headers: EsploraResponse["headers"], retry: number): Promise<void> => {
    const ra = headers.get("retry-after");
    const retryAfterMs =
      ra !== null && ra !== "" && !Number.isNaN(Number(ra)) ? Number(ra) * 1000 : undefined;
    const jitter = Math.floor(Math.random() * 100);
    await sleep(retryAfterMs ?? Math.min(100 * 2 ** retry + jitter, MAX_BACKOFF_MS));
  };
  const call = async (
    base: string,
    path: string,
    body: string | undefined,
    retry: number,
  ): Promise<unknown> => {
    await acquire();
    try {
      const res = await fetchFn(
        `${base.replace(/\/$/, "")}${path}`,
        body === undefined
          ? { method: "GET" }
          : { method: "POST", headers: { "content-type": "text/plain" }, body },
      );
      if (res.status === 429) {
        if (retry >= MAX_RETRIES) {
          throw new Error(`esplora ${base}${path}: 429 after ${MAX_RETRIES} retries`);
        }
        await backoff(res.headers, retry);
        return await call(base, path, body, retry + 1);
      }
      if (!res.ok) {
        throw new Error(`esplora ${base}${path}: ${res.status}`);
      }
      const text = await res.text();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    } finally {
      release();
    }
  };
  const attempt = async (
    rest: ReadonlyArray<string>,
    path: string,
    body: string | undefined,
    last: unknown,
  ): Promise<unknown> => {
    const [base, ...next] = rest;
    if (base === undefined) {
      throw last instanceof Error ? last : new Error("all esplora endpoints failed");
    }
    try {
      return await call(base, path, body, 0);
    } catch (error) {
      return attempt(next, path, body, error);
    }
  };
  return {
    get: async (path) => attempt(endpoints, path, undefined, undefined),
    post: async (path, body) => attempt(endpoints, path, body, undefined),
  };
};

export const validateEndpoint = async (es: Esplora, genesisHash: string): Promise<void> => {
  const got = await es.get("/block-height/0");
  if (got !== genesisHash) {
    throw new Error(`endpoint genesis ${String(got)} ≠ ${genesisHash}`);
  }
};

export const feeTiers = async (
  es: Esplora,
): Promise<ReadonlyArray<{ tier: "fast" | "normal" | "slow" | "economy"; satPerByte: number }>> => {
  const res = await es.get("/fee-estimates");
  const estimates = isObject(res) ? res : {};
  const pick = (target: string): number => Math.max(1, Math.ceil(Number(estimates[target] ?? 1)));
  return [
    { tier: "fast", satPerByte: pick("1") },
    { tier: "normal", satPerByte: pick("3") },
    { tier: "slow", satPerByte: pick("6") },
    { tier: "economy", satPerByte: pick("144") },
  ];
};

export const dustFor = (scriptType: string): number => DUST[scriptType] ?? 546;

export const isFrozen = (value: number): boolean => FROZEN_AMOUNTS.has(value);

export type BtcInput = TransactionInputUpdate;

export class BitcoinChainAdapter {
  /** Inputs for selectUTXO — the same TransactionInputUpdate objects added to the PSBT. */
  toInputs(
    utxos: ReadonlyArray<BtcUtxo>,
    fingerprint: number,
    pathOf: (utxo: BtcUtxo) => number[],
    pubkeyOf: (utxo: BtcUtxo) => Uint8Array,
    scriptOf: (utxo: BtcUtxo) => Uint8Array,
    template: string,
    rawTxOf?: (utxo: BtcUtxo) => Uint8Array | undefined,
  ): BtcInput[] {
    return utxos
      .filter((u) => u.status === "confirmed" && !isFrozen(u.value))
      .map((u) => {
        const pub = pubkeyOf(u);
        // bip49 is a segwit-wrapped P2SH spend (witnessUtxo + redeemScript);
        // bip44 P2PKH proves the prevout through the whole prior transaction.
        const entry: TransactionInputUpdate = {
          txid: u.txid,
          index: u.vout,
          sequence: 0xfffffffd,
          ...(template === "btc.bip44"
            ? {}
            : { witnessUtxo: { amount: BigInt(u.value), script: scriptOf(u) } }),
        };
        if (template === "btc.bip44") {
          const raw = rawTxOf === undefined ? undefined : rawTxOf(u);
          if (raw === undefined) {
            throw new Error(`no raw transaction for bip44 input ${u.txid}`);
          }
          entry.nonWitnessUtxo = raw;
        }
        if (template === "btc.bip86") {
          entry.tapInternalKey = pub.subarray(1);
          entry.tapBip32Derivation = [
            [pub.subarray(1), { hashes: [], der: { fingerprint, path: pathOf(u) } }],
          ];
        } else {
          entry.bip32Derivation = [[pub, { fingerprint, path: pathOf(u) }]];
          if (template === "btc.bip49") {
            entry.redeemScript = p2wpkh(pub).script;
          }
        }
        return entry;
      });
  }

  buildPsbt(
    inputs: ReadonlyArray<BtcInput>,
    to: string,
    amount: bigint,
    feePerByte: bigint,
    changeAddress: string,
    network: typeof BTC_MAINNET,
  ): { readonly psbt: Uint8Array; readonly inputs: ReadonlyArray<BtcInput> } {
    const selection = selectUTXO([...inputs], [{ address: to, amount }], "default", {
      feePerByte,
      changeAddress,
      bip69: true,
      dust: BigInt(dustFor("p2wpkh")),
      network,
      createTx: true,
    });
    if (selection === undefined || selection.tx === undefined) {
      throw new Error("insufficient confirmed utxo for the amount + fee");
    }
    const wanted = new Set(
      (selection.inputs ?? []).flatMap((sel) => {
        const raw = sel.txid;
        if (!(raw instanceof Uint8Array)) {
          return [];
        }
        const forward = hex.encode(raw);
        const reverse = hex.encode(Uint8Array.from(raw).reverse());
        return [`${forward}:${String(sel.index ?? -1)}`, `${reverse}:${String(sel.index ?? -1)}`];
      }),
    );
    const chosen = inputs.filter((i) => wanted.has(`${String(i.txid)}:${String(i.index)}`));
    return { psbt: selection.tx.toPSBT(), inputs: chosen };
  }

  /** Fixed-input/output PSBT — the RBF/CPFP path, which chooses nothing itself. */
  buildExactPsbt(
    inputs: ReadonlyArray<BtcInput>,
    outputs: ReadonlyArray<{ readonly address: string; readonly amount: bigint }>,
    network: typeof BTC_MAINNET,
  ): { readonly psbt: Uint8Array; readonly vsize: number } {
    const tx = new Transaction();
    for (const input of inputs) {
      tx.addInput(input);
    }
    for (const out of outputs) {
      tx.addOutputAddress(out.address, out.amount, network);
    }
    // Unsigned tx has no witness — vsize is the BIP-141 weight estimate
    // (10.5 overhead + ~68/input + ~31/output for P2WPKH; taproot ~57.5/43).
    const tap = inputs.every((i) => i.tapInternalKey !== undefined);
    const vsize = Math.ceil(
      10.5 + inputs.length * (tap ? 57.5 : 68) + outputs.length * (tap ? 43 : 31),
    );
    return { psbt: tx.toPSBT(), vsize };
  }
}
