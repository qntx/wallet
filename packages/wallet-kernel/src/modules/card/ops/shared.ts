/**
 * Shared machinery for the single-card ops (design §7): the step plumbing (`ask`, `tapRetry`, run
 * outcomes), the access-code policy (`askNewCode`, `validCode`), record readers (`walletOf`,
 * `pinnedShortId`, `holdDue`, `lowestTries`, `memberIds`), the registration and needed path sets,
 * the PUBLIC_KEY fetcher, and the record/hash builders every op shares.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { bitcoinNetwork } from "@qntx/wallet-chains/bitcoin";
import type { ChainTemplate } from "@qntx/wallet/protocol";

import type { KernelContext } from "../../../commands/context.ts";
import { walletIdOf } from "../../../derive/wallet-id.ts";
import { KernelError } from "../../../errors.ts";
import type { PromptLocale } from "../../../prompts.ts";
import { wipe } from "../../../secret/secret.ts";
import { CARD_WALLET_KIND } from "../../../vault/store.ts";
import { pathString } from "../../chains/keys.ts";
import { BTC_PURPOSE } from "../../chains/shared.ts";
import { PLAN_MS, priceOf } from "../budget.ts";
import { accessHash } from "../protocol/access.ts";
import type { CardPath } from "../protocol/commands.ts";
import { cmd } from "../protocol/commands.ts";
import type { WalletInfo } from "../protocol/decode.ts";
import { decode } from "../protocol/decode.ts";
import { shortId } from "../protocol/identity.ts";
import { ACCESS_LIMITS } from "../protocol/status.ts";
import type { CardWalletBody, CardWalletHeader } from "../record.ts";
import { parseCardWalletHeader } from "../record.ts";
import type { PendingInput, PendingTap, StepOutcome, TapSession } from "../tap.ts";
// oxlint-disable typescript/require-await -- op bodies are async generators whose own code
// only `yield*`s; the awaits live in the `run` callbacks and the hash helpers.
import { confirmAccessCodeLabel, newAccessCodeLabel } from "../text.ts";

export const HARDENED = 0x80000000;
export const DEFAULT_GROUPS = 3;
/** Headroom kept inside the plan so the tap can still finish its commit and close. */
export const PLAN_MARGIN_MS = 1000;
/** The input contract: 6–64 printable ASCII bytes (§7.1, enforced again in accessHash). */
export const CODE_LIMITS = { min: 6, confirmBelow: 8, max: 64 } as const;

/** The services an op needs — everything else lives in its own generator locals. */
export type OpEnv = {
  readonly ctx: KernelContext;
  /** The card module's live bodies — re-read fresh after every committed tap. */
  readonly bodies: ReadonlyMap<string, CardWalletBody>;
  readonly locale: PromptLocale;
  /** The per-tap command budget — `PLAN_MS` on every host, injectable for tests. */
  readonly planMs: number;
};

export type Needed = { readonly curve: "secp256k1" | "ed25519"; readonly path: CardPath };

/** What a tap's `run` reports back to its op — every other answer is staged into op locals. */
export type RunOutcome =
  | { readonly status: "done" }
  | { readonly status: "need-code"; readonly card: string }
  | { readonly status: "wrong-code"; readonly remaining: number };

export const badStep = (): KernelError =>
  new KernelError("integrity", "a card step resolved with the wrong outcome");

/** The engine feeds Uint8Array to input steps and TapOutcome to tap steps — nothing else. */
export const asRunOutcome = (value: unknown): RunOutcome => {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    throw badStep();
  }
  if (value.status === "done") {
    return { status: "done" };
  }
  if (value.status === "need-code" && "card" in value && typeof value.card === "string") {
    return { status: "need-code", card: value.card };
  }
  if (
    value.status === "wrong-code" &&
    "remaining" in value &&
    typeof value.remaining === "number"
  ) {
    return { status: "wrong-code", remaining: value.remaining };
  }
  throw badStep();
};

/** Yields an input step and resolves with the entered bytes. */
export function* ask(
  pending: Omit<PendingInput, "kind">,
): Generator<PendingInput, Uint8Array, StepOutcome | undefined> {
  const outcome = yield { kind: "input", ...pending };
  if (!(outcome instanceof Uint8Array)) {
    throw badStep();
  }
  return outcome;
}

/** Yields the tap; on a lost session re-yields it with `reason: "retry"` until it completes. */
export function* tapRetry(
  build: (retry: boolean) => Omit<PendingTap, "kind">,
): Generator<PendingInput | PendingTap, RunOutcome, StepOutcome | undefined> {
  let retry = false;
  for (;;) {
    const outcome = yield { kind: "tap", ...build(retry) };
    if (outcome === undefined || outcome instanceof Uint8Array) {
      throw badStep();
    }
    if (outcome.ok) {
      return asRunOutcome(outcome.value);
    }
    retry = true;
  }
}

