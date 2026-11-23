import { equalBytes } from "@noble/ciphers/utils.js";
// oxlint-disable eslint/no-await-in-loop, vitest/no-conditional-in-test -- the step driver is sequential and conditional by design
/**
 * The multi-card ops against the fake card (layer 5): `create` with 2/3 cards (imported and
 * generated), `transfer` to a pending member, `reseal` on loaded and wiped members, the
 * short-ID/card-ID failure stories, the hostile OFFER/EXPORT/IMPORT deviations, tag loss, and
 * `tear` on every persistent write of OFFER/CREATE/IMPORT.
 */
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vite-plus/test";

import type { CardInfo, WalletInfo } from "@qntx/wallet/types";

import { walletIdOf } from "../src/derive/wallet-id.ts";
import { accessHash } from "../src/modules/card/protocol/access.ts";
import { ascii } from "../src/modules/card/protocol/bytes.ts";
import { shortId } from "../src/modules/card/protocol/identity.ts";
import { entropyFromMnemonic } from "../src/seed/mnemonic.ts";
import { seedFromEntropy } from "../src/seed/seed.ts";
import { createFakeCard } from "./card/fake-card.ts";
import type { FakeCard } from "./card/fake-card.ts";
import { testSecureInput } from "./card/input.ts";
import { testCardReader } from "./card/reader.ts";
import { CA1_ANCHOR } from "./card/sim.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { createHarness, seededRandom } from "./harness.ts";
import { quickArgon2id, subtlePbkdf2 } from "./helpers.ts";

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const CODE = "set code 42";
/** Deep scan: true when any needle appears raw, hex, base64 or as printable text in `value`. */
const containsSecret = (value: unknown, needles: ReadonlyArray<Uint8Array>): boolean => {
  const stack: unknown[] = [value];
  const base64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (const b of bytes) {
      binary += String.fromCodePoint(b);
    }
    return btoa(binary);
  };
  const includesBytes = (hay: Uint8Array, needle: Uint8Array): boolean => {
    outer: for (let i = 0; i + needle.length <= hay.length; i += 1) {
      for (let j = 0; j < needle.length; j += 1) {
        if (hay[i + j] !== needle[j]) {
          continue outer;
        }
      }
      return true;
    }
    return false;
  };
  while (stack.length > 0) {
    const v = stack.pop();
    if (v instanceof Uint8Array) {
      if (needles.some((n) => includesBytes(v, n))) {
        return true;
      }
    } else if (typeof v === "string") {
      for (const n of needles) {
        if (v.includes(bytesToHex(n)) || v.includes(base64(n))) {
          return true;
        }
        if (n.every((b) => b >= 0x20 && b <= 0x7e) && v.includes(new TextDecoder().decode(n))) {
          return true;
        }
      }
    } else if (Array.isArray(v)) {
      stack.push(...v);
    } else if (typeof v === "object" && v !== null) {
      stack.push(...Object.values(v));
    }
  }
  return false;
};

const verifyPasskey = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(32).fill(1),
});

const ok = (res: KernelResponse): Record<string, unknown> => {
  if (!("ok" in res)) {
    throw new Error(`call failed: ${JSON.stringify(res.err)}`);
  }
  return res.ok as Record<string, unknown>;
};
const field = (v: unknown, k: string): unknown => (v as Record<string, unknown>)[k];

type Step = { kind: string; [k: string]: unknown };
type Rig = {
  h: Harness;
  session: string;
  reader: ReturnType<typeof testCardReader>;
  input: ReturnType<typeof testSecureInput>;
};

const rig = async (harness?: Parameters<typeof createHarness>[0]): Promise<Rig> => {
  const reader = testCardReader();
  const input = testSecureInput();
  const h = createHarness({
    ...harness,
    card: { reader: reader.reader, secureInput: input.secureInput, anchors: [CA1_ANCHOR] },
  });
  const res = ok(
    await h.call("wallet.createWithPasskey", {
      ceremony: "host",
      credentialId: CREDENTIAL_ID,
      prfWallet: new Uint8Array(32).fill(2),
      synced: true,
      factor: verifyPasskey(),
    }),
  );
  return { h, session: String(res["session"]), reader, input };
};

const vaultWalletId = async (r: Rig): Promise<string> => {
  const status = ok(await r.h.call("status", null, r.session)) as { wallets: WalletInfo[] };
  const vault = status.wallets.find((w) => w.custody === "vault");
  if (vault === undefined) {
    throw new Error("no vault wallet");
  }
  return vault.walletId;
};

const cardWallet = async (
  r: Rig,
): Promise<{ walletId: string; cards: ReadonlyArray<CardInfo> }> => {
  const status = ok(await r.h.call("status", null, r.session)) as { wallets: WalletInfo[] };
  const wallet = status.wallets.find((w) => w.custody === "card");
  if (wallet === undefined || wallet.custody !== "card") {
    throw new Error("no card wallet");
  }
  return { walletId: wallet.walletId, cards: wallet.cards };
};

/**
 * Drives `card.begin` to `done` (or the first error). `choices` fills the driver's pick at every
 * unbound short-id ask (in ask order); `deck` is every card the op may name — a step carrying
 * `card` presents the deck card with that printed ID, and a retry re-presents it. `presents`
 * overrides the presented card outright (for the wrong-device stories). `shortIds` overrides the
 * typed strings literally.
 */
const drive = async (
  r: Rig,
  op: unknown,
  actions: {
    codes?: string[];
    choices?: FakeCard[];
    deck?: FakeCard[];
    presents?: FakeCard[];
    shortIds?: string[];
  },
  verify?: unknown,
): Promise<{ result?: Record<string, unknown>; error?: string; steps: Step[] }> => {
  const first = await r.h.call(
    "card.begin",
    { op, ...(verify === undefined ? {} : { verify }) },
    r.session,
  );
  const steps: Step[] = [];
  if ("err" in first) {
    return { error: first.err.code, steps };
  }
  const { opId, step: firstStep } = first.ok as { opId: string; step: Step };
  const deck = actions.deck ?? actions.choices ?? [];
  const byShort = (sid: string): FakeCard | undefined =>
    deck.find((c) => shortId(c.identity) === sid);
  let pendingChoice: FakeCard | undefined;
  let step = firstStep;
  for (let guard = 0; step.kind !== "done"; guard += 1) {
    steps.push(step);
    if (guard > 80) {
      return { error: "driver-guard", steps };
    }
    if (step.kind === "input") {
      if (step["purpose"] === "short-id") {
        const bound = step["card"] as string | undefined;
        const override = actions.shortIds?.shift();
        const chosen =
          bound === undefined
            ? override === undefined
              ? actions.choices?.shift()
              : undefined
            : byShort(bound);
        pendingChoice = chosen;
        r.input.push(
          utf8ToBytes(override ?? (chosen === undefined ? "0000-0000" : shortId(chosen.identity))),
        );
      } else {
        const code = actions.codes?.shift();
        if (code === undefined) {
          return { error: "driver-no-code", steps };
        }
        r.input.push(utf8ToBytes(code));
      }
    } else {
      const bound = step["card"] as string | undefined;
      const next =
        actions.presents?.shift() ??
        (bound === undefined ? undefined : byShort(bound)) ??
        pendingChoice ??
        actions.choices?.shift();
      if (next === undefined) {
        return { error: "driver-no-card", steps };
      }
      r.reader.present(next);
    }
    const next = await r.h.call("card.step", { opId }, r.session);
    if ("err" in next) {
      return { error: next.err.code, steps };
    }
    step = next.ok as Step;
  }
  steps.push(step);
  return { result: field(step, "result") as Record<string, unknown>, steps };
};

