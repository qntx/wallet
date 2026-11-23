import { describe, expect, it } from "vite-plus/test";

import type { HistoryEntry } from "../src/history/types.ts";
import type { NftItemFacts } from "../src/nfts/metadata.ts";
import { collectionSkeleton, nftAcquisition, nftSpam } from "../src/nfts/spam.ts";
import type { TrackedTransaction, DisplayIntent } from "../src/transactions/route.ts";

const NETWORK = "eip155:1";
const CONTRACT = `0x${"ab".repeat(20)}`;

const facts = (over: Partial<NftItemFacts> = {}): NftItemFacts => ({
  id: `${CONTRACT}:7`,
  network: NETWORK,
  contract: CONTRACT,
  tokenId: "7",
  standard: "erc721",
  balance: "1",
  gatewaySpam: false,
  deceptive: false,
  transfer: "supported",
  ...over,
});

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: `${NETWORK}:0xhash`,
  family: "evm",
  network: NETWORK,
  hash: "0xhash",
  direction: "in",
  counterparties: [],
  changes: [],
  status: "confirmed",
  verified: false,
  origin: "chain",
  flags: [],
  ...over,
});

const intent = (over: Partial<DisplayIntent> = {}): DisplayIntent =>
  ({
    family: "evm",
    network: NETWORK,
    summary: "contract-call",
    outflows: [],
    approvals: [],
    ...over,
  }) as unknown as DisplayIntent;

const tx = (over: Partial<TrackedTransaction> = {}): TrackedTransaction =>
  ({
    id: "tx1",
    family: "evm",
    network: NETWORK,
    account: "w",
    hash: "0xhash",
    state: "confirmed",
    nonce: 0,
    ...over,
  }) as TrackedTransaction;

const inChange = (tokenId?: string): HistoryEntry["changes"][number] => ({
  direction: "in",
  asset: CONTRACT,
  amount: "1",
  ...(tokenId === undefined ? {} : { tokenId }),
  listed: false,
});

const airdropEntry = (tokenId?: string): HistoryEntry =>
  entry({ direction: "in", verified: true, changes: [inChange(tokenId)] });

const acquire = (
  tokenId: string | undefined,
  entries: ReadonlyArray<HistoryEntry>,
  txs: ReadonlyArray<TrackedTransaction>,
) => nftAcquisition(NETWORK, CONTRACT, tokenId, entries, txs);

describe("nftAcquisition", () => {
  it("answers interacted when an entry moved the contract out", () => {
    const bought = entry({ direction: "mixed", verified: true, changes: [inChange("7")] });
    expect(acquire("7", [bought], [])).toBe("interacted");
  });

  it("answers interacted when the wallet sent a tx naming the contract", () => {
    const sent = tx({
      state: "submitted",
      intent: intent({
        outflows: [
          {
            to: `0x${"cd".repeat(20)}`,
            amount: { asset: CONTRACT, amount: "1", tokenId: "7" },
            verified: false,
          },
        ],
      }),
    });
    expect(acquire("7", [], [sent])).toBe("interacted");
  });

  it("answers interacted when the wallet approved an operator for the contract", () => {
    const approved = tx({
      intent: intent({
        approvals: [
          {
            kind: "operator",
            asset: CONTRACT,
            spender: `0x${"cd".repeat(20)}`,
            approved: true,
            verified: false,
          },
        ],
      }),
    });
    expect(acquire("7", [], [approved])).toBe("interacted");
  });

  it("ignores a rejected tx", () => {
    const rejected = tx({
      state: "rejected",
      intent: intent({
        outflows: [
          { to: `0x${"cd".repeat(20)}`, amount: { asset: CONTRACT, amount: "1" }, verified: false },
        ],
      }),
    });
    expect(acquire("7", [], [rejected])).toBe("unknown");
  });

  it("answers interacted when the entry carries a local tx id", () => {
    const sent = entry({
      direction: "in",
      verified: true,
      localTxId: "tx-local",
      changes: [inChange("7")],
    });
    expect(acquire("7", [sent], [])).toBe("interacted");
  });

  it("answers airdrop for a verified inbound entry with no fee and no local tx", () => {
    expect(acquire("7", [airdropEntry("7")], [])).toBe("airdrop");
  });

  it("does not call an entry with a fee an airdrop", () => {
    const paid = entry({
      direction: "in",
      verified: true,
      fee: "21000000000000",
      changes: [inChange("7")],
    });
    expect(acquire("7", [paid], [])).toBe("unknown");
  });

  it("does not call an unverified entry an airdrop", () => {
    const unverified = entry({ direction: "in", verified: false, changes: [inChange("7")] });
    expect(acquire("7", [unverified], [])).toBe("unknown");
  });

  it("does not call a different token id an airdrop", () => {
    expect(acquire("9", [airdropEntry("7")], [])).toBe("unknown");
  });

  it("matches EVM contracts case-insensitively", () => {
    const upper = entry({
      direction: "mixed",
      changes: [{ ...inChange("7"), asset: CONTRACT.toUpperCase().replace("0X", "0x") }],
    });
    expect(acquire("7", [upper], [])).toBe("interacted");
  });
});

