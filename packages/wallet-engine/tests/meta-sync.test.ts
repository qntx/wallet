import { randomBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import type { Event, Filter } from "@qntx/nostr";
import type { Wallet, WalletInfo } from "@qntx/wallet";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { nostr } from "@qntx/wallet/nostr";
import type { WalletSyncSigner } from "@qntx/wallet/nostr";

import { AccountTreeController } from "../src/accounts/controller.ts";
import { AddressBookController } from "../src/addresses/controller.ts";
import { MetaSyncController } from "../src/meta/controller.ts";
import { decodeMetaDocBytes, encodeMetaDoc } from "../src/meta/doc.ts";
import { SparkController } from "../src/spark/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { realTimer } from "./send-helpers.ts";

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const PASSKEY_CONFIG = {
  rpId: "qntx.test",
  rpName: "qntx",
  walletSalt: "qntx/wallet",
  backupSalt: "qntx/backup",
  vaultSalt: "qntx/vault",
};
const PASSWORD = "correct horse battery staple";
const TAG = "qntx/wallet-meta";
const NETWORK = "regtest" as const;
const LOGGER = { warn: () => {} };

type FakeRelay = {
  readonly events: Event[];
  readonly published: Event[];
  readonly fetch: (filter: Filter) => Promise<ReadonlyArray<Event>>;
  readonly publish: (event: Event) => Promise<void>;
  fetchCalls: number;
};

/** Deliberately unfiltered fetch — the controller must verify every returned event itself. */
function fakeRelay(): FakeRelay {
  const relay: FakeRelay = {
    events: [],
    published: [],
    fetchCalls: 0,
    fetch: async () => {
      relay.fetchCalls += 1;
      return Promise.resolve([...relay.events]);
    },
    publish: async (event) => {
      relay.published.push(event);
      const d = event.tags.find((t) => t[0] === "d")?.[1];
      const at = relay.events.findIndex(
        (e) =>
          e.kind === event.kind &&
          e.pubkey === event.pubkey &&
          e.tags.find((t) => t[0] === "d")?.[1] === d,
      );
      if (at === -1) {
        relay.events.push(event);
      } else if ((relay.events[at]?.created_at ?? 0) < event.created_at) {
        // Replaceable events: a relay keeps the newest `created_at`, so a stale echo cannot win.
        relay.events[at] = event;
      }
      await Promise.resolve();
    },
  };
  return relay;
}

type Rig = {
  readonly wallet: Wallet;
  readonly accounts: AccountTreeController;
  readonly addressBook: AddressBookController;
  readonly metaSync: MetaSyncController;
  readonly relay: FakeRelay;
  setNow: (t: number) => void;
};

async function rig(
  opts: { relay?: FakeRelay; syncSignerWrap?: (s: WalletSyncSigner) => WalletSyncSigner } = {},
): Promise<Rig> {
  const wallet = await createNodeWallet({
    verifyEvent,
    passkey: PASSKEY_CONFIG,
    autoLock: { platform: "web", idleMinutes: 15 },
    authenticator: createSoftwarePasskey(randomBytes(32)),
    kernelUrl: KERNEL_URL,
  });
  let t = 1_700_000_000_000;
  const spark = new SparkController({
    setTimer: realTimer,
    spark: { signer: () => null as never, approve: async () => Promise.resolve({}) },
    fetch: async () => Promise.reject(new Error("no fetch")),
    random: (n) => new Uint8Array(n).fill(1),
    now: () => t,
    logger: LOGGER,
    createClient: () => ({ close: () => {} }) as unknown as never,
  });
  const accounts = new AccountTreeController({
    setTimer: realTimer,
    wallet,
    spark,
    sparkNetwork: NETWORK,
    logger: LOGGER,
    now: () => t,
  });
  accounts.setStore(createMemoryEngineStore());
  const relay = opts.relay ?? fakeRelay();
  const addressBook = new AddressBookController({
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    random: (n) => randomBytes(n),
    now: () => t,
    logger: LOGGER,
  });
  const metaSync = new MetaSyncController({
    setTimer: realTimer,
    verifyEvent,
    wallet,
    accounts,
    addressBook,
    nostr: {
      syncSigner: (walletId) => {
        const inner = nostr(wallet).syncSigner(walletId);
        return opts.syncSignerWrap === undefined ? inner : opts.syncSignerWrap(inner);
      },
    },
    metaSync: { tag: TAG, relays: relay },
    logger: LOGGER,
    now: () => t,
  });
  return {
    wallet,
    accounts,
    addressBook,
    metaSync,
    relay,
    setNow: (v: number) => {
      t = v;
    },
  };
}

async function vaultWithMnemonic(wallet: Wallet): Promise<WalletInfo> {
  const draft = await wallet.wallets.createMnemonic({
    words: 12,
    factor: { kind: "password", password: PASSWORD },
  });
  const words = new TextDecoder().decode(draft.words.read()).split(" ");
  return draft.confirm(draft.quiz.map((p) => words[p]!));
}

/** Same mnemonic on a second wallet instance — the shared secret of a "second device". */
async function vaultWithFixedMnemonic(wallet: Wallet): Promise<{
  info: WalletInfo;
  mnemonic: string;
}> {
  const draft = await wallet.wallets.createMnemonic({
    words: 12,
    factor: { kind: "password", password: PASSWORD },
  });
  const words = new TextDecoder().decode(draft.words.read()).split(" ");
  const info = await draft.confirm(draft.quiz.map((p) => words[p]!));
  return { info, mnemonic: words.join(" ") };
}

/** Create + unlock + derive the group-0 key + start both controllers. */
async function start(r: Rig): Promise<WalletInfo> {
  const created = await vaultWithMnemonic(r.wallet);
  await nostr(r.wallet).deriveKey(created.walletId, 0);
  await r.accounts.init();
  await r.addressBook.init();
  await r.metaSync.init();
  return created;
}

async function waitPublished(relay: FakeRelay, count: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(relay.published.length).toBeGreaterThanOrEqual(count);
    },
    { timeout: 15_000, interval: 100 },
  );
}

