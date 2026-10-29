/**
 * The store RPC shared by the worker (`src/worker/store-client.ts`) and the main side
 * (`src/node/store-server.ts`). The vault image travels as plain structured-clone data — it is
 * ciphertext plus public headers only, never decrypted secrets. This file stays platform-neutral:
 * the port shape is injected on both sides.
 */
import type { KernelErrorCode, StoreOp, VaultImage } from "@qntx/wallet-kernel";

export type StorePort = {
  readonly post: (message: unknown) => void;
  readonly listen: (handler: (message: unknown) => void) => () => void;
};

export type StoreRequest =
  | { readonly t: "load"; readonly id: number }
  | { readonly t: "commit"; readonly id: number; readonly ops: ReadonlyArray<StoreOp> };

export type StoreReply =
  | { readonly t: "loaded"; readonly id: number; readonly image: WireImage }
  | { readonly t: "committed"; readonly id: number }
  | { readonly t: "failed"; readonly id: number; readonly code: KernelErrorCode }
  | { readonly t: "changed" };

/** Structured clone preserves `undefined` properties, so `meta` travels as-is. */
type WireImage = VaultImage;

export function encodeImage(image: VaultImage): WireImage {
  return { meta: image.meta, factors: image.factors, records: image.records };
}

export { assertVaultImage } from "@qntx/wallet-kernel";

export type IdleMinutes = 5 | 15 | 60;

export function isIdleMinutes(value: unknown): value is IdleMinutes {
  return value === 5 || value === 15 || value === 60;
}

export function idleMsOf(minutes: IdleMinutes): number {
  return minutes * 60_000;
}

/** The fixed maximum session duration owned by the worker entries (never a host input). */
export const MAX_SESSION_MS: number = 12 * 3_600_000;

/**
 * The first message the Web host posts to `kernel.worker.js`: the session policy. The browser
 * worker's vault lives in IndexedDB inside the worker itself, so unlike Node there is no store port
 * — policy is all the kernel needs before `startKernel` runs.
 */
export type BrowserWorkerInit = {
  readonly t: "init";
  readonly idleMinutes: IdleMinutes;
};

function plainInitObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a plain object above
  return value as Record<string, unknown>;
}

/** Strict init-message validation; anything else must not start the kernel. */
export function isBrowserWorkerInit(value: unknown): value is BrowserWorkerInit {
  const init = plainInitObject(value);
  return (
    init !== undefined &&
    Object.keys(init).sort().join(",") === "idleMinutes,t" &&
    init["t"] === "init" &&
    isIdleMinutes(init["idleMinutes"])
  );
}

/**
 * Strict `workerData` validation for the Node kernel worker: `{ idleMinutes, storePort }` and
 * nothing else. `storePort` is checked structurally (the real type lives behind the worker_threads
 * boundary); a wrong shape must not start the kernel.
 */
export function isNodeWorkerData(
  value: unknown,
): value is { readonly idleMinutes: IdleMinutes; readonly storePort: unknown } {
  const data = plainInitObject(value);
  return (
    data !== undefined &&
    Object.keys(data).sort().join(",") === "idleMinutes,storePort" &&
    isIdleMinutes(data["idleMinutes"]) &&
    typeof data["storePort"] === "object" &&
    data["storePort"] !== null
  );
}
