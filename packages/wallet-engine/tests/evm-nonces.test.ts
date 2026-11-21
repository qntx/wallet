import { describe, expect, it } from "vite-plus/test";

import { EvmNonces } from "../src/transactions/evm-nonces.ts";

const NET = "eip155:1";
const OTHER_NET = "eip155:56";
const FROM = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const OTHER = "0x0000000000000000000000000000000000000001";

describe("EvmNonces", () => {
  it("a nonce another transaction holds cannot be reserved; shared allows a replacement", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [0], false, 0);
    expect(() => nonces.reserve("b", NET, FROM, [0], false, 0)).toThrow(
      "nonce 0 is already used by another transaction — start over",
    );
    nonces.reserve("b", NET, FROM, [0], true, 0);
    expect(nonces.taken(NET, FROM, 0)).toBe(true);
  });

  it("release frees only the holder's own nonces and is idempotent", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [0], false, 0);
    nonces.reserve("b", NET, FROM, [0], true, 0);
    nonces.release("b");
    expect(nonces.taken(NET, FROM, 0)).toBe(true);
    nonces.release("b");
    nonces.release("a");
    expect(nonces.taken(NET, FROM, 0)).toBe(false);
    expect(nonces.next(NET, FROM, 0)).toBe(0);
  });

  it("consume drops the holds but keeps the nonce spent as a floor", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [0], false, 0);
    nonces.consume("a");
    expect(nonces.taken(NET, FROM, 0)).toBe(true);
    expect(nonces.next(NET, FROM, 1)).toBe(1);
    expect(() => nonces.reserve("b", NET, FROM, [0], false, 0)).toThrow(/already used/);
    nonces.reserve("b", NET, FROM, [1], false, 0);
    expect(nonces.next(NET, FROM, 1)).toBe(2);
  });

  it("next is the lowest nonce at or above the chain count nothing holds", () => {
    const nonces = new EvmNonces();
    expect(nonces.next(NET, FROM, 0)).toBe(0);
    nonces.reserve("a", NET, FROM, [0, 1], false, 0);
    expect(nonces.taken(NET, FROM, 0)).toBe(true);
    expect(nonces.taken(NET, FROM, 1)).toBe(true);
    expect(nonces.taken(NET, FROM, 2)).toBe(false);
    expect(nonces.next(NET, FROM, 0)).toBe(2);
  });

  it("holds are scoped per network and per sender, and senders compare case-insensitively", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [0], false, 0);
    expect(nonces.taken(OTHER_NET, FROM, 0)).toBe(false);
    expect(nonces.taken(NET, OTHER, 0)).toBe(false);
    nonces.reserve("b", OTHER_NET, FROM, [0], false, 0);
    nonces.reserve("c", NET, OTHER, [0], false, 0);
    expect(() => nonces.reserve("d", NET, FROM.toLowerCase(), [0], false, 0)).toThrow(
      /already used/,
    );
  });

  it("a reserve that fails partway leaves no partial holds", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [0], false, 0);
    expect(() => nonces.reserve("b", NET, FROM, [1, 0], false, 0)).toThrow(/already used/);
    expect(nonces.taken(NET, FROM, 1)).toBe(false);
    nonces.reserve("b", NET, FROM, [1], false, 0);
    expect(nonces.next(NET, FROM, 0)).toBe(2);
  });

  it("consuming one of two shared holders leaves the other's hold and the spent floor", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [0], false, 0);
    nonces.reserve("b", NET, FROM, [0], true, 0);
    nonces.consume("a");
    expect(nonces.taken(NET, FROM, 0)).toBe(true);
    expect(nonces.next(NET, FROM, 1)).toBe(1);
    nonces.release("b");
    expect(nonces.taken(NET, FROM, 0)).toBe(true);
    expect(() => nonces.reserve("c", NET, FROM, [0], false, 0)).toThrow(/already used/);
  });

  it("a reorg reopens exactly the consumed nonce: held again, the floor lifted", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [5], false, 5);
    nonces.consume("a");
    expect(nonces.taken(NET, FROM, 5)).toBe(true);
    nonces.reopen("a", NET, FROM, [5]);
    // The nonce is a hold again: no fresh send may take it, its replacement may.
    expect(nonces.taken(NET, FROM, 5)).toBe(true);
    expect(nonces.next(NET, FROM, 5)).toBe(6);
    expect(() => nonces.reserve("b", NET, FROM, [5], false, 0)).toThrow(/already used/);
    nonces.reserve("b", NET, FROM, [5], true, 5);
    // Consuming again after the retry lands restores the floor with nothing held.
    nonces.release("b");
    nonces.consume("a");
    expect(nonces.taken(NET, FROM, 5)).toBe(true);
    expect(nonces.next(NET, FROM, 6)).toBe(6);
    expect(() => nonces.reserve("c", NET, FROM, [5], false, 0)).toThrow(/already used/);
    expect(() => nonces.reserve("c", NET, FROM, [6], false, 0)).not.toThrow();
  });

  it("reopening only the reorged consumer keeps the floor on the rest", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [5], false, 5);
    nonces.consume("a");
    nonces.reserve("c", NET, FROM, [6], false, 6);
    nonces.consume("c");
    expect(nonces.next(NET, FROM, 7)).toBe(7);
    nonces.reopen("a", NET, FROM, [5]);
    // A's reorg lifts only A's record: C still counts, so the floor stays 7.
    expect(nonces.taken(NET, FROM, 6)).toBe(true);
    expect(nonces.next(NET, FROM, 7)).toBe(7);
    nonces.reopen("c", NET, FROM, [6]);
    expect(() => nonces.reserve("d", NET, FROM, [6], false, 0)).toThrow(/already used/);
    expect(nonces.next(NET, FROM, 5)).toBe(7);
  });

  it("a 7702 pair consumes and reopens as a pair", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [3, 4], false, 3);
    nonces.consume("a");
    expect(nonces.taken(NET, FROM, 3)).toBe(true);
    expect(nonces.taken(NET, FROM, 4)).toBe(true);
    expect(nonces.next(NET, FROM, 5)).toBe(5);
    nonces.reopen("a", NET, FROM, [3, 4]);
    expect(() => nonces.reserve("b", NET, FROM, [4], false, 0)).toThrow(/already used/);
    expect(nonces.next(NET, FROM, 3)).toBe(5);
  });

  it("a reloaded in-block row is spent, not held", () => {
    const nonces = new EvmNonces();
    nonces.spend("a", NET, FROM, [5]);
    expect(nonces.taken(NET, FROM, 5)).toBe(true);
    expect(nonces.next(NET, FROM, 6)).toBe(6);
    // Its reorg reopens the spent record like a consumed one.
    nonces.reopen("a", NET, FROM, [5]);
    expect(() => nonces.reserve("b", NET, FROM, [5], false, 0)).toThrow(/already used/);
  });
});