/** The entered bytes are a usable access code — checked before they ever reach Argon2id. */
export const validCode = (code: Uint8Array): boolean =>
  code.length >= CODE_LIMITS.min &&
  code.length <= CODE_LIMITS.max &&
  code.every((b) => b >= 0x20 && b <= 0x7e);

/** New → confirm, looping on an invalid code or a mismatch (§3). */
export async function* askNewCode(
  env: OpEnv,
): AsyncGenerator<PendingInput | PendingTap, Uint8Array, StepOutcome | undefined> {
  for (;;) {
    const code = yield* ask({
      purpose: "new-access-code",
      secure: "access-code",
      label: newAccessCodeLabel(env.locale, undefined),
    });
    if (!validCode(code)) {
      wipe(code);
      continue;
    }
    const confirm = yield* ask({
      purpose: "confirm-access-code",
      secure: "access-code",
      label: confirmAccessCodeLabel(env.locale, undefined, code.length < CODE_LIMITS.confirmBelow),
    });
    const matched = equalBytes(code, confirm);
    wipe(confirm);
    if (matched) {
      return code;
    }
    wipe(code);
  }
}

/** Reads a card-wallet record off the live image + bodies; absent body → integrity. */
export const walletOf = (
  env: OpEnv,
  walletId: string,
): { header: CardWalletHeader; body: CardWalletBody } => {
  const record = env.ctx.image.records.find(
    (r) => r.kind === CARD_WALLET_KIND && r.id === walletId,
  );
  const body = env.bodies.get(walletId);
  if (record === undefined) {
    throw new KernelError("not-found", "no such card wallet");
  }
  if (body === undefined) {
    throw new KernelError("integrity", "card wallet body is not loaded");
  }
  return { header: parseCardWalletHeader(record.header), body };
};

/** The pinned-cert short ID of a card entry, when this kernel has seen the card. */
export const pinnedShortId = (header: CardWalletHeader, cardIdHex: string): string | undefined => {
  const cert = header.cards.find((c) => c.cardId === cardIdHex)?.cert;
  return cert === undefined ? undefined : shortId(hexToBytes(cert).subarray(0, 33));
};

/** `hold` — waits are due when the recorded tries are at or below the wait threshold. */
export const holdDue = (header: CardWalletHeader, cards: ReadonlyArray<string>): true | undefined =>
  cards.some((id) => {
    const tries = header.cards.find((c) => c.cardId === id)?.tries;
    return tries !== undefined && tries <= ACCESS_LIMITS.failures - ACCESS_LIMITS.free;
  }) || undefined;

/** The lowest recorded tries among a card set — drives the last-attempt label. */
export const lowestTries = (
  header: CardWalletHeader,
  cards: ReadonlyArray<string>,
): number | undefined => {
  let lowest: number | undefined;
  for (const id of cards) {
    const tries = header.cards.find((c) => c.cardId === id)?.tries;
    if (tries !== undefined && (lowest === undefined || tries < lowest)) {
      lowest = tries;
    }
  }
  return lowest;
};

/** The registration set (design §6): account parents plus group nodes, mainnet coin type. */
export const registrationPaths = (groups: number): ReadonlyArray<Needed> => {
  const paths: Needed[] = [
    { curve: "secp256k1", path: [44 + HARDENED, 60 + HARDENED, HARDENED] },
    { curve: "secp256k1", path: [44 + HARDENED, 195 + HARDENED, HARDENED] },
  ];
  for (const purpose of [44, 49, 84, 86]) {
    paths.push({ curve: "secp256k1", path: [purpose + HARDENED, HARDENED] });
    for (let g = 0; g < groups; g += 1) {
      paths.push({ curve: "secp256k1", path: [purpose + HARDENED, HARDENED, g + HARDENED] });
    }
  }
  for (let g = 0; g < groups; g += 1) {
    paths.push({
      curve: "ed25519",
      path: [44 + HARDENED, 501 + HARDENED, g + HARDENED, HARDENED],
    });
  }
  return paths;
};

