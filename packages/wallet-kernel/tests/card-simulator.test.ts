/**
 * Round trip against the real qntx card applet running in jcardsim via the multi-card bridge
 * (`QNTX_CARD_SIM` = path to the `card:sim` launcher; skipped without it). Every card comes
 * personalised to BLANK under the test CA ca1 and power-cycled, so each test SELECTs and OPENs
 * itself. The applet at the pinned commit implements the full §9 command set.
 */
import { randomBytes } from "node:crypto";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { cmd } from "../src/modules/card/protocol/commands.ts";
import type { Inner } from "../src/modules/card/protocol/commands.ts";
import { decode } from "../src/modules/card/protocol/decode.ts";
import { CardError } from "../src/modules/card/protocol/errors.ts";
import type { CardErrorCode } from "../src/modules/card/protocol/errors.ts";
import { openRequest, openResponse, SELECT_APDU } from "../src/modules/card/protocol/session.ts";
import type { Session } from "../src/modules/card/protocol/session.ts";
import { result } from "../src/modules/card/protocol/status.ts";
import { CA1_ANCHOR, SIM_LAUNCHER, startSimulator } from "./card/sim.ts";
import type { SimCard, Simulator } from "./card/sim.ts";
import { loadVectors } from "./helpers.ts";

const hex = hexToBytes;

const apdu = loadVectors("card/apdu.json") as {
  commands: ReadonlyArray<{
    name: string;
    cases: ReadonlyArray<{ name: string; inner: boolean; apdu: string; sw: string }>;
  }>;
};
const oracle = loadVectors("card/oracle.json") as {
  open: { hostPrivate: string; request: string };
};
const sessionVec = loadVectors("card/session.json") as { hostEph: string };

const requireCase = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("expected a vector case");
  }
  return value;
};

const capture = (fn: () => unknown): CardError | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof CardError) {
      return error;
    }
    throw error;
  }
  return undefined;
};

const cardError = (fn: () => unknown): CardErrorCode | undefined => capture(fn)?.code;

// apdu.json embeds placeholders documented in its "symbols": {hostEph}, hostEph with a 0x02
// prefix, and hostEph with a flipped y byte (off the curve).
const hostEphPrefix02 = hex(sessionVec.hostEph);
hostEphPrefix02[0] = 0x02;
const hostEphOffCurve = hex(sessionVec.hostEph);
hostEphOffCurve[hostEphOffCurve.length - 1] = requireCase(hostEphOffCurve.at(-1)) ^ 1;
const resolveApdu = (template: string): string =>
  template
    .replace("{hostEph.prefix02}", bytesToHex(hostEphPrefix02))
    .replace("{hostEph.offCurve}", bytesToHex(hostEphOffCurve))
    .replace("{hostEph}", sessionVec.hostEph);

let simulator: Simulator;
let card: SimCard;
let session: Session;

/** Sends one C-APDU; no command in this suite is expected to hit the armed tear. */
const transmit = async (capdu: Uint8Array): Promise<Uint8Array> => {
  const response = await card.transmit(capdu);
  if (response === "torn") {
    throw new Error("card was unexpectedly torn");
  }
  return response;
};

const wrapSend = async (inner: Inner): Promise<{ data: Uint8Array; sw: number }> => {
  const rapdu = await transmit(session.wrap(inner));
  return session.unwrap(rapdu);
};

const open = async (): Promise<Session> => {
  const { apdu: request, secret } = openRequest((n) => new Uint8Array(randomBytes(n)));
  const response = await transmit(request);
  return openResponse(secret, request, response, [CA1_ANCHOR], []);
};

