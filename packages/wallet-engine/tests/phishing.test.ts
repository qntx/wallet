import { describe, expect, it } from "vite-plus/test";

import { gatewayFetch } from "../src/gateway/client.ts";
import { INSTALL_ID_HEADER } from "../src/gateway/contract/index.ts";
import { PHISHING_REFRESH_MS, PhishingController } from "../src/phishing/controller.ts";
import { createMemoryPublicStore } from "../src/store/memory.ts";
import { b64 } from "./phishing-helpers.ts";

const GATEWAY = { url: "https://gateway.test", installId: "0123456789abcdef0123456789abcdef" };
const LIST_URL = `${GATEWAY.url}/v1/risk/lists/phishing`;
const TIMEOUT_MS = 30_000;

type Reply = (signal: AbortSignal | undefined) => Response | Promise<Response>;

const snapshot = (version: number, deny: string[], allow: string[] = []): Reply => {
  return () => Response.json({ kind: "snapshot", version, deny: b64(deny), allow: b64(allow) });
};

const diff = (
  from: number,
  version: number,
  deny: { add: string[]; remove: string[] },
  allow?: { add: string[]; remove: string[] },
): Reply => {
  const encode = (d: { add: string[]; remove: string[] }) => ({
    add: b64(d.add),
    remove: b64(d.remove),
  });
  return () =>
    Response.json({
      kind: "diff",
      from,
      version,
      deny: encode(deny),
      allow: encode(allow ?? { add: [], remove: [] }),
    });
};

const json =
  (body: unknown): Reply =>
  () =>
    Response.json(body);

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

const urlOf = (input: Parameters<typeof globalThis.fetch>[0]): string =>
  input instanceof Request ? input.url : String(input);

const sinceOf = (url: string | undefined): string | null =>
  new URL(url ?? "").searchParams.get("since");

