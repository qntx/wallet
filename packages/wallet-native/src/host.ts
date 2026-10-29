/**
 * `KernelHost` JS wrapper: CBOR frames over a Nitro-host-shaped channel. The host moves bytes only
 * — encode/decode happens here and in the kernel entry — so a malformed inbound frame can never
 * reach the message domain: the port exits `integrity` and the host runtime is destroyed.
 */
import type { MainPort } from "@qntx/wallet/host";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { decodeFrame, encodeFrame } from "./cbor.ts";

export type KernelExitReason = "locked" | "crashed" | "integrity";

/**
 * Structural mirror of the Nitro `KernelHost` spec (W2b registers the real hybrid object; tests
 * drive the same shape over an in-memory frame pipe).
 */
export type KernelHostLike = {
  readonly start: () => void;
  readonly post: (frame: ArrayBuffer) => void;
  readonly onMessage: (cb: (frame: ArrayBuffer) => void) => void;
  readonly onExit: (cb: (reason: KernelExitReason) => void) => void;
  readonly lock: () => void;
};

export function spawnFromHost(host: KernelHostLike): MainPort {
  const exitHandlers = new Set<() => void>();
  let exited = false;

  const exit = (): void => {
    if (exited) {
      return;
    }
    exited = true;
    for (const handler of exitHandlers) {
      handler();
    }
    host.lock();
  };

  host.onMessage((frame) => {
    let message: ProtocolValue;
    try {
      message = decodeFrame(frame);
    } catch {
      exit();
      return;
    }
    dispatch(message);
  });

  host.onExit(() => {
    exit();
  });

  const messageHandlers = new Set<(message: unknown) => void>();
  const dispatch = (message: unknown): void => {
    for (const handler of messageHandlers) {
      handler(message);
    }
  };

  host.start();

  return {
    post: (message, transfer) => {
      const frame = encodeFrame(message);
      host.post(frame);
      // Structured clone would neuter transferred buffers on the web; the main↔kernel
      // contract is the same here — the caller's buffers hold secrets (passwords, PRF
      // output) and are zeroed once their bytes are inside the frame.
      for (const buffer of transfer) {
        new Uint8Array(buffer).fill(0);
      }
    },
    listen: (handler) => {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },
    onExit: (handler) => {
      exitHandlers.add(handler);
      return () => {
        exitHandlers.delete(handler);
      };
    },
    terminate: () => {
      exit();
    },
  };
}
