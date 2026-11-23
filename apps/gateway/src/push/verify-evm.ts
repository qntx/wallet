/**
 * The EVM receipt verifier for push records: one JSON-RPC batch per network — the finalized head
 * (`eth_getBlockByNumber "finalized"`, `id: 0`) then one `eth_getTransactionReceipt` per due record
 * (`id: i+1`) — sent through the shared forwarder, so failover, the breaker, cool-downs and
 * `PROVIDER_BUDGET` billing behave exactly as for a client call. Server-initiated checks have no
 * client share, so they run under `SERVICE_METER`.
 *
 * Every uncertainty answers `unknown` — never a throw: `CHECKS_PER_RUN` (50) already bounds the
 * batch at 51 calls, a malformed batch fails the provider over (`ProviderFailure`), and a whole
 * network that fails every provider leaves its records `unknown` for the next alarm.
 */
import * as z from "zod/mini";

import { rpcCost } from "../budget/costs.ts";
import type { ResolvedNetwork } from "../middleware/network.ts";
import { ProviderFailure, REFUSED_STATUSES, SERVICE_METER } from "../providers/forward.ts";
import type { Forwarder } from "../providers/forward.ts";
import type { PushFamilyConfig } from "./core.ts";
import type { CheckResult } from "./rules.ts";

/** A head plus up to 50 receipts (~4 KB each) stays far under this. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

const HEX = /^0x[0-9a-fA-F]+$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const batchEntrySchema = z.looseObject({ id: z.number() });
const batchSchema = z.array(batchEntrySchema);
type BatchEntry = z.infer<typeof batchEntrySchema>;

const blockSchema = z.looseObject({ number: z.string() });
const receiptSchema = z.looseObject({
  status: z.string(),
  blockNumber: z.string(),
  from: z.string(),
  transactionHash: z.string(),
});

const UNKNOWN: CheckResult = { kind: "unknown" };

const receiptOf = (
  entry: BatchEntry | undefined,
  hash: string,
  finalized: number | undefined,
): CheckResult => {
  const result = entry?.["result"];
  // `undefined`: the id never came back or answered a JSON-RPC error — uncertainty, not absence.
  if (result === undefined) {
    return UNKNOWN;
  }
  if (result === null) {
    return { kind: "absent" };
  }
  const receipt = z.safeParse(receiptSchema, result);
  if (!receipt.success) {
    return UNKNOWN;
  }
  const { status, blockNumber, from, transactionHash } = receipt.data;
  // The answer must name the requested transaction — a confused provider's receipt proves nothing.
  if (transactionHash.toLowerCase() !== hash.toLowerCase()) {
    return UNKNOWN;
  }
  if ((status !== "0x1" && status !== "0x0") || !HEX.test(blockNumber) || !EVM_ADDRESS.test(from)) {
    return UNKNOWN;
  }
  const block = Number(blockNumber);
  if (!Number.isSafeInteger(block)) {
    return UNKNOWN;
  }
  return {
    kind: "included",
    success: status === "0x1",
    block,
    // A missing, errored or malformed finalized head means non-final: chains without the tag keep
    // checking until the 24 h record retention.
    final: finalized !== undefined && block <= finalized,
    from: from.toLowerCase(),
  };
};

export const evmVerifier =
  ({
    forwarder,
    served,
  }: {
    readonly forwarder: Forwarder;
    readonly served: ReadonlyMap<string, ResolvedNetwork>;
  }): PushFamilyConfig["verify"] =>
  async (targets) => {
    const results: CheckResult[] = targets.map(() => UNKNOWN);
    const groups = new Map<string, number[]>();
    for (const [index, target] of targets.entries()) {
      const group = groups.get(target.network);
      if (group === undefined) {
        groups.set(target.network, [index]);
      } else {
        group.push(index);
      }
    }
    await Promise.all(
      [...groups.entries()].map(async ([networkId, indexes]) => {
        const network = served.get(networkId);
        if (network === undefined) {
          return;
        }
        const batch = [
          {
            jsonrpc: "2.0" as const,
            id: 0,
            method: "eth_getBlockByNumber",
            params: ["finalized", false],
          },
          ...indexes.map((target, index) => ({
            jsonrpc: "2.0" as const,
            id: index + 1,
            method: "eth_getTransactionReceipt",
            params: [targets[target]?.hash ?? ""],
          })),
        ];
        let entries: ReadonlyArray<BatchEntry>;
        try {
          const { value } = await forwarder.run(
            network.providers,
            async (send, provider) => {
              const response = await send({
                url: provider.url,
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(batch),
                cost: rpcCost(provider.costs, batch),
              });
              if (!response.ok) {
                // A provider failure fails over like a client call — never a GatewayHttpError.
                throw new ProviderFailure(
                  `status-${response.status}`,
                  REFUSED_STATUSES.has(response.status),
                );
              }
              const text = await response.text(MAX_RESPONSE_BYTES);
              let parsed: unknown;
              try {
                parsed = JSON.parse(text);
              } catch {
                throw new ProviderFailure("malformed", false);
              }
              const batchResult = z.safeParse(batchSchema, parsed);
              if (!batchResult.success) {
                throw new ProviderFailure("malformed", false);
              }
              return batchResult.data;
            },
            { meter: SERVICE_METER },
          );
          entries = value;
        } catch {
          // Every provider failed (outage, refusal, malformed, budget) — this network's records
          // stay unknown for the next alarm.
          return;
        }
        const byId = new Map<number, BatchEntry>();
        for (const entry of entries) {
          byId.set(entry.id, entry);
        }
        let finalized: number | undefined;
        const head = z.safeParse(blockSchema, byId.get(0)?.["result"]);
        if (head.success && HEX.test(head.data.number)) {
          const value = Number(head.data.number);
          finalized = Number.isSafeInteger(value) ? value : undefined;
        }
        for (const [batchIndex, targetIndex] of indexes.entries()) {
          const target = targets[targetIndex];
          results[targetIndex] =
            target === undefined
              ? UNKNOWN
              : receiptOf(byId.get(batchIndex + 1), target.hash, finalized);
        }
      }),
    );
    return results;
  };
