/**
 * R4 PoC — finding: "`EvmNonces` reserves but never re-fills". `next()` is one past the highest
 * hold, so a nonce freed by release (refused send, dropped transaction) is never chosen again and
 * the account signs above a permanent hole: the held transactions above it can never mine.
 * Expected-correct behaviour: a fresh prepare always takes the lowest nonce at or above the
 * chain's account nonce that no live transaction holds. Model-based test of the real class with
 * fast-check: SAFETY and MEMORY are expected to hold on HEAD; the LIVENESS check asserts the
 * violation by requiring `fc.check` to fail and prints the shrunk counterexample.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { EvmNonces } from "../../src/transactions/evm-nonces.ts";

const NET = "eip155:1";
const FROM = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

type LiveTx = { readonly id: string; readonly nonce: number; readonly sharedWith?: string };

type Model = {
  /** The next nonce the chain will execute for the account — a gap does not move it. */
  chainNonce: number;
  /** Tracked transactions holding a nonce, by id. */
  live: Map<string, LiveTx>;
  /** Builds a `prepare` computed but not yet reserved, by id. */
  prepared: Map<string, number>;
  nextId: number;
};

const model = (): Model => ({ chainNonce: 0, live: new Map(), prepared: new Map(), nextId: 0 });

/** The nonce `prepareSpec` picks: max(chain pending as reported, EvmNonces.next). */
const prepareNonce = (nonces: EvmNonces, m: Model, lag: number): number =>
  Math.max(m.chainNonce - lag, nonces.next(NET, FROM));

/** The lowest nonce at or above the chain nonce that no live transaction holds — no holes. */
const lowestFree = (m: Model): number => {
  let n = m.chainNonce;
  for (;;) {
    if (!Array.from(m.live.values()).some((t) => t.nonce === n)) {
      return n;
    }
    n += 1;
  }
};

/**
 * SAFETY: `reserve(shared: false)` throws when a nonce is already held, so at one nonce there is
 * at most one non-shared holder — the original commit; every other holder got there through a
 * shared replacement hold (two replacements of a since-settled tx legitimately coexist).
 */
const safetyOk = (m: Model): boolean => {
  const roots = new Map<number, number>();
  for (const tx of m.live.values()) {
    if (tx.sharedWith === undefined) {
      roots.set(tx.nonce, (roots.get(tx.nonce) ?? 0) + 1);
    }
  }
  for (const count of roots.values()) {
    if (count > 1) {
      return false;
    }
  }
  return true;
};

type Command =
  | { readonly kind: "prepare"; readonly lag: number }
  | { readonly kind: "commit"; readonly pick: number }
  | { readonly kind: "replace"; readonly pick: number }
  | { readonly kind: "refuse"; readonly pick: number }
  | { readonly kind: "confirm"; readonly pick: number }
  | { readonly kind: "drop"; readonly pick: number };

const commandArb = fc.oneof(
  fc.record({ kind: fc.constant("prepare" as const), lag: fc.integer({ min: 0, max: 2 }) }),
  fc.record({ kind: fc.constant("commit" as const), pick: fc.integer({ min: 0, max: 9 }) }),
  fc.record({ kind: fc.constant("replace" as const), pick: fc.integer({ min: 0, max: 9 }) }),
  fc.record({ kind: fc.constant("refuse" as const), pick: fc.integer({ min: 0, max: 9 }) }),
  fc.record({ kind: fc.constant("confirm" as const), pick: fc.integer({ min: 0, max: 9 }) }),
  fc.record({ kind: fc.constant("drop" as const), pick: fc.integer({ min: 0, max: 9 }) }),
);

/** Picks one element of `items` by modular index; undefined when the list is empty. */
const pick = <T>(items: ReadonlyArray<T>, at: number): T | undefined => items[at % items.length];

