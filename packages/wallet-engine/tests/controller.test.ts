import { describe, expect, it } from "vite-plus/test";

import { Controller } from "../src/controller.ts";

type State = { readonly count: number; readonly label: string };

class Counter extends Controller<State> {
  constructor() {
    super({ name: "counter", defaultState: () => ({ count: 0, label: "x" }) });
  }
  bump(): void {
    this.update((s) => ({ ...s, count: s.count + 1 }));
  }
  noop(): void {
    this.update((s) => s);
  }
  async init(): Promise<void> {}
  async destroy(): Promise<void> {}
}

describe("Controller", () => {
  it("getState returns the default state, update applies the recipe", () => {
    const c = new Counter();
    expect(c.getState()).toStrictEqual({ count: 0, label: "x" });
    c.bump();
    expect(c.getState().count).toBe(1);
    expect(c.name).toBe("counter");
  });

  it("update with the same reference is a no-op — no notification", () => {
    const c = new Counter();
    let notified = 0;
    c.store.subscribe(() => {
      notified += 1;
    });
    c.noop();
    expect(notified).toBe(0);
    c.bump();
    expect(notified).toBe(1);
  });
});
