/**
 * An in-process WalletConnect relay and Verify service for tests.
 *
 * `jsonrpc-ws-connection` captures `globalThis.WebSocket` at module load and the Core's Verify
 * client reads `fetch`, so importing THIS module — whose top-level statements install the stubs —
 * must precede any import of `@reown/walletkit`, `@walletconnect/*` or `src/walletconnect`.
 * `DISABLE_GLOBAL_CORE` keeps every `new Core` off the process-wide singleton so each rig owns its
 * pairing store. `IS_VITEST` is never set: it would disable Verify.
 */
import type { WalletConnectStorage } from "../../src/walletconnect/index.ts";

// oxlint-disable typescript/require-await -- the storage and fetch contracts are async; the test doubles behind them are synchronous

export type VerifyAnswer = {
  readonly origin: string;
  readonly isScam?: boolean;
};

type StoredMessage = {
  readonly topic: string;
  readonly message: string;
  readonly publishedAt: number;
  readonly tag: number | undefined;
};

const topics = new Map<string, Set<FakeSocket>>();
const mailbox = new Map<string, StoredMessage[]>();
const sockets: FakeSocket[] = [];
let subscriptionSeq = 0;
let messageSeq = 0;

const verify: { current: VerifyAnswer | undefined } = { current: undefined };

/** Relay state a test tunes; every test resets it so stale sockets cannot cross-deliver. */
export const walletConnectRelay = {
  /** What `verify.walletconnect.org/attestation/<id>` answers; `undefined` is a 404 → UNKNOWN. */
  verify,
  /** Every ciphertext ever published on `topic` — decode with either side's `core.crypto`. */
  messagesOn: (topic: string): ReadonlyArray<string> =>
    (mailbox.get(topic) ?? []).map((data) => data.message),
  reset(): void {
    topics.clear();
    mailbox.clear();
    sockets.length = 0;
    verify.current = undefined;
  },
};

class FakeSocket {
  readonly url: string;
  readyState = 0;
  onopen?: (event: unknown) => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: (event: unknown) => void;
  private readonly subscriptions = new Map<string, string>();
  private readonly seen = new Set<StoredMessage>();

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  /** Node `ws` hooks the SDK installs but our fake ignores. */
  readonly on = (): void => undefined;
  terminate(): void {
    this.close();
  }

