/**
 * EVM chain adapter: native transfers through a viem PublicClient injected by NetworkController.
 * Fee tiers come from eth_feeHistory (20 blocks, p10/p50/p90 → slow/normal/fast, maxFee = 2×baseFee +
 * priority); networks that cannot answer feeHistory fall back to eth_gasPrice. gas = estimateGas ×
 * 1.2 (ceil). Nonces are allocated on a per-(network, from) serial queue as max(pending count, last
 * submitted + 1). Finalization uses the `finalized` block tag; receipts with status 0 fail.
 */
import { numberToHex } from "viem";
import type { PublicClient } from "viem";

import type { EvmTransaction, SignRequest } from "@qntx/wallet-chains";

export type EvmSignRequest = Extract<SignRequest, { kind: "evm.transaction" }>;
export type EvmSignResult = {
  readonly kind: "evm.transaction";
  readonly signedTransaction: Uint8Array;
};

export type EvmFeeTier = "slow" | "normal" | "fast";

export type EvmUnsignedTransaction = {
  readonly family: "evm";
  readonly network: string;
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
  readonly nonce: number;
  readonly gas: bigint;
  readonly gasPrice?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
};

export type EvmFeeQuote = {
  readonly tier: EvmFeeTier;
  readonly wei: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint | undefined;
};
export type ChainTxStatus = "pending" | "confirmed" | "failed" | "finalized";

const hex = (v: bigint | number): string => numberToHex(v);

export class EvmChainAdapter {
  readonly family = "evm";
  private readonly nonces = new Map<string, Promise<unknown>>();
  private readonly lastNonce = new Map<string, number>();

