// oxlint-disable eslint/no-await-in-loop, vitest/no-conditional-in-test, vitest/no-conditional-expect -- the step driver is sequential and conditional by design
/**
 * The layer-3 operations against the real qntx card applet in jcardsim (`QNTX_CARD_SIM`, skipped
 * without it): `create` imports a k=1 wallet through the kernel's whole pipeline, `status` reads
 * the card back, `health` verifies it, `change-access` rotates its code on the applet, `erase`
 * wipes it, and a `tear` on CREATE's persistent write leaves the card resumable by the op's
 * LOST-retry path.
 */
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { WalletInfo } from "@qntx/wallet/types";

import { cardId, shortId } from "../src/modules/card/protocol/identity.ts";
import { testSecureInput } from "./card/input.ts";
import { testCardReader } from "./card/reader.ts";
import { CA1_ANCHOR, SIM_LAUNCHER, startSimulator } from "./card/sim.ts";
import type { SimCard, Simulator } from "./card/sim.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { createHarness } from "./harness.ts";

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BTC_MAINNET = "bip122:000000000019d6689c085ae165831e93";
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

type Step = { kind: string; [k: string]: unknown };

type Rig = {
  h: Harness;
  session: string;
  reader: ReturnType<typeof testCardReader>;
  input: ReturnType<typeof testSecureInput>;
};

const rig = async (prfSeed = 2): Promise<Rig> => {
  const reader = testCardReader();
  const input = testSecureInput();
  const h = createHarness({
    card: { reader: reader.reader, anchors: [CA1_ANCHOR] },
    secureInput: input.secureInput,
  });
  const res = ok(
    await h.call("wallet.createWithPasskey", {
      ceremony: "host",
      credentialId: CREDENTIAL_ID,
      prfWallet: new Uint8Array(32).fill(prfSeed),
      synced: true,
      factor: verifyPasskey(),
    }),
  );
  return { h, session: String(res["session"]), reader, input };
};

/** A rig whose wallet differs from the default `prfSeed = 2` vaults — a genuine second vault. */
let altSeed = 0x40;
const altRig = async (): Promise<Rig> => {
  altSeed += 1;
  return rig(altSeed);
};

const vaultWalletId = async (r: Rig): Promise<string> => {
  const status = ok(await r.h.call("status", null, r.session)) as { wallets: WalletInfo[] };
  const vault = status.wallets.find((w) => w.custody === "vault");
  if (vault === undefined) {
    throw new Error("no vault wallet");
  }
  return vault.walletId;
};

/**
 * Drives a `card.begin` to `done`: codes queue in order, every `short-id` input answers with the
 * printed ID of `known` (the card about to be tapped), every tap presents the next queued card.
 */
const drive = async (
  r: Rig,
  op: unknown,
  actions: { codes?: Uint8Array[]; cards: SimCard[] },
  verify?: unknown,
): Promise<Record<string, unknown>> => {
  const first = ok(
    await r.h.call("card.begin", { op, ...(verify === undefined ? {} : { verify }) }, r.session),
  ) as { opId: string; step: Step };
  let { step } = first;
  for (let guard = 0; step.kind !== "done"; guard += 1) {
    if (guard > 60) {
      throw new Error(`operation did not finish: ${JSON.stringify(step)}`);
    }
    if (step.kind === "input") {
      if (step["purpose"] === "short-id") {
        const [upcoming] = actions.cards;
        if (upcoming === undefined) {
          throw new Error("short-id asked with no card queued");
        }
        r.input.push(utf8ToBytes(shortId(upcoming.identity)));
      } else {
        const code = actions.codes?.shift();
        if (code === undefined) {
          throw new Error(`unexpected input step ${JSON.stringify(step)}`);
        }
        r.input.push(code);
      }
    } else if (step.kind === "tap") {
      const [next] = actions.cards.splice(0, 1);
      if (next === undefined) {
        throw new Error(`unexpected tap step ${JSON.stringify(step)}`);
      }
      r.reader.present(next);
    }
    step = ok(await r.h.call("card.step", { opId: first.opId }, r.session)) as Step;
  }
  return step["result"] as Record<string, unknown>;
};

