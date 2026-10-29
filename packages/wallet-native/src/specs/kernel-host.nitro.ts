import type { HybridObject } from "react-native-nitro-modules";

/**
 * The only object the main runtime can reach into the enclave with. `start` loads the embedded
 * kernel bytecode after verifying its SHA-256; `post` delivers one CBOR frame (at most 1 MiB);
 * `onMessage` receives frames the kernel posts; `onExit` reports the one terminal exit — `locked`
 * after `lock`, `crashed` after a kernel fault, `integrity` after a transport or hash violation.
 * `lock` destroys the runtime. It exposes no script loading and no global-object access.
 */
export type KernelExitReason = "locked" | "crashed" | "integrity";

export interface KernelHost extends HybridObject<{ ios: "c++"; android: "c++" }> {
  start(): void;
  post(frame: ArrayBuffer): void;
  onMessage(listener: (frame: ArrayBuffer) => void): void;
  onExit(listener: (reason: KernelExitReason) => void): void;
  lock(): void;
}
