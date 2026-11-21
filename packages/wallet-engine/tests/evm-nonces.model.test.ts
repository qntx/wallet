import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { EvmNonces } from "../src/transactions/evm-nonces.ts";

const NET = "eip155:1";
const FROM = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

/** A transaction the tracker still follows. Single-nonce holds only — pairs are covered elsewhere. */
type LiveTx = {
  readonly id: string;
  readonly nonce: number;
  /** Counts as the nonce's non-shared occupant; a replacement shares its original's hold. */
  readonly own: boolean;
  unknown: boolean;
};

/** A prepared build: the chosen nonce and the reported chain count it was chosen against. */
type Prepared = { readonly nonce: number; readonly base: number };

/**
 * Model state for an account whose chain executes contiguously: `chainNonce` is the account's mined
 * count, `live` the tracked transactions, `mined` the confirmed ones a reorg can return to the pool
 * and `consumed` the nonce records `consume`/`spend` would leave — `final` mined rows are what an
 * unlock forgets.
 */
type Model = {
  chainNonce: number;
  live: Map<string, LiveTx>;
  prepared: Map<string, Prepared>;
  mined: Array<{ id: string; nonce: number; final: boolean }>;
  consumed: Map<string, number>;
  nextId: number;
};

const model = (): Model => ({
  chainNonce: 0,
  live: new Map(),
  prepared: new Map(),
  mined: [],
  consumed: new Map(),
  nextId: 0,
});

type Command =
  | { readonly kind: "prepare"; readonly lag: number }
  | { readonly kind: "commit"; readonly pick: number }
  | { readonly kind: "broadcastOk"; readonly pick: number }
  | { readonly kind: "refuse"; readonly pick: number }
  | { readonly kind: "unknown"; readonly pick: number }
  | { readonly kind: "drop"; readonly pick: number }
  | { readonly kind: "confirm" }
  | { readonly kind: "reorg" }
  | { readonly kind: "finalize"; readonly pick: number }
  | { readonly kind: "replace"; readonly pick: number }
  | { readonly kind: "unlock" };

