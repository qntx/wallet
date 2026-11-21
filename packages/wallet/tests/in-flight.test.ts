/**
 * In-flight bound: at most MAX_IN_FLIGHT requests sit posted-but-unanswered at once; the rest wait
 * in a FIFO, are never timed by the watchdog, and are rejected — with their wires wiped — when the
 * channel fails.
 */
import { describe, expect, it } from "vite-plus/test";

import { Channel, MAX_IN_FLIGHT } from "../src/channel.ts";
import type { SetTimer } from "../src/channel.ts";
import { SecretWire } from "../src/factors.ts";
import type { ProtocolValue } from "../src/protocol/index.ts";
import { WalletError } from "../src/types.ts";
import { FakeKernel, ScriptedPort, unlockedStatus } from "./host.test.ts";

const realtime: SetTimer = (delayMs, fn) => {
  const timer = setTimeout(fn, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

const NOOP_HANDLERS = { onStatus: () => {}, onLocked: () => {}, onCrashed: () => {} };

/** A port that records posts instead of forwarding them; the test answers by hand. */
class GatedPort extends ScriptedPort {
  /** Every post the channel made, in order. */
  readonly posts: Array<{ id: number; method: string; transfer: ArrayBuffer[] }> = [];
  /** Posted requests still awaiting an answer. */
  readonly held: Array<{ id: number; method: string; transfer: ArrayBuffer[] }> = [];

  override post(message: ProtocolValue, transfer?: ArrayBuffer[]): void {
    const envelope = message as { id?: unknown; method?: unknown };
    const entry = {
      id: Number(envelope.id),
      method: String(envelope.method),
      transfer: transfer ?? [],
    };
    this.posts.push(entry);
    this.held.push(entry);
  }

  /** Answers the `count` oldest posted requests with a `session.touch`-shaped ok. */
  deliver(count = 1): void {
    for (const entry of this.held.splice(0, count)) {
      this.send({ v: 3, id: entry.id, ok: null });
    }
  }
}

const connect = async (): Promise<{ channel: Channel; port: GatedPort }> => {
  const kernel = new FakeKernel(unlockedStatus());
  const ports: GatedPort[] = [];
  const channel = new Channel(
    () => {
      const port = new GatedPort(kernel);
      ports.push(port);
      kernel.attach(port);
      return port;
    },
    NOOP_HANDLERS,
    realtime,
  );
  await channel.start();
  const [port] = ports;
  if (port === undefined) {
    throw new Error("spawn was not called");
  }
  return { channel, port };
};

/** The first spawned port, or a test error when spawn never ran. */
const firstPort = (ports: GatedPort[]): GatedPort => {
  const [port] = ports;
  if (port === undefined) {
    throw new Error("spawn was not called");
  }
  return port;
};

/**
 * Answers the gated kernel's held requests a few at a time until `total` posts were made and all of
 * them were answered; asserts the in-flight bound never broke on the way.
 */
const drainFully = async (port: GatedPort, total: number): Promise<void> => {
  while (port.posts.length < total || port.held.length > 0) {
    // oxlint-disable-next-line no-await-in-loop -- drains the gated kernel a batch at a time
    await tick();
    port.deliver(4);
    expect(port.held.length).toBeLessThanOrEqual(MAX_IN_FLIGHT);
  }
};

const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve));
};

/** Answers held requests one at a time; asserts the watchdog never arms more than one head. */
const drainUntilIdle = async (
  port: GatedPort,
  timers: { readonly armed: number },
): Promise<void> => {
  while (port.held.length > 0) {
    port.deliver(1);
    // oxlint-disable-next-line no-await-in-loop -- drains the gated kernel one answer at a time
    await tick();
    expect(timers.armed).toBeLessThanOrEqual(1);
  }
};

const errorCode = (error: unknown): string =>
  error instanceof WalletError ? error.code : "not-a-wallet-error";

/** The one request a scripted test expects the kernel to be holding. */
const heldRequest = (port: GatedPort): { id: number; method: string } => {
  const [entry] = port.held;
  if (entry === undefined) {
    throw new Error("nothing held by the kernel");
  }
  return entry;
};

describe("hyperliquid methods ride the channel", () => {
  const AGENT = {
    address: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
    owner: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
    walletId: "aa".repeat(8),
    groupIndex: 0,
    network: "Mainnet",
    name: "bot-1",
    validUntil: 1_812_902_400_000,
    createdAt: 1_812_902_400_000,
  };

  it("posts hyperliquid.listAgents as a plain method and validates the result", async () => {
    const { channel, port } = await connect();
    const call = channel.call("hyperliquid.listAgents", null);
    await tick();
    const entry = heldRequest(port);
    expect(entry.method).toBe("hyperliquid.listAgents");
    port.send({ v: 3, id: entry.id, ok: [AGENT] });
    await expect(call).resolves.toStrictEqual([AGENT]);
    channel.destroy();
  });

  it("rejects an off-schema hyperliquid.listAgents result", async () => {
    const { channel, port } = await connect();
    const call = channel.call("hyperliquid.listAgents", null);
    await tick();
    const entry = heldRequest(port);
    expect(entry.method).toBe("hyperliquid.listAgents");
    port.send({ v: 3, id: entry.id, ok: [{ network: "Nowhere" }] });
    await expect(call).rejects.toBeInstanceOf(WalletError);
    channel.destroy();
  });
});

