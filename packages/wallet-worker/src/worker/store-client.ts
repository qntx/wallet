/**
 * RecordStore and VaultAnchor over one MessagePort RPC: the vault image (ciphertext + public
 * headers) and the anchor live in the main thread so a lock can destroy the whole worker without
 * losing either — a worker-side anchor would lose the failure counters on every lock. The main side
 * pushes a "changed" notice when some other writer committed; `watch` relays it to the kernel. A
 * failed request comes back as `{ t: "failed", code }` and rejects — never left hanging.
 */
import { KernelError } from "@qntx/wallet-kernel";
import type { KernelErrorCode, RecordStore, StoreOp, VaultAnchor } from "@qntx/wallet-kernel";
import { walletErrorCode } from "@qntx/wallet/protocol";

import type { StorePort, StoreReply, StoreRequest } from "../shared.ts";
import { assertVaultImage } from "../shared.ts";

type Pending = {
  readonly resolve: (reply: StoreReply) => void;
  readonly reject: (error: Error) => void;
};

/** The code on a `failed` reply is only trusted if it is a real WalletErrorCode. */
function replyCode(code: unknown): KernelErrorCode {
  try {
    return walletErrorCode(code);
  } catch {
    return "unavailable";
  }
}

export function createStoreClient(port: StorePort): {
  readonly store: RecordStore;
  readonly anchor: VaultAnchor;
} {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const watchers = new Set<() => void>();

  port.listen((raw) => {
    // Internal channel between this package's two halves — a malformed message means the host
    // wiring is broken; dropping it is safer than guessing.
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- internal wire shape; malformed payloads are dropped by the t-checks
    const reply = raw as StoreReply;
    if (reply.t === "changed") {
      for (const watcher of watchers) {
        watcher();
      }
      return;
    }
    if (
      reply.t === "loaded" ||
      reply.t === "committed" ||
      reply.t === "anchor-loaded" ||
      reply.t === "anchor-replaced" ||
      reply.t === "failed"
    ) {
      const entry = pending.get(reply.id);
      if (entry !== undefined) {
        pending.delete(reply.id);
        if (reply.t === "failed") {
          entry.reject(new KernelError(replyCode(reply.code), "vault store: request failed"));
        } else {
          entry.resolve(reply);
        }
      }
    }
  });

  /**
   * One request/response exchange; `pick` maps the reply and `undefined` means the reply did not
   * match the request — malformed, never a hanging resolve.
   */
  async function request<T>(
    build: (id: number) => StoreRequest,
    pick: (reply: StoreReply) => T | undefined,
  ): Promise<T> {
    const id = nextId++;
    const reply = await new Promise<StoreReply>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        port.post(build(id));
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const picked = pick(reply);
    if (picked === undefined) {
      throw new Error("vault store: malformed reply");
    }
    return picked;
  }

  const store: RecordStore = {
    load: async () =>
      request(
        (id) => ({ t: "load", id }),
        (reply) => (reply.t === "loaded" ? assertVaultImage(reply.image) : undefined),
      ),
    commit: async (ops: ReadonlyArray<StoreOp>): Promise<void> => {
      await request(
        (id) => ({ t: "commit", id, ops }),
        (reply) => (reply.t === "committed" ? true : undefined),
      );
    },
    watch(listener) {
      watchers.add(listener);
      return () => {
        watchers.delete(listener);
      };
    },
  };

  const anchor: VaultAnchor = {
    read: async () => {
      const box = await request(
        (id) => ({ t: "anchor-read", id }),
        (reply) => (reply.t === "anchor-loaded" ? { bytes: reply.bytes } : undefined),
      );
      return box.bytes;
    },
    replace: async (next, expected) =>
      request(
        (id) => ({ t: "anchor-replace", id, next, expected }),
        (reply) => (reply.t === "anchor-replaced" ? reply.ok : undefined),
      ),
  };

  return { store, anchor };
}
