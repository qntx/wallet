/**
 * The tap engine (design §6): one `tap` step is one reader session — SELECT → OPEN (certificate
 * chain + session signature) → ephemeral-tag history → cert pin → card-ID gate → short-ID check →
 * STATUS gates → the op's commands → one record commit → close. Every failure path closes the
 * session and, when STATUS was read, still lands the per-tap record bookkeeping.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import type { CardInputPurpose, CardOpResult, CardTapReason } from "@qntx/wallet/protocol";

import type { KernelContext } from "../../commands/context.ts";
import { KernelError } from "../../errors.ts";
import { promptLocale } from "../../prompts.ts";
import type { StoreOp } from "../../vault/store.ts";
import { CARD_WALLET_KIND } from "../../vault/store.ts";
import { sealRecord } from "../../vault/vault.ts";
import { PRICE_OPEN, priceOf } from "./budget.ts";
import type { Inner } from "./protocol/commands.ts";
import { cmd } from "./protocol/commands.ts";
import type { CardStatus, WalletInfo } from "./protocol/decode.ts";
import { decode } from "./protocol/decode.ts";
import { CardError } from "./protocol/errors.ts";
import type { CardErrorCode } from "./protocol/errors.ts";
import { shortId } from "./protocol/identity.ts";
import { openRequest, openResponse, SELECT_APDU } from "./protocol/session.ts";
import type { Session } from "./protocol/session.ts";
import { ACCESS_LIMITS, result, waitsBeforeVerify } from "./protocol/status.ts";
import type { CardWalletBody, CardWalletHeader } from "./record.ts";
import { encodeCardWalletBody, encodeCardWalletHeader, parseCardWalletHeader } from "./record.ts";

/** A step that asks the host's secure-input view for bytes (the label is kernel text). */
export type PendingInput = {
  readonly kind: "input";
  readonly purpose: CardInputPurpose;
  readonly card?: string | undefined;
  readonly remaining?: number | undefined;
  /** The `SecureInput` kind the view collects. */
  readonly secure: "access-code" | "short-id";
  readonly label: string;
};

/** A step that drives one reader session; `run` carries the tap's commands. */
export type PendingTap = {
  readonly kind: "tap";
  readonly reason: CardTapReason;
  readonly card?: string | undefined;
  readonly hold?: true | undefined;
  /** Kernel text for the reader sheet — checked against the UTF-8 cap before `open`. */
  readonly prompt: string;
  /** Kernel text shown on a successful `close` ("" closes silently). */
  readonly doneText?: string | undefined;
  readonly expect: TapExpect;
  readonly run: (tap: TapSession) => Promise<unknown>;
};

export type StepOutcome = Uint8Array | TapOutcome;
export type CardOp = AsyncGenerator<
  PendingInput | PendingTap,
  CardOpResult,
  StepOutcome | undefined
>;

/** What a tap step promises the card side: life, the allowed/forbidden card IDs, the typed short ID. */
export type TapExpect = {
  readonly life: "blank" | "loaded" | "any";
  /** Card IDs (16 bytes) this tap accepts; `undefined` = any card not in `exclude`. */
  readonly cards?: ReadonlyArray<Uint8Array> | undefined;
  readonly exclude?: ReadonlyArray<Uint8Array> | undefined;
  /** The short ID the user typed for this tap — checked before any command but OPEN/STATUS. */
  readonly shortId?: string | undefined;
  /** The card-wallet record supplying pin, ephemeral history and recorded tries. */
  readonly walletId?: string | undefined;
};

export type LostKind = "tag-lost" | "timeout" | "interrupted";
export type TapOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly lost: LostKind };

export type VerifyOutcome =
  | { readonly ok: true; readonly info: WalletInfo }
  | { readonly ok: false; readonly remaining: number };

/** The record an op stages through `tap.update` — committed once at the end of the tap. */
export type TapDraft = {
  header: CardWalletHeader | undefined;
  body: CardWalletBody | undefined;
  readonly extra: StoreOp[];
};