describe("in-flight bound", () => {
  it("posts at most MAX_IN_FLIGHT requests and drains the queue in FIFO order", async () => {
    const { channel, port } = await connect();
    const calls = Array.from({ length: 100 }, async () => channel.call("session.touch", null));
    await tick();
    expect(port.held).toHaveLength(MAX_IN_FLIGHT);
    // Drain a few at a time: every settle lets exactly one queued request post.
    await drainFully(port, 100);
    await Promise.all(calls);
    // FIFO: the post order is the call order — request ids are issued sequentially per call.
    expect(port.posts.map((p) => p.id)).toStrictEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    channel.destroy();
  });

  it("rejects queued requests on lock and wipes their wires", async () => {
    const { channel, port } = await connect();
    const secrets: Uint8Array[] = [];
    const calls = Array.from({ length: MAX_IN_FLIGHT + 8 }, async () => {
      const wire = new SecretWire();
      const password = wire.text("top secret");
      secrets.push(password);
      return channel
        .callWithSecrets("vault.unlock", { factor: { kind: "password", password } }, wire)
        .then(
          () => "resolved",
          (error: unknown) => errorCode(error),
        );
    });
    await tick();
    channel.lockNow();
    const results = await Promise.all(calls);
    expect(results).toStrictEqual(Array.from({ length: MAX_IN_FLIGHT + 8 }, () => "locked"));
    // The requests that never posted had their wire buffers zeroed by failPending.
    for (const bytes of secrets.slice(port.posts.length)) {
      expect(bytes.every((byte) => byte === 0)).toBe(true);
    }
    // The ones that did post travelled on their transfer list.
    for (const [index, post] of port.posts.entries()) {
      expect(post.transfer).toContain(secrets[index]?.buffer);
    }
    channel.destroy();
  });

  it("rejects queued requests on destroy", async () => {
    const { channel, port } = await connect();
    const secrets: Uint8Array[] = [];
    const calls = Array.from({ length: MAX_IN_FLIGHT + 4 }, async () => {
      const wire = new SecretWire();
      const password = wire.text("top secret");
      secrets.push(password);
      return channel
        .callWithSecrets("vault.unlock", { factor: { kind: "password", password } }, wire)
        .then(
          () => "resolved",
          (error: unknown) => errorCode(error),
        );
    });
    await tick();
    channel.destroy();
    const results = await Promise.all(calls);
    expect(results).toStrictEqual(Array.from({ length: MAX_IN_FLIGHT + 4 }, () => "locked"));
    for (const bytes of secrets.slice(port.posts.length)) {
      expect(bytes.every((byte) => byte === 0)).toBe(true);
    }
  });
});

describe("watchdog only times posted requests", () => {
  class FakeTimers {
    private next = 0;
    private readonly timers = new Map<number, { fn: () => void; cancelled: boolean }>();

    readonly setTimer: SetTimer = (_delayMs, fn) => {
      const id = ++this.next;
      this.timers.set(id, { fn, cancelled: false });
      return () => {
        const entry = this.timers.get(id);
        if (entry !== undefined) {
          entry.cancelled = true;
        }
      };
    };

    get armed(): number {
      let count = 0;
      for (const entry of this.timers.values()) {
        if (!entry.cancelled) {
          count++;
        }
      }
      return count;
    }
  }

  it("keeps exactly one head timed while the queue holds requests", async () => {
    const kernel = new FakeKernel(unlockedStatus());
    const ports: GatedPort[] = [];
    const timers = new FakeTimers();
    const channel = new Channel(
      () => {
        const port = new GatedPort(kernel);
        ports.push(port);
        kernel.attach(port);
        return port;
      },
      NOOP_HANDLERS,
      timers.setTimer,
    );
    await channel.start();
    const port = firstPort(ports);
    const calls = Array.from({ length: MAX_IN_FLIGHT + 10 }, async () =>
      channel.call("session.touch", null),
    );
    await tick();
    // 32 posted, 10 queued — but only the posted head is timed.
    expect(port.held).toHaveLength(MAX_IN_FLIGHT);
    expect(timers.armed).toBe(1);
    // Each settle re-arms the timer on the new head — queued requests never join the clock.
    await drainUntilIdle(port, timers);
    await Promise.all(calls);
    expect(timers.armed).toBe(0);
    channel.destroy();
  });
});
