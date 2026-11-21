/**
 * Nonce ownership per (network, sender). Every live transaction holds its nonces under its own id
 * from the moment its request commits until settlement, so an overlapping send can never sign a
 * nonce another transaction already carries, a refused send frees its nonce for reuse, and a
 * consumed nonce stays spent even when an endpoint's pending count lags behind. A replacement
 * shares its nonce with the original it may displace (`shared`); a self-sponsored EIP-7702
 * transaction also holds its authorization's nonce. `consumed` records the nonces of in-block
 * transactions per id rather than one floor so a reorg can un-consume exactly its own: with A@5 and
 * C@6 both consumed and only A's reorg seen, the floor stays 7 (C still counts) until C reopens
 * too. All state is in memory: a route is dropped at lock and `resume` re-anchors every tracked
 * transaction at unlock.
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
   * Holds `nonces` for transaction `id`. Throws when one is below the settled floor, or — unless
   * `shared` (a replacement, or a reload at unlock) — held by another transaction. Synchronous:
   * call it in the same sync segment as the request's commit.
   */
  reserve(
    id: string,
    network: string,
    from: string,
    nonces: ReadonlyArray<number>,
    shared: boolean,
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

  /** One past the highest held or consumed nonce, whichever is larger; 0 when nothing is known. */
  next(network: string, from: string): number {
    const account = this.accounts.get(`${network}:${from.toLowerCase()}`);
    if (account === undefined) {
      return 0;
    }
    let next = floorOf(account);
    for (const nonce of account.holds.keys()) {
      next = Math.max(next, nonce + 1);
    }
    return next;
  }
}
