/**
 * File-backed `RecordStore` for the kernel runtime. The whole vault image is one strict-CBOR frame
 * in a single fixed file; the native layer gives only whole-file read and a serialized
 * compare-and-swap replace (flock + temp file + fsync + rename) — no path parameters, so no
 * traversal is possible. Semantics (preconditions, revision bump, deep-copy isolation) are exactly
 * the memory store's: ops are applied through the same `applyStoreOps` against the image just read
 * from the file, and the CAS write turns a lost race into `conflict` instead of a silent overwrite
 * — two kernels sharing one vault file cannot clobber each other.
 *
 * Imports go through relative source paths, never `@qntx/wallet-kernel`: the package is private and
 * cannot be declared, and this file is bundled into the kernel bytecode anyway.
 */
import { KernelError } from "../../wallet-kernel/src/errors.ts";
import { applyStoreOps, cloneImage } from "../../wallet-kernel/src/vault/memory.ts";
import type { RecordStore, VaultImage } from "../../wallet-kernel/src/vault/store.ts";
import { assertVaultImage } from "../../wallet-kernel/src/vault/validate.ts";
import { decodeFrame, encodeFrame } from "../src/cbor.ts";

/** The `__qntx.file` primitive the native host injects into the kernel runtime. */
export type KernelFile = {
  /** Whole-file bytes, or null when the file does not exist. */
  readonly read: () => Uint8Array | undefined;
  /**
   * Atomic compare-and-swap: replaces the file with `next` only when its current bytes equal
   * `expected` (undefined = the file must not exist). Returns false — writing nothing — when the
   * file changed underneath.
   */
  readonly replace: (next: Uint8Array, expected: Uint8Array | undefined) => boolean;
};

const EMPTY: VaultImage = { meta: undefined, records: [], factors: [] };

function decodeImage(bytes: Uint8Array): VaultImage {
  // Strict CBOR first (a malformed file throws CborError), then the same structural validation
  // every host store applies — a well-formed but wrong-shaped file is integrity, not data.
  // `meta` crosses the wire as null — undefined is not a CBOR value; the validator accepts it.
  const decoded = assertVaultImage(decodeFrame(bytes));
  return { ...decoded, meta: decoded.meta === null ? undefined : decoded.meta };
}

export function createFileStore(file: KernelFile): RecordStore {
  const listeners = new Set<() => void>();

  function readImage(): VaultImage {
    const bytes = file.read();
    return bytes === undefined ? EMPTY : decodeImage(bytes);
  }

  return {
    // oxlint-disable-next-line typescript/require-await -- errors must reject, not throw synchronously
    async load() {
      // The file is the truth across lock/rebuild: reload instead of caching so a crashed
      // runtime can never resurrect a pre-commit view.
      return cloneImage(readImage());
    },
    // oxlint-disable-next-line typescript/require-await -- errors must reject, not throw synchronously
    async commit(ops) {
      // The image is read at commit time — never cached — so `init` and `expect-revision`
      // preconditions judge the file's truth, and the compare-and-swap below fails closed when
      // another writer slipped in between this read and the write.
      const bytes = file.read();
      const next = applyStoreOps(bytes === undefined ? EMPTY : decodeImage(bytes), ops);
      const encoded = new Uint8Array(
        encodeFrame({
          meta: next.meta ?? null,
          records: next.records,
          factors: next.factors,
        }),
      );
      if (!file.replace(encoded, bytes)) {
        throw new KernelError("conflict", "vault store: vault changed underneath");
      }
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
