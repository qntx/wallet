/**
 * Bridge-harness behaviours of the card simulator (`QNTX_CARD_SIM` = `card:sim` launcher; skipped
 * without it): independent cards, power-cycle semantics and the armed tear point. Protocol layer
 * (session, commands) is covered by card-simulator.test.ts; here the bridge contract itself is what
 * is under test.
 */
import { randomBytes } from "node:crypto";

import { bytesToHex } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { cmd } from "../src/modules/card/protocol/commands.ts";
import { decode } from "../src/modules/card/protocol/decode.ts";
import { openRequest, openResponse, SELECT_APDU } from "../src/modules/card/protocol/session.ts";
import type { Session } from "../src/modules/card/protocol/session.ts";
import { result } from "../src/modules/card/protocol/status.ts";
import { CA1_ANCHOR, SIM_LAUNCHER, startSimulator } from "./card/sim.ts";
import type { SimCard, Simulator } from "./card/sim.ts";

let simulator: Simulator;

const transmit = async (card: SimCard, apdu: Uint8Array): Promise<Uint8Array> => {
  const response = await card.transmit(apdu);
  if (response === "torn") {
    throw new Error("card was unexpectedly torn");
  }
  return response;
};

const select = async (card: SimCard): Promise<void> => {
  await expect(transmit(card, SELECT_APDU).then(bytesToHex)).resolves.toBe("9000");
};

const open = async (card: SimCard): Promise<Session> => {
  const { apdu: request, secret } = openRequest((n) => new Uint8Array(randomBytes(n)));
  const response = await transmit(card, request);
  return openResponse(secret, request, response, [CA1_ANCHOR], []);
};

const status = async (card: SimCard, session: Session): Promise<unknown> => {
  const rapdu = await transmit(card, session.wrap(cmd.status()));
  return decode.status(result(cmd.status(), session.unwrap(rapdu)));
};

describe.skipIf(SIM_LAUNCHER === undefined)("card sim bridge", () => {
  beforeAll(async () => {
    simulator = await startSimulator();
  }, 120_000);

  afterAll(async () => {
    await simulator.close();
  });

  it("creates independent cards with different certificates that both OPEN", async () => {
    expect.hasAssertions();
    const first = await simulator.newCard();
    const second = await simulator.newCard();
    expect(first.index).not.toBe(second.index);
    expect(first.cert).not.toStrictEqual(second.cert);
    expect(first.identity).not.toStrictEqual(second.identity);
    for (const card of [first, second]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- cards talk over the one bridge serially
      await select(card);
      // oxlint-disable-next-line eslint/no-await-in-loop -- cards talk over the one bridge serially
      const session = await open(card);
      expect(session.cert).toStrictEqual(card.cert);
      expect(session.batch).toBe("ca1");
      // oxlint-disable-next-line eslint/no-await-in-loop -- cards talk over the one bridge serially
      await expect(status(card, session)).resolves.toStrictEqual({ life: "blank", tries: 0 });
    }
  });

  it("needs SELECT again after a power cycle", async () => {
    expect.hasAssertions();
    const card = await simulator.newCard();
    await select(card);
    const session = await open(card);
    await expect(status(card, session)).resolves.toStrictEqual({ life: "blank", tries: 0 });

    await card.reset();
    // Without a selection the APDU never reaches the applet: the platform answers 6986
    // (SELECT then OPEN restore a fresh session; the torn-down one stays dead).
    await expect(card.transmit(session.wrap(cmd.status()))).resolves.toStrictEqual(
      Uint8Array.from([0x69, 0x86]),
    );

    await select(card);
    const reopened = await open(card);
    await expect(status(card, reopened)).resolves.toStrictEqual({ life: "blank", tries: 0 });
  });

  it("a tear inside CREATE's transaction reports torn and rolls the card back to BLANK", async () => {
    expect.hasAssertions();
    const card = await simulator.newCard();
    await select(card);
    const session = await open(card);

    // T-CREATE is one transaction (§4.3, §9.4): arming the tear on the next persistent write
    // kills power inside it, so nothing commits.
    await card.tear(1);
    const create = session.wrap(
      cmd.create({
        mode: "generate",
        accessHash: new Uint8Array(randomBytes(32)),
        entropy: new Uint8Array(randomBytes(32)),
        others: [],
      }),
    );
    await expect(card.transmit(create)).resolves.toBe("torn");

    await card.reset();
    await select(card);
    const reopened = await open(card);
    await expect(status(card, reopened)).resolves.toStrictEqual({ life: "blank", tries: 0 });
  });
});