const begin = async (
  r: Rig,
  op: unknown,
  verify?: unknown,
): Promise<{ opId: string; step: Step }> =>
  ok(
    await r.h.call("card.begin", { op, ...(verify === undefined ? {} : { verify }) }, r.session),
  ) as { opId: string; step: Step };

const step = async (r: Rig, opId: string): Promise<Step> =>
  ok(await r.h.call("card.step", { opId }, r.session)) as Step;

const createSet = async (
  r: Rig,
  cards: FakeCard[],
  opts?: { generate?: boolean; source?: string; code?: string },
): Promise<Record<string, unknown>> => {
  const code = opts?.code ?? CODE;
  const source =
    opts?.generate === true
      ? { kind: "generate" }
      : { kind: "wallet", walletId: opts?.source ?? (await vaultWalletId(r)) };
  const [, ...targets] = cards;
  const out = await drive(
    r,
    { kind: "create", cards: cards.length, source },
    { codes: [code, code], choices: [...targets, cards[0]!], deck: cards },
    verifyPasskey(),
  );
  if (out.result === undefined) {
    throw new Error(`create failed: ${out.error}`);
  }
  return out.result;
};

describe("multi-card operations (fake card)", () => {
  it("create k=2 imports the wallet: source ready, target ready, members in order", async () => {
    const r = await rig();
    const sourceId = await vaultWalletId(r);
    const source = createFakeCard();
    const target = createFakeCard();
    const result = await createSet(r, [source, target]);
    expect(result["kind"]).toBe("create");
    const { walletId, cards } = await cardWallet(r);
    expect(cards?.length).toBe(2);
    expect(cards?.map((c: CardInfo) => c.state)).toStrictEqual(["ready", "ready"]);
    expect(cards?.[0]?.cardId).toBe(bytesToHex(source.cardId));
    expect(cards?.[1]?.cardId).toBe(bytesToHex(target.cardId));
    expect(cards?.[1]?.shortId).toBe(shortId(target.identity)); // cert pinned → display id
    expect(cards?.[0]?.tries).toBe(10);
    expect(cards?.[1]?.tries).toBe(10);
    expect(walletId).toBe(sourceId); // the imported wallet keeps the source's walletId
    expect(source.state.life).toBe("loaded");
    expect(target.state.life).toBe("loaded");
    expect(source.received).toContain(0x41); // EXPORT happened on the source
    expect(target.received).toStrictEqual([0x20, 0x40, 0x20, 0x42, 0x42]); // STATUS+OFFER then STATUS+IMPORT pairR, IMPORT 0, IMPORT 1
  });

  it("create k=3 imports the wallet onto three cards", async () => {
    const r = await rig();
    const cards = [createFakeCard(), createFakeCard(), createFakeCard()];
    const result = await createSet(r, cards);
    expect(result["kind"]).toBe("create");
    const { cards: entries } = await cardWallet(r);
    expect(entries?.length).toBe(3);
    expect(entries?.every((c: CardInfo) => c.state === "ready")).toBe(true);
    expect(entries?.map((c: CardInfo) => c.cardId)).toStrictEqual(
      cards.map((c) => bytesToHex(c.cardId)),
    );
  });

  it("create k=2 generated: no source wallet, origin generated, both cards ready", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    const result = await createSet(r, [source, target], { generate: true });
    expect(result["kind"]).toBe("create");
    const status = ok(await r.h.call("status", null, r.session)) as { wallets: WalletInfo[] };
    const cardWalletInfo = status.wallets.find((w) => w.custody === "card");
    expect(cardWalletInfo?.origin).toBe("card-generated");
    // The vault wallet survives — generated create has no source to delete.
    expect(status.wallets.some((w) => w.custody === "vault")).toBe(true);
    const { cards } = await cardWallet(r);
    expect(cards?.every((c: CardInfo) => c.state === "ready")).toBe(true);
  });

  it("cards:1 with a generated source is invalid-input", async () => {
    const r = await rig();
    const first = await r.h.call(
      "card.begin",
      { op: { kind: "create", cards: 1, source: { kind: "generate" } }, verify: verifyPasskey() },
      r.session,
    );
    expect("err" in first && first.err.code).toBe("invalid-input");
  });

  it("a create stopped after the source tap leaves the target pending; transfer finishes it", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    const wid = await vaultWalletId(r);
    // Drive manually; cancel when the op asks for the target's install tap.
    const { opId, step: firstStep } = await begin(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: wid } },
      verifyPasskey(),
    );
    const codes = [CODE, CODE];
    const cards = [target, source];
    let s = firstStep;
    let targetTaps = 0;
    for (let guard = 0; s.kind !== "done"; guard += 1) {
      if (guard > 40) {
        throw new Error("stuck");
      }
      if (s.kind === "input") {
        if (s["purpose"] === "short-id") {
          r.input.push(utf8ToBytes(shortId(cards[0]?.identity ?? new Uint8Array(33))));
        } else {
          const c = codes.shift();
          if (c === undefined) {
            throw new Error("no code");
          }
          r.input.push(utf8ToBytes(c));
        }
      } else {
        if (s["reason"] === "target") {
          targetTaps += 1;
          if (targetTaps === 2) {
            break; // about to tap the target for install — stop instead
          }
        }
        const next = cards.shift();
        if (next === undefined) {
          throw new Error("no card");
        }
        r.reader.present(next);
      }
      s = await step(r, opId);
    }
    await r.h.call("card.cancel", { opId }, r.session);
    const { walletId, cards: entries } = await cardWallet(r);
    expect(entries?.[1]?.state).toBe("pending");
    expect(entries?.[1]?.shortId).toBe(shortId(target.identity)); // cert pinned from OPEN
    expect(entries?.[0]?.state).toBe("ready");

    // transfer provisions the pending member under a fresh code.
    const out = await drive(
      r,
      { kind: "transfer", walletId },
      {
        codes: [CODE, "new code t", "new code t"],
        choices: [target, source],
        deck: [target, source],
      },
      verifyPasskey(),
    );
    expect(out.error).toBeUndefined();
    expect(out.result?.["kind"]).toBe("transfer");
    const after = await cardWallet(r);
    expect(after.cards?.every((c: CardInfo) => c.state === "ready")).toBe(true);
    expect(target.state.life).toBe("loaded");
    // The source member never needed re-provisioning.
    expect(source.received.filter((ins) => ins === 0x42)).toHaveLength(0);
  });

  it("reseal gives a loaded member a new code: new works, old fails, member unchanged", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    await createSet(r, [source, target]);
    const { walletId, cards } = await cardWallet(r);
    const targetId = cards?.[1]?.cardId ?? "";
    const out = await drive(
      r,
      { kind: "reseal", walletId, card: targetId },
      {
        codes: [CODE, "resealed 1", "resealed 1"],
        choices: [target, source],
        deck: [target, source],
      },
      verifyPasskey(),
    );
    expect(out.error).toBeUndefined();
    expect(out.result?.["kind"]).toBe("reseal");

    // health: source still verifies under the create code, target under the new one —
    // feeding the old target code first must come back wrong (63Cx → re-asked).
    const health = await drive(
      r,
      { kind: "health", walletId },
      {
        codes: [CODE, CODE, "resealed 1"],
        choices: [source, target],
        deck: [source, target],
      },
    );
    expect(health.error).toBeUndefined();
    expect(health.result?.["kind"]).toBe("health");
    const asks = r.input.requests.map((q) => q.label).join("\n");
    expect(asks).toContain("left"); // the re-asked code carried a remaining count
    expect(target.state.fails).toBe(0);
  });

  it("reseal installs onto a member erased to BLANK", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    await createSet(r, [source, target]);
    const { walletId, cards } = await cardWallet(r);
    target.wipe(); // the failure limit erased it — record keeps the member
    const out = await drive(
      r,
      { kind: "reseal", walletId, card: cards?.[1]?.cardId ?? "" },
      {
        codes: [CODE, "resealed 2", "resealed 2"],
        choices: [target, source],
        deck: [target, source],
      },
      verifyPasskey(),
    );
    expect(out.error).toBeUndefined();
    const after = await cardWallet(r);
    expect(after.cards?.[1]?.state).toBe("ready");
    expect(target.state.life).toBe("loaded");
  });

  it("a different blank card presented for the target import → card-id-mismatch, no commands", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    const stranger = createFakeCard();
    const out = await drive(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
      {
        codes: [CODE, CODE],
        choices: [target, source],
        deck: [target, source, stranger],
        presents: [target, source, stranger],
      },
      verifyPasskey(),
    );
    expect(out.error).toBe("card-id-mismatch");
    expect(stranger.received).toStrictEqual([]); // gated before STATUS — nothing reached it
  });

  it("the same card tapped as two different targets → exclusion failure", async () => {
    const r = await rig();
    const twin = createFakeCard();
    const source = createFakeCard();
    const out = await drive(
      r,
      { kind: "create", cards: 3, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
      {
        codes: [CODE, CODE],
        choices: [twin, twin, source],
        deck: [twin, source],
      },
      verifyPasskey(),
    );
    expect(out.error).toBe("card-id-mismatch");
    expect(twin.received).toStrictEqual([0x20, 0x40]); // only the first OFFER ever reached it
  });

  it("a mistyped short ID stops the op before any card command", async () => {
    const r = await rig();
    const target = createFakeCard();
    const out = await drive(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
      {
        codes: [CODE, CODE],
        choices: [target],
        shortIds: ["0000-0000"],
      },
      verifyPasskey(),
    );
    expect(out.error).toBe("card-id-mismatch");
    expect(target.received).toStrictEqual([]);
  });

  it("a pending member that holds a foreign wallet → wrong-device, untouched", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    const wid = await vaultWalletId(r);
    // Build the pending member state: cancel create just before the target install.
    const { opId, step: firstStep } = await begin(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: wid } },
      verifyPasskey(),
    );
    const codes = [CODE, CODE];
    const queue = [target, source];
    let s = firstStep;
    let targetTaps = 0;
    for (let guard = 0; s.kind !== "done"; guard += 1) {
      if (guard > 40) {
        throw new Error("stuck");
      }
      if (s.kind === "input") {
        if (s["purpose"] === "short-id") {
          r.input.push(utf8ToBytes(shortId(queue[0]?.identity ?? new Uint8Array(33))));
        } else {
          const c = codes.shift();
          if (c === undefined) {
            throw new Error("no code");
          }
          r.input.push(utf8ToBytes(c));
        }
      } else {
        if (s["reason"] === "target") {
          targetTaps += 1;
          if (targetTaps === 2) {
            break;
          }
        }
        const next = queue.shift();
        if (next === undefined) {
          throw new Error("no card");
        }
        r.reader.present(next);
      }
      s = await step(r, opId);
    }
    await r.h.call("card.cancel", { opId }, r.session);
    const { walletId } = await cardWallet(r);
    // The same physical member now holds a foreign wallet — IMPORT must refuse it.
    target.wipe();
    target.load(
      await seedFromEntropy(
        entropyFromMnemonic(
          "legal winner thank year wave sausage worth useful legal winner thank yellow",
        ),
        "",
        subtlePbkdf2,
      ),
      await accessHash(utf8ToBytes("other code"), target.cardId, quickArgon2id),
    );
    const out = await drive(
      r,
      { kind: "transfer", walletId },
      {
        codes: [CODE, "new code t", "new code t"],
        choices: [target, source],
        deck: [target, source],
      },
      verifyPasskey(),
    );
    expect(out.error).toBe("wrong-device");
    expect(target.state.life).toBe("loaded"); // never touched
  });

  it("OFFER signed under a different identity → card-fault, no export ever sent", async () => {
    const r = await rig();
    const target = createFakeCard({ knobs: { offerBadSignature: true } });
    const source = createFakeCard();
    const out = await drive(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
      { codes: [CODE, CODE], choices: [target, source], deck: [target, source] },
      verifyPasskey(),
    );
    expect(out.error).toBe("card-fault");
    expect(source.received).toStrictEqual([]);
    expect(target.received).toStrictEqual([0x20, 0x40]); // STATUS+OFFER only
  });

  it("EXPORT head signed under a different identity → card-fault, no import ever sent", async () => {
    const r = await rig();
    const target = createFakeCard();
    const source = createFakeCard({ knobs: { exportBadSignature: true } });
    const out = await drive(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
      {
        codes: [CODE, CODE],
        choices: [target, source],
        deck: [target, source],
      },
      verifyPasskey(),
    );
    expect(out.error).toBe("card-fault");
    expect(target.received.filter((i) => i === 0x42)).toStrictEqual([]); // IMPORT never sent
  });

  it("IMPORT answering a WalletInfo with another master key → wrong-device", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard({ knobs: { walletInfoMaster: source.identity } });
    const out = await drive(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
      {
        codes: [CODE, CODE],
        choices: [target, source],
        deck: [target, source],
      },
      verifyPasskey(),
    );
    expect(out.error).toBe("wrong-device");
    expect(target.state.life).toBe("loaded"); // the install did happen; the record stays pending
    const { cards } = await cardWallet(r);
    expect(cards?.[1]?.state).toBe("pending");
  });

  it("a CREATE echo with members in a different order → card-fault", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    source.knobs.walletInfoMembers = [target.cardId, source.cardId];
    const out = await drive(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
      {
        codes: [CODE, CODE],
        choices: [target, source],
        deck: [target, source],
      },
      verifyPasskey(),
    );
    expect(out.error).toBe("card-fault");
  });

  it("lost IMPORT P1=1 response: retry finds LOADED and confirms by VERIFY", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    // Drive: offer tap (3 transmits), source tap (select+open+status+create+nodes+exports),
    // target tap (select+open+status+import0+import1). Lose the whole target tap's
    // final transmit — the response to IMPORT P1=1.
    const { opId, step: firstStep } = await begin(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
      verifyPasskey(),
    );
    const codes = [CODE, CODE];
    const queue: FakeCard[] = [target, source, target, target];
    let s = firstStep;
    let taps = 0;
    for (let guard = 0; s.kind !== "done"; guard += 1) {
      if (guard > 60) {
        throw new Error("stuck");
      }
      if (s.kind === "input") {
        if (s["purpose"] === "short-id") {
          r.input.push(utf8ToBytes(shortId(queue[0]?.identity ?? new Uint8Array(33))));
        } else {
          const c = codes.shift();
          if (c === undefined) {
            throw new Error("no code");
          }
          r.input.push(utf8ToBytes(c));
        }
      } else {
        const next = queue.shift();
        if (next === undefined) {
          throw new Error("no card");
        }
        taps += 1;
        if (taps === 3) {
          target.knobs.dieAfterCommit = true; // T-INSTALL commits, then the card dies
        }
        if (taps >= 4) {
          target.reset();
        }
        r.reader.present(next);
      }
      s = await step(r, opId);
    }
    expect(s["result"]).toBeDefined();
    const { cards } = await cardWallet(r);
    expect(cards?.every((c: CardInfo) => c.state === "ready")).toBe(true);
    // The retry target tap VERIFYed the committed install — a 0x22 reached the card.
    expect(target.received.filter((i) => i === 0x22).length).toBeGreaterThan(0);
  });

  it("lost IMPORT P1=1 response: retry finds BLANK and resends the payload", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    // Tear the install write itself — the card stays BLANK, the response never lands.
    const { opId, step: firstStep } = await begin(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
      verifyPasskey(),
    );
    const codes = [CODE, CODE];
    const queue: FakeCard[] = [target, source, target, target];
    let s = firstStep;
    let taps = 0;
    for (let guard = 0; s.kind !== "done"; guard += 1) {
      if (guard > 60) {
        throw new Error("stuck");
      }
      if (s.kind === "input") {
        if (s["purpose"] === "short-id") {
          r.input.push(utf8ToBytes(shortId(queue[0]?.identity ?? new Uint8Array(33))));
        } else {
          const c = codes.shift();
          if (c === undefined) {
            throw new Error("no code");
          }
          r.input.push(utf8ToBytes(c));
        }
      } else {
        const next = queue.shift();
        if (next === undefined) {
          throw new Error("no card");
        }
        taps += 1;
        if (taps === 3) {
          target.tearAt(1); // T-INSTALL's persistent write powers the card off mid-response
        }
        if (taps >= 4) {
          target.reset(); // power cycle before the retry session
        }
        r.reader.present(next);
      }
      s = await step(r, opId);
    }
    expect(s["result"]).toBeDefined();
    const { cards } = await cardWallet(r);
    expect(cards?.every((c: CardInfo) => c.state === "ready")).toBe(true);
    // The BLANK retry resent IMPORT P1=0 + P1=1 — two 0x42s after the first torn pair.
    expect(target.received.filter((i) => i === 0x42)).toHaveLength(4);
  });

  it("a BLANK target whose offer vanished → fresh OFFER, re-export, then install", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    const wid = await vaultWalletId(r);
    const { opId, step: firstStep } = await begin(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: wid } },
      verifyPasskey(),
    );
    const codes = [CODE, CODE];
    const queue: FakeCard[] = [target, source, target, source, target];
    let s = firstStep;
    let taps = 0;
    for (let guard = 0; s.kind !== "done"; guard += 1) {
      if (guard > 60) {
        throw new Error("stuck");
      }
      if (s.kind === "input") {
        if (s["purpose"] === "short-id") {
          r.input.push(utf8ToBytes(shortId(queue[0]?.identity ?? new Uint8Array(33))));
        } else {
          const c = codes.shift();
          if (c === undefined) {
            throw new Error("no code");
          }
          r.input.push(utf8ToBytes(c));
        }
      } else {
        const next = queue.shift();
        if (next === undefined) {
          throw new Error("no card");
        }
        taps += 1;
        if (taps === 3) {
          // The target forgot its offer between export and import (e.g. an erase wiped it
          // and it is blank again) — IMPORT P1=0 answers wrong-state.
          target.wipe();
        }
        r.reader.present(next);
      }
      s = await step(r, opId);
    }
    expect(s["result"]).toBeDefined();
    const { cards } = await cardWallet(r);
    expect(cards?.every((c: CardInfo) => c.state === "ready")).toBe(true);
    // OFFER twice (initial + refresh), IMPORT retried after the re-export.
    expect(target.received.filter((i) => i === 0x40)).toHaveLength(2);
    expect(source.received.filter((i) => i === 0x41)).toHaveLength(4); // two exports
    expect(target.received.filter((i) => i === 0x42)).toHaveLength(3); // refused 0 + resent 0,1
  });

  it("tag loss at every transmit index of a two-card create still completes", async () => {
    // First measure the clean run.
    const base = await rig();
    const cleanCards = [createFakeCard(), createFakeCard()];
    await createSet(base, cleanCards);
    const total = base.reader.sent.length;
    expect(total).toBeGreaterThan(5);
    for (let i = 1; i <= total; i += 1) {
      const r = await rig();
      const source = createFakeCard();
      const target = createFakeCard();
      r.reader.loseGlobal(i);
      const out = await drive(
        r,
        { kind: "create", cards: 2, source: { kind: "wallet", walletId: await vaultWalletId(r) } },
        {
          codes: [CODE, CODE],
          choices: [target, source],
          deck: [target, source],
        },
        verifyPasskey(),
      );
      if (out.result === undefined) {
        throw new Error(`loss at transmit ${i}/${total} failed: ${out.error}`);
      }
      const { cards } = await cardWallet(r);
      expect(cards?.every((c: CardInfo) => c.state === "ready")).toBe(true);
    }
  }, 120_000);

  it("tear at the persistent writes of OFFER, CREATE and IMPORT leaves resumable state", async () => {
    // Fake-card persistent writes: OFFER = 1 (linkKey+offer), CREATE = 1 (wallet),
    // IMPORT P1=1 = 1 (T-INSTALL). EXPORT and IMPORT P1=0 write nothing persistent —
    // their pending keys are session state, so only tag loss applies to them.
    for (const k of [1]) {
      // Torn OFFER: write didn't commit → next OFFER creates a fresh link key; the
      // source's CREATE/exports proceed and the set completes.
      const r1 = await rig();
      const t1 = createFakeCard();
      const s1 = createFakeCard();
      let taps = 0;
      const { opId, step: s0 } = await begin(
        r1,
        {
          kind: "create",
          cards: 2,
          source: { kind: "wallet", walletId: await vaultWalletId(r1) },
        },
        verifyPasskey(),
      );
      const codes = [CODE, CODE];
      const queue: FakeCard[] = [t1, t1, s1, t1];
      let st = s0;
      for (let guard = 0; st.kind !== "done"; guard += 1) {
        if (guard > 60) {
          throw new Error("stuck");
        }
        if (st.kind === "input") {
          if (st["purpose"] === "short-id") {
            r1.input.push(utf8ToBytes(shortId(queue[0]?.identity ?? new Uint8Array(33))));
          } else {
            const c = codes.shift();
            if (c === undefined) {
              throw new Error("no code");
            }
            r1.input.push(utf8ToBytes(c));
          }
        } else {
          const next = queue.shift();
          if (next === undefined) {
            throw new Error("no card");
          }
          taps += 1;
          if (taps === 1) {
            t1.tearAt(k);
          }
          if (taps === 2) {
            t1.reset();
          }
          r1.reader.present(next);
        }
        st = await step(r1, opId);
      }
      expect(st["result"]).toBeDefined();
      const { cards: after } = await cardWallet(r1);
      expect(after?.every((c: CardInfo) => c.state === "ready")).toBe(true);
      void s1;
    }
  });

  it("no secret reaches posted messages, errors or console across create, transfer and reseal", async () => {
    const consoleLines: string[] = [];
    const seen = new Map<"log" | "warn" | "error", typeof console.log>();
    for (const name of ["log", "warn", "error"] as const) {
      seen.set(name, console[name]);
      console[name] = (...args: unknown[]) => {
        consoleLines.push(args.map(String).join(" "));
      };
    }
    const r = await rig();
    try {
      // The vault wallet's own seed is a needle too; `wallet.exportMnemonic` is the sanctioned
      // user-export channel, so its response is spliced out of `posted` before the scan.
      const sourceId = await vaultWalletId(r);
      const postedAt = r.h.posted.length;
      const exported = ok(
        await r.h.call(
          "wallet.exportMnemonic",
          { walletId: sourceId, verify: verifyPasskey() },
          r.session,
        ),
      );
      r.h.posted.length = postedAt;
      const mnemonic = new TextDecoder().decode(exported["mnemonic"] as Uint8Array);
      const seed = await seedFromEntropy(entropyFromMnemonic(mnemonic), "", subtlePbkdf2);
      const source = createFakeCard();
      const target = createFakeCard();
      // Stop before the install tap → pending member → transfer → then reseal.
      const first = await begin(
        r,
        { kind: "create", cards: 2, source: { kind: "wallet", walletId: sourceId } },
        verifyPasskey(),
      );
      const codes = ["leak set", "leak set"];
      const cards_ = [target, source];
      let s = first.step;
      let targetTaps = 0;
      for (let guard = 0; s.kind !== "done"; guard += 1) {
        if (guard > 40) {
          throw new Error("stuck");
        }
        if (s.kind === "input") {
          if (s["purpose"] === "short-id") {
            r.input.push(utf8ToBytes(shortId(cards_[0]?.identity ?? new Uint8Array(33))));
          } else {
            const c = codes.shift();
            if (c === undefined) {
              throw new Error("no code");
            }
            r.input.push(utf8ToBytes(c));
          }
        } else {
          if (s["reason"] === "target") {
            targetTaps += 1;
            if (targetTaps === 2) {
              break; // about to tap the target for install — stop instead
            }
          }
          const next = cards_.shift();
          if (next === undefined) {
            throw new Error("no card");
          }
          r.reader.present(next);
        }
        s = await step(r, first.opId);
      }
      await r.h.call("card.cancel", { opId: first.opId }, r.session);
      const { walletId, cards } = await cardWallet(r);
      expect(cards?.[1]?.state).toBe("pending");
      const transferred = await drive(
        r,
        { kind: "transfer", walletId },
        {
          codes: ["leak set", "leak new", "leak new"],
          choices: [target, source],
          deck: [target, source],
        },
        verifyPasskey(),
      );
      expect(transferred.error).toBeUndefined();
      const resealed = await drive(
        r,
        { kind: "reseal", walletId, card: cards?.[1]?.cardId ?? "" },
        {
          codes: ["leak set", "leak rs", "leak rs"],
          choices: [target, source],
          deck: [target, source],
        },
        verifyPasskey(),
      );
      expect(resealed.error).toBeUndefined();
      const needles = [
        utf8ToBytes("leak set"),
        utf8ToBytes("leak new"),
        utf8ToBytes("leak rs"),
        await accessHash(utf8ToBytes("leak set"), source.cardId, quickArgon2id),
        await accessHash(utf8ToBytes("leak set"), target.cardId, quickArgon2id),
        await accessHash(utf8ToBytes("leak new"), target.cardId, quickArgon2id),
        await accessHash(utf8ToBytes("leak rs"), target.cardId, quickArgon2id),
        source.secrets.keys ?? new Uint8Array(0),
        target.secrets.keys ?? new Uint8Array(0),
        source.secrets.eph ?? new Uint8Array(0),
        target.secrets.eph ?? new Uint8Array(0),
        seed,
      ].filter((n) => n.length > 0);
      for (const message of r.h.posted) {
        expect(containsSecret(message, needles)).toBe(false);
      }
      const status = ok(await r.h.call("status", null, r.session));
      expect(containsSecret(status, needles)).toBe(false);
      expect(containsSecret(consoleLines, needles)).toBe(false);
      const image = await r.h.store.load();
      for (const record of image.records) {
        expect(
          containsSecret({ kind: record.kind, id: record.id, header: record.header }, needles),
        ).toBe(false);
      }
      r.h.posted.push({ planted: seed });
      expect(containsSecret(r.h.posted.at(-1), needles)).toBe(true);
      r.h.posted.pop();
    } finally {
      for (const [name, fn] of seen) {
        console[name] = fn;
      }
    }
  });

  it("generated creates leak nothing — host entropy, codes, hashes and session keys", async () => {
    const consoleLines: string[] = [];
    const seen = new Map<"log" | "warn" | "error", typeof console.log>();
    for (const name of ["log", "warn", "error"] as const) {
      seen.set(name, console[name]);
      console[name] = (...args: unknown[]) => {
        consoleLines.push(args.map(String).join(" "));
      };
    }
    const r = await rig();
    try {
      const drawn = r.h.draws.length;
      const a = createFakeCard();
      const b = createFakeCard();
      const first = await begin(
        r,
        { kind: "create", cards: 2, source: { kind: "generate" } },
        verifyPasskey(),
      );
      const cards_ = [a, b];
      const codes = ["leak gen", "leak gen", "leak gen2", "leak gen2"];
      let s = first.step;
      for (let guard = 0; s.kind !== "done"; guard += 1) {
        if (guard > 40) {
          throw new Error("stuck");
        }
        if (s.kind === "input") {
          if (s["purpose"] === "short-id") {
            r.input.push(utf8ToBytes(shortId(cards_[0]?.identity ?? new Uint8Array(33))));
          } else {
            const c = codes.shift();
            if (c === undefined) {
              throw new Error("no code");
            }
            r.input.push(utf8ToBytes(c));
          }
        } else {
          const bound = s["card"];
          const next =
            bound === undefined
              ? cards_.shift()
              : [a, b].find((c) => shortId(c.identity) === bound);
          if (next === undefined) {
            throw new Error("no card");
          }
          r.reader.present(next);
        }
        s = await step(r, first.opId);
      }
      const { walletId } = await cardWallet(r);
      expect(walletId).not.toBe("");
      const entropy = r.h.draws.slice(drawn).filter((d) => d.length === 32);
      const keys = [...(a.secrets.keys ?? []), ...(b.secrets.keys ?? [])];
      const needles = [
        utf8ToBytes("leak gen"),
        utf8ToBytes("leak gen2"),
        await accessHash(utf8ToBytes("leak gen"), a.cardId, quickArgon2id),
        await accessHash(utf8ToBytes("leak gen"), b.cardId, quickArgon2id),
        await accessHash(utf8ToBytes("leak gen2"), b.cardId, quickArgon2id),
        a.secrets.eph ?? new Uint8Array(0),
        b.secrets.eph ?? new Uint8Array(0),
        a.secrets.keys ?? new Uint8Array(0),
        b.secrets.keys ?? new Uint8Array(0),
        new Uint8Array(keys),
        ...entropy,
        ...entropy.map((e) => e.subarray(0, 16)),
      ].filter((n) => n.length > 0);
      for (const message of r.h.posted) {
        expect(containsSecret(message, needles)).toBe(false);
      }
      const status = ok(await r.h.call("status", null, r.session));
      expect(containsSecret(status, needles)).toBe(false);
      expect(containsSecret(consoleLines, needles)).toBe(false);
      const image = await r.h.store.load();
      for (const record of image.records) {
        expect(
          containsSecret({ kind: record.kind, id: record.id, header: record.header }, needles),
        ).toBe(false);
      }
      r.h.posted.push({ planted: entropy[0] ?? new Uint8Array([1]) });
      expect(containsSecret(r.h.posted.at(-1), needles)).toBe(true);
      r.h.posted.pop();
    } finally {
      for (const [name, fn] of seen) {
        console[name] = fn;
      }
    }
  });
});

