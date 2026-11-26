import type { KernelPolicy } from "../../wallet-kernel/src/platform.ts";

/**
 * The native session policy: a 15-minute presence idle lock under a 24-hour absolute session. On
 * this host "presence" is stricter than on the Web: only a successful factor verification re-arms
 * the deadline — a system keystore prompt is the one presence signal the main runtime cannot forge
 * — so `session.touch`, `sessions.sign` trading or any other callable method cannot hold the vault
 * open. The host still locks on backgrounding after autoLock.backgroundSeconds (W7).
 */
export const NATIVE_POLICY: KernelPolicy = {
  maxSessionMs: 24 * 3_600_000,
  maxScryptLogN: 18,
  idle: { ms: 15 * 60_000, activity: "presence" },
};
