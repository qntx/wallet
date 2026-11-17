/**
 * Back-pressure at the native boundary: KernelRuntime fails closed once 64 inbound frames are
 * undelivered. The channel's in-flight bound keeps posted-but-unanswered requests well below that,
 * so a busy kernel delays work instead of killing the session.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { MAX_IN_FLIGHT } from "@qntx/wallet/host";

import { Channel } from "../../wallet/src/channel.ts";
import type { SetTimer } from "../../wallet/src/channel.ts";
import { decodeFrame, encodeFrame } from "../src/cbor.ts";
import type { KernelExitReason, KernelHostLike } from "../src/host.ts";
import { spawnFromHost } from "../src/index.ts";

const realtime: SetTimer = (delayMs, fn) => {
  const timer = setTimeout(fn, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

const STATUS = {
  protocol: 3,
  appLock: true,
  verification: "available",
  vault: "unlocked",
  factors: [],
  wallets: [],
  nostr: { keys: [] },
  importedKeys: [],
  backup: null,
  blindSigning: false,
};

/**
 * A KernelHostLike with the real runtime's inbound accounting: frames queue until delivered, and
 * more than `cap` undelivered frames is an integrity exit — the failure the unbounded channel used
 * to cause under a busy kernel.
 */
class InboundCappedHost implements KernelHostLike {
  readonly cap = 64;
  readonly held: ArrayBuffer[] = [];
  undelivered = 0;
  maxUndelivered = 0;
  exitReason: KernelExitReason | undefined;
  private messageCb: ((frame: ArrayBuffer) => void) | undefined;
  private exitCb: ((reason: KernelExitReason) => void) | undefined;

  start(): void {
    setTimeout(() => {
      this.messageCb?.(encodeFrame({ v: 3, event: "status", status: STATUS }));
    });
  }

  post(frame: ArrayBuffer): void {
    this.undelivered++;
    this.maxUndelivered = Math.max(this.maxUndelivered, this.undelivered);
    if (this.undelivered > this.cap) {
      this.exitReason = "integrity";
      this.exitCb?.("integrity");
      return;
    }
    this.held.push(frame);
  }

  /** The busy kernel catching up: answers the `count` oldest frames. */
  deliver(count: number): void {
    for (const frame of this.held.splice(0, count)) {
      this.undelivered--;
      const request = decodeFrame(frame) as { readonly id: number };
      this.messageCb?.(encodeFrame({ v: 3, id: request.id, ok: null }));
    }
  }

  onMessage(cb: (frame: ArrayBuffer) => void): void {
    this.messageCb = cb;
  }

  onExit(cb: (reason: KernelExitReason) => void): void {
    this.exitCb = cb;
  }

  setBackgroundLock(): void {}

  lock(): void {}
}

describe("the channel keeps the native inbound cap out of reach", () => {
  it("serves a burst of requests without ever hitting the integrity cap", async () => {
    const host = new InboundCappedHost();
    const channel = new Channel(
      () => spawnFromHost(host, 0),
      { onStatus: () => {}, onLocked: () => {}, onCrashed: () => {} },
      realtime,
    );
    await channel.start();
    const calls = Array.from({ length: 100 }, async () => channel.call("session.touch", null));
    await new Promise((resolve) => setTimeout(resolve));
    // The busy kernel has not answered yet — only the bounded batch is inflight.
    expect(host.undelivered).toBeLessThanOrEqual(MAX_IN_FLIGHT);
    while (host.undelivered > 0) {
      host.deliver(4);
    }
    await Promise.all(calls);
    expect(host.exitReason).toBeUndefined();
    expect(host.maxUndelivered).toBeLessThanOrEqual(MAX_IN_FLIGHT);
    expect(host.maxUndelivered).toBeLessThan(host.cap);
    channel.destroy();
  });

  it("keeps MAX_IN_FLIGHT below the runtime's inbound cap", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../cpp/runtime/KernelRuntime.cpp", import.meta.url)),
      "utf8",
    );
    const cap = Number(/kMaxInboundFrames\s*=\s*(\d+)/.exec(source)?.[1]);
    expect(Number.isInteger(cap)).toBe(true);
    expect(cap).toBeGreaterThan(MAX_IN_FLIGHT);
  });
});
