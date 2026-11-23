/**
 * Client for the card simulator bridge (`scripts/card-sim/Bridge.java`, built by
 * `scripts/card-sim/build.sh`). One child process hosts any number of independent cards over the
 * bridge's line protocol: `READY` on start, then `new` → `CARD <n> <cert hex>`, `apdu <n> <hex>` →
 * `R <hex> | TORN | ERR <m>`, `tear <n> <k>` → `OK`, `reset <n>` → `OK`. Requests are serialized
 * over the one child; `ERR` lines reject. Test-only.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import type { Anchor } from "../../src/modules/card/protocol/identity.ts";
import { loadVectors } from "../helpers.ts";

/** The `card:sim` launcher path; the sim suites skip when it is unset. */
export const SIM_LAUNCHER: string | undefined = process.env["QNTX_CARD_SIM"];

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the vector shape is pinned by check-card-vectors
const cert = loadVectors("card/cert.json") as {
  cas: ReadonlyArray<{ name: string; public: string }>;
};
const ca1 = cert.cas.find((ca) => ca.name === "ca1");
if (ca1 === undefined) {
  throw new Error("vectors/card/cert.json has no ca1 entry");
}

/** The test CA the bridge personalises every card under. */
export const CA1_ANCHOR: Anchor = { batch: ca1.name, key: hexToBytes(ca1.public) };

export type SimCard = {
  readonly index: number;
  /** The 97-byte certificate the card was personalised with (`A ‖ r ‖ s`). */
  readonly cert: Uint8Array;
  /** The card's compressed identity key: `cert[0..33)`. */
  readonly identity: Uint8Array;
  /** One raw C-APDU; `"torn"` when the armed tear fired and the card lost power mid-command. */
  readonly transmit: (apdu: Uint8Array) => Promise<Uint8Array | "torn">;
  /** Arms the tear on the `write`-th persistent write of a later command. */
  readonly tear: (write: number) => Promise<void>;
  /** Power cycle: clears the selection; the client must SELECT again itself. */
  readonly reset: () => Promise<void>;
};

export type Simulator = {
  /** Installs, selects and personalises a fresh card under ca1; BLANK and power-cycled. */
  readonly newCard: () => Promise<SimCard>;
  /** Kills the bridge child; idempotent. */
  readonly close: () => Promise<void>;
};

/** Returns `response` unchanged, or throws the bridge's `ERR` message. */
const expect = (line: string, response: string): string => {
  if (response.startsWith("ERR ")) {
    throw new Error(`bridge: ${response.slice(4)} (${line})`);
  }
  return response;
};

/** Spawns the bridge launcher and returns its multi-card client. */
export async function startSimulator(
  launcher: string | undefined = SIM_LAUNCHER,
): Promise<Simulator> {
  if (launcher === undefined) {
    throw new Error("QNTX_CARD_SIM is not set and no launcher was given");
  }
  const proc: ChildProcess = spawn(launcher, [], { stdio: ["pipe", "pipe", "pipe"] });
  // stderr is drained (the bridge logs there) and kept for the exit error.
  const stderr: string[] = [];
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString("utf8"));
  });
  const kill = (): void => {
    proc.kill("SIGKILL");
  };
  process.on("exit", kill);

  let buffer = "";
  const lines: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  const deliver = (line: string): void => {
    const waiter = waiters.shift();
    if (waiter === undefined) {
      lines.push(line);
    } else {
      waiter.resolve(line);
    }
  };
  proc.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let cut = buffer.indexOf("\n");
    while (cut >= 0) {
      deliver(buffer.slice(0, cut).trim());
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf("\n");
    }
  });
  const fail = (error: Error): void => {
    for (const waiter of waiters.splice(0)) {
      waiter.reject(error);
    }
  };
  proc.on("error", (error) => fail(error));
  proc.on("exit", (code, signal) =>
    fail(
      new Error(
        `card-sim bridge exited (code ${String(code)}, signal ${String(signal)}): ${stderr.join("").trim()}`,
      ),
    ),
  );
  // Eager so close() cannot miss an exit emitted between kill() and awaiting it.
  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => {
      resolve();
    });
  });

  const readLine = async (): Promise<string> => {
    const queued = lines.shift();
    return queued === undefined
      ? new Promise((resolve, reject) => {
          waiters.push({ resolve, reject });
        })
      : Promise.resolve(queued);
  };

  // The bridge answers one line per request line, in order: the promise chain itself is the
  // serialization, so concurrent callers are queued behind the previous request.
  let tail: Promise<unknown> = Promise.resolve();
  const ask = async (line: string): Promise<string> => {
    // oxlint-disable-next-line promise/prefer-await-to-then -- the queue IS promise chaining
    const answer = tail.then(async () => {
      proc.stdin?.write(`${line}\n`);
      return readLine();
    });
    // oxlint-disable-next-line promise/prefer-await-to-then -- the next request waits on this one
    tail = answer.catch(() => undefined);
    return answer;
  };

  const ready = await readLine();
  if (ready !== "READY") {
    throw new Error(`bridge answered ${ready} on start, expected READY`);
  }

  const newCard = async (): Promise<SimCard> => {
    const response = expect("new", await ask("new"));
    const match = /^CARD (\d+) ([0-9a-f]+)$/.exec(response);
    if (match === null) {
      throw new Error(`bridge answered ${response} to new`);
    }
    const index = Math.trunc(Number(match[1] ?? "0"));
    const cardCert = hexToBytes(match[2] ?? "");
    const transmit = async (apdu: Uint8Array): Promise<Uint8Array | "torn"> => {
      const answer = expect("apdu", await ask(`apdu ${index} ${bytesToHex(apdu)}`));
      if (answer === "TORN") {
        return "torn";
      }
      if (!answer.startsWith("R ")) {
        throw new Error(`bridge answered ${answer} to apdu`);
      }
      return hexToBytes(answer.slice(2));
    };
    const tear = async (write: number): Promise<void> => {
      if (expect("tear", await ask(`tear ${index} ${write}`)) !== "OK") {
        throw new Error("bridge refused tear");
      }
    };
    const reset = async (): Promise<void> => {
      if (expect("reset", await ask(`reset ${index}`)) !== "OK") {
        throw new Error("bridge refused reset");
      }
    };
    return {
      index,
      cert: cardCert,
      identity: new Uint8Array(cardCert.subarray(0, 33)),
      transmit,
      tear,
      reset,
    };
  };

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    process.removeListener("exit", kill);
    proc.stdin?.end();
    kill();
    await exited;
    fail(new Error("card-sim bridge closed"));
  };

  return { newCard, close };
}
