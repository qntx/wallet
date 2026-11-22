/**
 * Round trip against the real qntx card applet running in jcardsim via the line-oriented APDU
 * bridge (`QNTX_CARD_SIM` = path to the bridge launcher; skipped without it). The bridge prints
 * `READY <cert hex>` once personalised to BLANK with the test CA ca1, then answers one hex C-APDU
 * line on stdin with one hex response line (data ‖ SW).
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { cmd } from "../src/modules/card/protocol/commands.ts";
import type { Inner } from "../src/modules/card/protocol/commands.ts";
import { decode } from "../src/modules/card/protocol/decode.ts";
import { CardError } from "../src/modules/card/protocol/errors.ts";
import type { CardErrorCode } from "../src/modules/card/protocol/errors.ts";
import type { Anchor } from "../src/modules/card/protocol/identity.ts";
import { openRequest, openResponse, SELECT_APDU } from "../src/modules/card/protocol/session.ts";
import type { Session } from "../src/modules/card/protocol/session.ts";
import { result } from "../src/modules/card/protocol/status.ts";
import { loadVectors } from "./helpers.ts";

const SIM = process.env["QNTX_CARD_SIM"];
const hex = hexToBytes;

const cert = loadVectors("card/cert.json") as {
  cas: ReadonlyArray<{ name: string; public: string }>;
};
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

const ca1 = cert.cas.find((ca) => ca.name === "ca1");
const anchor: Anchor = { batch: "ca1", key: hex(requireCase(ca1).public) };

/** A line of the bridge protocol. */
class Bridge {
  private readonly proc: ChildProcess;
  private readonly queue: string[] = [];
  private readonly waiters: Array<(line: string) => void> = [];
  stderr = "";

  constructor(command: string) {
    this.proc = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    this.proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let cut = buffer.indexOf("\n");
      while (cut >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        const waiter = this.waiters.shift();
        if (waiter === undefined) {
          this.queue.push(line);
        } else {
          waiter(line);
        }
        cut = buffer.indexOf("\n");
      }
    });
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
  }

  /** Next stdout line; the bridge answers one line per command line. */
  async read(): Promise<string> {
    const queued = this.queue.shift();
    return queued === undefined
      ? new Promise((resolve) => {
          this.waiters.push(resolve);
        })
      : Promise.resolve(queued);
  }

  /** Sends one C-APDU (hex) and returns the response line (hex, data ‖ SW). */
  async transmit(apduBytes: Uint8Array): Promise<string> {
    this.proc.stdin?.write(`${bytesToHex(apduBytes)}\n`);
    return this.read();
  }

  close(): void {
    this.proc.stdin?.end();
    this.proc.kill();
  }
}

let bridge: Bridge;
let readyCert = "";
let session: Session;

const wrapSend = async (inner: Inner): Promise<{ data: Uint8Array; sw: number }> => {
  const rapdu = await bridge.transmit(session.wrap(inner));
  return session.unwrap(hex(rapdu));
};

const open = async (): Promise<Session> => {
  const { apdu: request, secret } = openRequest((n) => new Uint8Array(randomBytes(n)));
  const response = await bridge.transmit(request);
  return openResponse(secret, request, hex(response), [anchor], []);
};

/** One inner command exchange asserted to end on inner 6D00 → card-fault. */
const expectSixDZeroZero = async (inner: Inner): Promise<void> => {
  const response = await wrapSend(inner);
  expect(response.sw).toBe(0x6d00);
  expect(cardError(() => result(inner, response))).toBe("card-fault");
};

describe.skipIf(SIM === undefined)("card simulator round trip", () => {
  beforeAll(async () => {
    bridge = new Bridge(requireCase(SIM));
    const ready = await bridge.read();
    readyCert = ready.replace(/^READY /, "");
  }, 120_000);

  afterAll(() => {
    bridge.close();
  });

  it("SELECT answers 9000 and OPEN opens a session carrying the READY certificate", async () => {
    expect.hasAssertions();
    await expect(bridge.transmit(SELECT_APDU)).resolves.toBe("9000");
    session = await open();
    expect(bytesToHex(session.cert)).toBe(readyCert);
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
    const rapdu1 = await bridge.transmit(first);
    const rapdu2 = await bridge.transmit(second);
    expect(session.unwrap(hex(rapdu1)).sw).toBe(0x9000);
    expect(session.unwrap(hex(rapdu2)).sw).toBe(0x9000);
  });

  it("an unknown inner INS answers 6D00 → card-fault", async () => {
    expect.hasAssertions();
    const unknown: Inner = { name: "status", ins: 0x7f, p1: 0, p2: 0, data: new Uint8Array(0) };
    await expectSixDZeroZero(unknown);
  });

  // Const.INNER_INS = {INS_STATUS}: the stage-core applet implements STATUS only — every other
  // inner command answers 6D00, which no command's allow-list accepts.
  it.each([
    ["verify", cmd.verify(new Uint8Array(32))],
    ["change", cmd.change(new Uint8Array(32))],
    ["wait", cmd.wait()],
    ["public-key", cmd.publicKey("secp256k1", [0x80_00_00_00])],
    ["sign-ecdsa", cmd.signEcdsa(new Uint8Array(32), [0x80_00_00_00])],
    ["sign-bip340", cmd.signBip340(new Uint8Array(32), new Uint8Array(32), [0x80_00_00_00])],
    ["ed25519-begin", cmd.ed25519Begin([0x80_00_00_00])],
    [
      "create",
      cmd.create({
        mode: "generate",
        accessHash: new Uint8Array(32),
        entropy: new Uint8Array(32),
        others: [],
      }),
    ],
    [
      "export-head",
      cmd.export0(new Uint8Array(97), {
        linkKey: new Uint8Array(65),
        signature: new Uint8Array(64),
      }),
    ],
    [
      "import-head",
      cmd.import0(new Uint8Array(97), {
        ephemeral: new Uint8Array(65),
        signature: new Uint8Array(64),
      }),
    ],
    ["import-payload", cmd.import1(new Uint8Array(160))],
  ])("%s also answers 6D00", async (_name, inner) => {
    expect.hasAssertions();
    await expectSixDZeroZero(inner);
  });

  it("a flipped record tag answers 6982 and breaks the session", async () => {
    expect.hasAssertions();
    const apduBytes = session.wrap(cmd.status());
    // tag = the 8 bytes right before the trailing Le byte: flip the first tag byte.
    const tagByte = requireCase(apduBytes.at(-10));
    apduBytes[apduBytes.length - 10] = tagByte ^ 1;
    const rapdu = await bridge.transmit(apduBytes);
    expect(rapdu).toBe("6982");
    expect(cardError(() => session.unwrap(hex(rapdu)))).toBe("session-broken");
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
    await expect(bridge.transmit(hex(resolveApdu(v.apdu)))).resolves.toBe(v.sw);
  });

  it.each(openCases)("openResponse($name) is card-not-genuine", (v) => {
    expect.hasAssertions();
    expect(
      cardError(() =>
        openResponse(
          hex(oracle.open.hostPrivate),
          hex(oracle.open.request),
          hex(v.sw),
          [anchor],
          [],
        ),
      ),
    ).toBe("card-not-genuine");
  });
});
