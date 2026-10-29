/**
 * Kernel-side CBOR transport: adapts the frame pipe the C++ runtime exposes into the kernel's
 * `Port`. Same strict decode as the main side — a malformed frame is a transport violation, not a
 * protocol error, and kills the runtime rather than being answered.
 */
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { decodeFrame, encodeFrame } from "../src/cbor.ts";

/** Frame-level channel the kernel runtime hands to the entry script (W3 wires it). */
export type KernelFramePipe = {
  readonly post: (frame: ArrayBuffer) => void;
  readonly onMessage: (cb: (frame: ArrayBuffer) => void) => void;
  /** Called when a frame fails decode — the entry maps it to an `integrity` exit. */
  readonly onIntegrityViolation: (cb: () => void) => void;
};

/**
 * Structural mirror of `@qntx/wallet-kernel`'s `Port` — the kernel is private and must not be a
 * declared dependency (the harness installs this package via `file:` outside the workspace).
 */
type Port = {
  readonly post: (message: ProtocolValue, transfer: ArrayBuffer[]) => void;
  readonly listen: (handler: (message: unknown) => void) => () => void;
};

export function createKernelPort(pipe: KernelFramePipe): Port {
  pipe.onMessage((frame) => {
    let message: ProtocolValue;
    try {
      message = decodeFrame(frame);
    } catch {
      // W3's kernel-entry registers onIntegrityViolation; the transport itself only stops dispatch.
      return;
    }
    for (const handler of handlers) {
      handler(message);
    }
  });

  const handlers = new Set<(message: unknown) => void>();

  return {
    post: (message, transfer) => {
      const frame = encodeFrame(message);
      pipe.post(frame);
      for (const buffer of transfer) {
        new Uint8Array(buffer).fill(0);
      }
    },
    listen: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
