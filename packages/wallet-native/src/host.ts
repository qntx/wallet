/**
 * `KernelHost` JS wrapper: CBOR frames over a Nitro-host-shaped channel. The host moves bytes only
 * — encode/decode happens here and in the kernel entry — so a malformed inbound frame can never
 * reach the message domain: the port exits `crashed` and the host runtime is destroyed.
 */
import type { MainPort, PortExit } from "@qntx/wallet/host";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import { decodeFrame, encodeFrame } from "./cbor.ts";

export type KernelExitReason = "locked" | "crashed" | "integrity" | "background";

/**
 * Structural mirror of the Nitro `KernelHost` spec (W2b registers the real hybrid object; tests
 * drive the same shape over an in-memory frame pipe).
 */
export type KernelHostLike = {
  readonly start: (backgroundLockSeconds: number) => void;
  readonly post: (frame: ArrayBuffer) => void;
  readonly onMessage: (cb: (frame: ArrayBuffer) => void) => void;
  readonly onExit: (cb: (reason: KernelExitReason) => void) => void;
  /** Changes the background lock budget of the live kernel — applied by `setAutoLock`. */
  readonly setBackgroundLock: (seconds: number) => void;
  readonly lock: () => void;
};

export function spawnFromHost(host: KernelHostLike, backgroundLockSeconds: number): MainPort {
  const exitHandlers = new Set<(reason: PortExit) => void>();
  let exited = false;

  const exit = (reason: PortExit): void => {
    if (exited) {
      return;
    }
    exited = true;
    for (const handler of exitHandlers) {
      handler(reason);
    }
    host.lock();
  };

  host.onMessage((frame) => {
    let message: ProtocolValue;
    try {
      message = decodeFrame(frame);
    } catch {
      exit("crashed");
      return;
    } finally {
      // The frame's bytes are decode-copied or dead either way — never leave the
      // encoded form resident past dispatch.
      new Uint8Array(frame).fill(0);
    }
    dispatch(message);
  });

  // The platform locked the enclave in the background — report it honestly so
  // the channel takes the lock path, not the crash path.
  host.onExit((reason) => {
    exit(reason === "background" ? "background" : "crashed");
  });

  const messageHandlers = new Set<(message: unknown) => void>();
  const dispatch = (message: unknown): void => {
    for (const handler of messageHandlers) {
      handler(message);
    }
  };

  host.start(backgroundLockSeconds);

  return {
    post: (message, transfer) => {
      // Structured clone would neuter transferred buffers on the web; the main↔kernel
      // contract is the same here — the caller's buffers hold secrets (passwords, PRF
      // output) and are zeroed once their bytes are inside the frame. The frame itself
      // is wiped on every path after the host took its copy — success or a throwing
      // host.post alike.
      let frame: ArrayBuffer | undefined;
      try {
        frame = encodeFrame(message);
        host.post(frame);
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
      exit("crashed");
    },
  };
}