describe("PhishingController sync", () => {
  it("is unchecked until a list is loaded, and clear for non-web URLs", () => {
    const { controller } = rig();
    expect(controller.check("https://evil.com/")).toBe("unchecked");
    expect(controller.check("ftp://evil.com/")).toBe("clear");
  });

  it("installs a snapshot, sends the install id, and persists it", async () => {
    const { controller, replies, requests, values } = rig();
    replies.push(snapshot(10, ["evil.com"], ["good.com"]));
    await controller.init();
    expect(requests).toStrictEqual([{ url: LIST_URL, installId: GATEWAY.installId }]);
    expect(controller.getState()).toMatchObject({ version: 10, updatedAt: 1000 });
    expect(controller.check("https://evil.com/login")).toBe("blocked");
    expect(controller.check("https://fine.com/")).toBe("clear");
    expect(values.has("phishing-list")).toBe(true);
  });

  it("restores from the public store without a network request", async () => {
    const first = rig();
    first.replies.push(snapshot(10, ["evil.com"]));
    await first.controller.init();

    const second = rig({ values: first.values, gateway: undefined });
    await second.controller.init();
    expect(second.requests).toHaveLength(0);
    expect(second.controller.getState().version).toBe(10);
    expect(second.controller.check("https://evil.com/")).toBe("blocked");
  });

  it("asks for a diff since the stored version and applies it", async () => {
    const { controller, replies, requests } = rig();
    replies.push(
      snapshot(10, ["a.com", "b.com"]),
      diff(10, 11, { add: ["c.com"], remove: ["a.com"] }),
    );
    await controller.init();
    await controller.sync();
    expect(sinceOf(requests[1]?.url)).toBe("10");
    expect(controller.getState().version).toBe(11);
    expect(controller.check("https://a.com/")).toBe("clear");
    expect(controller.check("https://b.com/")).toBe("blocked");
    expect(controller.check("https://c.com/")).toBe("blocked");
  });

  it("ignores a diff whose from is not the local version and refetches a snapshot", async () => {
    const { controller, replies, requests } = rig();
    replies.push(
      snapshot(10, ["a.com"]),
      diff(9, 12, { add: ["c.com"], remove: [] }),
      snapshot(12, ["a.com", "c.com"]),
    );
    await controller.init();
    await controller.sync();
    expect(controller.check("https://c.com/")).toBe("clear");
    expect(controller.getState().version).toBeNull();
    await controller.sync();
    expect(sinceOf(requests[2]?.url)).toBeNull();
    expect(controller.check("https://c.com/")).toBe("blocked");
    expect(controller.getState().version).toBe(12);
  });

  it("updates only updatedAt on current", async () => {
    const { controller, replies, advance, values } = rig();
    replies.push(snapshot(10, ["a.com"]), json({ kind: "current", version: 10 }));
    await controller.init();
    const stored = values.get("phishing-list");
    advance(5000);
    await controller.sync();
    expect(values.get("phishing-list")).toBe(stored);
    expect(controller.getState()).toMatchObject({ version: 10, updatedAt: 6000 });
    expect(controller.check("https://a.com/")).toBe("blocked");
  });

  it.each([
    ["not the contract", json({ kind: "nope" })],
    ["a non-JSON body", () => new Response("<html>", { status: 200 })],
    ["an error status", () => new Response("{}", { status: 503 })],
    [
      "a snapshot that is not ascending",
      json({
        kind: "snapshot",
        version: 3,
        deny: btoa(String.fromCodePoint(2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0)),
        allow: "",
      }),
    ],
    [
      "a hash list of the wrong width",
      json({ kind: "snapshot", version: 3, deny: btoa("123456789"), allow: "" }),
    ],
  ])("keeps the current list and warns on %s", async (_name, bad) => {
    const { controller, replies, warnings } = rig();
    replies.push(snapshot(10, ["a.com"]), bad);
    await controller.init();
    await controller.sync();
    expect(warnings).toHaveLength(1);
    expect(controller.getState().version).toBe(10);
    expect(controller.check("https://a.com/")).toBe("blocked");
  });

  it("warns and keeps nothing when the first sync fails", async () => {
    const { controller, replies, warnings } = rig();
    replies.push(() => {
      throw new TypeError("offline");
    });
    await controller.init();
    expect(warnings).toHaveLength(1);
    expect(controller.check("https://a.com/")).toBe("unchecked");
  });

  it("ignores a malformed stored list with a warning", async () => {
    const values = new Map<string, Uint8Array>([
      ["phishing-list", new TextEncoder().encode(JSON.stringify({ version: 1, deny: "x" }))],
    ]);
    const { controller, warnings } = rig({ values, gateway: undefined });
    await controller.init();
    expect(warnings).toHaveLength(1);
    expect(controller.check("https://a.com/")).toBe("unchecked");
  });

  it("does not sync without a gateway", async () => {
    const { controller, requests } = rig({ gateway: undefined });
    await controller.init();
    await controller.sync();
    expect(requests).toHaveLength(0);
    expect(controller.check("https://a.com/")).toBe("unchecked");
  });

  it("shares one request between concurrent syncs", async () => {
    const { controller, replies, requests } = rig();
    replies.push(snapshot(10, ["a.com"]));
    await Promise.all([controller.sync(), controller.sync(), controller.sync()]);
    expect(requests).toHaveLength(1);
  });

  it("aborts a sync after 30 seconds", async () => {
    const { controller, replies, warnings, fire } = rig();
    replies.push(
      async (signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const pending = controller.sync();
    fire(TIMEOUT_MS);
    await pending;
    expect(warnings).toHaveLength(1);
    expect(controller.check("https://a.com/")).toBe("unchecked");
  });

  it("refreshes every hour and stops after destroy", async () => {
    const { controller, replies, requests, fire } = rig();
    replies.push(snapshot(10, ["a.com"]), json({ kind: "current", version: 10 }));
    await controller.init();
    fire(PHISHING_REFRESH_MS);
    await controller.sync();
    expect(requests).toHaveLength(2);
    await controller.destroy();
    fire(PHISHING_REFRESH_MS);
    expect(requests).toHaveLength(2);
  });

  it("re-arms the refresh after each run", async () => {
    const { controller, replies, armed, fire } = rig();
    replies.push(snapshot(10, ["a.com"]), json({ kind: "current", version: 10 }));
    await controller.init();
    expect(armed(PHISHING_REFRESH_MS)).toBe(1);
    fire(PHISHING_REFRESH_MS);
    await controller.sync();
    await Promise.resolve();
    expect(armed(PHISHING_REFRESH_MS)).toBe(1);
  });

  it("discards a sync result that arrives after destroy", async () => {
    const { controller, replies } = rig();
    let release: (response: Response) => void = () => undefined;
    replies.push(
      async () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const pending = controller.sync();
    await controller.destroy();
    release(Response.json({ kind: "snapshot", version: 1, deny: b64(["a.com"]), allow: "" }));
    await pending;
    expect(controller.check("https://a.com/")).toBe("unchecked");
    expect(controller.getState().version).toBeNull();
  });
});

describe("PhishingController check", () => {
  async function loaded(deny: string[], allow: string[] = []) {
    const context = rig();
    context.replies.push(snapshot(1, deny, allow));
    await context.controller.init();
    return context;
  }

  it("matches path prefixes from the deepest down", async () => {
    const { controller } = await loaded(["sites.google.com/view/scam"]);
    expect(controller.check("https://sites.google.com/view/scam")).toBe("blocked");
    expect(controller.check("https://sites.google.com/view/scam/page/2?x=1")).toBe("blocked");
    expect(controller.check("https://sites.google.com/view/fine")).toBe("clear");
    expect(controller.check("https://sites.google.com/")).toBe("clear");
  });

  it("matches parent domains and the host itself", async () => {
    const { controller } = await loaded(["evil.com"]);
    expect(controller.check("https://login.evil.com/")).toBe("blocked");
    expect(controller.check("https://a.b.evil.com/x")).toBe("blocked");
    expect(controller.check("https://notevil.com/")).toBe("clear");
  });

  it("lets an allow entry beat a deny entry on the same candidate", async () => {
    const { controller } = await loaded(["both.com"], ["both.com"]);
    expect(controller.check("https://both.com/")).toBe("clear");
  });

  it("lets a more specific deny beat a parent allow", async () => {
    const { controller } = await loaded(["scam.github.io"], ["github.io"]);
    expect(controller.check("https://scam.github.io/")).toBe("blocked");
    expect(controller.check("https://github.io/")).toBe("clear");
    expect(controller.check("https://friend.github.io/")).toBe("clear");
  });

  it("lets a more specific allow beat a parent deny", async () => {
    const { controller } = await loaded(["evil.com"], ["docs.evil.com"]);
    expect(controller.check("https://docs.evil.com/")).toBe("clear");
    expect(controller.check("https://www.evil.com/")).toBe("blocked");
  });

  it("does not block a hosting root because a tenant is listed", async () => {
    const { controller } = await loaded(["scam.vercel.app"], ["vercel.app"]);
    expect(controller.check("https://vercel.app/")).toBe("clear");
    expect(controller.check("https://scam.vercel.app/")).toBe("blocked");
  });

  it("checks an IP address only as a whole host", async () => {
    const { controller } = await loaded(["0.0.1", "10.0.0.2"]);
    expect(controller.check("http://10.0.0.1/login")).toBe("clear");
    expect(controller.check("http://10.0.0.2/login")).toBe("blocked");
  });
});

describe("PhishingController trust", () => {
  it("turns blocked into trusted for that origin only", async () => {
    const { controller, replies } = rig();
    replies.push(snapshot(1, ["evil.com"]));
    await controller.init();
    await controller.trust("https://evil.com");
    expect(controller.check("https://evil.com/path")).toBe("trusted");
    expect(controller.check("https://www.evil.com/")).toBe("blocked");
    expect(controller.check("http://evil.com/")).toBe("blocked");
    await controller.untrust("https://evil.com");
    expect(controller.check("https://evil.com/")).toBe("blocked");
    expect(controller.getState().trusted).toStrictEqual([]);
  });

  it("persists the trusted origins", async () => {
    const first = rig({ gateway: undefined });
    await first.controller.trust("https://evil.com:8443");
    await first.controller.trust("https://evil.com:8443");
    const second = rig({ values: first.values, gateway: undefined });
    await second.controller.init();
    expect(second.controller.getState().trusted).toStrictEqual(["https://evil.com:8443"]);
  });

  it.each([
    "evil.com",
    "https://evil.com/",
    "https://evil.com/path",
    "https://Evil.com",
    "ftp://evil.com",
    "file:///etc/hosts",
    "",
  ])("rejects the origin %j", async (origin) => {
    const { controller } = rig({ gateway: undefined });
    await expect(controller.trust(origin)).rejects.toThrow("http(s)://host[:port]");
    await expect(controller.untrust(origin)).rejects.toThrow("http(s)://host[:port]");
  });
});

describe("gatewayFetch", () => {
  it("adds the install id to the gateway origin only", async () => {
    const seen: Array<{ url: string; installId: string | null }> = [];
    const wrapped = gatewayFetch(async (input, init) => {
      const url = urlOf(input);
      seen.push({ url, installId: new Headers(init?.headers).get(INSTALL_ID_HEADER) });
      return Promise.resolve(new Response("{}"));
    }, GATEWAY);
    await wrapped(`${GATEWAY.url}/v1/health`);
    await wrapped("https://other.test/v1/health", { headers: { accept: "text/plain" } });
    expect(seen).toStrictEqual([
      { url: `${GATEWAY.url}/v1/health`, installId: GATEWAY.installId },
      { url: "https://other.test/v1/health", installId: null },
    ]);
  });

  it("adds nothing without a gateway", async () => {
    let installId: string | null = "unset";
    const wrapped = gatewayFetch(async (_input, init) => {
      installId = new Headers(init?.headers).get(INSTALL_ID_HEADER);
      return Promise.resolve(new Response("{}"));
    }, undefined);
    await wrapped(`${GATEWAY.url}/v1/health`);
    expect(installId).toBeNull();
  });
});
