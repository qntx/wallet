import { hex } from "@scure/base";
import type { NETWORK as BTC_MAINNET } from "@scure/btc-signer";
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

/** Ordered failover over the host/custom endpoint list. */
export const esplora = (
  endpoints: ReadonlyArray<string>,
  fetchFn: (
    url: string,
    init?: unknown,
  ) => Promise<{ json: () => Promise<unknown>; ok: boolean; text: () => Promise<string> }>,
): Esplora => {
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
      const res = await fetchFn(
        `${base.replace(/\/$/, "")}${path}`,
        body === undefined
          ? undefined
          : { method: "POST", headers: { "content-type": "text/plain" }, body },
      );
      return await (body === undefined ? res.json() : res.text());
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
    tap: boolean,
  ): BtcInput[] {
    return utxos
      .filter((u) => u.status === "confirmed" && !isFrozen(u.value))
      .map((u) => {
        const pub = pubkeyOf(u);
        const entry: TransactionInputUpdate = {
          txid: u.txid,
          index: u.vout,
          sequence: 0xfffffffd,
          witnessUtxo: { amount: BigInt(u.value), script: scriptOf(u) },
        };
        if (tap) {
          entry.tapInternalKey = pub.subarray(1);
          entry.tapBip32Derivation = [
            [pub.subarray(1), { hashes: [], der: { fingerprint, path: pathOf(u) } }],
          ];
        } else {
          entry.bip32Derivation = [[pub, { fingerprint, path: pathOf(u) }]];
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
}