describe.skipIf(SIM_LAUNCHER === undefined)("card simulator round trip", () => {
  beforeAll(async () => {
    simulator = await startSimulator();
    card = await simulator.newCard();
  }, 120_000);

  afterAll(async () => {
    await simulator.close();
  });

  it("SELECT answers 9000 and OPEN opens a session carrying the card certificate", async () => {
    expect.hasAssertions();
    await expect(transmit(SELECT_APDU).then(bytesToHex)).resolves.toBe("9000");
    session = await open();
    expect(session.cert).toStrictEqual(card.cert);
    expect(session.identity).toStrictEqual(card.identity);
  });

  it("STATUS decodes as blank/0", async () => {
    expect.hasAssertions();
    const response = await wrapSend(cmd.status());
    expect(response.sw).toBe(0x9000);
    const status = decode.status(result(cmd.status(), response));
    expect(status).toStrictEqual({ life: "blank", tries: 0 });
  });

  it("unwraps two pre-wrapped STATUS records in order", async () => {
    expect.hasAssertions();
    const first = session.wrap(cmd.status());
    const second = session.wrap(cmd.status());
    const rapdu1 = await transmit(first);
    const rapdu2 = await transmit(second);
    expect(session.unwrap(rapdu1).sw).toBe(0x9000);
    expect(session.unwrap(rapdu2).sw).toBe(0x9000);
  });

  it("an unknown inner INS answers 6D00 → card-fault", async () => {
    expect.hasAssertions();
    const unknown: Inner = { name: "status", ins: 0x7f, p1: 0, p2: 0, data: new Uint8Array(0) };
    const response = await wrapSend(unknown);
    expect(response.sw).toBe(0x6d00);
    expect(cardError(() => result(unknown, response))).toBe("card-fault");
  });

  // The stage-core applet answered 6D00 for every inner command but STATUS; the full applet gates
  // each LOADED-only command on life first (§9.2 checking order), so a BLANK card answers 6985,
  // which the client maps to wrong-state.
  it.each([
    ["verify", cmd.verify(new Uint8Array(32))],
    ["change", cmd.change(new Uint8Array(32))],
    ["wait", cmd.wait()],
    ["erase", cmd.erase()],
    ["public-key", cmd.publicKey("secp256k1", [0x80_00_00_00])],
    ["sign-ecdsa", cmd.signEcdsa(new Uint8Array(32), [0x80_00_00_00])],
    ["sign-bip340", cmd.signBip340(new Uint8Array(32), new Uint8Array(32), [0x80_00_00_00])],
    ["ed25519-begin", cmd.ed25519Begin([0x80_00_00_00])],
    [
      "export-head",
      cmd.export0(new Uint8Array(97), {
        linkKey: new Uint8Array(65),
        signature: new Uint8Array(64),
      }),
    ],
    ["export-payload", cmd.export1(new Uint8Array(32))],
  ])("%s answers 6985 → wrong-state on a BLANK card", async (_name, inner) => {
    expect.hasAssertions();
    const response = await wrapSend(inner);
    expect(response.sw).toBe(0x6985);
    expect(cardError(() => result(inner, response))).toBe("wrong-state");
  });

  it("IMPORT head without an OFFER answers 6985 → wrong-state", async () => {
    expect.hasAssertions();
    const inner = cmd.import0(new Uint8Array(97), {
      ephemeral: new Uint8Array(65),
      signature: new Uint8Array(64),
    });
    const response = await wrapSend(inner);
    expect(response.sw).toBe(0x6985);
    expect(cardError(() => result(inner, response))).toBe("wrong-state");
  });

  it("OFFER answers an offer that verifies under the card identity and repeats its LK", async () => {
    expect.hasAssertions();
    const first = decode.offer(result(cmd.offer(), await wrapSend(cmd.offer())), session.identity);
    const second = decode.offer(result(cmd.offer(), await wrapSend(cmd.offer())), session.identity);
    // §9.12: offer = VALID keeps the stored link key; only the signature is fresh.
    expect(second.linkKey).toStrictEqual(first.linkKey);
    expect(second.signature).not.toStrictEqual(first.signature);
  });

  it("IMPORT payload without a pending import answers 6985 → wrong-state", async () => {
    expect.hasAssertions();
    const inner = cmd.import1(new Uint8Array(160));
    const response = await wrapSend(inner);
    expect(response.sw).toBe(0x6985);
    expect(cardError(() => result(inner, response))).toBe("wrong-state");
  });

  it("CREATE(generate) loads the wallet and echoes its WalletInfo", async () => {
    expect.hasAssertions();
    const params = {
      mode: "generate",
      accessHash: new Uint8Array(randomBytes(32)),
      entropy: new Uint8Array(randomBytes(32)),
      others: [],
    } as const;
    const inner = cmd.create(params);
    const response = await wrapSend(inner);
    expect(response.sw).toBe(0x9000);
    const info = decode.created(result(inner, response), params, session.cardId);
    expect(info.origin).toBe("generated");
    expect(info.members).toStrictEqual([session.cardId]);
    const status = decode.status(result(cmd.status(), await wrapSend(cmd.status())));
    expect(status).toStrictEqual({ life: "loaded", tries: 10 });
  });

  it("a second CREATE answers 6985 → wrong-state", async () => {
    expect.hasAssertions();
    const inner = cmd.create({
      mode: "generate",
      accessHash: new Uint8Array(32),
      entropy: new Uint8Array(32),
      others: [],
    });
    const response = await wrapSend(inner);
    expect(response.sw).toBe(0x6985);
    expect(cardError(() => result(inner, response))).toBe("wrong-state");
  });

  it("a flipped record tag answers 6982 and breaks the session", async () => {
    expect.hasAssertions();
    const apduBytes = session.wrap(cmd.status());
    // tag = the 8 bytes right before the trailing Le byte: flip the first tag byte.
    const tagByte = requireCase(apduBytes.at(-10));
    apduBytes[apduBytes.length - 10] = tagByte ^ 1;
    const rapdu = await transmit(apduBytes);
    expect(bytesToHex(rapdu)).toBe("6982");
    expect(cardError(() => session.unwrap(rapdu))).toBe("session-broken");
    expect(session.closed).toBe(true);
  });

  it("a fresh OPEN works and produces a different ephemeral tag", async () => {
    expect.hasAssertions();
    const first = bytesToHex(session.ephemeralTag);
    session = await open();
    expect(session.closed).toBe(false);
    expect(bytesToHex(session.ephemeralTag)).not.toBe(first);
  });

  // Outer-layer rejections from apdu.json — the card answers each with its status word and
  // openResponse turns the short/error response into card-not-genuine.
  const openGroup = requireCase(apdu.commands.find((c) => c.name === "OPEN"));
  const openCases = ["p1p2", "length", "hosteph-prefix02", "hosteph-off-curve"].map((name) =>
    requireCase(openGroup.cases.find((c) => c.name === name)),
  );

  it.each(openCases)("OPEN $name answers its status word", async (v) => {
    expect.hasAssertions();
    await expect(transmit(hex(resolveApdu(v.apdu)))).resolves.toStrictEqual(hex(v.sw));
  });

  it.each(openCases)("openResponse($name) is card-not-genuine", (v) => {
    expect.hasAssertions();
    expect(
      cardError(() =>
        openResponse(
          hex(oracle.open.hostPrivate),
          hex(oracle.open.request),
          hex(v.sw),
          [CA1_ANCHOR],
          [],
        ),
      ),
    ).toBe("card-not-genuine");
  });
});