export type TapSession = {
  readonly identity: Uint8Array;
  readonly cert: Uint8Array;
  readonly cardId: Uint8Array;
  readonly shortId: string;
  readonly status: CardStatus;
  /** The wallet whose record lists this card as a member, when one does. */
  readonly memberOf: string | undefined;
  /** Wrap → transmit → unwrap → `result()`; a reader failure ends the tap (see step 9). */
  readonly send: (inner: Inner) => Promise<Uint8Array>;
  /** The §7.3 gate: WAITs the counter demands, then VERIFY; `wrong-card` on a record mismatch. */
  readonly verify: (accessHash: Uint8Array) => Promise<VerifyOutcome>;
  /** Estimated milliseconds this session has spent so far (budget.ts). */
  readonly cost: () => number;
  /** Stages record work applied in this tap's single commit (new nodes, saved hash, …). */
  readonly update: (fn: (draft: TapDraft) => void) => void;
};

/** The reader prompt may carry at most this many UTF-8 bytes (§10 — never truncated). */
const PROMPT_LIMIT = 1024;

const ERROR_CODE: Readonly<Record<CardErrorCode, KernelError["code"]>> = {
  "card-not-genuine": "card-not-genuine",
  "wallet-erased": "card-erased",
  "session-broken": "card-fault",
  "card-fault": "card-fault",
  "invalid-data": "card-fault",
  "not-verified": "card-fault",
  "wrong-state": "card-fault",
  "wait-required": "card-fault",
  "wrong-access-code": "card-fault",
  "invalid-input": "integrity",
};

/** The CardError → KernelError table (§5): the one place protocol errors become kernel codes. */
export function cardToKernel(error: unknown): never {
  if (error instanceof KernelError) {
    throw error;
  }
  if (error instanceof CardError) {
    throw new KernelError(ERROR_CODE[error.code], error.message);
  }
  throw error;
}

/** A transmit's reader failure, rethrown so `run` unwinds to the session bookkeeping. */
class LostError extends Error {
  readonly failure: "cancelled" | "unavailable" | LostKind;
  readonly detail: string | undefined;

  constructor(failure: "cancelled" | "unavailable" | LostKind, detail?: string) {
    super(failure);
    this.name = "LostError";
    this.failure = failure;
    this.detail = detail;
  }
}

const lostOf = (failure: string): LostKind =>
  failure === "tag-lost" || failure === "timeout" || failure === "interrupted"
    ? failure
    : "interrupted";

type CardEntry = { readonly header: CardWalletHeader; readonly body: CardWalletBody };

/**
 * One reader session for `pending`. `bodies` is the card module's live map — the engine parses
 * headers from `ctx.image` itself. Resolves the op's outcome; KernelErrors propagate.
 */
