/**
 * Test driver for speculos containers started by scripts/ledger/speculos.ts.
 *
 * Reads .cache/ledger/endpoints.json (written by that script — it must run first). APDU exchange
 * uses the speculos TCP protocol (speculos/mcu/apdu.py): request is u32be(len(apdu)) ‖ apdu;
 * response is u32be(len(data)) ‖ data ‖ u16be(sw) — the length covers the data only, the status
 * word is the trailing two bytes outside it. Screen control uses the REST API
 * (speculos/api/api.py): GET /events?currentscreenonly=true returns the screen's TextEvents, POST
 * /button/{left,right,both} {"action": ...} presses buttons.
 */

import { existsSync, readFileSync } from "node:fs";
import { Socket } from "node:net";
import { fileURLToPath } from "node:url";

const endpointsPath = fileURLToPath(
  new URL("../../../../.cache/ledger/endpoints.json", import.meta.url),
);

export type SpeculosEndpoint = {
  apdu: string;
  api: string;
};

function isEndpoint(value: unknown): value is SpeculosEndpoint {
  return (
    typeof value === "object" &&
    value !== null &&
    "apdu" in value &&
    "api" in value &&
    typeof value.apdu === "string" &&
    typeof value.api === "string"
  );
}

export function hasEndpoints(): boolean {
  return existsSync(endpointsPath);
}

export function endpoints(): Record<string, SpeculosEndpoint> {
  const raw: unknown = JSON.parse(readFileSync(endpointsPath, "utf8"));
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${endpointsPath}: expected an object`);
  }
  const out: Record<string, SpeculosEndpoint> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isEndpoint(value)) {
      throw new Error(`${endpointsPath}: bad endpoint for "${key}"`);
    }
    out[key] = value;
  }
  return out;
}

function endpoint(app: string): SpeculosEndpoint {
  const e = endpoints()[app];
  if (e === undefined) {
    throw new Error(`no speculos endpoint for "${app}" in ${endpointsPath}`);
  }
  return e;
}

/** Send one APDU; resolves with the RAPDU bytes (response data ‖ 2-byte status word). */
export async function exchange(app: string, apdu: Uint8Array): Promise<Uint8Array> {
  const [host, port] = endpoint(app).apdu.split(":");
  if (host === undefined || host === "" || port === undefined || port === "") {
    throw new Error(`bad apdu endpoint for "${app}"`);
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const socket = new Socket();
    const chunks: Buffer[] = [];
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.on("error", fail);
    socket.on("connect", () => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(apdu.length);
      socket.write(Buffer.concat([header, Buffer.from(apdu)]));
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) {
        return;
      }
      const dataLen = buf.readUInt32BE(0);
      if (buf.length < 4 + dataLen + 2) {
        return;
      }
      socket.destroy();
      resolve(new Uint8Array(buf.subarray(4, 4 + dataLen + 2)));
    });
    socket.on("close", () => {
      fail(new Error(`${app}: speculos closed the APDU connection`));
    });
    socket.connect(Number(port), host);
  });
}

export function rapduData(rapdu: Uint8Array): Uint8Array {
  return rapdu.subarray(0, -2);
}

export function rapduSw(rapdu: Uint8Array): number {
  const hi = rapdu.at(-2);
  const lo = rapdu.at(-1);
  if (hi === undefined || lo === undefined) {
    throw new Error("empty RAPDU");
  }
  return (hi << 8) | lo;
}

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function isEventsBody(value: unknown): value is { events: Array<{ text: string }> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "events" in value &&
    Array.isArray(value.events) &&
    value.events.every((e: unknown) => typeof e === "object" && e !== null && "text" in e)
  );
}

type Button = "left" | "right" | "both";

export type NavigateOptions = {
  /** Hold both buttons this long instead of a click — for "Hold to sign" screens. */
  holdMs?: number;
  maxSteps?: number;
  /**
   * Warning interstitials to confirm with both buttons and continue (e.g. "Blind signing ahead — To
   * accept risk, press both buttons"); checked before `match` so a warning that happens to contain
   * the match word does not end navigation early.
   */
  through?: RegExp;
  /**
   * Menu screens to wait out without pressing — the review may not have drawn yet when navigation
   * starts; a right-press on a stale menu screen is consumed by the review's first page and can
   * skip straight to its Reject page.
   */
  leave?: RegExp;
};

/**
 * Buttons and screen scraping for one app. `texts` accumulates every distinct screen seen so tests
 * can assert on what the device showed.
 */
export class Screen {
  readonly texts: string[] = [];
  private readonly endpoint: SpeculosEndpoint;
  private lastScreen = "";

  constructor(app: string) {
    this.endpoint = endpoint(app);
  }

  async screen(): Promise<string> {
    const response = await fetch(`${this.endpoint.api}/events?currentscreenonly=true`);
    if (!response.ok) {
      throw new Error(`/events: HTTP ${String(response.status)}`);
    }
    const body: unknown = await response.json();
    if (!isEventsBody(body)) {
      throw new Error("/events: unexpected response shape");
    }
    return body.events
      .map((e) => e.text)
      .join(" ")
      .replaceAll(/\s+/g, " ")
      .trim();
  }

  async button(button: Button, action: "press" | "release" | "press-and-release"): Promise<void> {
    const response = await fetch(`${this.endpoint.api}/button/${button}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!response.ok) {
      throw new Error(`/button/${button}: HTTP ${String(response.status)}`);
    }
  }

  private async navigate(match: RegExp, opts: NavigateOptions): Promise<void> {
    const maxSteps = opts.maxSteps ?? 30;
    for (let step = 0; step < maxSteps; step++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- screens must be polled one at a time
      const screen = await this.screen();
      if (screen !== this.lastScreen) {
        this.lastScreen = screen;
        this.texts.push(screen);
      }
      if (opts.through?.test(screen) === true) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- warnings are confirmed one at a time
        await this.button("both", "press-and-release");
        // oxlint-disable-next-line eslint/no-await-in-loop -- let the device redraw between steps
        await sleep(200);
        continue;
      }
      if (match.test(screen)) {
        if (opts.holdMs !== undefined && opts.holdMs > 0) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- hold is sequential by definition
          await this.button("both", "press");
          // oxlint-disable-next-line eslint/no-await-in-loop -- hold is sequential by definition
          await sleep(opts.holdMs);
          // oxlint-disable-next-line eslint/no-await-in-loop -- hold is sequential by definition
          await this.button("both", "release");
        } else {
          // oxlint-disable-next-line eslint/no-await-in-loop -- single confirm step
          await this.button("both", "press-and-release");
        }
        return;
      }
      if (opts.leave?.test(screen) === true) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- poll until the review draws
        await sleep(250);
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- pages advance one at a time
      await this.button("right", "press-and-release");
      // oxlint-disable-next-line eslint/no-await-in-loop -- let the device redraw between steps
      await sleep(200);
    }
    throw new Error(`screen ${String(match)} not reached; saw: ${this.texts.join(" | ")}`);
  }

  /**
   * Advance right until the screen shows the app's approve label, then press both (held `holdMs`
   * for "Hold to sign" screens). Run it concurrently with an `exchange` that blocks on user
   * approval.
   */
  async approve(match: RegExp, opts: NavigateOptions = {}): Promise<void> {
    return this.navigate(match, opts);
  }

  /** Advance right until the screen shows the app's reject label, then press both. */
  async reject(match: RegExp, opts: NavigateOptions = {}): Promise<void> {
    return this.navigate(match, opts);
  }
}
