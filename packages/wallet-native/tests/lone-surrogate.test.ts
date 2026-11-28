/**
 * An unencodable request on the native CBOR boundary (a string carrying a lone surrogate) rejects
 * `invalid-input` — the port's own answer, passed through by the channel — instead of an integrity
 * crash that ends the session. The request's secret wire is wiped and the kernel keeps serving.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import { Channel } from "../../wallet/src/channel.ts";
import type { SetTimer } from "../../wallet/src/channel.ts";
import { SecretWire } from "../../wallet/src/factors.ts";
import { decodeFrame, encodeFrame } from "../src/cbor.ts";
import type { KernelExitReason, KernelHostLike } from "../src/host.ts";
import { spawnFromHost } from "../src/index.ts";

vi.mock("react-native-nitro-modules", () => ({
  NitroModules: { createHybridObject: vi.fn() },
}));

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
  vault: { status: "unlocked" },
  factors: [],
  wallets: [],
  nostr: { keys: [] },
  importedKeys: [],
  backup: null,
  blindSigning: false,
};

/** Answers every posted frame with `{id, ok}` — the kernel stand-in the request never reaches. */
class EchoHost implements KernelHostLike {
  readonly exits: KernelExitReason[] = [];
  private messageCb: ((frame: ArrayBuffer) => void) | undefined;
  private exitCb: ((reason: KernelExitReason) => void) | undefined;

  start(): void {
    setTimeout(() => {
      this.messageCb?.(encodeFrame({ v: 3, event: "status", status: STATUS }));
    });
  }

  post(frame: ArrayBuffer): void {
    // The post contract borrows the frame for the call — copy like the real host does.
    const copy = new Uint8Array(frame.byteLength);
    copy.set(new Uint8Array(frame));
    setTimeout(() => {
      const request = decodeFrame(copy.buffer) as { readonly id: number };
      this.messageCb?.(encodeFrame({ v: 3, id: request.id, ok: null }));
    });
  }

  onMessage(cb: (frame: ArrayBuffer) => void): void {
    this.messageCb = cb;
  }

  onExit(cb: (reason: KernelExitReason) => void): void {
    this.exitCb = cb;
  }

  exit(reason: KernelExitReason): void {
    this.exits.push(reason);
    this.exitCb?.(reason);
  }

  setBackgroundLock(): void {}

  lock(): void {}
}

describe("an unencodable request on the native boundary", () => {
  it("rejects invalid-input, wipes the secret wire, and keeps the session alive", async () => {
    const host = new EchoHost();
    const channel = new Channel(
      () => spawnFromHost(host, 0),
      { onStatus: () => {}, onLocked: () => {}, onCrashed: () => {} },
      realtime,
    );
    await channel.start();

    const wire = new SecretWire();
    const password = wire.text("hunter2");
    await expect(
      channel.callWithSecrets(
        "wallet.exportMnemonic",
        { verify: { kind: "password", password }, walletId: "\uD800" },
        wire,
      ),
    ).rejects.toMatchObject({
      code: "invalid-input",
      message: "the kernel port cannot encode the request",
    });
    expect(password.every((b) => b === 0)).toBe(true);

    // The port's own error must not be mistaken for a kernel refusal: no integrity
    // break, no exit — the next request is answered.
    await channel.call("session.touch", null);
    expect(host.exits).toHaveLength(0);
    channel.destroy();
  });

  it("maps a refusal that is not an encode failure to integrity", async () => {
    const host = new EchoHost();
    const inner = spawnFromHost(host, 0);
    const channel = new Channel(
      () => ({
        ...inner,
        post: () => {
          // WalletError-shaped but not an encode refusal — a different code must
          // not pass through as a wallet error.
          throw Object.assign(new Error("port is locked"), {
            name: "WalletError",
            code: "locked",
          });
        },
      }),
      { onStatus: () => {}, onLocked: () => {}, onCrashed: () => {} },
      realtime,
    );
    await channel.start();

    await expect(channel.call("session.touch", null)).rejects.toMatchObject({
      code: "integrity",
      message: "the kernel port refused the message",
    });
    channel.destroy();
  });
});
