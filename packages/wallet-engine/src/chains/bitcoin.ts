/**
 * Bitcoin chain adapter — Esplora client, gap-20 address scanning, PSBT construction with
 * @scure/btc-signer selectUTXO (bip69), fee tiers from /fee-estimates (targets 1/3/6/144),
 * dust floors per output type, frozen 546/330-sat UTXOs, and POST /tx broadcasting. Custom
 * endpoints are validated by the genesis block hash via /block-height/0. RBF/CPFP are out
 * of scope for this layer.
 */
import { selectUTXO, Transaction, NETWORK as BTC_MAINNET } from "@scure/btc-signer";

import type { SolanaRpc } from "../networks/controller.ts";

const GAP = 20;
const DUST: Record<string, number> = { p2wpkh: 294, p2tr: 330, p2pkh: 546 };
const FROZEN_AMOUNTS = new Set([546, 330]);

export type BtcNetworkId = `bip122:${string}`;

export type BtcUtxo = {
  readonly txid: string;
  readonly vout: number;
  readonly value: number;
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
  fetchFn: (url: string, init?: unknown) => Promise<{ json: () => Promise<unknown>; ok: boolean; text: () => Promise<string> }>,
): Esplora => ({
  get: async (path) => {
    let last: unknown;
    for (const base of endpoints) {
      try {
        const res = await fetchFn(`${base.replace(/\/$/, "")}${path}`);
        return res.json();
      } catch (e) {
        last = e;
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
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error("all esplora endpoints failed");
  },
});

export const validateEndpoint = async (
  es: Esplora,
  genesisHash: string,
): Promise<void> => {
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

export class BitcoinChainAdapter {
  /** Fee-payer aware PSBT build with derivation entries the kernel re-derives. */
  buildPsbt(params: {
    readonly utxos: ReadonlyArray<BtcUtxo>;
    readonly to: string;
    readonly amount: bigint;
    readonly feePerByte: number;
    readonly changeAddress: string;
    readonly network: typeof BTC_MAINNET;
    readonly scriptOf: (address: string) => Uint8Array;
    readonly fingerprint: number;
    readonly pathOf: (utxo: BtcUtxo) => string;
  }): Uint8Array {
    const inputs = params.utxos
      .filter((u) => u.status === "confirmed" && !isFrozen(u.value))
      .map((u) => ({ txid: u.txid, index: u.vout }));
    const outputs = [
      { address: params.to, amount: params.amount },
      { address: params.changeAddress, amount: 0n }, // placeholder — selectUTXO fills change
    ];
    const selection = selectUTXO(inputs, outputs.slice(0, 1), "default", {
      feePerByte: BigInt(params.feePerByte),
      changeAddress: params.changeAddress,
      bip69: true,
      dust: dustFor("p2wpkh"),
      network: params.network,
      createTx: false,
      requiredInputs: undefined,
    });
    if (selection === undefined || !("inputs" in selection)) {
      throw new Error("insufficient confirmed utxo for the amount + fee");
    }
    const tx = new Transaction({ version: 2 });
    for (const input of selection.inputs ?? []) {
      const utxo = params.utxos.find(
        (u) => u.txid === input.txid && u.vout === input.index,
      );
      if (utxo === undefined) {
        continue;
      }
      tx.addInput({
        txid: input.txid,
        index: input.index,
        sequence: 0xfffffff0,
        witnessUtxo: {
          script: params.scriptOf(params.changeAddress),
          amount: BigInt(utxo.value),
        },
        bip32Derivation: [
          {
            fingerprint: params.fingerprint,
            path: params.pathOf(utxo),
            pubkey: new Uint8Array(33),
          },
        ],
      });
    }
    for (const output of selection.outputs ?? []) {
      tx.addOutputAddress(output.address ?? params.changeAddress, output.amount ?? 0n, params.network);
    }
    return tx.toPSBT();
  }
}
