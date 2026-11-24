// oxlint-disable eslint/no-await-in-loop, vitest/no-conditional-in-test -- the connect retry and branch assertions are sequential and conditional by design
/**
 * Bridge-harness behaviours of the card simulator (`QNTX_CARD_SIM` = `card:sim` launcher; skipped
 * without it): independent cards, power-cycle semantics and the armed tear point. Protocol layer
 * (session, commands) is covered by card-simulator.test.ts; here the bridge contract itself is what
 * is under test.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

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

/** Polls until the bridge's TCP listener accepts — the JVM needs a moment to bind. */
const waitForListener = async (
  port: number,
  proc: ChildProcess,
  stderr: ReadonlyArray<string>,
): Promise<Socket> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (proc.exitCode !== null || proc.killed) {
      throw new Error(
        `card-sim bridge exited before listening (code ${String(proc.exitCode)}): ${stderr.join("").trim()}`,
      );
    }
    const socket: Socket = createConnection({ host: "127.0.0.1", port });
    const opened = await new Promise<boolean>((resolve) => {
      socket.once("connect", () => resolve(true));
      socket.once("error", () => resolve(false));
    });
    if (opened) {
      return socket;
    }
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("bridge never listened");
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

  it("serves the same line protocol over TCP (--tcp)", async () => {
    expect.hasAssertions();
    const port = 19000 + Math.floor(Math.random() * 1000);
    const proc = spawn(SIM_LAUNCHER!, ["--tcp", String(port)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: string[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk.toString("utf8"));
    });
    let socket: Socket | undefined;
    try {
      socket = await waitForListener(port, proc, stderr);
      const lines = createInterface({ input: socket });
      const reader = lines[Symbol.asyncIterator]();
      const ask = async (line: string): Promise<string> => {
        socket?.write(`${line}\n`);
        const next = await reader.next();
        if (next.done === true) {
          throw new Error("bridge closed");
        }
        return next.value;
      };
      const banner = await reader.next();
      expect(banner.value).toBe("READY");
      const created = await ask("new");
      expect(created).toMatch(/^CARD 0 [0-9a-f]+$/);
      await expect(ask("apdu 0 00a4040007f0716e7478010100")).resolves.toBe("R 9000");
      await expect(ask("reset 0")).resolves.toBe("OK");
      await expect(ask("bogus")).resolves.toMatch(/^ERR /);
      socket.end();
    } finally {
      socket?.destroy();
      proc.kill();
    }
  }, 120_000);
});

/* The client contract needs no simulator: a launcher that dies after READY — like a restored
   cache whose classpath lost its jars — must fail the pending request with the child's stderr,
   not leave it queued for the test timeout. */
describe("card sim bridge client", () => {
  it("rejects a request whose bridge died after READY with the child's stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "card-sim-stub-"));
    const stub = join(dir, "card-sim");
    writeFileSync(
      stub,
      '#!/usr/bin/env bash\nprintf "READY\\n"\necho "boom: missing classpath" >&2\nexit 1\n',
    );
    chmodSync(stub, 0o755);
    try {
      const sim = await startSimulator(stub);
      await expect(sim.newCard()).rejects.toThrow(/exited.*boom: missing classpath/s);
      await sim.close();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
