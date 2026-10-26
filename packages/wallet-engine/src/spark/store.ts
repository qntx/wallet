import type { SparkExitChain, SparkStore } from "@qntx/spark";

import type { EngineCollection } from "../store/port.ts";
import { decodeExitChain, encodeExitChain } from "./exit-chain-codec.ts";

const ALL = "__all__";

/**
 * SparkStore over one EngineCollection: chains keyed by leafId, plus an index record listing them
 * (`exitChains` is a full listing — the port has no secondary index).
 */
export function sparkStore(col: EngineCollection): SparkStore {
  const readIndex = async (): Promise<string[]> => {
    const index = await col.get(ALL);
    if (index === undefined) {
      return [];
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(index));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((v): v is string => typeof v === "string");
  };
  const writeIndex = async (ids: ReadonlyArray<string>): Promise<void> => {
    await col.put(ALL, new TextEncoder().encode(JSON.stringify(ids)));
  };
  return {
    exitChains: async () => {
      const ids = await readIndex();
      const chains: SparkExitChain[] = [];
      for (const leafId of ids) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- reads must stay ordered and sequential
        const record = await col.get(leafId);
        if (record !== undefined) {
          chains.push(decodeExitChain(record));
        }
      }
      return chains;
    },
    putExitChains: async (chains) => {
      const ids = await readIndex();
      const set = new Set(ids);
      for (const chain of chains) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- writes commit one record at a time
        await col.put(chain.leafId, encodeExitChain(chain));
        set.add(chain.leafId);
      }
      await writeIndex([...set]);
    },
    deleteExitChains: async (leafIds) => {
      const ids = await readIndex();
      const drop = new Set(leafIds);
      for (const leafId of leafIds) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- deletes commit one record at a time
        await col.delete(leafId);
      }
      await writeIndex(ids.filter((leafId) => !drop.has(leafId)));
    },
  };
}
