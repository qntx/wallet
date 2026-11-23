/**
 * Display-time spam rules for NFT inventory. The gateway's own spam flag is one signal; the rest
 * are computed from what the wallet itself knows: whether the user ever touched the item, whether
 * it appeared out of nowhere (an airdrop), whether its collection masquerades as a trusted one, and
 * whether its name phishes. Reasons come out in the type's fixed order so the same item always
 * flags the same way.
 */
import { hasLinkInText } from "../assets/spam.ts";
import type { HistoryEntry } from "../history/types.ts";
import type { TrackedTransaction } from "../transactions/route.ts";
import type { NftItemFacts } from "./metadata.ts";

export type NftSpamReason = "gateway" | "airdrop" | "lookalike" | "link-in-name" | "deceptive-text";

/** How the item got into the wallet, as far as its own activity can tell. */
export type NftAcquisition = "airdrop" | "interacted" | "unknown";

/** Asset text equality: EVM addresses compare lowercase, everything else exactly. */
const sameAsset = (network: string, a: string, b: string): boolean =>
  network.startsWith("eip155:") ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * How the wallet acquired the item: `interacted` when its own activity shows the item leaving or
 * being approved or any chain-verified outgoing touch, `airdrop` when a verified incoming entry is
 * the only evidence, `unknown` otherwise. The user can fake none of these — they come from the
 * wallet's own history and tracked sends.
 */
export function nftAcquisition(
  network: string,
  contract: string,
  tokenId: string | undefined,
  entries: ReadonlyArray<HistoryEntry>,
  txs: ReadonlyArray<TrackedTransaction>,
): NftAcquisition {
  const same = (asset: string): boolean => sameAsset(network, asset, contract);

  for (const tx of txs) {
    if (tx.network !== network || tx.state === "rejected" || tx.intent === undefined) {
      continue;
    }
    const named =
      tx.intent.outflows.some((flow) => same(flow.amount.asset)) ||
      tx.intent.approvals.some((approval) => {
        if (approval.kind === "operator") {
          return same(approval.asset);
        }
        return approval.kind === "allowance" && same(approval.amount.asset);
      });
    if (named) {
      return "interacted";
    }
  }

  let airdrop = false;
  for (const entry of entries) {
    if (entry.network !== network || !entry.changes.some((change) => same(change.asset))) {
      continue;
    }
    if (entry.direction !== "in" || entry.localTxId !== undefined) {
      return "interacted";
    }
    if (
      entry.verified &&
      entry.fee === undefined &&
      entry.changes.some(
        (change) =>
          change.direction === "in" &&
          same(change.asset) &&
          (tokenId === undefined || change.tokenId === tokenId),
      )
    ) {
      airdrop = true;
    }
  }
  return airdrop ? "airdrop" : "unknown";
}

/**
 * Single-letter confusables across scripts, from
 * https://www.unicode.org/Public/security/latest/confusables.txt — the look a scam collection
 * copies when it spells a real name in Cyrillic or Greek.
 */
const SKELETON_MAP: ReadonlyMap<string, string> = new Map([
  // Cyrillic.
  ["а", "a"],
  ["в", "b"],
  ["е", "e"],
  ["к", "k"],
  ["м", "m"],
  ["н", "h"],
  ["о", "o"],
  ["р", "p"],
  ["с", "c"],
  ["т", "t"],
  ["у", "y"],
  ["х", "x"],
  ["і", "i"],
  ["ј", "j"],
  ["ѕ", "s"],
  ["ԁ", "d"],
  ["ӏ", "l"],
  // Greek.
  ["α", "a"],
  ["β", "b"],
  ["ε", "e"],
  ["ι", "i"],
  ["κ", "k"],
  ["ν", "v"],
  ["ο", "o"],
  ["ρ", "p"],
  ["τ", "t"],
  ["υ", "u"],
  ["χ", "x"],
  // Digit lookalikes.
  ["0", "o"],
  ["1", "l"],
]);

/**
 * The shape a collection name resolves to for lookalike matching: accent-free, lowercase,
 * confusables folded to latin, anything but `[a-z0-9]` dropped. `undefined` when nothing meaningful
 * remains — a name too short to impersonate with.
 */
export function collectionSkeleton(name: string): string | undefined {
  const folded = name.normalize("NFKD").replaceAll(/\p{M}/gu, "").toLowerCase();
  let skeleton = "";
  for (const char of folded) {
    skeleton += SKELETON_MAP.get(char) ?? char;
  }
  const clean = skeleton.replaceAll(/[^a-z0-9]/g, "");
  return clean.length < 3 ? undefined : clean;
}

/** The skeleton one collection group claims, from the first item whose name produces one. */
const groupSkeleton = (group: ReadonlyArray<NftItemFacts>): string | undefined => {
  for (const item of group) {
    if (item.collection?.name !== undefined) {
      const skeleton = collectionSkeleton(item.collection.name);
      if (skeleton !== undefined) {
        return skeleton;
      }
    }
  }
  return undefined;
};

/**
 * The spam reasons of every item in `items`, keyed by item id, in the type's fixed order. A
 * collection counts as trusted when any of its items is verified, was interacted with, or the user
 * pinned it visible — only then can it be the reference a lookalike imitates.
 */
export function nftSpam(
  items: ReadonlyArray<NftItemFacts>,
  context: {
    readonly acquisition: (item: NftItemFacts) => NftAcquisition;
    readonly shown: (item: NftItemFacts) => boolean;
  },
): ReadonlyMap<string, ReadonlyArray<NftSpamReason>> {
  const acquisitions = new Map<string, NftAcquisition>();
  for (const item of items) {
    if (!acquisitions.has(item.id)) {
      acquisitions.set(item.id, context.acquisition(item));
    }
  }

  const groups = new Map<string, NftItemFacts[]>();
  for (const item of items) {
    const key = item.collection?.id ?? item.contract;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const trusted = new Map<string, boolean>();
  for (const [key, group] of groups) {
    trusted.set(
      key,
      group.some(
        (item) =>
          item.collection?.verified === true ||
          acquisitions.get(item.id) === "interacted" ||
          context.shown(item),
      ),
    );
  }

  const trustedSkeletons = new Set<string>();
  for (const [key, group] of groups) {
    if (trusted.get(key) === true) {
      const skeleton = groupSkeleton(group);
      if (skeleton !== undefined) {
        trustedSkeletons.add(skeleton);
      }
    }
  }

  const out = new Map<string, ReadonlyArray<NftSpamReason>>();
  for (const item of items) {
    const reasons: NftSpamReason[] = [];
    if (item.gatewaySpam) {
      reasons.push("gateway");
    }
    if (acquisitions.get(item.id) === "airdrop") {
      reasons.push("airdrop");
    }
    const key = item.collection?.id ?? item.contract;
    if (trusted.get(key) !== true) {
      const skeleton = groupSkeleton(groups.get(key) ?? []);
      if (skeleton !== undefined && trustedSkeletons.has(skeleton)) {
        reasons.push("lookalike");
      }
    }
    if (
      (item.name !== undefined && hasLinkInText(item.name)) ||
      (item.collection?.name !== undefined && hasLinkInText(item.collection.name))
    ) {
      reasons.push("link-in-name");
    }
    if (item.deceptive) {
      reasons.push("deceptive-text");
    }
    out.set(item.id, reasons);
  }
  return out;
}
