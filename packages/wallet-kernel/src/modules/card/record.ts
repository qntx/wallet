/**
 * The `card-wallet` record (id = `walletId`): the vault's half of a card wallet — no secret is ever
 * stored, the seed lives only on the cards. The public header (manifest-authenticated) carries
 * members, per-card state and pinned certificates; the sealed body is UTF-8 JSON with the public
 * material a verified tap fetched (master key, cached nodes, recent ephemeral tags, saved access
 * hashes). Encoders emit canonical JSON — fixed key order, sorted inner maps — so vectors are
 * byte-exact; parsers are strict and every failure is `integrity`.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { CardWalletInfo } from "@qntx/wallet/types";

import { parsePinnedEd25519, parsePinnedNodes, pathToString } from "../../derive/pinned.ts";
import type { Pin, PinnedKeys } from "../../derive/pinned.ts";
import { walletIdOf } from "../../derive/wallet-id.ts";
import { KernelError } from "../../errors.ts";
import {
  asCreatedAt,
  asWalletId,
  expectKeys,
  headerFailure,
  headerObject,
} from "../../vault/header-codec.ts";
import type { VaultImage } from "../../vault/store.ts";
import { CARD_WALLET_KIND } from "../../vault/store.ts";
import { cardId, shortId } from "./protocol/identity.ts";

export { CARD_WALLET_KIND } from "../../vault/store.ts";

const CARD_ID = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
export type CardWalletCard = {
  readonly cardId: string; // ∈ members
  /** 97-byte certificate, pinned once this kernel has seen the card (194 hex). */
  readonly cert?: string;
  /** `pending` never finished IMPORT; `unknown` this kernel has not checked the card. */
  readonly state: "ready" | "unknown" | "pending";
  readonly tries?: number; // 0..10
  readonly verifiedAt?: number;
};

export type CardWalletHeader = {
  readonly v: 1; // card protocol version
  readonly walletId: string; // 16 hex — the record id
  readonly origin: "generated" | "imported";
  readonly createdAt: number;
  /** 1..3 `ID(A)` values, in the order the card reports them. */
  readonly members: ReadonlyArray<string>;
  readonly cards: ReadonlyArray<CardWalletCard>;
};

/** A cached secp256k1 node: compressed public key + 32-byte chain code (+ pinned parent fp). */
export type CardWalletNode = {
  readonly key: string;
  readonly chainCode: string;
  readonly parent?: string;
};

export type CardWalletBody = {
  /** Compressed master public key (66 hex); `walletIdOf(master)` must equal the record id. */
  readonly master: string;
  /** Secp256k1 nodes by `m/…` path (≤ 512). */
  readonly nodes: Readonly<Record<string, CardWalletNode>>;
  /** SLIP-10 `m/…` path → RFC 8032 public key (≤ 256). */
  readonly ed25519: Readonly<Record<string, string>>;
  /** CardId → the ≤ 16 most recent 8-byte ephemeral tags seen from it (16 hex each). */
  readonly ephemerals: Readonly<Record<string, ReadonlyArray<string>>>;
  /** CardId → the access hash remembered for it (64 hex), when the owner opted in. */
  readonly access?: Readonly<Record<string, string>>;
};

const bodyFailure = (): KernelError => new KernelError("integrity", "invalid card-wallet body");

const bodyObject = (text: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw bodyFailure();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw bodyFailure();
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a non-array object
  return value as Record<string, unknown>;
};

const expectBodyKeys = (object: Record<string, unknown>, keys: ReadonlyArray<string>): void => {
  const actual = Object.keys(object);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(object, key))) {
    throw bodyFailure();
  }
};

const asHex = (value: unknown, pattern: RegExp): string => {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw bodyFailure();
  }
  return value;
};

const asSecpPoint = (hex: string): void => {
  try {
    secp256k1.Point.fromBytes(hexToBytes(hex));
  } catch {
    throw bodyFailure();
  }
};

const asInt = (value: unknown, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw headerFailure();
  }
  return value;
};

