import { describe, expect, it } from "vite-plus/test";

import { INSTALL_ID_HEADER } from "../src/gateway/contract/index.ts";
import { PhishingController } from "../src/phishing/controller.ts";
import { createMemoryPublicStore } from "../src/store/memory.ts";
import { b64 } from "./phishing-helpers.ts";

const GATEWAY = { url: "https://gateway.test", installId: "0123456789abcdef0123456789abcdef" };

type Reply = (signal: AbortSignal | undefined) => Response | Promise<Response>;

const snapshot = (version: number, deny: string[], allow: string[] = []): Reply => {
  return () => Response.json({ kind: "snapshot", version, deny: b64(deny), allow: b64(allow) });
};

const urlOf = (input: Parameters<typeof globalThis.fetch>[0]): string =>
  input instanceof Request ? input.url : String(input);

function rig(
  options: { gateway?: typeof GATEWAY | undefined; values?: Map<string, Uint8Array> } = {},
) {
  const gateway = "gateway" in options ? options.gateway : GATEWAY;
  const values = options.values ?? new Map<string, Uint8Array>();
  const requests: Array<{ url: string; installId: string | null }> = [];
  const replies: Reply[] = [];
  const warnings: string[] = [];
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  let clock = 1000;
  const controller = new PhishingController({
    publicStore: createMemoryPublicStore({ values }),
    gateway,
    fetch: async (input, init) => {
      const url = urlOf(input);
      requests.push({ url, installId: new Headers(init?.headers).get(INSTALL_ID_HEADER) });
      const reply = replies.shift();
      if (reply === undefined) {
        throw new TypeError("no scripted reply");
      }
      return reply(init?.signal ?? undefined);
    },
    now: () => clock,
    setTimer: (ms, fn) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    logger: { warn: (message) => warnings.push(message) },
  });
  const fire = (ms: number): void => {
    for (const timer of timers.filter((t) => t.ms === ms && !t.cancelled)) {
      timer.cancelled = true;
      timer.fn();
    }
  };
  const armed = (ms: number): number => timers.filter((t) => t.ms === ms && !t.cancelled).length;
  return {
    controller,
    armed,
    values,
    requests,
    replies,
    warnings,
    timers,
    fire,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("audit GS", () => {
  it("GS-F an allow entry with the same key as a deny entry clears it; a broader one does not", async () => {
    const { controller, replies } = rig();
    replies.push(
      snapshot(1, ["x1.pages.dev", "x2.pages.dev", "evil.example"], ["x1.pages.dev", "pages.dev"]),
    );
    await controller.init();
    expect(controller.check("https://x1.pages.dev/login")).toBe("clear");
    expect(controller.check("https://x2.pages.dev/")).toBe("blocked");
    expect(controller.check("https://evil.example/")).toBe("blocked");
  });

  it("GS-F-control the same deny list with an empty allow keeps x1 blocked", async () => {
    const { controller, replies } = rig();
    replies.push(snapshot(1, ["x1.pages.dev", "x2.pages.dev", "evil.example"]));
    await controller.init();
    expect(controller.check("https://x1.pages.dev/login")).toBe("blocked");
  });
});