  send(raw: string): void {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- relay JSON-RPC frames are shaped by the SDK
    const msg = JSON.parse(raw) as {
      id: number;
      method?: string;
      params?: Record<string, unknown> & { topics?: string[] };
    };
    // A bare `{id, jsonrpc, result}` is the client acking a delivery — no method to serve.
    if (msg.method === undefined) {
      return;
    }
    const params = (msg.params ?? {}) as {
      topic?: string;
      topics?: ReadonlyArray<string>;
      pairingTopic?: string;
      sessionTopic?: string;
      sessionProposal?: string;
      sessionProposalResponse?: string;
      sessionSettlementRequest?: string;
      message?: string;
      tag?: number;
    };
    const reply = (result: unknown): void => {
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify({ id: msg.id, jsonrpc: "2.0", result }),
        });
      });
    };
    const deliver = (topic: string, message: string, tag?: number): void => {
      const data: StoredMessage = { topic, message, publishedAt: Date.now(), tag };
      let list = mailbox.get(topic);
      if (list === undefined) {
        list = [];
        mailbox.set(topic, list);
      }
      list.push(data);
      for (const socket of topics.get(topic) ?? []) {
        if (socket === this || socket.seen.has(data)) {
          continue;
        }
        socket.seen.add(data);
        socket.push(topic, data);
      }
    };
    switch (msg.method) {
      // The subscription id is acked before the topic's stored messages are pushed — a message
      // delivered ahead of the ack would be dropped by the client as an unknown subscription.
      case "irn_subscribe": {
        const id = `sub${++subscriptionSeq}`;
        reply(id);
        this.sub(params.topic ?? "", id);
        return;
      }
      case "irn_batchSubscribe": {
        const list = params.topics ?? [];
        const ids = list.map(() => `sub${++subscriptionSeq}`);
        reply(ids);
        for (const [index, topic] of list.entries()) {
          this.sub(topic, ids[index] ?? `sub${subscriptionSeq}`);
        }
        return;
      }
      case "irn_unsubscribe":
        topics.get(params.topic ?? "")?.delete(this);
        reply(true);
        return;
      case "irn_publish":
        deliver(params.topic ?? "", params.message ?? "", params.tag);
        reply(true);
        return;
      case "irn_batchFetchMessages":
        reply({ messages: [], hasMore: false });
        return;
      // The dApp's settlement: it joins its pairing topic, the wallet is pushed the proposal.
      case "wc_proposeSession":
        this.sub(params.pairingTopic ?? "", `sub${++subscriptionSeq}`);
        deliver(params.pairingTopic ?? "", params.sessionProposal ?? "", 1100);
        reply(true);
        return;
      // The wallet's settlement: it joins the session topic; the dApp gets the approval on the
      // pairing topic and the settlement record on the session topic.
      case "wc_approveSession":
        this.sub(params.sessionTopic ?? "", `sub${++subscriptionSeq}`);
        deliver(params.pairingTopic ?? "", params.sessionProposalResponse ?? "", 1101);
        deliver(params.sessionTopic ?? "", params.sessionSettlementRequest ?? "", 1102);
        reply(true);
        return;
      default:
        reply(true);
    }
  }

  private sub(topic: string, id: string): void {
    let subscribers = topics.get(topic);
    if (subscribers === undefined) {
      subscribers = new Set();
      topics.set(topic, subscribers);
    }
    subscribers.add(this);
    this.subscriptions.set(topic, id);
    for (const data of mailbox.get(topic) ?? []) {
      if (!this.seen.has(data)) {
        this.seen.add(data);
        this.push(topic, data);
      }
    }
  }

  private push(topic: string, data: StoredMessage): void {
    const subscription = this.subscriptions.get(topic) ?? "sub0";
    setTimeout(() => {
      this.onmessage?.({
        data: JSON.stringify({
          id: ++messageSeq,
          jsonrpc: "2.0",
          method: "irn_subscription",
          params: { id: subscription, data },
        }),
      });
    });
  }

  close(): void {
    this.readyState = 3;
    for (const subscribers of topics.values()) {
      subscribers.delete(this);
    }
    setTimeout(() => {
      this.onclose?.({ code: 1000 });
    });
  }
}

/** `verify.walletconnect.org` answers the attestation lookup; anything else is a test bug. */
const verifyFetch: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://verify.walletconnect.org/attestation/")) {
    const answer = verify.current;
    if (answer === undefined) {
      return new Response("not found", { status: 404 });
    }
    return Response.json({ origin: answer.origin, isScam: answer.isScam ?? false });
  }
  throw new Error(`unexpected fetch ${url}`);
};

// Installed at module evaluation — before the SDK modules that read these globals load.
globalThis.WebSocket =
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake implements only what jsonrpc-ws-connection calls
  FakeSocket as unknown as typeof WebSocket;
globalThis.fetch = verifyFetch;
process.env["DISABLE_GLOBAL_CORE"] = "true";

/** A `WalletConnectStorage` (and IKeyValueStorage) over a Map — share one for restart tests. */
export const memoryWalletConnectStorage = (): WalletConnectStorage & {
  entries: Map<string, unknown>;
} => {
  const entries = new Map<string, unknown>();
  return {
    entries,
    getKeys: async () => [...entries.keys()],
    getEntries: async () => [...entries.entries()],
    getItem: async (key) => entries.get(key),
    setItem: async (key, value) => {
      entries.set(key, value);
    },
    removeItem: async (key) => {
      entries.delete(key);
    },
  };
};
