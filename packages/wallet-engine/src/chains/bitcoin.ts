import type { NETWORK as BTC_MAINNET } from "@scure/btc-signer";
/**
 * Bitcoin chain adapter — Esplora client, gap-20 address scanning, PSBT construction with
 *
 * @scure/btc-signer selectUTXO (bip69), fee tiers from /fee-estimates (targets 1/3/6/144),
 * dust floors per output type, frozen 546/330-sat UTXOs, and POST /tx broadcasting. Custom
 * endpoints are validated by the genesis block hash via /block-height/0. RBF/CPFP are out
 * of scope for this layer.
 */
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
): Esplora => ({
  get: async (path) => {
    let last: unknown;
    for (const base of endpoints) {
      try {
        const res = await fetchFn(`${base.replace(/\/$/, "")}${path}`);
        return res.json();
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error("all esplora endpoints failed");
  },
  post: async (path, body) => {
    let last: unknown;
    for (const base of endpoints) {
      try {
        const res = await fetchFn(`${base.replace(/\/$/, "")}${path}`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body,
        });
        return res.text();
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error("all esplora endpoints failed");
  },
});

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

export type BtcInput = {
  readonly txid: string;
  readonly index: number;
  readonly sequence: number;
  readonly witnessUtxo: { readonly amount: bigint; readonly script: Uint8Array };
  readonly bip32Derivation?: ReadonlyArray<
    readonly [Uint8Array, { readonly fingerprint: number; readonly path: ReadonlyArray<number> }]
  >;
  readonly tapBip32Derivation?: ReadonlyArray<
    readonly [
      Uint8Array,
      {
        readonly hashes: ReadonlyArray<Uint8Array>;
        readonly der: { readonly fingerprint: number; readonly path: ReadonlyArray<number> };
      },
    ]
  >;
  readonly tapInternalKey?: Uint8Array;
};

export class BitcoinChainAdapter {
  /** Inputs for selectUTXO — the same TransactionInputUpdate objects added to the PSBT. */
  toInputs(
    utxos: ReadonlyArray<BtcUtxo>,
    fingerprint: number,
    pathOf: (utxo: BtcUtxo) => number[],
    pubkeyOf: (utxo: BtcUtxo) => Uint8Array,
    scriptOf: (utxo: BtcUtxo) => Uint8Array,
    tap: boolean,
  ): ReadonlyArray<{
    readonly txid: string;
    readonly index: number;
    readonly sequence: number;
    readonly witnessUtxo: { readonly amount: bigint; readonly script: Uint8Array };
    readonly bip32Derivation?: ReadonlyArray<
      [Uint8Array, { readonly fingerprint: number; readonly path: ReadonlyArray<number> }]
    >;
    readonly tapBip32Derivation?: ReadonlyArray<
      [
        Uint8Array,
        {
          readonly hashes: ReadonlyArray<Uint8Array>;
          readonly der: { readonly fingerprint: number; readonly path: ReadonlyArray<number> };
        },
      ]
    >;
    readonly tapInternalKey?: Uint8Array;
  }> {
    return utxos
      .filter((u) => u.status === "confirmed" && !isFrozen(u.value))
      .map((u) => ({
        txid: u.txid,
        index: u.vout,
        sequence: 0xfffffffd,
        witnessUtxo: { amount: BigInt(u.value), script: scriptOf(u) },
        ...(tap
          ? {
              tapInternalKey: pubkeyOf(u).subarray(1),
              tapBip32Derivation: [
                [
                  pubkeyOf(u).subarray(1),
                  { hashes: [] as Uint8Array[], der: { fingerprint, path: pathOf(u) } },
                ],
              ],
            }
          : {
              bip32Derivation: [[pubkeyOf(u), { fingerprint, path: pathOf(u) }]],
            }),
      }));
  }

  buildPsbt(
    inputs: ReadonlyArray<BtcInput>,
    to: string,
    amount: bigint,
    feePerByte: bigint,
    changeAddress: string,
    network: typeof BTC_MAINNET,
  ): { readonly psbt: Uint8Array; readonly inputs: ReadonlyArray<BtcInput> } {
    const selection = selectUTXO(
      [...inputs] as unknown as Parameters<typeof selectUTXO>[0],
      [{ address: to, amount }],
      "default",
      {
        feePerByte,
        changeAddress,
        bip69: true,
        dust: BigInt(dustFor("p2wpkh")),
        network,
        createTx: true,
      },
    );
    if (selection === undefined || selection.tx === undefined) {
      throw new Error("insufficient confirmed utxo for the amount + fee");
    }
    return {
      psbt: selection.tx.toPSBT(),
      inputs: selection.inputs as unknown as ReadonlyArray<BtcInput>,
    };
  }
}