/** The nodes `accounts` must hold so the requested accounts resolve without a tap. */
export const neededPaths = (
  templates: ReadonlyArray<ChainTemplate>,
  groupIndex: number,
  network: string,
): ReadonlyArray<Needed> => {
  const paths: Needed[] = [];
  const seen = new Set<string>();
  const push = (needed: Needed): void => {
    const key = `${needed.curve}:${pathString(needed.path)}`;
    if (!seen.has(key)) {
      seen.add(key);
      paths.push(needed);
    }
  };
  for (const template of templates) {
    if (template === "evm.bip44") {
      push({ curve: "secp256k1", path: [44 + HARDENED, 60 + HARDENED, HARDENED] });
      continue;
    }
    if (template === "tron.bip44") {
      push({ curve: "secp256k1", path: [44 + HARDENED, 195 + HARDENED, HARDENED] });
      continue;
    }
    if (template === "solana.bip44-change") {
      push({
        curve: "ed25519",
        path: [44 + HARDENED, 501 + HARDENED, groupIndex + HARDENED, HARDENED],
      });
      continue;
    }
    const purpose = BTC_PURPOSE[template];
    if (purpose === undefined) {
      throw new KernelError("invalid-input", `unknown template ${template}`);
    }
    const coin = bitcoinNetwork(network).coinType;
    push({ curve: "secp256k1", path: [purpose + HARDENED, coin + HARDENED] });
    push({
      curve: "secp256k1",
      path: [purpose + HARDENED, coin + HARDENED, groupIndex + HARDENED],
    });
  }
  return paths;
};

/** The registration/needed paths still missing from this body. */
export const missingIn = (
  body: CardWalletBody | undefined,
  paths: ReadonlyArray<Needed>,
): Needed[] => {
  if (body === undefined) {
    return [...paths];
  }
  return paths.filter(({ curve, path }) =>
    curve === "secp256k1"
      ? body.nodes[pathString(path)] === undefined
      : body.ed25519[pathString(path)] === undefined,
  );
};

/**
 * Fetches up to the plan budget of `paths` through PUBLIC_KEY and stages every node as it arrives —
 * a lost session keeps what already landed, so the retry never refetches it. secp256k1 keeps key +
 * chainCode of the 65-byte response, ed25519 keeps the RFC 8032 encoding.
 */
export const fetchNodes = async (tap: TapSession, paths: ReadonlyArray<Needed>): Promise<void> => {
  const room = Math.floor((PLAN_MS - tap.cost() - PLAN_MARGIN_MS) / priceOf("public-key"));
  const batch = paths.slice(0, Math.max(0, room));
  for (const needed of batch) {
    const key = pathString(needed.path);
    // oxlint-disable-next-line eslint/no-await-in-loop -- PUBLIC_KEYs are strictly sequential
    const data = await tap.send(cmd.publicKey(needed.curve, needed.path));
    if (needed.curve === "secp256k1") {
      const { publicKey, chainCode } = decode.publicKey(data);
      const node = { key: bytesToHex(publicKey), chainCode: bytesToHex(chainCode) };
      tap.update((d) => {
        if (d.body !== undefined) {
          d.body = { ...d.body, nodes: { ...d.body.nodes, [key]: node } };
        }
      });
    } else {
      const encoded = bytesToHex(decode.weiPoint(data));
      tap.update((d) => {
        if (d.body !== undefined) {
          d.body = { ...d.body, ed25519: { ...d.body.ed25519, [key]: encoded } };
        }
      });
    }
  }
};

/** A record a `VERIFY`/`CREATE` just proved: members in the card's order, this card ready. */
export const recordFrom = (
  env: OpEnv,
  cardId: Uint8Array,
  info: WalletInfo,
  access?: Record<string, string>,
): { header: CardWalletHeader; body: CardWalletBody } => ({
  header: {
    v: 1,
    walletId: walletIdOf(info.masterPublicKey),
    origin: info.origin,
    createdAt: env.ctx.platform.now(),
    members: info.members.map(bytesToHex),
    cards: info.members.map((id) => ({
      cardId: bytesToHex(id),
      state: equalBytes(id, cardId) ? ("ready" as const) : ("unknown" as const),
    })),
  },
  body: {
    master: bytesToHex(info.masterPublicKey),
    nodes: {},
    ed25519: {},
    ephemerals: {},
    ...(access === undefined ? {} : { access }),
  },
});
/** Fills `hashes` for every allowed cardId from `code`, then wipes the code. */
export const hashAll = async (
  env: OpEnv,
  hashes: Map<string, Uint8Array>,
  code: Uint8Array,
  ids: ReadonlyArray<Uint8Array>,
): Promise<void> => {
  for (const id of ids) {
    const key = bytesToHex(id);
    if (!hashes.has(key)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- hashes are cheap to serialize and one KDF at a time keeps memory bounded
      hashes.set(key, await accessHash(code, id, env.ctx.platform.argon2id));
    }
  }
};
