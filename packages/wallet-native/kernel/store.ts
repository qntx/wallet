/**
 * File-backed `RecordStore` for the kernel runtime. The whole vault image is one strict-CBOR frame
 * in a single fixed file; the native layer gives only whole-file read and atomic replace (temp file +
 * fsync + rename) — no path parameters, so no traversal is possible. Semantics (preconditions,
 * revision bump, deep-copy isolation) are exactly the memory store's: ops are applied through the
 * same `applyStoreOps` and rows are cloned through `cloneImage`.
 *
 * Imports go through relative source paths, never `@qntx/wallet-kernel`: the package is private and
 * cannot be declared, and this file is bundled into the kernel bytecode anyway.
 */
import { applyStoreOps, cloneImage } from "../../wallet-kernel/src/vault/memory.ts";
import type { RecordStore, VaultImage } from "../../wallet-kernel/src/vault/store.ts";
import { assertVaultImage } from "../../wallet-kernel/src/vault/validate.ts";
import { decodeFrame, encodeFrame } from "../src/cbor.ts";

/** The `__qntx.file` primitive the native host injects into the kernel runtime. */
export type KernelFile = {
  /** Whole-file bytes, or null when the file does not exist. */
  readonly read: () => Uint8Array | undefined;
  /** Atomic whole-file replace (temp + fsync + rename, fsync of the directory). */
  readonly write: (bytes: Uint8Array) => void;
};

const EMPTY: VaultImage = { meta: undefined, records: [], factors: [] };

export function createFileStore(file: KernelFile): RecordStore {
  const listeners = new Set<() => void>();
  let image: VaultImage | undefined;

  function readImage(): VaultImage {
    const bytes = file.read();
    if (bytes === undefined) {
      return EMPTY;
    }
    // Strict CBOR first (a malformed file throws CborError), then the same structural validation
    // every host store applies — a well-formed but wrong-shaped file is integrity, not data.
    // `meta` crosses the wire as null — undefined is not a CBOR value.
    // `meta` crosses the wire as null — undefined is not a CBOR value; the validator accepts it.
    const decoded = assertVaultImage(decodeFrame(bytes));
    return { ...decoded, meta: decoded.meta === null ? undefined : decoded.meta };
  }

  return {
    // oxlint-disable-next-line typescript/require-await -- errors must reject, not throw synchronously
    async load() {
      // The file is the truth across lock/rebuild: reload instead of caching so a crashed
      // runtime can never resurrect a pre-commit view.
      image = readImage();
      return cloneImage(image);
    },
    // oxlint-disable-next-line typescript/require-await -- errors must reject, not throw synchronously
    async commit(ops) {
      const next = applyStoreOps(image ?? readImage(), ops);
      // Write before committing to memory: a failed write leaves both the file and the in-memory
      // image at the previous state, so the next commit cannot build on unpersisted state.
      file.write(
        new Uint8Array(
          encodeFrame({
            meta: next.meta ?? null,
            records: next.records,
            factors: next.factors,
          }),
        ),
      );
      image = next;
      for (const listener of listeners) {
        listener();
      }
    },
    watch(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