  private async serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const prior = this.nonces.get(key) ?? Promise.resolve();
    const next = (async () => {
      try {
        await prior;
      } catch {
        // a failed earlier run must not poison the nonce queue
      }
      return run();
    })();
    this.nonces.set(key, next);
    return next;
  }

  private async rpc(client: PublicClient, method: string, params: unknown[]): Promise<unknown> {
    return client.transport.request({ method, params });
  }

  private async rpcHex(client: PublicClient, method: string, params: unknown[]): Promise<string> {
    const result: unknown = await this.rpc(client, method, params);
    if (typeof result !== "string") {
      throw new TypeError(`${method} returned a malformed result`);
    }
    return result;
  }

  /** Allocate the next nonce for (network, from) — serial per key. */
  private async nonce(client: PublicClient, network: string, from: string): Promise<number> {
    const key = `${network}:${from}`;
    return this.serial(key, async () => {
      const pending = Number(
        await this.rpcHex(client, "eth_getTransactionCount", [from, "pending"]),
      );
      const local = this.lastNonce.get(key);
      const nonce = Math.max(pending, local === undefined ? 0 : local + 1);
      this.lastNonce.set(key, nonce);
      return nonce;
    });
  }

  async build(
    client: PublicClient,
    network: string,
    from: string,
    to: string,
    value: bigint,
  ): Promise<EvmUnsignedTransaction> {
    const nonce = await this.nonce(client, network, from);
    const estimate = BigInt(
      await this.rpcHex(client, "eth_estimateGas", [{ from, to, value: hex(value) }]),
    );
    const gas = (estimate * 12n) / 10n + ((estimate * 12n) % 10n === 0n ? 0n : 1n);
    return { family: "evm", network, from, to, value, nonce, gas };
  }

  async estimateFee(client: PublicClient): Promise<ReadonlyArray<EvmFeeQuote>> {
    try {
      const history: unknown = await this.rpc(client, "eth_feeHistory", [
        "0x14",
        "latest",
        [10, 50, 90],
      ]);
      if (
        typeof history !== "object" ||
        history === null ||
        !("baseFeePerGas" in history) ||
        !Array.isArray(history.baseFeePerGas) ||
        !("reward" in history) ||
        !Array.isArray(history.reward)
      ) {
        throw new TypeError("eth_feeHistory returned a malformed result");
      }
      const { baseFeePerGas, reward } = history;
      if (
        !Array.isArray(baseFeePerGas) ||
        !baseFeePerGas.every((v) => typeof v === "string") ||
        !Array.isArray(reward) ||
        !reward.every((r) => Array.isArray(r) && r.every((v) => typeof v === "string"))
      ) {
        throw new TypeError("eth_feeHistory returned a malformed result");
      }
      const baseFee = BigInt(baseFeePerGas.at(-1) ?? "0x0");
      const tier = (i: number, name: EvmFeeTier): EvmFeeQuote => {
        const last = reward.at(-1);
        const priority = last === undefined ? 0n : BigInt(last[i] ?? "0x0");
        const maxFeePerGas = baseFee * 2n + priority;
        return { tier: name, wei: maxFeePerGas, maxFeePerGas, maxPriorityFeePerGas: priority };
      };
      return [tier(0, "slow"), tier(1, "normal"), tier(2, "fast")];
    } catch {
      const price = BigInt(await this.rpcHex(client, "eth_gasPrice", []));
      return (["slow", "normal", "fast"] as const).map((name) => ({
        tier: name,
        wei: price,
        maxFeePerGas: price,
        maxPriorityFeePerGas: undefined,
      }));
    }
  }

  applyFee(tx: EvmUnsignedTransaction, fee: EvmFeeQuote): EvmUnsignedTransaction {
    if (fee.maxPriorityFeePerGas === undefined) {
      return { ...tx, gasPrice: fee.maxFeePerGas };
    }
    return {
      ...tx,
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    };
  }

  toSignRequest<A extends SignRequest["account"]>(
    tx: EvmUnsignedTransaction,
    account: A,
    chainId: number,
  ): EvmSignRequest & { readonly account: A } {
    const base = {
      chainId,
      nonce: tx.nonce,
      gas: hex(tx.gas),
      to: tx.to,
      value: hex(tx.value),
      data: "0x",
    };
    const transaction: EvmTransaction =
      tx.gasPrice === undefined
        ? {
            ...base,
            type: "eip1559",
            accessList: [],
            maxFeePerGas: hex(tx.maxFeePerGas ?? 0n),
            maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas ?? 0n),
          }
        : { ...base, type: "legacy", gasPrice: hex(tx.gasPrice) };
    return { kind: "evm.transaction", network: tx.network, account, tx: transaction };
  }

  finalize(
    _tx: EvmUnsignedTransaction,
    signed: { kind: string; signedTransaction?: Uint8Array },
  ): string {
    const bytes = signed.signedTransaction;
    if (signed.kind !== "evm.transaction" || bytes === undefined) {
      throw new Error(`unexpected sign result ${signed.kind}`);
    }
    return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  async broadcast(client: PublicClient, raw: string): Promise<string> {
    return this.rpcHex(client, "eth_sendRawTransaction", [raw]);
  }

  async status(client: PublicClient, hash: string): Promise<ChainTxStatus> {
    const receipt: unknown = await this.rpc(client, "eth_getTransactionReceipt", [hash]);
    if (receipt === null || typeof receipt !== "object") {
      return "pending";
    }
    if (
      "status" in receipt &&
      typeof receipt.status === "string" &&
      BigInt(receipt.status) === 0n
    ) {
      return "failed";
    }
    try {
      const finalized: unknown = await this.rpc(client, "eth_getBlockByNumber", [
        "finalized",
        false,
      ]);
      if (
        finalized !== null &&
        typeof finalized === "object" &&
        "number" in finalized &&
        typeof finalized.number === "string" &&
        "blockNumber" in receipt &&
        typeof receipt.blockNumber === "string" &&
        BigInt(receipt.blockNumber) <= BigInt(finalized.number)
      ) {
        return "finalized";
      }
    } catch {
      // endpoint does not know the `finalized` tag — receipt confirmation is enough
    }
    return "confirmed";
  }
}
