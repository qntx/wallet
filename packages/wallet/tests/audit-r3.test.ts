/**
 * R3 audit PoC. Asserts the CURRENT (vulnerable) behaviour so it passes today and documents the
 * bug; the comment on the `it` states the correct behaviour.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";

import type { MainPort, SetTimer } from "../src/channel.ts";
import { SecretWire } from "../src/factors.ts";
import type { PasskeyCeremony, PrfResult } from "../src/factors.ts";
import type { ProtocolValue } from "../src/protocol/index.ts";
import { WalletError } from "../src/types.ts";
import type { StatusPayload, Wallet } from "../src/types.ts";
import { connectKernel } from "../src/wallet.ts";
import { FakeKernel, PASSKEY, ScriptedPort, unlockedStatus } from "./host.test.ts";

const realtime: SetTimer = (delayMs, fn) => {
  const timer = setTimeout(fn, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

type PostedRequest = { readonly method: string; readonly transfer: ArrayBuffer[] };

class RecordingPort extends ScriptedPort {
  readonly records: PostedRequest[] = [];

  override post(message: ProtocolValue, transfer?: ArrayBuffer[]): void {
    this.records.push({
      method: String((message as { method?: unknown }).method ?? ""),
      transfer: transfer ?? [],
    });
    super.post(message, transfer);
  }
}

const zeroed = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0);

describe("R3-W1: backup.enable wipes the wire while a parallel ceremony still writes to it", () => {
  // Correct: a build must not keep writing to a wire after it failed — resolve the backup factors
  // sequentially or with allSettled so every ceremony's output is wired before the build settles,
  // or make SecretWire refuse/wipe bytes added after wipe().
  it("R3-W1 PoC: a late passkey ceremony leaves a PRF copy resident on the wiped wire", async () => {
    // An unlocked software wallet whose vault holds two passkey factors.
    const status: StatusPayload = {
      ...unlockedStatus(),
      vault: "locked",
      factors: [
        { kind: "passkey", id: "f".repeat(32), credentialId: "Y3JlZA", createdAt: 1 },
        { kind: "passkey", id: "e".repeat(32), credentialId: "Y3JlZA", createdAt: 2 },
      ],
    };
    // The first assert rejects promptly; the second resolves ~20 ms later with 0xab PRF bytes.
    const LATE_FIRST = new Uint8Array(32).fill(0xab);
    let assertCalls = 0;
    const ceremony: PasskeyCeremony = {
      create: async () => {
        await Promise.resolve();
        throw new Error("unused in this PoC");
      },
      assert: async (): Promise<PrfResult> => {
        assertCalls += 1;
        if (assertCalls === 1) {
          await Promise.resolve();
          throw new WalletError("cancelled", "the backup ceremony was cancelled");
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        return { credentialId: new Uint8Array([1]), first: LATE_FIRST, synced: false };
      },
    };

    const kernel = new FakeKernel(status);
    const port = new RecordingPort(kernel);
    const wallet: Wallet = await connectKernel({
      verifyEvent,
      spawn: () => {
        kernel.attach(port);
        return port;
      },
      factors: "software",
      passkey: PASSKEY,
      ceremony,
      setTimer: realtime,
    });
    // Drive a real unlock so the deferred status installs the session and factor list.
    await wallet.vault.unlock({ kind: "password", password: "long enough password" });

    const spy = vi.spyOn(SecretWire.prototype, "bytes");
    try {
      await expect(
        wallet.backup.enable({
          verify: { kind: "password", password: "pw" },
          factors: [{ kind: "passkey" }, { kind: "passkey" }],
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "cancelled" }));
      // Let the losing ceremony finish: its output lands on the already-wiped wire.
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      const copies = spy.mock.results.map((result) => result.value as Uint8Array);
      const resident = copies.filter((copy) => !zeroed(copy));
      const prf = resident.find((copy) => copy.some((byte) => byte === 0xab));
      console.log(
        `R3-W1 assert calls: ${String(assertCalls)} | wire.bytes() calls: ${String(copies.length)}` +
          ` | resident (non-zero) copies: ${String(resident.length)}` +
          ` | resident lengths: ${resident.map((copy) => copy.length).join(",")}` +
          ` | backup.enable posted: ${String(port.records.some((r) => r.method === "backup.enable"))}`,
      );
      // The request never posted — the wire was wiped on the build failure.
      expect(port.records.some((r) => r.method === "backup.enable")).toBe(false);
      // wipeSource still zeroed the ceremony's own output buffer…
      expect(zeroed(LATE_FIRST)).toBe(true);
      // …but the wire copy the late assert pushed after wipe() still holds the PRF bytes.
      expect(prf).toBeDefined();
      expect(prf).toHaveLength(32);
    } finally {
      spy.mockRestore();
      await wallet.destroy();
    }
  });
});
