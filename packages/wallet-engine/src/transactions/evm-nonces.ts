/**
 * Nonce ownership per (network, sender). Every live transaction holds its nonces under its own
 * id from the moment its request commits until settlement, so an overlapping send can never sign
 * a nonce another transaction already carries, a refused send frees its nonce for reuse, and a
 * consumed nonce stays spent even when an endpoint's pending count lags behind. A replacement
 * shares its nonce with the original it may displace (`shared`); a self-sponsored EIP-7702
 * transaction also holds its authorization's nonce. All state is in memory: a route is dropped at
 * lock and `resume` re-holds every live transaction at unlock.
 */

type Account = {
  /** One past the highest nonce known consumed for this account. */
  floor: number;
  /** nonce → ids of the live transactions holding it; a replace pair shares one entry. */
  holds: Map<number, Set<string>>;
};

const nonceTaken = (nonce: number): Error =>
  new Error(`nonce ${String(nonce)} is already used by another transaction — start over`);

export class EvmNonces {
  private readonly accounts = new Map<string, Account>();

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
    const key = `${network}:${from.toLowerCase()}`;
    const account = this.accounts.get(key) ?? { floor: 0, holds: new Map<number, Set<string>>() };
    for (const nonce of nonces) {
      if (nonce < account.floor) {
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
    this.accounts.set(key, account);
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
   * `id` ended with a receipt: frees it and raises the floor past its nonces (guards a lagging
   * endpoint's pending count).
   */
  consume(id: string): void {
    for (const account of this.accounts.values()) {
      for (const [nonce, holders] of account.holds) {
        if (holders.has(id)) {
          account.floor = Math.max(account.floor, nonce + 1);
        }
      }
    }
    this.release(id);
  }

  /** Whether `nonce` is held by a live transaction or below the floor. */
  taken(network: string, from: string, nonce: number): boolean {
    const account = this.accounts.get(`${network}:${from.toLowerCase()}`);
    return account !== undefined && (nonce < account.floor || account.holds.has(nonce));
  }

  /** One past the highest held nonce or the floor, whichever is larger; 0 when nothing is known. */
  next(network: string, from: string): number {
    const account = this.accounts.get(`${network}:${from.toLowerCase()}`);
    if (account === undefined) {
      return 0;
    }
    let next = account.floor;
    for (const nonce of account.holds.keys()) {
      next = Math.max(next, nonce + 1);
    }
    return next;
  }
}