export async function runTap(
  ctx: KernelContext,
  pending: PendingTap,
  bodies: ReadonlyMap<string, CardWalletBody>,
): Promise<TapOutcome> {
  const { card } = ctx.platform;
  if (card === undefined) {
    throw new KernelError("unsupported", "this host has no card reader");
  }
  const { expect } = pending;
  const { reader } = card;
  if (utf8ToBytes(pending.prompt).length > PROMPT_LIMIT) {
    throw new KernelError("card-unsupported", "the reader prompt does not fit the card surface");
  }
  const locale = promptLocale(ctx.platform.keystore?.locale ?? "en");
  const closedText = (error: unknown): string => {
    if (error instanceof KernelError && error.code === "card-tampered") {
      return locale === "zh-Hans"
        ? "这张卡上有人在别处试过访问码"
        : "Someone else tried codes on this card";
    }
    return "";
  };

  const recordOf = (walletId: string): CardEntry | undefined => {
    const record = ctx.image.records.find((r) => r.kind === CARD_WALLET_KIND && r.id === walletId);
    const body = bodies.get(walletId);
    if (record === undefined) {
      return undefined;
    }
    if (body === undefined) {
      // An unlocked vault claims every card-wallet body — a miss means the claim never ran.
      throw new KernelError("integrity", "card wallet body is not loaded");
    }
    return { header: parseCardWalletHeader(record.header), body };
  };
  /** The card-wallet record whose `cards[]` tracks this cardId, whichever wallet it is. */
  const recordForCard = (cardIdHex: string): CardEntry | undefined => {
    for (const record of ctx.image.records) {
      if (record.kind !== CARD_WALLET_KIND) {
        continue;
      }
      const header = parseCardWalletHeader(record.header);
      if (header.cards.some((c) => c.cardId === cardIdHex)) {
        const body = bodies.get(record.id);
        if (body === undefined) {
          throw new KernelError("integrity", "card wallet body is not loaded");
        }
        return { header, body };
      }
    }
    return undefined;
  };

  const draft: TapDraft = { header: undefined, body: undefined, extra: [] };
  const updates: Array<(d: TapDraft) => void> = [];
  if (expect.walletId !== undefined) {
    const entry = recordOf(expect.walletId);
    draft.header = entry?.header;
    draft.body = entry?.body;
  }

  /** The bookkeeping fields the engine owns for the card it just talked to. */
  let triesNow: number | undefined;
  let verifyInfo: WalletInfo | undefined;
  let certHex: string | undefined;
  let tagHex: string | undefined;
  let cardIdHex = "";
  let own: CardEntry | undefined;
  /** The card self-erased this session — its record entry goes back to `unknown`. */
  let markErased = false;

  /** Applies the engine's bookkeeping to the record entry that tracks `cardIdHex`. */
  const bookkeep = (entry: CardEntry): CardEntry => {
    const cards = entry.header.cards.map((c) => {
      if (c.cardId !== cardIdHex) {
        return c;
      }
      if (markErased) {
        return { cardId: c.cardId, state: "unknown" as const };
      }
      return {
        ...c,
        ...(triesNow === undefined ? {} : { tries: triesNow }),
        ...(c.cert === undefined && certHex !== undefined ? { cert: certHex } : {}),
        ...(verifyInfo === undefined
          ? {}
          : { state: "ready" as const, verifiedAt: ctx.platform.now() }),
      };
    });
    const ephemerals =
      tagHex === undefined
        ? entry.body.ephemerals
        : {
            ...entry.body.ephemerals,
            [cardIdHex]: [tagHex, ...(entry.body.ephemerals[cardIdHex] ?? [])].slice(0, 16),
          };
    return { header: { ...entry.header, cards }, body: { ...entry.body, ephemerals } };
  };

  /**
   * The tap's single commit: the op's staged changes plus the engine's bookkeeping — the ephemeral
   * tag of every OPENed known card and the tries read on every post-STATUS exit. Bookkeeping lands
   * on the record that lists this card: the draft's when it does (member taps, staged creates), the
   * presented card's own record when it belongs to a different wallet.
   */
  const commit = async (): Promise<void> => {
    for (const update of updates) {
      update(draft);
    }
    if (!ctx.session.unlocked) {
      return; // the lock already discarded the op — nothing more is owed
    }
    const seal = (entry: CardEntry) =>
      sealRecord(
        ctx.platform,
        ctx.session.current().dek,
        CARD_WALLET_KIND,
        entry.header.walletId,
        encodeCardWalletHeader(entry.header),
        utf8ToBytes(encodeCardWalletBody(entry.body)),
      );
    const bookkeeping =
      tagHex !== undefined || triesNow !== undefined || verifyInfo !== undefined || markErased;
    const inDraft = draft.header?.cards.some((c) => c.cardId === cardIdHex) === true;
    const ops: StoreOp[] = [];
    if (own !== undefined && !inDraft && bookkeeping) {
      // A genuine card tracked by another record — presented to the wrong tap, still owes
      // its tag and tries to its own wallet's record.
      ops.push({ op: "put-record", record: seal(bookkeep(own)) });
    }
    if (
      draft.header !== undefined &&
      draft.body !== undefined &&
      (updates.length > 0 || (inDraft && bookkeeping))
    ) {
      if (inDraft && bookkeeping) {
        const booked = bookkeep({ header: draft.header, body: draft.body });
        draft.header = booked.header;
        draft.body = booked.body;
      }
      ops.push({ op: "put-record", record: seal({ header: draft.header, body: draft.body }) });
    }
    ops.push(...draft.extra);
    if (ops.length > 0) {
      await ctx.commit(ops);
    }
  };

  // Step 1: the reader session itself. A failed open is the session's own ending.
  const opened = await reader.open(pending.prompt);
  if (!opened.ok) {
    if (opened.failure === "cancelled") {
      throw new KernelError("cancelled", "the card session was dismissed");
    }
    if (opened.failure === "unavailable") {
      throw new KernelError(
        "unavailable",
        "the card reader is unavailable",
        undefined,
        false,
        opened.detail,
      );
    }
    return { ok: false, lost: lostOf(opened.failure) };
  }

  let session: Session | undefined;
  try {
    const sendRaw = async (apdu: Uint8Array): Promise<Uint8Array> => {
      const response = await reader.transmit(apdu);
      if (!response.ok) {
        throw new LostError(response.failure, response.detail);
      }
      return response.value;
    };

    // Step 2: SELECT + OPEN — a genuine card or nothing at all.
    const selected = await sendRaw(SELECT_APDU);
    if (selected.length !== 2 || selected[0] !== 0x90 || selected[1] !== 0x00) {
      throw new CardError("card-not-genuine", "SELECT did not answer 9000");
    }
    const request = openRequest(ctx.platform.random);
    const answered = await sendRaw(request.apdu);
    const sess = openResponse(request.secret, request.apdu, answered, card.anchors, []);
    session = sess;
    cardIdHex = bytesToHex(sess.cardId);
    certHex = bytesToHex(sess.cert);
    own = recordForCard(cardIdHex);

    // Step 3: a replayed cardEph is a protocol fault — a fresh tag is recorded on every exit.
    const tag = bytesToHex(sess.ephemeralTag);
    if (own !== undefined && (own.body.ephemerals[cardIdHex] ?? []).includes(tag)) {
      throw new CardError("card-fault", "cardEph repeats a recently seen value");
    }
    tagHex = tag;
    // Step 4: a pinned certificate must match byte-exactly.
    const entry = own?.header.cards.find((c) => c.cardId === cardIdHex);
    if (entry?.cert !== undefined && !equalBytes(hexToBytes(entry.cert), sess.cert)) {
      throw new CardError("card-not-genuine", "the card presented a different certificate");
    }
    // Step 5: the card-ID gate runs before any further command.
    if (
      (expect.cards !== undefined && !expect.cards.some((id) => equalBytes(id, sess.cardId))) ||
      (expect.exclude !== undefined && expect.exclude.some((id) => equalBytes(id, sess.cardId)))
    ) {
      throw new KernelError("card-id-mismatch", "this tap expects a different card");
    }
    // Step 6: the typed short ID confirms the physical card (create/reseal/transfer).
    if (expect.shortId !== undefined && expect.shortId !== shortId(sess.identity)) {
      throw new KernelError("card-id-mismatch", "the card's short ID does not match");
    }

    const spent = { ms: PRICE_OPEN };
    const send = async (inner: Inner): Promise<Uint8Array> => {
      const response = await reader.transmit(sess.wrap(inner));
      spent.ms += priceOf(inner.name);
      if (!response.ok) {
        throw new LostError(response.failure, response.detail);
      }
      return result(inner, sess.unwrap(response.value));
    };

    // Step 7: STATUS and the life/tries gates — the read tries are owed to the record
    // on every exit from here on.
    const status = decode.status(await send(cmd.status()));
    triesNow = status.tries;
    const memberOf = ctx.image.records.find((record) => {
      if (record.kind !== CARD_WALLET_KIND) {
        return false;
      }
      return parseCardWalletHeader(record.header).members.includes(cardIdHex);
    })?.id;
    if (expect.life === "loaded" && status.life === "blank") {
      markErased = true;
      throw new KernelError("card-erased", "the card is blank — its wallet was erased");
    }
    if (expect.life === "blank" && status.life === "loaded") {
      throw new KernelError("card-id-mismatch", "this tap expects a blank card");
    }
    const recorded = entry?.tries;
    if (recorded !== undefined && status.tries < recorded) {
      throw new KernelError("card-tampered", "the card's failure count dropped since the last tap");
    }
    if (status.life === "loaded" && status.tries === 0) {
      throw new KernelError("card-locked", "the card is locked — the next code would erase it");
    }

    const verify = async (hash: Uint8Array): Promise<VerifyOutcome> => {
      // Step 8: the §7.3 gate — waits first, then VERIFY.
      const waits = waitsBeforeVerify(status);
      for (let i = 0; i < waits; i += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the card counts each WAIT in order
        await send(cmd.wait());
      }
      let data: Uint8Array;
      try {
        data = await send(cmd.verify(hash));
      } catch (error) {
        if (error instanceof CardError && error.code === "wrong-access-code") {
          triesNow = error.remaining;
          return { ok: false, remaining: error.remaining ?? 0 };
        }
        throw error;
      }
      // The card accepted the hash and reset its counter — record it even when the
      // wallet proof below rejects the card.
      triesNow = ACCESS_LIMITS.failures;
      const info = decode.walletInfo(data, sess.cardId);
      if (draft.header !== undefined && draft.body !== undefined) {
        const { members } = draft.header;
        if (
          bytesToHex(info.masterPublicKey) !== draft.body.master ||
          members.length !== info.members.length ||
          !members.every((m) => info.members.some((id) => bytesToHex(id) === m))
        ) {
          throw new KernelError("wrong-card", "the card's wallet does not match the record");
        }
      }
      verifyInfo = info;
      return { ok: true, info };
    };

    // Step 9: the op's commands. A reader failure ends the session — the single commit below
    // still lands the bookkeeping and whatever the op staged; partial progress is kept.
    const tap: TapSession = {
      identity: sess.identity,
      cert: sess.cert,
      cardId: sess.cardId,
      shortId: shortId(sess.identity),
      status,
      memberOf,
      send,
      verify,
      cost: () => spent.ms,
      update: (fn) => {
        updates.push(fn);
      },
    };
    const value = await pending.run(tap);

    // Step 10: the single per-tap commit — tries, tag, verifiedAt, cert pin, staged changes.
    // On the success path a commit failure is the tap's own failure and propagates.
    await commit();
    // Step 11: close in the shown outcome; session keys are wiped either way.
    reader.close("success", pending.doneText ?? "");
    session.close();
    session = undefined;
    return { ok: true, value };
  } catch (error) {
    const live = session;
    session = undefined;
    live?.close();
    if (error instanceof CardError && error.code === "wallet-erased") {
      // The card erased itself mid-session (the failure count ran out).
      markErased = true;
    }
    // Bookkeeping and staged work land on every exit — a commit failure never masks
    // the session's own outcome.
    const bookkeeping = (async (): Promise<void> => {
      try {
        await commit();
      } catch {
        // masked — the session's own outcome wins
      }
    })();
    if (error instanceof LostError) {
      reader.close("failure", ""); // the session ended silently on its own
      await bookkeeping;
      if (error.failure === "cancelled") {
        throw new KernelError("cancelled", "the card session was dismissed");
      }
      if (error.failure === "unavailable") {
        throw new KernelError(
          "unavailable",
          "the card reader is unavailable",
          undefined,
          false,
          error.detail,
        );
      }
      return { ok: false, lost: lostOf(error.failure) };
    }
    reader.close("failure", closedText(error));
    await bookkeeping;
    return cardToKernel(error);
  } finally {
    session?.close();
  }
}