/** An acquisition callback driven by an id → acquisition table. */
const byId =
  (table: ReadonlyArray<readonly [string, "airdrop" | "interacted" | "unknown"]>) =>
  (item: NftItemFacts): "airdrop" | "interacted" | "unknown" =>
    table.find(([id]) => id === item.id)?.[1] ?? "unknown";

describe("nftSpam", () => {
  const spamOf = (
    items: ReadonlyArray<NftItemFacts>,
    acquisition: (item: NftItemFacts) => "airdrop" | "interacted" | "unknown" = () => "unknown",
    shown: (item: NftItemFacts) => boolean = () => false,
  ) => nftSpam(items, { acquisition, shown });

  it("flags gateway spam, airdrop and deceptive text in the type's fixed order", () => {
    const item = facts({ gatewaySpam: true, deceptive: true, name: "x" });
    const map = spamOf([item], () => "airdrop");
    expect(map.get(item.id)).toStrictEqual(["gateway", "airdrop", "deceptive-text"]);
  });

  it("flags a link in the item or collection name", () => {
    const item = facts({ name: "claim now at scam.xyz" });
    const coll = facts({
      id: `${CONTRACT}:8`,
      tokenId: "8",
      collection: { name: "visit evil.com now", verified: false },
    });
    const map = spamOf([item, coll]);
    expect(map.get(item.id)).toStrictEqual(["link-in-name"]);
    expect(map.get(coll.id)).toStrictEqual(["link-in-name"]);
  });

  it("flags an untrusted collection imitating a verified one", () => {
    const real = facts({
      collection: { id: "0xreal", name: "Azuki", verified: true },
    });
    const fake = facts({
      id: "0xfake:1",
      contract: "0xfake",
      collection: { id: "0xfake", name: "Аzuki", verified: false },
    });
    const map = spamOf([real, fake]);
    expect(map.get(fake.id)).toStrictEqual(["lookalike"]);
    expect(map.get(real.id)).toStrictEqual([]);
  });

  it("flags nothing when no trusted collection shares the name", () => {
    const fakeA = facts({ collection: { id: "0xa", name: "Аzuki", verified: false } });
    const fakeB = facts({
      id: "0xb:1",
      contract: "0xb",
      collection: { id: "0xb", name: "Azuki", verified: false },
    });
    const map = spamOf([fakeA, fakeB]);
    expect(map.get(fakeA.id)).toStrictEqual([]);
    expect(map.get(fakeB.id)).toStrictEqual([]);
  });

  it("trusts a collection an interacted item belongs to", () => {
    const touched = facts({ collection: { id: "0xa", name: "Azuki", verified: false } });
    const fake = facts({
      id: "0xb:1",
      contract: "0xb",
      collection: { id: "0xb", name: "Аzuki", verified: false },
    });
    const map = spamOf([touched, fake], byId([[touched.id, "interacted"]]));
    expect(map.get(fake.id)).toStrictEqual(["lookalike"]);
  });

  it("trusts a collection the user pinned visible", () => {
    const pinned = facts({ collection: { id: "0xa", name: "Azuki", verified: false } });
    const fake = facts({
      id: "0xb:1",
      contract: "0xb",
      collection: { id: "0xb", name: "Аzuki", verified: false },
    });
    const map = spamOf(
      [pinned, fake],
      () => "unknown",
      (item) => item.id === pinned.id,
    );
    expect(map.get(fake.id)).toStrictEqual(["lookalike"]);
  });

  it("keeps every reason for an item that earns them all", () => {
    const real = facts({
      id: "0xreal:1",
      contract: "0xreal",
      collection: { id: "0xreal", name: "Azuki", verified: true },
    });
    const bad = facts({
      name: "mint at scam.xyz",
      gatewaySpam: true,
      deceptive: true,
      collection: { id: "0xfake", name: "Аzuki", verified: false },
    });
    const map = spamOf([real, bad], byId([[bad.id, "airdrop"]]));
    expect(map.get(bad.id)).toStrictEqual([
      "gateway",
      "airdrop",
      "lookalike",
      "link-in-name",
      "deceptive-text",
    ]);
  });
});

describe("collectionSkeleton", () => {
  it("folds case, accents and confusable scripts", () => {
    expect(collectionSkeleton("Azuki")).toBe("azuki");
    expect(collectionSkeleton("Аzuki")).toBe("azuki");
    expect(collectionSkeleton("AZUKI-Elementals #1")).toBe("azukielementalsl");
  });

  it("answers undefined for a name too short to impersonate with", () => {
    expect(collectionSkeleton("ab")).toBeUndefined();
    expect(collectionSkeleton("#!")).toBeUndefined();
  });

  it("folds a plain latin name", () => {
    expect(collectionSkeleton("Bored Ape")).toBe("boredape");
  });
});
