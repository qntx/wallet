import { describe, expect, it } from "vite-plus/test";

import { createEventBus } from "../src/events.ts";
import type { EngineLogger } from "../src/events.ts";

type Events = { hello: { n: number }; bye: string };

const logger = (caught: unknown[]): EngineLogger => ({
  warn: (_m, e) => {
    caught.push(e);
  },
});

describe("EventBus", () => {
  it("emit dispatches synchronously in registration order; on unsubscribes", () => {
    const bus = createEventBus<Events>(logger([]));
    const order: number[] = [];
    const off = bus.on("hello", (p) => {
      order.push(p.n);
    });
    bus.on("hello", (p) => {
      order.push(p.n * 10);
    });
    bus.emit("hello", { n: 2 });
    expect(order).toStrictEqual([2, 20]);
    off();
    bus.emit("hello", { n: 1 });
    expect(order).toStrictEqual([2, 20, 10]);
  });

  it("a throwing listener is logged and does not affect peers", () => {
    const caught: unknown[] = [];
    const bus = createEventBus<Events>(logger(caught));
    const seen: string[] = [];
    bus.on("bye", () => {
      throw new Error("boom");
    });
    bus.on("bye", (p) => {
      seen.push(p);
    });
    bus.emit("bye", "x");
    expect(seen).toStrictEqual(["x"]);
    expect(caught).toHaveLength(1);
  });
});