const parseCard = (value: unknown, members: ReadonlySet<string>): CardWalletCard => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw headerFailure();
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a non-array object
  const object = value as Record<string, unknown>;
  const optional = ["cert", "tries", "verifiedAt"].filter((key) => Object.hasOwn(object, key));
  expectKeys(object, ["cardId", "state", ...optional]);
  const id = object["cardId"];
  if (typeof id !== "string" || !CARD_ID.test(id) || !members.has(id)) {
    throw headerFailure();
  }
  const { state } = object;
  if (state !== "ready" && state !== "unknown" && state !== "pending") {
    throw headerFailure();
  }
  let cert: string | undefined;
  if (Object.hasOwn(object, "cert")) {
    const raw = object["cert"];
    if (typeof raw !== "string" || !/^[0-9a-f]{194}$/.test(raw)) {
      throw headerFailure();
    }
    // The pinned certificate must attest the card it is listed for.
    if (bytesToHex(cardId(hexToBytes(raw).subarray(0, 33))) !== id) {
      throw headerFailure();
    }
    cert = raw;
  }
  return {
    cardId: id,
    ...(cert === undefined ? {} : { cert }),
    state,
    ...(Object.hasOwn(object, "tries") ? { tries: asInt(object["tries"], 0, 10) } : {}),
    ...(Object.hasOwn(object, "verifiedAt")
      ? { verifiedAt: asCreatedAt(object["verifiedAt"]) }
      : {}),
  };
};

export function parseCardWalletHeader(text: string): CardWalletHeader {
  const object = headerObject(text);
  expectKeys(object, ["v", "walletId", "origin", "createdAt", "members", "cards"]);
  if (object["v"] !== 1) {
    throw headerFailure();
  }
  const { origin } = object;
  if (origin !== "generated" && origin !== "imported") {
    throw headerFailure();
  }
  const membersValue = object["members"];
  if (!Array.isArray(membersValue) || membersValue.length === 0 || membersValue.length > 3) {
    throw headerFailure();
  }
  const members = membersValue.map((member) => {
    if (typeof member !== "string" || !CARD_ID.test(member)) {
      throw headerFailure();
    }
    return member;
  });
  if (new Set(members).size !== members.length) {
    throw headerFailure();
  }
  const memberSet = new Set(members);
  const cardsValue = object["cards"];
  if (!Array.isArray(cardsValue)) {
    throw headerFailure();
  }
  const cards = cardsValue.map((card) => parseCard(card, memberSet));
  if (new Set(cards.map((card) => card.cardId)).size !== cards.length) {
    throw headerFailure();
  }
  return {
    v: 1,
    walletId: asWalletId(object["walletId"]),
    origin,
    createdAt: asCreatedAt(object["createdAt"]),
    members,
    cards,
  };
}

export function encodeCardWalletHeader(header: CardWalletHeader): string {
  return JSON.stringify({
    v: header.v,
    walletId: header.walletId,
    origin: header.origin,
    createdAt: header.createdAt,
    members: header.members,
    cards: header.cards.map((card) => ({
      cardId: card.cardId,
      ...(card.cert === undefined ? {} : { cert: card.cert }),
      state: card.state,
      ...(card.tries === undefined ? {} : { tries: card.tries }),
      ...(card.verifiedAt === undefined ? {} : { verifiedAt: card.verifiedAt }),
    })),
  });
}

const parseHexRecord = (
  value: unknown,
  entry: (key: string, value: unknown) => void,
): Record<string, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw bodyFailure();
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    entry(key, item);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- entry() checked the shape
    out[key] = item as string;
  }
  return out;
};

/**
 * Parses and verifies a sealed body: the master key is a point deriving `walletId`, every node a
 * point with a 32-byte chain code under a depth-1..10 path, every ed25519 entry a valid encoding,
 * counts bounded. `walletId` is the record id the body was sealed under.
 */
