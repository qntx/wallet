import { describe, expect, test } from "vite-plus/test";

import type { Event } from "@qntx/nostr";
import type { NostrKeyRef } from "@qntx/wallet";
import type { WalletSigner } from "@qntx/wallet/nostr";

import type { ConnectionSession, NostrPolicy } from "../src/connect/controller.ts";
import { Nip07Handler } from "../src/connect/nip07.ts";
import type { Nip07HandlerOptions } from "../src/connect/nip07.ts";
import type { NostrSignResult, PendingRequest } from "../src/requests/controller.ts";

const ORIGIN = "https://dapp.example";
const REF: NostrKeyRef = { kind: "derived", walletId: "w", index: 0 };
const PUBKEY = "aa".repeat(32);

const EVENT: Event = {
  id: "e1",
  sig: "s",
  pubkey: PUBKEY,
  kind: 1,
  content: "hi",
  created_at: 1,
  tags: [],
};

const testSigner = (signed: Event): WalletSigner => ({
  unwrapGiftWraps: async () => Promise.resolve([]),
  getPublicKey: async () => Promise.resolve(PUBKEY),
  signEvent: async () => Promise.resolve(signed),
  nip04Encrypt: async () => Promise.resolve("c04"),
  nip04Decrypt: async () => Promise.resolve("p04"),
  nip44Encrypt: async () => Promise.resolve("c44"),
  nip44Decrypt: async () => Promise.resolve("p44"),
});

type Connections = Nip07HandlerOptions["connections"];
type Requests = Nip07HandlerOptions["requests"];

const session = (policy: NostrPolicy | undefined): ConnectionSession => ({
  id: "s1",
  origin: { kind: "browser", origin: ORIGIN },
  scopes: {
    nostr: { accounts: [`nostr:${PUBKEY}`], methods: ["signEvent"], notifications: [] },
  },
  currentNetwork: "",
  ...(policy === undefined ? {} : { nostrPolicy: policy }),
  createdAt: 0,
  lastUsedAt: 0,
});

type Rig = { handler: Nip07Handler; approved: string[] };

const rig = (
  opts: { policy?: NostrPolicy; identity?: NostrKeyRef | undefined; connected?: boolean } = {},
): Rig => {
  const approved: string[] = [];
  const connected = opts.connected !== false;
  const identity = "identity" in opts ? opts.identity : REF;
  const connections: Connections = {
    checkOrigin: (origin) => ({ kind: "browser", origin }),
    authorize: () => session(opts.policy),
    session: () => (connected ? session(opts.policy) : undefined),
    nostrAccount: () => (connected ? PUBKEY : undefined),
    nostrPolicy: () => opts.policy,
    activeIdentity: () => identity,
    request: async () => Promise.resolve(session(opts.policy)),
    touch: async () => Promise.resolve(),
  };
  const requests: Requests = {
    prepare: async () => {
      const id = `req-${approved.length}`;
      approved.push(id);
      return Promise.resolve({ id } as PendingRequest);
    },
    outcome: async () => Promise.resolve({ kind: "nostr.event", event: EVENT } as NostrSignResult),
  };
  return {
    handler: new Nip07Handler({ connections, requests, signerFor: () => testSigner(EVENT) }),
    approved,
  };
};

const unsigned = (over: Record<string, unknown> = {}): ReadonlyArray<Record<string, unknown>> => [
  { kind: 1, content: "hi", created_at: 1, tags: [], ...over },
];

describe("Nip07Handler", () => {
  test("getPublicKey returns the session's identity pubkey", async () => {
    const { handler } = rig();
    await expect(handler.handle(ORIGIN, { method: "getPublicKey" })).resolves.toBe(PUBKEY);
  });

  test("no active identity → 4100", async () => {
    const { handler } = rig({ identity: undefined });
    await expect(handler.handle(ORIGIN, { method: "getPublicKey" })).rejects.toMatchObject({
      code: 4100,
    });
  });

  test("policy 'always' signs a non-forced kind directly", async () => {
    const { handler, approved } = rig({ policy: { signing: "always", decrypt: false } });
    await expect(
      handler.handle(ORIGIN, { method: "signEvent", params: unsigned() }),
    ).resolves.toMatchObject({ id: "e1" });
    expect(approved).toHaveLength(0);
  });

  test("policy 'ask' goes through the pipeline", async () => {
    const { handler, approved } = rig({ policy: { signing: "ask", decrypt: false } });
    await expect(
      handler.handle(ORIGIN, { method: "signEvent", params: unsigned() }),
    ).resolves.toMatchObject({ id: "e1" });
    expect(approved).toHaveLength(1);
  });

  test("policy {kinds:[1]} signs kind-1 directly and a non-listed kind via the pipeline", async () => {
    const { handler, approved } = rig({ policy: { signing: { kinds: [1] }, decrypt: false } });
    await handler.handle(ORIGIN, { method: "signEvent", params: unsigned() });
    await handler.handle(ORIGIN, { method: "signEvent", params: unsigned({ kind: 42 }) });
    expect(approved).toHaveLength(1);
  });

  test.each([[0], [3], [5], [10002]])(
    "forced-confirm kind %i always uses the pipeline",
    async (kind) => {
      const { handler, approved } = rig({ policy: { signing: "always", decrypt: false } });
      await handler.handle(ORIGIN, { method: "signEvent", params: unsigned({ kind }) });
      expect(approved).toHaveLength(1);
    },
  );

  test("a page-supplied pubkey that mismatches the identity → -32602", async () => {
    const { handler } = rig();
    await expect(
      handler.handle(ORIGIN, {
        method: "signEvent",
        params: unsigned({ pubkey: "bb".repeat(32) }),
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  test("decrypt needs nostrPolicy.decrypt → 4100 without the grant", async () => {
    const { handler } = rig({ policy: { signing: "always", decrypt: false } });
    await expect(
      handler.handle(ORIGIN, { method: "nip04.decrypt", params: ["peer", "cipher"] }),
    ).rejects.toMatchObject({ code: 4100 });
  });

  test("decrypt succeeds with the grant", async () => {
    const { handler } = rig({ policy: { signing: "always", decrypt: true } });
    await expect(
      handler.handle(ORIGIN, { method: "nip44.decrypt", params: ["peer", "cipher"] }),
    ).resolves.toBe("p44");
  });
});
