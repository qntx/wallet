/**
 * The native kernel policy: a 15-minute presence idle lock (same semantics as the Web — only
 * presence-bearing methods hold the vault open, so `sessions.sign` trading or background traffic
 * cannot) inside the 24-hour absolute session. Kernel-side behaviour is covered by the kernel's own
 * idle tests (tests/integration.test.ts "presence activity").
 */
import { describe, expect, it } from "vite-plus/test";

import { NATIVE_POLICY } from "../kernel/policy.ts";

describe("the native kernel policy", () => {
  it("presence-locks after 15 idle minutes under a 24-hour session", () => {
    expect(NATIVE_POLICY.idle).toStrictEqual({ ms: 15 * 60_000, activity: "presence" });
    expect(NATIVE_POLICY.maxSessionMs).toBe(24 * 3_600_000);
    expect(NATIVE_POLICY.maxScryptLogN).toBe(18);
  });
});
