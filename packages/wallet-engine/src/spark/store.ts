import type { SparkExitChain, SparkStore } from "@qntx/spark";

import { EngineStoreError } from "../errors.ts";
import { readJson } from "../store/json.ts";
import type { EngineCollection } from "../store/port.ts";
import { decodeExitChain, encodeExitChain } from "./exit-chain-codec.ts";

const ALL = "__all__";

const isIntegrity = (error: unknown): boolean =>
  error instanceof EngineStoreError && error.code === "integrity";

/**
 * SparkStore over one EngineCollection: chains keyed by leafId, plus an index record listing them
 * (`exitChains` is a full listing — the port has no secondary index). A corrupt index or record is
 * skipped, not fatal: the next leaves sync rewrites it.
 */
export function sparkStore(col: EngineCollection): SparkStore {
  const readIndex = async (): Promise<string[]> => {
    let index: Uint8Array | undefined;
    try {
      index = await col.get(ALL);
    } catch (error) {
      if (isIntegrity(error)) {
        return [];
      }
      throw error;
    }
    if (index === undefined) {
      return [];
    }
    const parsed = readJson(index);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((v): v is string => typeof v === "string");
  };
  const writeIndex = async (ids: ReadonlyArray<string>): Promise<void> => {
    await col.put(ALL, new TextEncoder().encode(JSON.stringify(ids)));
  };
  const readChain = async (leafId: string): Promise<SparkExitChain | undefined> => {
    let record: Uint8Array | undefined;
    try {
      record = await col.get(leafId);
    } catch (error) {
      if (isIntegrity(error)) {
        return undefined;
      }
      throw error;
    }
    if (record === undefined) {
      return undefined;
    }
    try {
      return decodeExitChain(record);
    } catch {
      return undefined;
    }
  };
  return {
    exitChains: async () => {
      const ids = await readIndex();
      const chains: SparkExitChain[] = [];
      for (const leafId of ids) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- reads must stay ordered and sequential
        const chain = await readChain(leafId);
        if (chain !== undefined) {
          chains.push(chain);
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