/** Like `drive`, but returns the first `card.begin`/`card.step` error code instead of a result. */
const driveErr = async (
  r: Rig,
  op: unknown,
  actions: { codes?: Uint8Array[]; cards: SimCard[] },
  verify?: unknown,
): Promise<string> => {
  const first = await r.h.call(
    "card.begin",
    { op, ...(verify === undefined ? {} : { verify }) },
    r.session,
  );
  if ("err" in first) {
    return first.err.code;
  }
  const { opId, step: firstStep } = first.ok as { opId: string; step: Step };
  let step = firstStep;
  for (let guard = 0; step.kind !== "done"; guard += 1) {
    if (guard > 60) {
      return "driver-guard";
    }
    if (step.kind === "input") {
      if (step["purpose"] === "short-id") {
        const [upcoming] = actions.cards;
        r.input.push(utf8ToBytes(shortId(upcoming?.identity ?? new Uint8Array(33))));
      } else {
        const code = actions.codes?.shift();
        if (code === undefined) {
          return "driver-no-code";
        }
        r.input.push(code);
      }
    } else {
      const next = actions.cards.shift();
      if (next === undefined) {
        return "driver-no-card";
      }
      r.reader.present(next);
    }
    const next = await r.h.call("card.step", { opId }, r.session);
    if ("err" in next) {
      return next.err.code;
    }
    step = next.ok as Step;
  }
  return "driver-done";
};

let simulator: Simulator;

