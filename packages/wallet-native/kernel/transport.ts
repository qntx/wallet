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
    // An undecodable frame is a transport violation, not a message: rethrowing out of the
    // handler crashes the runtime (deliver → task error → onError) instead of silently
    // dropping it and serving whatever a confused peer sends next.
    let message: ProtocolValue;
    try {
      message = decodeFrame(frame);
    } finally {
      // The frame's bytes are decode-copied or dead either way — never leave the
      // encoded form resident past dispatch.
      new Uint8Array(frame).fill(0);
    }
    for (const handler of handlers) {
      handler(message);
    }
  });

  const handlers = new Set<(message: unknown) => void>();

  return {
    post: (message, transfer) => {
      // The frame and the transferred buffers carry secrets — wipe both on every path
      // once the pipe took its copy, including a throwing pipe.post.
      let frame: ArrayBuffer | undefined;
      try {
        frame = encodeFrame(message);
        pipe.post(frame);
      } finally {
        if (frame !== undefined) {
          new Uint8Array(frame).fill(0);
        }
        for (const buffer of transfer) {
          new Uint8Array(buffer).fill(0);
        }
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
