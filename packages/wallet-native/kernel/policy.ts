import type { KernelPolicy } from "../../wallet-kernel/src/platform.ts";

/**
 * The native session policy: a 15-minute presence idle lock, same semantics as the Web — only
 * presence-bearing methods count, so `sessions.sign` trading or background traffic cannot hold the
 * vault open — under a 24-hour absolute session. The host still locks on backgrounding after
 * autoLock.backgroundSeconds (W7).
 */
export const NATIVE_POLICY: KernelPolicy = {
  maxSessionMs: 24 * 3_600_000,
  maxScryptLogN: 18,
  idle: { ms: 15 * 60_000, activity: "presence" },
};
