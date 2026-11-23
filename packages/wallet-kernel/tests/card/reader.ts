/**
 * A scripted `CardReader` for kernel tests. Field cards queue via `present`; the next `open` picks
 * the head of the queue up (an empty queue answers `timeout`, the field poll giving up).
 * `openFails` scripts a one-shot open failure, `loseAfter(n)` ends the next session with `tag-lost`
 * on the (n+1)-th transmit — a card `"torn"` reply maps to the same failure. `loseGlobal(n)` arms
 * the harder case: the n-th transmit from then on, across session boundaries, is delivered to the
 * card (its persistent effects commit) but the answer never comes back. Every prompt, close, APDU
 * and per-session transmit count is logged for assertions.
 */
import type { CardReader, CardReaderFailure, CardReaderResult } from "../../src/platform.ts";

/** What the reader asks of a field card: one raw C-APDU, data‖SW or power loss. */
export type FieldCard = {
  readonly transmit: (apdu: Uint8Array) => Promise<Uint8Array | "torn">;
};

export type TestCardReader = {
  readonly reader: CardReader;
  /** Queue a card presented on the next `open`. */
  readonly present: (card: FieldCard) => void;
  /** The next `open` fails with `failure` (default `unavailable`) instead of polling. */
  readonly openFails: (failure: CardReaderFailure, detail?: string) => void;
  /** The next session loses the tag on the (n+1)-th transmit; the APDU never reaches the card. */
  readonly loseAfter: (n: number) => void;
  /**
   * The n-th transmit from now — counting across sessions — is delivered to the card but its answer
   * is dropped (`tag-lost`). The card may have committed persistent state.
   */
  readonly loseGlobal: (n: number) => void;
  /** Every prompt `open` was called with. */
  readonly prompts: string[];
  /** Every `(outcome, text)` `close` recorded. */
  readonly closes: Array<{ outcome: "success" | "failure"; text: string }>;
  /** Every APDU transmitted, in order. */
  readonly sent: Uint8Array[];
  /** How many APDUs each session transmitted, one entry per ended session. */
  readonly sessionLengths: number[];
};

const fail = (failure: CardReaderFailure, detail?: string): CardReaderResult<never> => ({
  ok: false,
  failure,
  detail,
});

export function testCardReader(): TestCardReader {
  const queue: FieldCard[] = [];
  const prompts: string[] = [];
  const closes: Array<{ outcome: "success" | "failure"; text: string }> = [];
  const sent: Uint8Array[] = [];
  const sessionLengths: number[] = [];
  let failNext: { failure: CardReaderFailure; detail: string | undefined } | undefined;
  let loseAt = Number.POSITIVE_INFINITY;
  let loseGlobalAt = Number.POSITIVE_INFINITY;
  let globalCount = 0;
  let session: { card: FieldCard; transmitted: number } | undefined;

  const endSession = (): void => {
    if (session !== undefined) {
      sessionLengths.push(session.transmitted);
      session = undefined;
    }
  };

  const reader: CardReader = {
    // oxlint-disable-next-line typescript/require-await -- the CardReader contract is async
    open: async (prompt) => {
      prompts.push(prompt);
      if (session !== undefined) {
        throw new Error("test reader: open while a session is live");
      }
      if (failNext !== undefined) {
        const scripted = failNext;
        failNext = undefined;
        return fail(scripted.failure, scripted.detail);
      }
      const card = queue.shift();
      if (card === undefined) {
        return fail("timeout");
      }
      session = { card, transmitted: 0 };
      return { ok: true, value: undefined };
    },
    transmit: async (apdu) => {
      const live = session;
      if (live === undefined) {
        throw new Error("test reader: transmit outside a session");
      }
      sent.push(new Uint8Array(apdu));
      live.transmitted += 1;
      globalCount += 1;
      if (globalCount === loseGlobalAt) {
        loseGlobalAt = Number.POSITIVE_INFINITY;
        // The card does the work — only the answer is lost.
        await live.card.transmit(apdu);
        endSession();
        return fail("tag-lost");
      }
      const response: Uint8Array | "torn" =
        live.transmitted > loseAt ? "torn" : await live.card.transmit(apdu);
      if (response === "torn") {
        endSession();
        loseAt = Number.POSITIVE_INFINITY;
        return fail("tag-lost");
      }
      return { ok: true, value: response };
    },
    close: (outcome, text) => {
      closes.push({ outcome, text });
      endSession();
      loseAt = Number.POSITIVE_INFINITY; // loseAfter arms a single session
    },
  };
  return {
    reader,
    present: (card) => {
      queue.push(card);
    },
    openFails: (failure, detail) => {
      failNext = { failure, detail };
    },
    loseAfter: (n) => {
      loseAt = n;
    },
    loseGlobal: (n) => {
      globalCount = 0;
      loseGlobalAt = n;
    },
    prompts,
    closes,
    sent,
    sessionLengths,
  };
}
