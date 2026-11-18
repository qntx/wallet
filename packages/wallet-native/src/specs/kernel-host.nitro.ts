import type { HybridObject } from "react-native-nitro-modules";

/**
 * The only object the main runtime can reach into the enclave with. `start` loads the kernel
 * bytecode compiled into the signed app binary as a constexpr array (the build-time manifest check
 * only catches a stale artifact); `post` delivers one CBOR frame (at most 1 MiB); `onMessage`
 * receives frames the kernel posts; `onExit` reports the one terminal exit — `locked` after `lock`,
 * `crashed` after a kernel fault, `integrity` after a transport violation. `lock` destroys the
 * runtime. It exposes no script loading and no global-object access.
 */
export type KernelExitReason = "locked" | "crashed" | "integrity" | "background";

export interface KernelHost extends HybridObject<{ ios: "c++"; android: "c++" }> {
  /** 0/60/300/900 — after this long in the background the host locks the enclave itself. */
  start(backgroundLockSeconds: number): void;
  post(frame: ArrayBuffer): void;
  onMessage(listener: (frame: ArrayBuffer) => void): void;
  onExit(listener: (reason: KernelExitReason) => void): void;
  /** Applies a new background lock budget (0/60/300/900) to the running kernel. */
  setBackgroundLock(backgroundLockSeconds: number): void;
  lock(): void;
}