describe("MetaSyncController", () => {
  it("a wallet with no derived identity still syncs on its dedicated key", async () => {
    const r = await rig();
    const created = await vaultWithMnemonic(r.wallet);
    await r.accounts.init();
    await r.addressBook.init();
    await r.metaSync.init();
    const pubkey = await nostr(r.wallet).syncSigner(created.walletId).getPublicKey();
    // The sync key authors the wallet's doc — it is never a nostr.keys identity.
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(r.relay.fetchCalls).toBeGreaterThan(0);
    const s = r.metaSync.getState().wallets;
    expect(s[created.walletId]?.status).toBe("synced");
    await r.metaSync.destroy();
    await r.accounts.destroy();
    await r.wallet.destroy();
  });

  it("pull with no remote doc then publishes the local tree", async () => {
    const r = await rig();
    const created = await vaultWithMnemonic(r.wallet);
    const identity0 = await nostr(r.wallet).deriveKey(created.walletId, 0);
    await r.accounts.init();
    // An edit stamps updatedAt > 0 — without it a fresh device publishes nothing.
    r.accounts.renameGroup(created.walletId, 0, "local");
    await r.addressBook.init();
    await r.metaSync.init();
    await waitPublished(r.relay, 1);
    expect(r.relay.published).toHaveLength(1);
    const e = r.relay.published[0]!;
    expect(e.kind).toBe(30078);
    expect(e.tags).toStrictEqual([["d", TAG]]);
    const signer = nostr(r.wallet).syncSigner(created.walletId);
    // The author is the wallet's dedicated sync key — distinct from every identity index.
    const syncPub = await signer.getPublicKey();
    expect(e.pubkey).toBe(syncPub);
    expect(e.pubkey).not.toBe(identity0.publicKey);
    const plain = await signer.decrypt(e.content);
    const doc = decodeMetaDocBytes(new TextEncoder().encode(plain));
    expect(doc?.groups[0]?.index).toBe(0);
    expect(r.metaSync.getState().wallets[created.walletId]?.status).toBe("synced");
    await r.metaSync.destroy();
    await r.accounts.destroy();
    await r.wallet.destroy();
  });

  it("forged sig, wrong author and wrong d tag events are all ignored", async () => {
    const r = await rig();
    const created = await vaultWithMnemonic(r.wallet);
    await nostr(r.wallet).deriveKey(created.walletId, 0);
    const signer = nostr(r.wallet).syncSigner(created.walletId);
    const pubkey = await signer.getPublicKey();
    // 1) wrong d tag
    const wrongTag = await signer.signEvent({
      pubkey,
      kind: 30078,
      created_at: 1_700_000_600,
      tags: [["d", "other/tag"]],
      content: "x",
    });
    // 2) wrong author (the same wallet's identity-1 key signs)
    await nostr(r.wallet).deriveKey(created.walletId, 1);
    const signer2 = nostr(r.wallet).signer({
      kind: "derived",
      walletId: created.walletId,
      index: 1,
    });
    const wrongAuthor = await signer2.signEvent({
      pubkey: await signer2.getPublicKey(),
      kind: 30078,
      created_at: 1_700_000_700,
      tags: [["d", TAG]],
      content: "x",
    });
    // 3) forged signature shape
    const forged: Event = {
      id: "0".repeat(64),
      sig: "0".repeat(128),
      pubkey,
      kind: 30078,
      created_at: 1_700_000_800,
      tags: [["d", TAG]],
      content: "x",
    };
    r.relay.events.push(wrongTag, wrongAuthor, forged);
    await r.accounts.init();
    r.accounts.renameGroup(created.walletId, 0, "local");
    await r.addressBook.init();
    await r.metaSync.init();
    await waitPublished(r.relay, 1);
    // All three remote events were rejected; no merge happened — the local name survives.
    expect(r.accounts.getState().groups[created.walletId]?.[0]?.name).toBe("local");
    expect(r.relay.published).toHaveLength(1);
    await r.metaSync.destroy();
    await r.accounts.destroy();
    await r.wallet.destroy();
  });

  it("a failed pull publishes nothing, even after local changes", async () => {
    const r = await rig();
    const created = await vaultWithMnemonic(r.wallet);
    await nostr(r.wallet).deriveKey(created.walletId, 0);
    const base = fakeRelay();
    const broken: FakeRelay = {
      ...base,
      fetch: async () => {
        base.fetchCalls += 1;
        return Promise.reject(new Error("offline"));
      },
    };
    const metaSync = new MetaSyncController({
      setTimer: realTimer,
      verifyEvent,
      wallet: r.wallet,
      accounts: r.accounts,
      addressBook: r.addressBook,
      nostr: { syncSigner: (walletId) => nostr(r.wallet).syncSigner(walletId) },
      metaSync: { tag: TAG, relays: broken },
      logger: LOGGER,
      now: () => Date.now(),
    });
    await r.accounts.init();
    await r.addressBook.init();
    await metaSync.init();
    expect(metaSync.getState().wallets[created.walletId]?.status).toBe("error");
    r.accounts.renameGroup(created.walletId, 0, "changed");
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    expect(broken.published).toHaveLength(0);
    await metaSync.destroy();
    await r.accounts.destroy();
    await r.wallet.destroy();
  });

  it(
    "local edits debounce-publish; created_at stays above the remote event",
    { timeout: 15_000 },
    async () => {
      const r = await rig();
      const created = await vaultWithMnemonic(r.wallet);
      await nostr(r.wallet).deriveKey(created.walletId, 0);
      const signer = nostr(r.wallet).syncSigner(created.walletId);
      const pubkey = await signer.getPublicKey();
      // Seed a remote doc far in the future — created_at must exceed it.
      const remoteDoc = encodeMetaDoc({
        v: 2,
        contacts: [],
        wallet: { name: "remote-name", updatedAt: 1_700_000_000_000 },
        groups: [{ index: 0, name: "remote", hidden: false, updatedAt: 1_700_000_000_000 }],
      });
      const encrypted = await signer.encrypt(new TextDecoder().decode(remoteDoc));
      const remoteEvent = await signer.signEvent({
        pubkey,
        kind: 30078,
        created_at: 1_800_000_000,
        tags: [["d", TAG]],
        content: encrypted,
      });
      r.relay.events.push(remoteEvent);
      await r.accounts.init();
      await r.addressBook.init();
      await r.metaSync.init();
      // Remote doc wins group 0's name (local updatedAt = 0).
      expect(r.accounts.getState().groups[created.walletId]?.[0]?.name).toBe("remote");
      vi.useFakeTimers();
      r.accounts.renameGroup(created.walletId, 0, "mine");
      await waitPublished(r.relay, 1);
      vi.useRealTimers();
      expect(r.relay.published).toHaveLength(1);
      expect(r.relay.published[0]?.created_at).toBeGreaterThan(1_800_000_000);
      await r.metaSync.destroy();
      await r.accounts.destroy();
      await r.wallet.destroy();
    },
  );

  it(
    "two devices converge to the newer values through the relay",
    { timeout: 15_000 },
    async () => {
      const relay = fakeRelay();
      const a = await rig({ relay });
      const b = await rig({ relay });
      const { info: createdA, mnemonic } = await vaultWithFixedMnemonic(a.wallet);
      await nostr(a.wallet).deriveKey(createdA.walletId, 0);
      const createdB = await b.wallet.wallets.importMnemonic({
        mnemonic,
        factor: { kind: "password", password: PASSWORD },
      });
      await nostr(b.wallet).deriveKey(createdB.walletId, 0);
      await a.accounts.init();
      await a.addressBook.init();
      await a.metaSync.init();
      await b.accounts.init();
      await b.addressBook.init();
      await b.metaSync.init();
      a.setNow(1_700_100_000_000);
      b.setNow(1_700_100_000_000);
      // Device A names its group — the only publish (fresh trees carry no edits).
      vi.useFakeTimers();
      a.accounts.renameGroup(createdA.walletId, 0, "from-A");
      await waitPublished(relay, 1);
      // Device B pulls and converges.
      await b.metaSync.sync();
      expect(b.accounts.getState().groups[createdB.walletId]?.[0]?.name).toBe("from-A");
      // Device B names it again with a later timestamp; A converges back.
      b.setNow(1_700_200_000_000);
      b.accounts.renameGroup(createdB.walletId, 0, "from-B");
      await waitPublished(relay, 2);
      await a.metaSync.sync();
      expect(a.accounts.getState().groups[createdA.walletId]?.[0]?.name).toBe("from-B");
      vi.useRealTimers();
      await a.metaSync.destroy();
      await b.metaSync.destroy();
      await a.accounts.destroy();
      await b.accounts.destroy();
      await a.wallet.destroy();
      await b.wallet.destroy();
    },
  );

  it("a verified-but-undecryptable remote sets corrupt and never publishes", async () => {
    const r = await rig();
    const created = await vaultWithMnemonic(r.wallet);
    await nostr(r.wallet).deriveKey(created.walletId, 0);
    const signer = nostr(r.wallet).syncSigner(created.walletId);
    const pubkey = await signer.getPublicKey();
    // Verified event, correct author/kind/d — and it decrypts fine — but the plaintext is not a
    // meta doc: that is the corrupt-data path (a decrypt that THREW would be a sync failure).
    const garbage = await signer.encrypt("not-a-meta-doc");
    r.relay.events.push(
      await signer.signEvent({
        pubkey,
        kind: 30078,
        created_at: 1_700_000_500,
        tags: [["d", TAG]],
        content: garbage,
      }),
    );
    await r.accounts.init();
    await r.addressBook.init();
    await r.metaSync.init();
    expect(r.metaSync.getState().wallets[created.walletId]?.status).toBe("error");
    expect(r.metaSync.getState().wallets[created.walletId]?.error).toBe("corrupt");
    // Local edits still do not publish — the wallet never entered `pulled`.
    r.accounts.renameGroup(created.walletId, 0, "local");
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    expect(r.relay.published).toHaveLength(0);
    await r.metaSync.destroy();
    await r.accounts.destroy();
    await r.wallet.destroy();
  });

  it("a transient decrypt failure is a sync error, not corrupt, and recovers", async () => {
    // `impl` is the decrypt the wrapper delegates to — it survives across syncSigner calls, so a
    // transient failure can be armed and then healed without a conditional inside the test.
    let impl: WalletSyncSigner["decrypt"] = async () =>
      Promise.reject(new Error("syncDecrypt blew up (transient)"));
    let innerDecrypt: WalletSyncSigner["decrypt"] = async () =>
      Promise.reject(new Error("signer not armed"));
    const r = await rig({
      syncSignerWrap: (inner): WalletSyncSigner => {
        innerDecrypt = inner.decrypt.bind(inner);
        return {
          getPublicKey: async () => inner.getPublicKey(),
          signEvent: async (e) => inner.signEvent(e),
          encrypt: async (text) => inner.encrypt(text),
          decrypt: async (payload) => impl(payload),
        };
      },
    });
    const created = await vaultWithMnemonic(r.wallet);
    const signer = nostr(r.wallet).syncSigner(created.walletId);
    const pubkey = await signer.getPublicKey();
    // A perfectly good remote doc — the signer just cannot decrypt it while the failure is armed.
    const good = await signer.signEvent({
      pubkey,
      kind: 30078,
      created_at: 1_700_000_500,
      tags: [["d", TAG]],
      content: await signer.encrypt(
        JSON.stringify({ v: 2, wallet: { updatedAt: 5 }, groups: [], contacts: [] }),
      ),
    });
    r.relay.events.push(good);
    await r.accounts.init();
    await r.addressBook.init();
    await r.metaSync.init();
    // The thrown decrypt is a sync failure (`network`), not a corrupt doc — and the wallet can
    // recover instead of latching `corrupt`.
    expect(r.metaSync.getState().wallets[created.walletId]?.status).toBe("error");
    expect(r.metaSync.getState().wallets[created.walletId]?.error).toBe("network");
    expect(r.metaSync.getState().wallets[created.walletId]?.error).not.toBe("corrupt");
    impl = async (payload) => innerDecrypt(payload);
    await r.metaSync.sync();
    expect(r.metaSync.getState().wallets[created.walletId]?.status).toBe("synced");
    await r.metaSync.destroy();
    await r.accounts.destroy();
    await r.wallet.destroy();
  });

  it("a v: 3 doc sets unsupported and never publishes", async () => {
    const r = await rig();
    const created = await vaultWithMnemonic(r.wallet);
    await nostr(r.wallet).deriveKey(created.walletId, 0);
    const signer = nostr(r.wallet).syncSigner(created.walletId);
    const pubkey = await signer.getPublicKey();
    const encrypted = await signer.encrypt(
      JSON.stringify({ v: 3, wallet: { updatedAt: 5 }, groups: [], contacts: [] }),
    );
    r.relay.events.push(
      await signer.signEvent({
        pubkey,
        kind: 30078,
        created_at: 1_700_000_500,
        tags: [["d", TAG]],
        content: encrypted,
      }),
    );
    await r.accounts.init();
    await r.addressBook.init();
    await r.metaSync.init();
    expect(r.metaSync.getState().wallets[created.walletId]?.error).toBe("unsupported");
    r.accounts.renameGroup(created.walletId, 0, "local");
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    expect(r.relay.published).toHaveLength(0);
    await r.metaSync.destroy();
    await r.accounts.destroy();
    await r.wallet.destroy();
  });

  it(
    "an empty relay on a fresh device syncs without publishing until a real edit",
    { timeout: 15_000 },
    async () => {
      const r = await rig();
      const created = await start(r);
      expect(r.metaSync.getState().wallets[created.walletId]?.status).toBe("synced");
      expect(r.relay.published).toHaveLength(0);
      vi.useFakeTimers();
      r.accounts.renameGroup(created.walletId, 0, "now-real");
      await waitPublished(r.relay, 1);
      vi.useRealTimers();
      expect(r.relay.published).toHaveLength(1);
      await r.metaSync.destroy();
      await r.accounts.destroy();
      await r.wallet.destroy();
    },
  );

  it(
    "lock cancels the debounce — a post-lock edit never publishes",
    { timeout: 15_000 },
    async () => {
      const r = await rig();
      const created = await start(r);
      vi.useFakeTimers();
      r.accounts.renameGroup(created.walletId, 0, "before-lock");
      await waitPublished(r.relay, 1);
      await r.metaSync.lock();
      r.accounts.renameGroup(created.walletId, 0, "after-lock");
      await vi.advanceTimersByTimeAsync(3000);
      vi.useRealTimers();
      expect(r.relay.published).toHaveLength(1);
      await r.accounts.destroy();
      await r.wallet.destroy();
    },
  );

  describe("address book sync", () => {
    const EVM_A = "0x52908400098527886E0F7030069857D2E4169EE7";

    /** Pulls on `device` until `check` holds — publishes are debounced and signed asynchronously. */
    async function syncUntil(device: Rig, check: () => boolean): Promise<void> {
      await vi.waitFor(
        async () => {
          await device.metaSync.sync();
          expect(check()).toBe(true);
        },
        { timeout: 15_000, interval: 200 },
      );
    }

    /** Two devices sharing one wallet and one relay, both started and pulled. */
    async function twoDevices() {
      const relay = fakeRelay();
      const a = await rig({ relay });
      const b = await rig({ relay });
      const { info: createdA, mnemonic } = await vaultWithFixedMnemonic(a.wallet);
      await nostr(a.wallet).deriveKey(createdA.walletId, 0);
      const createdB = await b.wallet.wallets.importMnemonic({
        mnemonic,
        factor: { kind: "password", password: PASSWORD },
      });
      await nostr(b.wallet).deriveKey(createdB.walletId, 0);
      await Promise.all(
        [a, b].map(async (device) => {
          await device.accounts.init();
          await device.addressBook.init();
          await device.metaSync.init();
          device.setNow(1_700_100_000_000);
        }),
      );
      const stop = async () => {
        await Promise.all(
          [a, b].map(async (device) => {
            await device.metaSync.destroy();
            await device.accounts.destroy();
            await device.wallet.destroy();
          }),
        );
      };
      return { relay, a, b, stop };
    }

    it(
      "an entry added and renamed on A reaches B; a delete on A removes it on B",
      { timeout: 20_000 },
      async () => {
        const { a, b, stop } = await twoDevices();
        vi.useFakeTimers();
        const added = await a.addressBook.add({
          name: "Alice",
          family: "evm",
          address: EVM_A,
          note: "friend",
        });
        await syncUntil(b, () => b.addressBook.getState().entries[added.id] !== undefined);
        expect(b.addressBook.getState().entries[added.id]).toStrictEqual(added);

        a.setNow(1_700_200_000_000);
        await a.addressBook.rename(added.id, "Alice B");
        await syncUntil(b, () => b.addressBook.getState().entries[added.id]?.name === "Alice B");

        a.setNow(1_700_300_000_000);
        await a.addressBook.remove(added.id);
        await syncUntil(b, () => b.addressBook.getState().entries[added.id] === undefined);
        expect(b.addressBook.getState().entries).toStrictEqual({});
        expect(b.addressBook.syncEntries()).toMatchObject([{ id: added.id, deleted: true }]);
        vi.useRealTimers();
        await stop();
      },
    );

    it(
      "concurrent edits of one entry converge to the same deterministic result",
      { timeout: 25_000 },
      async () => {
        const { relay, a, b, stop } = await twoDevices();
        vi.useFakeTimers();
        const added = await a.addressBook.add({ name: "Alice", family: "evm", address: EVM_A });
        await syncUntil(b, () => b.addressBook.getState().entries[added.id] !== undefined);

        a.setNow(1_700_400_000_000);
        b.setNow(1_700_400_000_000);
        await a.addressBook.rename(added.id, "alpha");
        await b.addressBook.rename(added.id, "beta");
        await syncUntil(a, () => relay.published.length >= 3);
        await b.metaSync.sync();
        await a.metaSync.sync();
        await b.metaSync.sync();
        const nameA = a.addressBook.getState().entries[added.id]?.name;
        const nameB = b.addressBook.getState().entries[added.id]?.name;
        expect(nameA).toBe(nameB);
        expect(nameA).toBe("beta");
        vi.useRealTimers();
        await stop();
      },
    );
  });
});