const runCommand = (nonces: EvmNonces, m: Model, cmd: Command): void => {
  switch (cmd.kind) {
    case "prepare": {
      const lag = Math.min(cmd.lag, m.chainNonce);
      const id = `p${m.nextId}`;
      m.nextId += 1;
      m.prepared.set(id, prepareNonce(nonces, m, lag));
      break;
    }
    case "commit": {
      const entry = pick([...m.prepared.entries()], cmd.pick);
      if (entry === undefined) {
        break;
      }
      const [id, nonce] = entry;
      m.prepared.delete(id);
      try {
        nonces.reserve(id, NET, FROM, [nonce], false);
        m.live.set(id, { id, nonce });
      } catch {
        // A prepared build whose nonce was taken in the meantime fails at commit — allowed.
      }
      break;
    }
    case "replace": {
      const old = pick(Array.from(m.live.values()), cmd.pick);
      if (old === undefined) {
        break;
      }
      const id = `r${m.nextId}`;
      m.nextId += 1;
      try {
        nonces.reserve(id, NET, FROM, [old.nonce], true);
        m.live.set(id, { id, nonce: old.nonce, sharedWith: old.id });
      } catch {
        // A replacement below the settled floor cannot reserve — allowed.
      }
      break;
    }
    case "refuse":
    case "drop": {
      const tx = pick(Array.from(m.live.values()), cmd.pick);
      if (tx === undefined) {
        break;
      }
      nonces.release(tx.id);
      m.live.delete(tx.id);
      break;
    }
    case "confirm": {
      const tx = pick(Array.from(m.live.values()), cmd.pick);
      if (tx === undefined || tx.nonce !== m.chainNonce) {
        break;
      }
      nonces.consume(tx.id);
      m.live.delete(tx.id);
      m.chainNonce += 1;
      // A mined nonce buries every other live transaction sitting at it.
      for (const other of Array.from(m.live.values())) {
        if (other.nonce === tx.nonce) {
          nonces.release(other.id);
          m.live.delete(other.id);
        }
      }
      break;
    }
  }
};

const runAll = (nonces: EvmNonces, m: Model, commands: ReadonlyArray<Command>): void => {
  for (const cmd of commands) {
    runCommand(nonces, m, cmd);
  }
};

/** Every live transaction settles (drop any that cannot confirm): nothing may leak. */
const settleAll = (nonces: EvmNonces, m: Model): void => {
  for (const tx of Array.from(m.live.values())) {
    if (tx.nonce === m.chainNonce) {
      nonces.consume(tx.id);
      m.live.delete(tx.id);
      m.chainNonce += 1;
      for (const other of Array.from(m.live.values())) {
        if (other.nonce === tx.nonce) {
          nonces.release(other.id);
          m.live.delete(other.id);
        }
      }
    } else {
      nonces.release(tx.id);
      m.live.delete(tx.id);
    }
  }
};

describe("EvmNonces model", () => {
  it("SAFETY: unrelated live transactions never share a nonce (expected to hold)", () => {
    fc.assert(
      fc.property(fc.array(commandArb, { minLength: 0, maxLength: 40 }), (commands) => {
        const nonces = new EvmNonces();
        const m = model();
        for (const cmd of commands) {
          runCommand(nonces, m, cmd);
          expect(safetyOk(m)).toBe(true);
        }
      }),
      { numRuns: 500, seed: 42 },
    );
  });

  it("LIVENESS: a fresh prepare re-fills the lowest free nonce (expected to FAIL on HEAD)", () => {
    const result = fc.check(
      fc.property(fc.array(commandArb, { minLength: 0, maxLength: 40 }), (commands) => {
        const nonces = new EvmNonces();
        const m = model();
        for (const cmd of commands) {
          runCommand(nonces, m, cmd);
          // A fresh prepare sees the true chain nonce and the tracker's own `next` …
          const prepared = prepareNonce(nonces, m, 0);
          // … and must land on the lowest nonce above the chain nonce nothing live holds.
          if (prepared !== lowestFree(m)) {
            return false;
          }
        }
        return prepareNonce(nonces, m, 0) === lowestFree(m);
      }),
      // Seed 1 hits the hole within the budget on HEAD; seeds are a replay id, not a fix knob.
      { numRuns: 500, seed: 1 },
    );
    // On HEAD the property fails: `next()` only ever points above the highest hold.
    console.log(
      "LIVENESS counterexample (shrunk):",
      JSON.stringify(result.counterexample, null, 2),
    );
    expect(result.failed).toBe(true);
  });

  it("a refused send frees only its own nonce — and the hole is never filled", () => {
    // The minimal counterexample the model test above shrinks to: reserve a@0 and b@1, release
    // a (its broadcast was refused) — nonce 0 is free and the chain nonce is still 0, but the
    // next send signs 2.
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [0], false);
    nonces.reserve("b", NET, FROM, [1], false);
    nonces.release("a");
    expect(nonces.taken(NET, FROM, 0)).toBe(false); // nonce 0 is free
    expect(nonces.next(NET, FROM)).toBe(2); // … yet the next send signs 2, above the hole
  });

  it("MEMORY: once every live transaction settles, nothing leaks (expected to hold)", () => {
    fc.assert(
      fc.property(fc.array(commandArb, { minLength: 0, maxLength: 40 }), (commands) => {
        const nonces = new EvmNonces();
        const m = model();
        runAll(nonces, m, commands);
        settleAll(nonces, m);
        expect(m.live.size).toBe(0);
        expect(nonces.next(NET, FROM)).toBe(m.chainNonce);
        for (let n = m.chainNonce; n <= m.chainNonce + 3; n += 1) {
          expect(nonces.taken(NET, FROM, n)).toBe(false);
        }
      }),
      { numRuns: 500, seed: 42 },
    );
  });
});