export function parseCardWalletBody(text: string, walletId: string): CardWalletBody {
  const object = bodyObject(text);
  const flagged = Object.hasOwn(object, "access");
  expectBodyKeys(
    object,
    flagged
      ? ["master", "nodes", "ed25519", "ephemerals", "access"]
      : ["master", "nodes", "ed25519", "ephemerals"],
  );
  const master = asHex(object["master"], /^[0-9a-f]{66}$/);
  asSecpPoint(master);
  if (walletIdOf(hexToBytes(master)) !== walletId) {
    throw new KernelError("integrity", "card-wallet master does not derive its walletId");
  }
  const nodes: Record<string, CardWalletNode> = {};
  for (const node of parsePinnedNodes(object["nodes"])) {
    nodes[pathToString(node.path)] = {
      key: bytesToHex(node.publicKey),
      chainCode: bytesToHex(node.chainCode),
      ...(node.parent === undefined ? {} : { parent: bytesToHex(node.parent) }),
    };
  }
  const ed25519Entries: Record<string, string> = {};
  for (const key of parsePinnedEd25519(object["ed25519"])) {
    ed25519Entries[pathToString(key.path)] = bytesToHex(key.publicKey);
  }
  const ephemeralsValue = object["ephemerals"];
  if (
    typeof ephemeralsValue !== "object" ||
    ephemeralsValue === null ||
    Array.isArray(ephemeralsValue)
  ) {
    throw bodyFailure();
  }
  const ephemerals: Record<string, ReadonlyArray<string>> = {};
  for (const [id, tags] of Object.entries(ephemeralsValue)) {
    if (!CARD_ID.test(id) || !Array.isArray(tags) || tags.length > 16) {
      throw bodyFailure();
    }
    ephemerals[id] = tags.map((tag) => asHex(tag, /^[0-9a-f]{16}$/));
  }
  let access: Record<string, string> | undefined;
  if (flagged) {
    access = parseHexRecord(object["access"], (id, hash) => {
      if (!CARD_ID.test(id)) {
        throw bodyFailure();
      }
      asHex(hash, HEX64);
    });
  }
  return {
    master,
    nodes,
    ed25519: ed25519Entries,
    ephemerals,
    ...(access === undefined ? {} : { access }),
  };
}

const sortedEntries = <T>(record: Readonly<Record<string, T>>): Array<[string, T]> =>
  Object.entries(record).sort(([a], [b]) => a.localeCompare(b));

export function encodeCardWalletBody(body: CardWalletBody): string {
  return JSON.stringify({
    master: body.master,
    nodes: Object.fromEntries(
      sortedEntries(body.nodes).map(([path, node]) => [
        path,
        {
          key: node.key,
          chainCode: node.chainCode,
          ...(node.parent === undefined ? {} : { parent: node.parent }),
        },
      ]),
    ),
    ed25519: Object.fromEntries(sortedEntries(body.ed25519)),
    ephemerals: Object.fromEntries(sortedEntries(body.ephemerals)),
    ...(body.access === undefined
      ? {}
      : { access: Object.fromEntries(sortedEntries(body.access)) }),
  });
}

/** The `CardWalletInfo` a `card-wallet` header contributes to `wallets` in status. */
export function cardWalletInfo(header: CardWalletHeader): CardWalletInfo {
  return {
    custody: "card",
    walletId: header.walletId,
    origin: header.origin === "generated" ? "card-generated" : "card-imported",
    backup: "cards",
    createdAt: header.createdAt,
    members: header.members.length,
    cards: header.cards.map((card) => ({
      cardId: card.cardId,
      ...(card.cert === undefined
        ? {}
        : { shortId: shortId(hexToBytes(card.cert).subarray(0, 33)) }),
      state: card.state,
      ...(card.tries === undefined ? {} : { tries: card.tries }),
      ...(card.verifiedAt === undefined ? {} : { verifiedAt: card.verifiedAt }),
    })),
  };
}

/** Whether `walletId` names a `card-wallet` record — the caller picks the card path, not a seed. */
export function isCardWallet(image: VaultImage, walletId: string): boolean {
  return image.records.some((r) => r.kind === CARD_WALLET_KIND && r.id === walletId);
}

/** The body's public material as a {@link Pin} — the master key plus every cached path. */
export function cardPin(body: CardWalletBody): Pin {
  return {
    master: hexToBytes(body.master),
    // A genuine card's keys are its own — the verified tap already proved custody.
    confirmed: "all",
    keys: {
      nodes: parsePinnedNodes(body.nodes),
      ed25519: parsePinnedEd25519(body.ed25519),
    } satisfies PinnedKeys,
  };
}