const commandArb = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("prepare" as const),
      lag: fc.integer({ min: 0, max: 2 }),
    }),
  },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("commit" as const), pick: fc.nat() }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("broadcastOk" as const), pick: fc.nat() }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("refuse" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("unknown" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("drop" as const), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.constant({ kind: "confirm" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "reorg" as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("finalize" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("replace" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.constant({ kind: "unlock" as const }) },
);

const pick = <T>(items: ReadonlyArray<T>, at: number): T | undefined =>
  items.length === 0 ? undefined : items[at % items.length];

/** The floor the model expects: one past the highest consumed nonce. */
const floorModel = (m: Model): number => {
  let floor = 0;
  for (const nonce of m.consumed.values()) {
    floor = Math.max(floor, nonce + 1);
  }
  return floor;
};

const held = (m: Model, nonce: number): boolean =>
  [...m.live.values()].some((t) => t.nonce === nonce);

/** The lowest nonce at or above the chain's count that no live transaction holds. */
const lowestFree = (m: Model): number => {
  let n = m.chainNonce;
  while (held(m, n)) {
    n += 1;
  }
  return n;
};

const runCommand = (env: { nonces: EvmNonces }, m: Model, cmd: Command): void => {
  const { nonces } = env;
  switch (cmd.kind) {
    case "prepare": {
      // A lagging endpoint reports below the true chain count, never above it.
      const base = m.chainNonce - Math.min(cmd.lag, m.chainNonce);
      m.prepared.set(`p${m.nextId}`, { nonce: nonces.next(NET, FROM, base), base });
      m.nextId += 1;
      break;
    }
    case "commit": {
      const entry = pick([...m.prepared.entries()], cmd.pick);
      if (entry === undefined) {
        break;
      }
      const [id, p] = entry;
      m.prepared.delete(id);
      const floor = floorModel(m);
      const taken = p.nonce < floor || held(m, p.nonce);
      let gap = false;
      for (let k = Math.max(p.base, floor); k < p.nonce; k += 1) {
        if (!held(m, k)) {
          gap = true;
          break;
        }
      }
      if (taken || gap) {
        // RESERVE GUARD: a build prepared above a freed or spent lower nonce must not sign.
        expect(() => nonces.reserve(id, NET, FROM, [p.nonce], false, p.base)).toThrow(/nonce/);
        break;
      }
      nonces.reserve(id, NET, FROM, [p.nonce], false, p.base);
      m.live.set(id, { id, nonce: p.nonce, own: true, unknown: false });
      break;
    }
    case "broadcastOk":
      // The node accepted the bytes — nothing about the holds changes.
      break;

    case "refuse": {
      const tx = pick(
        [...m.live.values()].filter((t) => t.own),
        cmd.pick,
      );
      if (tx === undefined) {
        break;
      }
      nonces.release(tx.id);
      m.live.delete(tx.id);
      break;
    }
    case "unknown": {
      const tx = pick([...m.live.values()], cmd.pick);
      if (tx !== undefined) {
        tx.unknown = true;
      }
      break;
    }
    case "drop": {
      const lives = [...m.live.values()];
      const unknown = lives.filter((t) => t.unknown);
      const tx = pick(unknown.length > 0 ? unknown : lives, cmd.pick);
      if (tx === undefined) {
        break;
      }
      nonces.release(tx.id);
      m.live.delete(tx.id);
      break;
    }
    case "confirm": {
      // The chain executes contiguously: only a live transaction at the chain nonce can mine,
      // and every other holder at that nonce is a replacement it buries.
      const tx = [...m.live.values()].find((t) => t.nonce === m.chainNonce);
      if (tx === undefined) {
        break;
      }
      nonces.consume(tx.id);
      m.consumed.set(tx.id, tx.nonce);
      m.live.delete(tx.id);
      m.mined.push({ id: tx.id, nonce: tx.nonce, final: false });
      for (const other of m.live.values()) {
        if (other.nonce === tx.nonce) {
          nonces.release(other.id);
          m.live.delete(other.id);
        }
      }
      m.chainNonce += 1;
      break;
    }
    case "reorg": {
      let index = -1;
      for (const [i, t] of m.mined.entries()) {
        if (!t.final) {
          index = Math.max(index, i);
        }
      }
      if (index < 0) {
        break;
      }
      const [tx] = m.mined.splice(index, 1);
      if (tx === undefined) {
        break;
      }
      m.consumed.delete(tx.id);
      nonces.reopen(tx.id, NET, FROM, [tx.nonce]);
      m.live.set(tx.id, { id: tx.id, nonce: tx.nonce, own: true, unknown: false });
      // The chain tip only retreats when the last confirmed transaction leaves it.
      if (index === m.mined.length) {
        m.chainNonce -= 1;
      }
      break;
    }
    case "finalize": {
      const tx = pick(
        m.mined.filter((t) => !t.final),
        cmd.pick,
      );
      if (tx !== undefined) {
        tx.final = true;
      }
      break;
    }
    case "replace": {
      const old = pick([...m.live.values()], cmd.pick);
      if (old === undefined) {
        break;
      }
      const id = `r${m.nextId}`;
      m.nextId += 1;
      try {
        // A replacement shares the original's already-broadcast nonce — no new gap.
        nonces.reserve(id, NET, FROM, [old.nonce], true, old.nonce);
        m.live.set(id, { id, nonce: old.nonce, own: false, unknown: false });
      } catch {
        // A replacement below the settled floor cannot reserve — allowed.
      }
      break;
    }
    case "unlock":
      // Lock drops the whole in-memory tracker; unlock re-anchors every reloaded row the way
      // `createEvmRoute().resume` does: live holds shared at their nonce, rows already in a
      // block are spent — and finalized rows are never re-anchored at all.
      env.nonces = new EvmNonces();
      for (const tx of m.mined) {
        if (!tx.final) {
          env.nonces.spend(tx.id, NET, FROM, [tx.nonce]);
        }
      }
      m.consumed = new Map(m.mined.filter((t) => !t.final).map((t) => [t.id, t.nonce]));
      for (const tx of m.live.values()) {
        env.nonces.reserve(tx.id, NET, FROM, [tx.nonce], true, tx.nonce);
      }
      break;
  }
};

/** LIVENESS + SAFETY, checked after every step. RESERVE GUARD lives inside `commit`. */
const checkInvariant = (env: { nonces: EvmNonces }, m: Model): void => {
  // LIVENESS: the next send fills the lowest nonce the chain can still take.
  expect(env.nonces.next(NET, FROM, m.chainNonce)).toBe(lowestFree(m));
  // SAFETY: at most one non-shared holder per nonce.
  const roots = new Map<number, number>();
  for (const tx of m.live.values()) {
    if (tx.own) {
      roots.set(tx.nonce, (roots.get(tx.nonce) ?? 0) + 1);
    }
  }
  for (const count of roots.values()) {
    expect(count).toBe(1);
  }
};

/** Every live transaction settles (drop any that cannot confirm): nothing may leak. */
const settleAll = (env: { nonces: EvmNonces }, m: Model): void => {
  for (const tx of m.live.values()) {
    if (!m.live.has(tx.id)) {
      continue;
    }
    if (tx.nonce === m.chainNonce) {
      env.nonces.consume(tx.id);
      m.consumed.set(tx.id, tx.nonce);
      m.chainNonce += 1;
      for (const other of m.live.values()) {
        if (other.nonce === tx.nonce) {
          env.nonces.release(other.id);
          m.live.delete(other.id);
        }
      }
    } else {
      env.nonces.release(tx.id);
    }
    m.live.delete(tx.id);
  }
};

describe("EvmNonces model", () => {
  it("a released lower nonce is re-filled before any higher one signs", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(fc.array(commandArb, { minLength: 0, maxLength: 60 }), (commands) => {
        const env = { nonces: new EvmNonces() };
        const m = model();
        for (const cmd of commands) {
          runCommand(env, m, cmd);
          checkInvariant(env, m);
        }
        settleAll(env, m);
        // MEMORY: everything settled leaves nothing held and the next send at the chain nonce.
        expect(m.live.size).toBe(0);
        expect(env.nonces.next(NET, FROM, m.chainNonce)).toBe(m.chainNonce);
        for (let n = m.chainNonce; n <= m.chainNonce + 3; n += 1) {
          expect(env.nonces.taken(NET, FROM, n)).toBe(false);
        }
      }),
      {
        numRuns: 2000,
        seed: 7,
        // A send holds 0, a second send holds 1, the first dies — nonce 0 must be signed again.
        examples: [
          [
            [
              { kind: "prepare", lag: 0 },
              { kind: "commit", pick: 0 },
              { kind: "prepare", lag: 0 },
              { kind: "commit", pick: 0 },
              { kind: "drop", pick: 0 },
            ] as Command[],
          ],
        ],
      },
    );
  });

  it("a refused send frees its nonce — the next send re-issues it", () => {
    const nonces = new EvmNonces();
    nonces.reserve("a", NET, FROM, [0], false, 0);
    nonces.reserve("b", NET, FROM, [1], false, 0);
    nonces.release("a");
    expect(nonces.next(NET, FROM, 0)).toBe(0);
    expect(nonces.gap(NET, FROM, 0, 1)).toBe(0);
    expect(() => nonces.reserve("c", NET, FROM, [2], false, 0)).toThrow(
      "nonce 0 is free again — an earlier transaction was not sent; start over",
    );
    // After the gap is filled the higher hold signs normally.
    nonces.reserve("c", NET, FROM, [0], false, 0);
    expect(nonces.next(NET, FROM, 0)).toBe(2);
  });
});
