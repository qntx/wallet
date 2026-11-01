import type { RecordStore, StoreOp, VaultImage } from "./store.ts";
export declare function cloneImage(image: VaultImage): VaultImage;
/**
 * In-memory RecordStore for the Node host and kernel tests. Loads and commits deep-copy every
 * Uint8Array, so callers can never mutate stored state. `commit` applies ops to a clone and swaps
 * atomically: a failing precondition (`init`, `expect-revision`, a counter op on an empty store)
 * leaves the store untouched. Content ops bump `meta.revision` once per commit; an `init` commit
 * writes its meta verbatim (revision stays as the initializer set it).
 */
/**
 * Applies a commit's ops to a vault image and returns the next image — the single implementation of
 * record/factor op semantics shared by the memory store and the file-backed store in
 *
 * @qntx/wallet-native.
 */
export declare function applyStoreOps(image: VaultImage, ops: ReadonlyArray<StoreOp>): VaultImage;
export declare function createMemoryStore(): RecordStore;
