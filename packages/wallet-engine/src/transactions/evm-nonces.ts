/**
 * Nonce ownership per (network, sender). Every live transaction holds its nonces under its own id
 * from the moment its request commits until settlement, so an overlapping send can never sign a
 * nonce another transaction already carries, a refused send frees its nonce for reuse — `next`
 * answers the lowest nonce at or above the chain's count that nothing holds, so a freed lower
 * nonce is filled before anything higher and `reserve` refuses to sign above such a gap (the same
 * check that staleness uses to retire a prepared build) — and a consumed nonce stays spent even
 * when an endpoint's pending count lags behind. A replacement shares its nonce with the original
 * it may displace (`shared`); a self-sponsored EIP-7702 transaction also holds its
 * authorization's nonce. `consumed` records the nonces of in-block transactions per id rather
 * than one floor so a reorg can un-consume exactly its own: with A@5 and C@6 both consumed and
 * only A's reorg seen, the floor stays 7 (C still counts) until C reopens too. All state is in
 * memory: a route is dropped at lock and `resume` re-anchors every tracked transaction at unlock.
 */

type Account = {
  /** Nonces each transaction consumed with its receipt — the floor is 1 + their max. */
  consumed: Map<string, ReadonlyArray<number>>;
  /** Nonce → ids of the live transactions holding it; a replace pair shares one entry. */
  holds: Map<number, Set<string>>;
};

const nonceTaken = (nonce: number): Error =>
  new Error(`nonce ${String(nonce)} is already used by another transaction — start over`);

/** One past the highest nonce any transaction consumed; 0 when nothing is known spent. */
const floorOf = (account: Account): number => {
  let floor = 0;
  for (const nonces of account.consumed.values()) {
    for (const nonce of nonces) {
      floor = Math.max(floor, nonce + 1);
    }
  }
  return floor;
};

export class EvmNonces {
  private readonly accounts = new Map<string, Account>();

  private account(network: string, from: string): Account {
    const key = `${network}:${from.toLowerCase()}`;
    const account =
      this.accounts.get(key) ??
      ({
        consumed: new Map<string, ReadonlyArray<number>>(),
        holds: new Map<number, Set<string>>(),
      } satisfies Account);
    this.accounts.set(key, account);
    return account;
  }

  /**
   * Holds `nonces` for transaction `id`. Throws when one is below the settled floor, when —
   * unless `shared` (a replacement, or a reload at unlock) — one is held by another transaction,
   * or when a nonce below the hold is free again since `base`: signing above it would widen the
   * gap an earlier transaction left. Synchronous: call it in the same sync segment as the
   * request's commit.
   */
  reserve(
    id: string,
    network: string,
    from: string,
    nonces: ReadonlyArray<number>,
    shared: boolean,
    base: number,
  ): void {
    const account = this.account(network, from);
    const floor = floorOf(account);
    for (const nonce of nonces) {
      if (nonce < floor) {
        throw nonceTaken(nonce);
      }
      const holders = account.holds.get(nonce);
      if (!shared && holders !== undefined && [...holders].some((holder) => holder !== id)) {
        throw nonceTaken(nonce);
      }
    }
    const gap = nonces.length === 0 ? undefined : this.gap(network, from, base, Math.min(...nonces));
    if (gap !== undefined) {
      throw new Error(
        `nonce ${String(gap)} is free again — an earlier transaction was not sent; start over`,
      );
    }
    for (const nonce of nonces) {
      const holders = account.holds.get(nonce) ?? new Set<string>();
      holders.add(id);
      account.holds.set(nonce, holders);
    }
  }

  /** Frees what `id` holds; never touches another transaction's nonces. Idempotent. */
  release(id: string): void {
    for (const account of this.accounts.values()) {
      for (const [nonce, holders] of account.holds) {
        if (!holders.delete(id)) {
          continue;
        }
        if (holders.size === 0) {
          account.holds.delete(nonce);
        }
      }
    }
  }

  /**
   * `id` ended in a block: frees its holds and records its nonces consumed under it (guards a
   * lagging endpoint's pending count — and `reopen` can lift exactly this record on a reorg).
   */
  consume(id: string): void {
    for (const account of this.accounts.values()) {
      const held: number[] = [];
      for (const [nonce, holders] of account.holds) {
        if (holders.has(id)) {
          held.push(nonce);
        }
      }
      if (held.length > 0) {
        account.consumed.set(id, held);
      }
    }
    this.release(id);
  }

  /** Marks `nonces` consumed under `id` — the reload-time record for a row already in a block. */
  spend(id: string, network: string, from: string, nonces: ReadonlyArray<number>): void {
    this.account(network, from).consumed.set(id, nonces);
  }

  /**
   * A reorg returned `id` to the pool: its consumed record is lifted and its nonces are held again
   * — recorded without the floor/holder checks, a chain fact that must never throw.
   */
  reopen(id: string, network: string, from: string, nonces: ReadonlyArray<number>): void {
    const account = this.account(network, from);
    account.consumed.delete(id);
    for (const nonce of nonces) {
      const holders = account.holds.get(nonce) ?? new Set<string>();
      holders.add(id);
      account.holds.set(nonce, holders);
    }
  }

  /** Whether `nonce` is held by a live transaction or below the floor. */
  taken(network: string, from: string, nonce: number): boolean {
    const account = this.accounts.get(`${network}:${from.toLowerCase()}`);
    return account !== undefined && (nonce < floorOf(account) || account.holds.has(nonce));
  }

  /** The lowest nonce in [`base`, `nonce`) that is free — at or above the floor and not held. */
  gap(network: string, from: string, base: number, nonce: number): number | undefined {
    const account = this.accounts.get(`${network}:${from.toLowerCase()}`);
    const floor = account === undefined ? 0 : floorOf(account);
    for (let k = Math.max(base, floor); k < nonce; k += 1) {
      if (account?.holds.has(k) !== true) {
        return k;
      }
    }
    return undefined;
  }

  /** The lowest nonce at or above `chain` and the floor that nothing holds. */
  next(network: string, from: string, chain: number): number {
    const account = this.accounts.get(`${network}:${from.toLowerCase()}`);
    let next = Math.max(chain, account === undefined ? 0 : floorOf(account));
    while (account?.holds.has(next) === true) {
      next += 1;
    }
    return next;
  }
}
