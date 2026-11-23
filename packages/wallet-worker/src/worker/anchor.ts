/**
 * The Web vault anchor: the few bytes the kernel keeps OUTSIDE the IndexedDB vault store. Cache
 * Storage is a separate backend from IndexedDB (Chromium keeps every IndexedDB database of an
 * origin in one LevelDB, Cache Storage in another), so a restore that rewinds only the vault
 * database is detected. It does not resist a same-origin script or extension — they can write both
 * stores — or a whole-profile restore.
 *
 * One entry in `caches.open("qntx-wallet-anchor")`, keyed by a fixed same-origin URL: never
 * relative to the worker script, whose path changes with deploy layouts. Cache Storage has no
 * conditional put, so `replace` runs read-compare-put inside the cross-tab Web Lock of the same
 * name and two tabs' workers serialize the CAS.
 */
import type { VaultAnchor } from "@qntx/wallet-kernel";

const CACHE_NAME = "qntx-wallet-anchor";
const LOCK_NAME = "qntx-wallet-anchor";
const ENTRY_URL = new URL("/qntx-wallet/anchor", self.location.origin).href;

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

async function readBytes(): Promise<Uint8Array | undefined> {
  const cache = await caches.open(CACHE_NAME);
  const response = await cache.match(ENTRY_URL);
  return response === undefined ? undefined : new Uint8Array(await response.arrayBuffer());
}

export function createCacheAnchor(): VaultAnchor {
  return {
    read: readBytes,
    replace: async (next, expected) =>
      globalThis.navigator.locks.request(LOCK_NAME, async () => {
        const stored = await readBytes();
        const match =
          stored === undefined
            ? expected === undefined
            : expected !== undefined && equalBytes(stored, expected);
        if (!match) {
          return false;
        }
        const cache = await caches.open(CACHE_NAME);
        // A Response body wants an ArrayBuffer-backed view; `next` is caller memory — copy it.
        const body = new Uint8Array(new ArrayBuffer(next.length));
        body.set(next);
        await cache.put(
          ENTRY_URL,
          new Response(body, {
            headers: { "content-type": "application/octet-stream" },
          }),
        );
        return true;
      }),
  };
}