describe.skipIf(SIM_LAUNCHER === undefined)("card operations (simulator)", () => {
  beforeAll(async () => {
    simulator = await startSimulator();
  });

  afterAll(async () => {
    await simulator.close();
  });

  it("create imports a k=1 wallet end to end on the real applet", async () => {
    const r = await rig();
    const source = await vaultWalletId(r);
    const card = await simulator.newCard();
    const result = await drive(
      r,
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
      {
        codes: [utf8ToBytes("sim code 1"), utf8ToBytes("sim code 1")],
        cards: Array.from({ length: 10 }, () => card),
      },
      verifyPasskey(),
    );
    expect(result["kind"]).toBe("create");
    const walletId = String(result["walletId"]);
    const status = ok(await r.h.call("status", null, r.session)) as { wallets: WalletInfo[] };
    const info = status.wallets.find((w) => w.walletId === walletId);
    if (info?.custody !== "card") {
      throw new Error("expected a card wallet");
    }
    expect(info.cards).toHaveLength(1);
    expect(info.cards[0]?.state).toBe("ready");
    const { records } = await r.h.store.load();
    expect(records.some((rec) => rec.id === source && rec.kind === "entropy")).toBe(false);
    expect(records.some((rec) => rec.id === walletId && rec.kind === "card-wallet")).toBe(true);
  });

  it("status and health on the created card", async () => {
    const r = await rig();
    const source = await vaultWalletId(r);
    const card = await simulator.newCard();
    const created = await drive(
      r,
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
      {
        codes: [utf8ToBytes("sim code 2"), utf8ToBytes("sim code 2")],
        cards: Array.from({ length: 10 }, () => card),
      },
      verifyPasskey(),
    );
    const walletId = String(created["walletId"]);
    const status = await drive(r, { kind: "status" }, { cards: [card] });
    expect(status).toMatchObject({ kind: "status", life: "loaded", tries: 10, walletId });
    const health = await drive(
      r,
      { kind: "health", walletId },
      { codes: [utf8ToBytes("sim code 2")], cards: Array.from({ length: 4 }, () => card) },
    );
    expect(health).toStrictEqual({ kind: "health", walletId });
  });

  it("change-access rotates the applet's access hash; the old code fails 63Cx", async () => {
    const r = await rig();
    const source = await vaultWalletId(r);
    const card = await simulator.newCard();
    const created = await drive(
      r,
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
      {
        codes: [utf8ToBytes("sim code 3"), utf8ToBytes("sim code 3")],
        cards: Array.from({ length: 10 }, () => card),
      },
      verifyPasskey(),
    );
    const walletId = String(created["walletId"]);
    const result = await drive(
      r,
      { kind: "change-access", walletId },
      {
        codes: [utf8ToBytes("sim code 3"), utf8ToBytes("sim code 4"), utf8ToBytes("sim code 4")],
        cards: Array.from({ length: 4 }, () => card),
      },
      verifyPasskey(),
    );
    expect(result["kind"]).toBe("change-access");
    // The old code now fails on the card (health re-asks with the remaining count).
    const begin = ok(
      await r.h.call("card.begin", { op: { kind: "health", walletId } }, r.session),
    ) as { opId: string; step: Step };
    r.input.push(utf8ToBytes("sim code 3"));
    let step = ok(await r.h.call("card.step", { opId: begin.opId }, r.session)) as Step;
    r.reader.present(card);
    step = ok(await r.h.call("card.step", { opId: begin.opId }, r.session)) as Step;
    expect(step).toMatchObject({ kind: "input", remaining: 9 });
    await r.h.call("card.cancel", { opId: begin.opId }, r.session);
  });

  it("a CREATE torn mid-write leaves the card LOADED; the retry stages the record anyway", async () => {
    const r = await rig();
    const source = await vaultWalletId(r);
    const card = await simulator.newCard();
    await card.tear(1); // the first persistent write of a later command — CREATE's T-CREATE
    const result = await drive(
      r,
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
      {
        codes: [utf8ToBytes("sim code 5"), utf8ToBytes("sim code 5")],
        cards: Array.from({ length: 12 }, () => card),
      },
      verifyPasskey(),
    );
    // The CREATE committed before the tear; the retry's VERIFY sees the loaded wallet.
    expect(result["kind"]).toBe("create");
    const status = ok(await r.h.call("status", null, r.session)) as { wallets: WalletInfo[] };
    expect(
      status.wallets.some((w) => w.custody === "card" && w.walletId === result["walletId"]),
    ).toBe(true);
  });

  it("erase wipes the applet and deletes the emptied record", async () => {
    const r = await rig();
    const source = await vaultWalletId(r);
    const card = await simulator.newCard();
    const created = await drive(
      r,
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
      {
        codes: [utf8ToBytes("sim code 6"), utf8ToBytes("sim code 6")],
        cards: Array.from({ length: 10 }, () => card),
      },
      verifyPasskey(),
    );
    const walletId = String(created["walletId"]);
    const result = await drive(
      r,
      { kind: "erase", walletId, card: bytesToHex(cardId(card.identity)) },
      {
        codes: [utf8ToBytes("sim code 6")],
        cards: Array.from({ length: 4 }, () => card),
      },
      verifyPasskey(),
    );
    expect(result["kind"]).toBe("erase");
    const status = await drive(r, { kind: "status" }, { cards: [card] });
    expect(status["life"]).toBe("blank");
    const { records } = await r.h.store.load();
    expect(records.some((rec) => rec.id === walletId)).toBe(false);
  });

  it("wallet.accounts of the imported card wallet equals the software wallet's", async () => {
    const r = await rig();
    const imported = ok(
      await r.h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC) }, r.session),
    );
    const source = String((imported["wallet"] as Record<string, unknown>)["walletId"]);
    const CASES: ReadonlyArray<readonly [string, string]> = [
      ["evm.bip44", "eip155:1"],
      ["solana.bip44-change", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
      ["tron.bip44", "tron:728126428"],
      ["btc.bip44", BTC_MAINNET],
      ["btc.bip49", BTC_MAINNET],
      ["btc.bip84", BTC_MAINNET],
      ["btc.bip86", BTC_MAINNET],
    ];
    const accounts = async (
      walletId: string,
      template: string,
      network: string,
      groupIndex: number,
    ) =>
      ok(await r.h.call("wallet.accounts", { walletId, groupIndex, template, network }, r.session));
    // Every software answer, captured before the source is imported onto the card.
    const before: Record<string, unknown> = {};
    for (const [template, network] of CASES) {
      for (let g = 0; g <= 2; g += 1) {
        before[`${template}/${network}/${g}`] = await accounts(source, template, network, g);
      }
    }
    const card = await simulator.newCard();
    const created = await drive(
      r,
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
      {
        codes: [utf8ToBytes("sim acct 1"), utf8ToBytes("sim acct 1")],
        cards: Array.from({ length: 10 }, () => card),
      },
      verifyPasskey(),
    );
    const walletId = String(created["walletId"]);
    for (const [template, network] of CASES) {
      for (let g = 0; g <= 2; g += 1) {
        await expect(accounts(walletId, template, network, g)).resolves.toStrictEqual(
          before[`${template}/${network}/${g}`],
        );
      }
    }
  });

  it("a second vault adds the same card — same walletId, same accounts, then already-exists", async () => {
    const first = await rig();
    const source = await vaultWalletId(first);
    const card = await simulator.newCard();
    const created = await drive(
      first,
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
      {
        codes: [utf8ToBytes("sim code sv"), utf8ToBytes("sim code sv")],
        cards: Array.from({ length: 10 }, () => card),
      },
      verifyPasskey(),
    );
    const walletId = String(created["walletId"]);
    const second = await altRig();
    const added = await drive(
      second,
      { kind: "add", groups: 3 },
      { codes: [utf8ToBytes("sim code sv")], cards: Array.from({ length: 10 }, () => card) },
    );
    expect(added["walletId"]).toBe(walletId);
    // Both vaults answer the same accounts from the card's public material.
    for (const [template, network] of [
      ["evm.bip44", "eip155:1"],
      ["btc.bip84", BTC_MAINNET],
      ["solana.bip44-change", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
    ] as const) {
      for (let g = 0; g <= 2; g += 1) {
        const a = ok(
          await first.h.call(
            "wallet.accounts",
            { walletId, groupIndex: g, template, network },
            first.session,
          ),
        );
        const b = ok(
          await second.h.call(
            "wallet.accounts",
            { walletId, groupIndex: g, template, network },
            second.session,
          ),
        );
        expect(b).toStrictEqual(a);
      }
    }
    // Adding it again in the same vault is already-exists before any VERIFY.
    const error = await driveErr(
      second,
      { kind: "add", groups: 1 },
      { codes: [utf8ToBytes("sim code sv")], cards: [card] },
    );
    expect(error).toBe("already-exists");
  });

  it("wrong codes count down, gate 15 WAITs, warn at one try and self-erase at zero", async () => {
    const r = await rig();
    const source = await vaultWalletId(r);
    const card = await simulator.newCard();
    const created = await drive(
      r,
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
      {
        codes: [utf8ToBytes("sim code right"), utf8ToBytes("sim code right")],
        cards: Array.from({ length: 10 }, () => card),
      },
      verifyPasskey(),
    );
    const walletId = String(created["walletId"]);
    const begin = ok(
      await r.h.call("card.begin", { op: { kind: "health", walletId } }, r.session),
    ) as { opId: string; step: Step };
    const remainingSeen: number[] = [];
    const holdSeen: boolean[] = [];
    const lengthsBefore = r.reader.sessionLengths.length;
    let { step } = begin;
    let failure: string | undefined;
    for (let guard = 0; failure === undefined && guard < 60; guard += 1) {
      if (step.kind === "input") {
        remainingSeen.push(step["remaining"] as number);
        r.input.push(utf8ToBytes("sim code wrong"));
      } else {
        holdSeen.push(step["hold"] === true);
        r.reader.present(card);
      }
      const next = await r.h.call("card.step", { opId: begin.opId }, r.session);
      if ("err" in next) {
        failure = next.err.code;
      } else {
        step = next.ok as Step;
      }
    }
    expect(failure).toBe("card-erased");
    // The first ask carries no count (the record's 10 is not shown); each re-ask carries the
    // card's own remaining after the failed VERIFY: 9 down to 1.
    expect(remainingSeen).toStrictEqual([undefined, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    // §7.3: tries ≤ 10 − 3 = 7 gates 15 WAITs before VERIFY. The first three sessions are
    // free (SELECT+OPEN+STATUS+VERIFY = 4); every later one carries the 15 WAITs (19).
    const lengths = r.reader.sessionLengths.slice(lengthsBefore);
    expect(lengths.slice(0, 3)).toStrictEqual([4, 4, 4]);
    for (const length of lengths.slice(3)) {
      expect(length).toBe(19);
    }
    // hold: true marks every gated tap.
    expect(holdSeen.slice(0, 3)).toStrictEqual([false, false, false]);
    expect(holdSeen.slice(3)).toStrictEqual([true, true, true, true, true, true, true]);
    // The last-attempt label warns about the erase — the final request was the remaining=1 ask.
    expect(r.input.requests.at(-1)?.label).toContain("last attempt");
    // The self-erase landed in the record — the member is now unknown.
    const status = ok(await r.h.call("status", null, r.session)) as { wallets: WalletInfo[] };
    const info = status.wallets.find((w) => w.walletId === walletId);
    if (info?.custody !== "card") {
      throw new Error("expected a card wallet");
    }
    expect(info.cards[0]?.state).toBe("unknown");
  });

  it("codes tried in another vault surface as card-tampered on the real applet", async () => {
    const first = await rig();
    const source = await vaultWalletId(first);
    const card = await simulator.newCard();
    const created = await drive(
      first,
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
      {
        codes: [utf8ToBytes("sim code tp"), utf8ToBytes("sim code tp")],
        cards: Array.from({ length: 10 }, () => card),
      },
      verifyPasskey(),
    );
    const walletId = String(created["walletId"]);
    // A second vault adopts the card, then burns one attempt on it.
    const second = await altRig();
    await drive(
      second,
      { kind: "add", groups: 1 },
      { codes: [utf8ToBytes("sim code tp")], cards: Array.from({ length: 10 }, () => card) },
    );
    await driveErr(
      second,
      { kind: "health", walletId },
      { codes: [utf8ToBytes("sim code bad!")], cards: Array.from({ length: 2 }, () => card) },
    );
    // The first vault reads tries 9 < recorded 10 — tampered, and no VERIFY was sent.
    first.reader.closes.length = 0;
    const before = first.reader.sessionLengths.length;
    const error = await driveErr(
      first,
      { kind: "health", walletId },
      { codes: [utf8ToBytes("sim code tp")], cards: [card] },
    );
    expect(error).toBe("card-tampered");
    // The session ended right after STATUS: SELECT + OPEN + STATUS = 3 transmits.
    expect(first.reader.sessionLengths.slice(before)).toStrictEqual([3]);
    expect(first.reader.closes.at(-1)?.text).toBe("Someone else tried codes on this card");
    // The lower count committed — the next tap is clean and verifies.
    const healthy = await drive(
      first,
      { kind: "health", walletId },
      { codes: [utf8ToBytes("sim code tp")], cards: Array.from({ length: 4 }, () => card) },
    );
    expect(healthy["kind"]).toBe("health");
  });

  it("tag loss at every transmit index of add still lands one record, once", async () => {
    const maker = await rig();
    const source = await vaultWalletId(maker);
    const card = await simulator.newCard();
    const created = await drive(
      maker,
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
      {
        codes: [utf8ToBytes("sim sweep ad"), utf8ToBytes("sim sweep ad")],
        cards: Array.from({ length: 10 }, () => card),
      },
      verifyPasskey(),
    );
    const walletId = String(created["walletId"]);
    // A clean run in a second vault measures the transmit count and the session layout.
    const probe = await altRig();
    const probeSent = probe.reader.sent.length;
    await drive(
      probe,
      { kind: "add", groups: 1 },
      { codes: [utf8ToBytes("sim sweep ad")], cards: Array.from({ length: 10 }, () => card) },
    );
    const clean = probe.reader.sent.length - probeSent;
    const fetchSession = probe.reader.sessionLengths.at(-1) ?? 0;

    const fetches = fetchSession - 4; // SELECT + OPEN + STATUS + VERIFY precede the PUBLIC_KEYs
    for (let i = 1; i <= clean; i += 1) {
      const r = await altRig();
      r.reader.loseGlobal(i);
      const sent = r.reader.sent.length;
      const added = await drive(
        r,
        { kind: "add", groups: 1 },
        { codes: [utf8ToBytes("sim sweep ad")], cards: Array.from({ length: 20 }, () => card) },
      );
      expect(added["walletId"]).toBe(walletId);
      const total = r.reader.sent.length - sent;
      // Bounded rework: the retry re-OPENs once and fetches only what the loss left unfetched.
      expect(total).toBeLessThanOrEqual(clean + 5);
      if (i === clean) {
        // The last transmit is the last PUBLIC_KEY — its node is the only one refetched.
        expect(r.reader.sessionLengths.at(-1)).toBe(4 + 1);
      }
      if (i === clean - 2 && fetches >= 3) {
        // Three fetches back: two landed before the loss, this and the last are refetched.
        expect(r.reader.sessionLengths.at(-1)).toBe(4 + 3);
      }
    }
  }, 120_000);

  it("tag loss at every transmit index of change-access finishes, CHANGE never re-sends", async () => {
    const r = await rig();
    const source = await vaultWalletId(r);
    const card = await simulator.newCard();
    const created = await drive(
      r,
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
      {
        codes: [utf8ToBytes("sim code c0"), utf8ToBytes("sim code c0")],
        cards: Array.from({ length: 10 }, () => card),
      },
      verifyPasskey(),
    );
    const walletId = String(created["walletId"]);
    let current = "sim code c0";
    // Clean run: one member — SELECT + OPEN + STATUS + VERIFY + CHANGE = 5 transmits.
    const sent0 = r.reader.sent.length;
    await drive(
      r,
      { kind: "change-access", walletId },
      {
        codes: [utf8ToBytes(current), utf8ToBytes("sim code c1"), utf8ToBytes("sim code c1")],
        cards: [card],
      },
      verifyPasskey(),
    );
    const clean = r.reader.sent.length - sent0;

    expect(clean).toBe(5);
    current = "sim code c1";
    for (let i = 1; i <= clean; i += 1) {
      const next = `sim code n${i}`;
      r.reader.loseGlobal(i);
      const rotated = await drive(
        r,
        { kind: "change-access", walletId },
        {
          codes: [utf8ToBytes(current), utf8ToBytes(next), utf8ToBytes(next)],
          cards: Array.from({ length: 4 }, () => card),
        },
        verifyPasskey(),
      );
      expect(rotated["kind"]).toBe("change-access");
      const retrySession = r.reader.sessionLengths.at(-1) ?? 0;
      if (i === clean) {
        // The CHANGE transmit was delivered but its response lost — the retry proves the
        // change with VERIFY(new) alone: 4 transmits, no second CHANGE.
        expect(retrySession).toBe(4);
      }
      current = next;
    }
    // The uncommitted-loss branch probes the new code (63Cx), falls back to VERIFY(old),
    // then re-sends CHANGE: 6 transmits in the retry session.
    {
      r.reader.loseAfter(4); // the 5th transmit — CHANGE — never reaches the card
      const rotated = await drive(
        r,
        { kind: "change-access", walletId },
        {
          codes: [utf8ToBytes(current), utf8ToBytes("sim code last"), utf8ToBytes("sim code last")],
          cards: Array.from({ length: 4 }, () => card),
        },
        verifyPasskey(),
      );
      expect(rotated["kind"]).toBe("change-access");
      expect(r.reader.sessionLengths.at(-1)).toBe(6);
      current = "sim code last";
    }
    // The final code is the live one.
    const healthy = await drive(
      r,
      { kind: "health", walletId },
      { codes: [utf8ToBytes(current)], cards: [card] },
    );
    expect(healthy["kind"]).toBe("health");
  }, 120_000);

  it("tag loss at every transmit index of create recovers or retries cleanly", async () => {
    // Probe the clean layout once: S1 ends with CREATE, S2 verifies and fetches.
    const probe = await rig();
    const probeSource = await vaultWalletId(probe);
    const probeCard = await simulator.newCard();
    const probeSent = probe.reader.sent.length;
    const probeSessions = probe.reader.sessionLengths.length;
    await drive(
      probe,
      { kind: "create", cards: 1, source: { kind: "wallet", walletId: probeSource } },
      {
        codes: [utf8ToBytes("sim sweep c0"), utf8ToBytes("sim sweep c0")],
        cards: Array.from({ length: 10 }, () => probeCard),
      },
      verifyPasskey(),
    );
    const clean = probe.reader.sent.length - probeSent;
    const layout = probe.reader.sessionLengths.slice(probeSessions);

    const createAt = layout[0] ?? 0; // the transmit index of CREATE inside session one
    for (let i = 1; i <= clean; i += 1) {
      const r = await rig();
      const source = await vaultWalletId(r);
      const card = await simulator.newCard();
      r.reader.loseGlobal(i);
      const sessions = r.reader.sessionLengths.length;
      const result = await drive(
        r,
        { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
        {
          codes: [utf8ToBytes(`sim sweep c${i}`), utf8ToBytes(`sim sweep c${i}`)],
          cards: Array.from({ length: 20 }, () => card),
        },
        verifyPasskey(),
      );
      expect(result["kind"]).toBe("create");
      const { records } = await r.h.store.load();
      expect(records.some((rec) => rec.id === source && rec.kind === "entropy")).toBe(false);
      const status = await drive(r, { kind: "status" }, { cards: [card] });
      expect(status["life"]).toBe("loaded");
      if (i === createAt) {
        // CREATE committed but its response was lost: a LOADED card rejects a second CREATE
        // (6985), so a clean finish proves the retry ran the VERIFY-recovery branch — the
        // recovery session is SELECT + OPEN + STATUS + VERIFY = 4 transmits.
        expect(r.reader.sessionLengths[sessions + 1]).toBe(4);
      }
    }
  }, 120_000);

  it("a CREATE torn at every persistent write leaves BLANK and retries cleanly", async () => {
    let k = 0;
    for (;;) {
      k += 1;
      if (k > 40) {
        throw new Error("CREATE has more than 40 persistent writes — bound the sweep");
      }
      const r = await rig();
      const source = await vaultWalletId(r);
      const card = await simulator.newCard();
      await card.tear(k);
      const sessions = r.reader.sessionLengths.length;
      const result = await drive(
        r,
        { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
        {
          codes: [utf8ToBytes(`sim tear ${k}`), utf8ToBytes(`sim tear ${k}`)],
          cards: Array.from({ length: 20 }, () => card),
        },
        verifyPasskey(),
      );
      expect(result["kind"]).toBe("create");
      const tornSessions = r.reader.sessionLengths.slice(sessions);
      if (tornSessions.length === 2) {
        break; // the armed tear never fired: CREATE does k − 1 persistent writes
      }
      // Every torn write rolls T-CREATE back — the card is blank, the retry re-CREATEs. A
      // VERIFY sent to a blank card would fault (6985), so finishing proves the retry.
      expect(tornSessions).toHaveLength(3);
      const { records } = await r.h.store.load();
      expect(records.some((rec) => rec.id === source && rec.kind === "entropy")).toBe(false);
      const status = await drive(r, { kind: "status" }, { cards: [card] });
      expect(status["life"]).toBe("loaded");
    }
    expect(k).toBeGreaterThan(1);
  }, 120_000);
});
