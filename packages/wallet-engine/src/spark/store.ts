import type { SparkExitChain, SparkStore } from "@qntx/spark";

import type { EngineCollection } from "../store/port.ts";
import { decodeExitChain, encodeExitChain } from "./exit-chain-codec.ts";

/**
 * SparkStore over one EngineCollection: chains keyed by leafId, enumerated by the port's `list()`.
 * A record that fails to decode — or does not name its own key, like a leftover `__all__` index
 * row from older data — is skipped, not fatal: the next leaves sync rewrites it.
 */
export function sparkStore(col: EngineCollection): SparkStore {
  const readChain = async (leafId: string): Promise<SparkExitChain | undefined> => {
    const record = await col.get(leafId);
    if (record === undefined) {
      return undefined;
    }
    try {
      const chain = decodeExitChain(record);
      return chain.leafId === leafId ? chain : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    exitChains: async () => {
      const keys = [...(await col.list())].sort();
      const chains: SparkExitChain[] = [];
      for (const leafId of keys) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- reads must stay ordered and sequential
        const chain = await readChain(leafId);
        if (chain !== undefined) {
          chains.push(chain);
        }
      }
      return chains;
    },
    putExitChains: async (chains) => {
      for (const chain of chains) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- writes commit one record at a time
        await col.put(chain.leafId, encodeExitChain(chain));
      }
    },
    deleteExitChains: async (leafIds) => {
      for (const leafId of leafIds) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- deletes commit one record at a time
        await col.delete(leafId);
      }
    },
  };
}
