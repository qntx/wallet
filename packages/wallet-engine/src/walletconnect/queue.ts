import type { WalletConnectVerify } from "../requests/types.ts";

/** One session_request, normalized from the live event or a recovered pending request. */
export type SessionRequestItem = {
  readonly id: number;
  readonly topic: string;
  readonly chainId: string;
  readonly method: string;
  readonly params: unknown;
  readonly expiryTimestamp: number | undefined;
  readonly verify: WalletConnectVerify;
};

export type SessionRequestQueueHandler = {
  /** Runs one item end to end — validation, dispatch, response. */
  readonly run: (item: SessionRequestItem) => Promise<void>;
  /** A peer-side expiry ended the topic's in-flight request: void its pipeline work. */
  readonly invalidate: (topic: string) => void;
  /** A run threw — reported, then the queue moves on. */
  readonly warn: (error: unknown) => void;
};

/** How many recently seen request ids dedup keeps. */
const MAX_SEEN = 500;

/**
 * Per-topic FIFO queues: requests of one session serialize (an approval must not race the next
 * call) while different sessions run concurrently. Requests queue while the vault is locked and
 * drain when it unlocks; ids already queued, in flight or recently done are dropped so the relay's
 * at-least-once delivery never reaches the pipeline twice — and a restarted client refuses ids it
 * already answered before they ever arrive here.
 */
export class SessionRequestQueue {
  private readonly pending = new Map<string, SessionRequestItem[]>();
  private readonly running = new Map<string, SessionRequestItem>();
  private readonly expired = new Set<number>();
  private readonly seen = new Set<number>();
  private readonly seenOrder: number[] = [];
  private ready = false;
  private readonly handler: SessionRequestQueueHandler;

  constructor(handler: SessionRequestQueueHandler) {
    this.handler = handler;
  }

  /** The vault opened or locked: queued items drain only while ready. */
  setReady(ready: boolean): void {
    this.ready = ready;
    if (ready) {
      for (const topic of this.pending.keys()) {
        void this.drain(topic);
      }
    }
  }

  has(id: number): boolean {
    return this.seen.has(id);
  }

  enqueue(item: SessionRequestItem): void {
    if (this.seen.has(item.id)) {
      return;
    }
    this.seen.add(item.id);
    this.seenOrder.push(item.id);
    if (this.seenOrder.length > MAX_SEEN) {
      const oldest = this.seenOrder.shift();
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    const queue = this.pending.get(item.topic) ?? [];
    queue.push(item);
    this.pending.set(item.topic, queue);
    if (this.ready) {
      void this.drain(item.topic);
    }
  }

  /** Back at the head of its queue — a dispatch that failed while the vault was locked. */
  requeue(item: SessionRequestItem): void {
    const queue = this.pending.get(item.topic) ?? [];
    queue.unshift(item);
    this.pending.set(item.topic, queue);
    if (this.ready) {
      void this.drain(item.topic);
    }
  }

  /** The session went away: its queued requests are never answered. */
  drop(topic: string): void {
    this.pending.delete(topic);
  }

  /** The client is gone: nothing else runs and every in-flight request's pipeline work is voided. */
  dispose(): void {
    this.ready = false;
    this.pending.clear();
    for (const topic of this.running.keys()) {
      this.handler.invalidate(topic);
    }
  }

  /**
   * `session_request_expire`: a queued item is dropped; an in-flight one is marked so no response
   * is sent and its pipeline request is voided.
   */
  expire(id: number): void {
    this.expired.add(id);
    for (const [topic, queue] of this.pending) {
      const index = queue.findIndex((item) => item.id === id);
      if (index !== -1) {
        queue.splice(index, 1);
        if (queue.length === 0) {
          this.pending.delete(topic);
        }
        return;
      }
    }
    for (const [topic, item] of this.running) {
      if (item.id === id) {
        this.handler.invalidate(topic);
        return;
      }
    }
  }

  /** `session_request_expire` marked this id — the answer would fail, so none is sent. */
  wasExpired(id: number): boolean {
    return this.expired.has(id);
  }

  private async drain(topic: string): Promise<void> {
    if (this.running.has(topic)) {
      return;
    }
    for (;;) {
      if (!this.ready) {
        return;
      }
      const queue = this.pending.get(topic);
      const item = queue?.shift();
      if (item === undefined) {
        this.pending.delete(topic);
        return;
      }
      this.running.set(topic, item);
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one request per topic at a time
        await this.handler.run(item);
      } catch (error) {
        this.handler.warn(error);
      } finally {
        this.running.delete(topic);
      }
    }
  }
}