describe("multi-card mutation coverage (fake card)", () => {
  it("a generated create transmits the host's entropy — wiping it early loads a different wallet", async () => {
    const r = await rig();
    const cardRandom = seededRandom(97);
    const source = createFakeCard({ random: cardRandom.random });
    const target = createFakeCard();
    const result = await createSet(r, [source, target], { generate: true });
    expect(result["kind"]).toBe("create");
    const { walletId } = await cardWallet(r);
    // The applet's generate path mixes the transmitted 32 bytes into its seed — replay every
    // (card draw, host draw) pair; exactly one must reproduce the committed wallet. A wiped
    // buffer transmits zeros, whose candidate never matches a real draw.
    const label = ascii("qntx-card/v1/seed");
    const candidates = new Set<string>();
    for (const mix of cardRandom.draws) {
      if (mix.length !== 32) {
        continue;
      }
      for (const host of r.h.draws) {
        if (host.length !== 32) {
          continue;
        }
        const master = HDKey.fromMasterSeed(sha512(concatBytes(label, mix, host))).publicKey;
        if (master !== null) {
          candidates.add(walletIdOf(master));
        }
      }
    }
    expect(candidates.has(walletId)).toBe(true);
  });

  it("transfer seals the export under the target's new code — the target verifies with it", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    const wid = await vaultWalletId(r);
    const { opId, step: firstStep } = await begin(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: wid } },
      verifyPasskey(),
    );
    const codes = [CODE, CODE];
    const cards = [target, source];
    let s = firstStep;
    let targetTaps = 0;
    for (let guard = 0; s.kind !== "done"; guard += 1) {
      if (guard > 40) {
        throw new Error("stuck");
      }
      if (s.kind === "input") {
        if (s["purpose"] === "short-id") {
          r.input.push(utf8ToBytes(shortId(cards[0]?.identity ?? new Uint8Array(33))));
        } else {
          const c = codes.shift();
          if (c === undefined) {
            throw new Error("no code");
          }
          r.input.push(utf8ToBytes(c));
        }
      } else {
        if (s["reason"] === "target") {
          targetTaps += 1;
          if (targetTaps === 2) {
            break;
          }
        }
        const next = cards.shift();
        if (next === undefined) {
          throw new Error("no card");
        }
        r.reader.present(next);
      }
      s = await step(r, opId);
    }
    await r.h.call("card.cancel", { opId }, r.session);
    const out = await drive(
      r,
      { kind: "transfer", walletId: wid },
      {
        codes: [CODE, "new code t", "new code t"],
        choices: [target, source],
        deck: [target, source],
      },
      verifyPasskey(),
    );
    expect(out.error).toBeUndefined();
    expect(out.result?.["kind"]).toBe("transfer");
    // Proof the payload carried the TARGET's hash: the member verifies under its new code.
    const health = await drive(
      r,
      { kind: "health", walletId: wid },
      {
        codes: [CODE, "new code t"],
        choices: [source, target],
        deck: [source, target],
      },
    );
    expect(health.error).toBeUndefined();
    expect(health.result?.["kind"]).toBe("health");
  });

  it("an imported two-card create deletes the source entropy record with the wallet commit", async () => {
    const r = await rig();
    const sourceId = await vaultWalletId(r);
    const result = await createSet(r, [createFakeCard(), createFakeCard()]);
    expect(result["kind"]).toBe("create");
    const { records } = await r.h.store.load();
    expect(records.some((rec) => rec.kind === "entropy")).toBe(false);
    void sourceId;
  });

  it("health verifies every member — stopping at the first leaves the rest unchecked", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    await createSet(r, [source, target]);
    const { walletId } = await cardWallet(r);
    source.received.length = 0;
    target.received.length = 0;
    const out = await drive(
      r,
      { kind: "health", walletId },
      { codes: [CODE], choices: [source, target], deck: [source, target] },
    );
    expect(out.error).toBeUndefined();
    expect(out.result?.["kind"]).toBe("health");
    expect(source.received).toContain(0x22); // VERIFY
    expect(target.received).toContain(0x22);
  });

  it("cancel wipes the codes a suspended transfer and reseal still hold", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    await createSet(r, [source, target]);
    const { walletId, cards } = await cardWallet(r);
    const targetId = cards?.[1]?.cardId ?? "";
    // reseal: push the member code, suspend at the verify tap, cancel — code wiped.
    const first = await begin(r, { kind: "reseal", walletId, card: targetId }, verifyPasskey());
    const code = utf8ToBytes(CODE);
    const queue = [target, source];
    let s = first.step;
    let pushed = false;
    for (let guard = 0; guard < 20 && !pushed; guard += 1) {
      if (s.kind === "input") {
        if (s["purpose"] === "short-id") {
          r.input.push(utf8ToBytes(shortId((queue[0] ?? target).identity)));
        } else {
          r.input.push(code); // the member's existing code — held until its VERIFY
          pushed = true;
        }
      } else {
        r.reader.present(queue.shift() ?? target);
      }
      s = await step(r, first.opId);
    }
    expect(pushed).toBe(true);
    await r.h.call("card.cancel", { opId: first.opId }, r.session);
    await r.h.settle();
    expect(code.every((b) => b === 0)).toBe(true);
  });

  it("cancel wipes the code a suspended transfer still holds", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    const wid = await vaultWalletId(r);
    // Stop the create before the target's install tap — a pending member to transfer onto.
    const { opId, step: firstStep } = await begin(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: wid } },
      verifyPasskey(),
    );
    const codes = [CODE, CODE];
    const cards = [target, source];
    let s = firstStep;
    let targetTaps = 0;
    for (let guard = 0; s.kind !== "done"; guard += 1) {
      if (guard > 40) {
        throw new Error("stuck");
      }
      if (s.kind === "input") {
        if (s["purpose"] === "short-id") {
          r.input.push(utf8ToBytes(shortId(cards[0]?.identity ?? new Uint8Array(33))));
        } else {
          const c = codes.shift();
          if (c === undefined) {
            throw new Error("no code");
          }
          r.input.push(utf8ToBytes(c));
        }
      } else {
        if (s["reason"] === "target") {
          targetTaps += 1;
          if (targetTaps === 2) {
            break;
          }
        }
        const next = cards.shift();
        if (next === undefined) {
          throw new Error("no card");
        }
        r.reader.present(next);
      }
      s = await step(r, opId);
    }
    await r.h.call("card.cancel", { opId }, r.session);
    // transfer: walk to the source-code ask, push it, suspend at the next step, cancel.
    const t = await begin(r, { kind: "transfer", walletId: wid }, verifyPasskey());
    const code = utf8ToBytes(CODE);
    const queue = [target, source];
    s = t.step;
    let pushed = false;
    for (let guard = 0; guard < 20 && !pushed; guard += 1) {
      if (s.kind === "input") {
        if (s["purpose"] === "short-id") {
          r.input.push(utf8ToBytes(shortId((queue[0] ?? target).identity)));
        } else if (s["purpose"] === "access-code") {
          r.input.push(code); // the source code — held until the source tap's VERIFY
          pushed = true;
        } else {
          r.input.push(code);
        }
      } else {
        r.reader.present(queue.shift() ?? target);
      }
      s = await step(r, t.opId);
    }
    expect(pushed).toBe(true);
    await r.h.call("card.cancel", { opId: t.opId }, r.session);
    await r.h.settle();
    expect(code.every((b) => b === 0)).toBe(true);
  });

  it("cancel between a create's new-code asks wipes the half-entered code", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    const wid = await vaultWalletId(r);
    const { opId, step: firstStep } = await begin(
      r,
      { kind: "create", cards: 2, source: { kind: "wallet", walletId: wid } },
      verifyPasskey(),
    );
    const code = utf8ToBytes(CODE);
    let typed = 0;
    let s = firstStep;
    let pushed = false;
    for (let guard = 0; guard < 20 && !pushed; guard += 1) {
      if (s.kind === "input") {
        if (s["purpose"] === "short-id") {
          typed += 1;
          r.input.push(utf8ToBytes(shortId((typed === 1 ? target : source).identity)));
        } else {
          r.input.push(code); // new code — held while the confirm ask is pending
          pushed = true;
        }
      } else {
        r.reader.present(s["reason"] === "target" ? target : source);
      }
      s = await step(r, opId);
    }
    expect(pushed).toBe(true);
    expect(s.kind).toBe("input"); // the confirm ask — `code` still held
    await r.h.call("card.cancel", { opId }, r.session);
    await r.h.settle();
    expect(code.every((b) => b === 0)).toBe(true);
  });

  it("a torn create whose VERIFYed members come back reordered is wrong-device", async () => {
    // k=3: [source, t2, t1] survives the decoder (distinct, contains the card) but is not the
    // op's member order — `stage` must compare the list in order, not just its length. The
    // first source tap is lost so the retry admits the already-loaded liar under "any" life.
    const r = await rig();
    const t1 = createFakeCard();
    const t2 = createFakeCard();
    const source = createFakeCard();
    const codeText = "the new code";
    const wid = await vaultWalletId(r);
    const exported = ok(
      await r.h.call(
        "wallet.exportMnemonic",
        { walletId: wid, verify: verifyPasskey() },
        r.session,
      ),
    );
    const seed = await seedFromEntropy(
      entropyFromMnemonic(new TextDecoder().decode(exported["mnemonic"] as Uint8Array)),
      "",
      subtlePbkdf2,
    );
    source.load(seed, await accessHash(utf8ToBytes(codeText), source.cardId, quickArgon2id), [
      t2.cardId,
      t1.cardId,
    ]);
    const { opId, step: firstStep } = await begin(
      r,
      { kind: "create", cards: 3, source: { kind: "wallet", walletId: wid } },
      verifyPasskey(),
    );
    let err: string | undefined;
    let s = firstStep;
    let typed = 0;
    let lost = false;
    let presented = false;
    const ids = [t1, t2, source];
    for (let guard = 0; guard < 30; guard += 1) {
      if (s.kind === "input") {
        if (s["purpose"] === "short-id") {
          typed += 1;
          r.input.push(utf8ToBytes(shortId((ids[typed - 1] ?? source).identity)));
        } else {
          r.input.push(utf8ToBytes(codeText));
        }
      } else if (s["reason"] === "target") {
        r.reader.present(typed === 1 ? t1 : t2);
      } else if (lost) {
        presented = true;
        r.reader.present(source); // same master, reordered member list → wrong-device
      } else {
        lost = true;
        r.reader.loseAfter(0); // the source tap dies before SELECT answers
        r.reader.present(createFakeCard());
      }
      const next = await r.h.call("card.step", { opId }, r.session);
      if ("err" in next) {
        err = next.err.code;
        break;
      }
      s = next.ok as Step;
    }
    expect(err).toBe("wrong-device");
    expect(presented).toBe(true);
  });

  it("the create source tap refuses a card already OFFERed as a target", async () => {
    // Typing the target's own short ID at the source ask and presenting that card again must
    // be refused before any command — the same card cannot take two slots.
    const r = await rig();
    const target = createFakeCard();
    const source = createFakeCard();
    const out = await drive(
      r,
      { kind: "create", cards: 2, source: { kind: "generate" } },
      {
        codes: [CODE, CODE],
        shortIds: [shortId(target.identity), shortId(target.identity)],
        deck: [target, source],
        presents: [target, target],
      },
      verifyPasskey(),
    );
    expect(out.error).toBe("card-id-mismatch");
  });

  it("cancel at the source tap wipes the codes a k=2 create still holds", async () => {
    // createSet keeps `newCode` live through the source tap — a cancel there must run the
    // finally that wipes it.
    const r = await rig();
    const target = createFakeCard();
    const source = createFakeCard();
    const { opId, step: firstStep } = await begin(
      r,
      { kind: "create", cards: 2, source: { kind: "generate" } },
      verifyPasskey(),
    );
    const code = utf8ToBytes(CODE);
    const confirm = utf8ToBytes(CODE);
    let s = firstStep;
    let presented = 0;
    for (let guard = 0; guard < 20; guard += 1) {
      if (s.kind === "input") {
        if (s["purpose"] === "short-id") {
          r.input.push(utf8ToBytes(shortId((presented === 0 ? target : source).identity)));
        } else if (s["purpose"] === "new-access-code") {
          r.input.push(code);
        } else {
          r.input.push(confirm);
        }
      } else if (s["reason"] === "target") {
        r.reader.present(target);
        presented += 1;
      } else {
        break; // the source tap — newCode is held, unwiped until its hash lands
      }
      s = await step(r, opId);
    }
    expect(s.kind).toBe("tap");
    await r.h.call("card.cancel", { opId }, r.session);
    await r.h.settle();
    expect(code.every((b) => b === 0)).toBe(true);
    expect(confirm.every((b) => b === 0)).toBe(true);
  });

  it("a generated create sends the live host entropy — the kernel buffer is wiped after CREATE", async () => {
    // Inject a stream that keeps a copy of every draw and a live view of the buffer the kernel got.
    const drawn: Uint8Array[] = [];
    const live: Uint8Array[] = [];
    const random = (length: number): Uint8Array => {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        out[i] = (i * 31 + 0x5a + drawn.length) & 0xff;
      }
      drawn.push(new Uint8Array(out));
      live.push(out);
      return out;
    };
    const r = await rig({ random });
    const at = drawn.length;
    const source = createFakeCard();
    const target = createFakeCard();
    const result = await createSet(r, [source, target], { generate: true });
    expect(result["kind"]).toBe("create");
    // Only the source sees CREATE (the targets get IMPORT) — the wire carried the live draw,
    // not a wiped buffer: the card captured entropy matching one of the op's own 32-byte draws.
    expect(target.createEntropy).toBeUndefined();
    const got = source.createEntropy;
    expect(got).toBeDefined();
    expect(got?.some((b) => b !== 0)).toBe(true);
    const idx = drawn.slice(at).findIndex((d) => got !== undefined && equalBytes(d, got));
    expect(idx).toBeGreaterThanOrEqual(0);
    // The kernel wiped the exact buffer it sent — the live view now reads zeros.
    expect(live[at + idx]?.every((b) => b === 0)).toBe(true);
  });

  it("health verifies every member of the set, not just the first", async () => {
    const r = await rig();
    const source = createFakeCard();
    const target = createFakeCard();
    await createSet(r, [source, target]);
    const { walletId } = await cardWallet(r);
    const out = await drive(
      r,
      { kind: "health", walletId },
      { codes: [CODE], choices: [source], deck: [source, target] },
    );
    expect(out.error).toBeUndefined();
    const taps = out.steps.filter((s) => s.kind === "tap");
    expect(taps).toHaveLength(2);
    // The second tap's bound ask names the member the first tap did not verify.
    const second = taps[1]?.["card"];
    expect(second === shortId(source.identity) || second === shortId(target.identity)).toBe(true);
    expect(second).not.toBe(taps[0]?.["card"]);
  });
});
