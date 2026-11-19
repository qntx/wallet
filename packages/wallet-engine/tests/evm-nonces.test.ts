import { describe, expect, it } from "vite-plus/test";

import { EvmNonces } from "../src/transactions/evm-nonces.ts";

const NET = "eip155:1";
const OTHER_NET = "eip155:56";
const FROM = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const OTHER = "0x0000000000000000000000000000000000000001";

describe("EvmNonces", () => {
  it("a nonce another transaction holds cannot be reserved; shared allows a replacement", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [0], false);
    expect(() => nonces.reserve("b", NET, FROM, [0], false)).toThrow(
      "nonce 0 is already used by another transaction — start over",
    );
    nonces.reserve("b", NET, FROM, [0], true);
    expect(nonces.taken(NET, FROM, 0)).toBe(true);
  });

  it("release frees only the holder's own nonces and is idempotent", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [0], false);
    nonces.reserve("b", NET, FROM, [0], true);
    nonces.release("b");
    expect(nonces.taken(NET, FROM, 0)).toBe(true);
    nonces.release("b");
    nonces.release("a");
    expect(nonces.taken(NET, FROM, 0)).toBe(false);
    expect(nonces.next(NET, FROM)).toBe(0);
  });

  it("consume drops the holds but keeps the nonce spent as a floor", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [0], false);
    nonces.consume("a");
    expect(nonces.taken(NET, FROM, 0)).toBe(true);
    expect(nonces.next(NET, FROM)).toBe(1);
    expect(() => nonces.reserve("b", NET, FROM, [0], false)).toThrow(/already used/);
    nonces.reserve("b", NET, FROM, [1], false);
    expect(nonces.next(NET, FROM)).toBe(2);
  });

  it("next is one past the highest held nonce; multi-nonce holds count", () => {
    const nonces = new EvmNonces();
    expect(nonces.next(NET, FROM)).toBe(0);
    nonces.reserve("a", NET, FROM, [0, 1], false);
    expect(nonces.taken(NET, FROM, 0)).toBe(true);
    expect(nonces.taken(NET, FROM, 1)).toBe(true);
    expect(nonces.taken(NET, FROM, 2)).toBe(false);
    expect(nonces.next(NET, FROM)).toBe(2);
  });

  it("holds are scoped per network and per sender, and senders compare case-insensitively", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [0], false);
    expect(nonces.taken(OTHER_NET, FROM, 0)).toBe(false);
    expect(nonces.taken(NET, OTHER, 0)).toBe(false);
    nonces.reserve("b", OTHER_NET, FROM, [0], false);
    nonces.reserve("c", NET, OTHER, [0], false);
    expect(() =>
      nonces.reserve("d", NET, FROM.toLowerCase(), [0], false),
    ).toThrow(/already used/);
  });

  it("a reserve that fails partway leaves no partial holds", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [0], false);
    expect(() => nonces.reserve("b", NET, FROM, [1, 0], false)).toThrow(/already used/);
    expect(nonces.taken(NET, FROM, 1)).toBe(false);
    nonces.reserve("b", NET, FROM, [1], false);
    expect(nonces.next(NET, FROM)).toBe(2);
  });

  it("consuming the lower of two shared holders frees both but the floor stands", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [0], false);
    nonces.reserve("b", NET, FROM, [0], true);
    nonces.consume("a");
    expect(nonces.taken(NET, FROM, 0)).toBe(true);
    expect(nonces.next(NET, FROM)).toBe(1);
    nonces.release("b");
    expect(nonces.taken(NET, FROM, 0)).toBe(true);
    expect(() => nonces.reserve("c", NET, FROM, [0], false)).toThrow(/already used/);
  });
});
