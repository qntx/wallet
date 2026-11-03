/**
 * `@qntx/wallet-engine/connect` — the in-app-browser provider injection and message bridge.
 * Platform-neutral: the injected script is a plain string the host runs in the WebView; the bridge
 * lives in the main runtime and speaks `postMessage`/`injectJavaScript` through the host's `inject`
 * hook. No WebView or DOM types cross this boundary.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type { ConnectionController } from "./controller.ts";
import type { Eip1193Event, Eip1193Handler } from "./eip1193.ts";
import { ProviderError } from "./errors.ts";
import { PROVIDER_SCRIPT } from "./inject.generated.ts";
import type { Nip07Handler } from "./nip07.ts";

export type { ConnectionController, ConnectionSession } from "./controller.ts";
export type { Eip1193Handler, Eip1193Request, Eip1193Event } from "./eip1193.ts";
export type { Nip07Handler, Nip07Request } from "./nip07.ts";
export { ProviderError } from "./errors.ts";

/** The EIP-6963 provider identity the host stamps into the injected script. */
export type ProviderInfo = {
  /** UUIDv4 — the host generates or fixes one per install. */
  readonly uuid: string;
  /** 1–64 characters. */
  readonly name: string;
  /** `data:image/(png|svg+xml|webp);base64,…`, ≤ 64 KiB of base64. */
  readonly icon: string;
  /** Lowercase reverse-DNS, e.g. `xyz.meowl`. */
  readonly rdns: string;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ICON_PREFIX = /^data:image\/(png|svg\+xml|webp);base64,/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const RDNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_ICON_B64 = 64 * 1024;

const bad = (message: string): Error => new Error(`ProviderInfo: ${message}`);

function checkInfo(info: ProviderInfo): void {
  if (typeof info !== "object" || info === null) {
    throw bad("not an object");
  }
  if (!UUID_V4.test(info.uuid)) {
    throw bad("uuid is not a UUIDv4");
  }
  if (typeof info.name !== "string" || info.name.length === 0 || info.name.length > 64) {
    throw bad("name must be 1–64 characters");
  }
  const iconMatch = ICON_PREFIX.exec(info.icon);
  if (iconMatch === null) {
    throw bad("icon is not a png/svg+xml/webp data URL");
  }
  const base64 = info.icon.slice(iconMatch[0].length);
  if (base64.length > MAX_ICON_B64 || !BASE64.test(base64)) {
    throw bad("icon base64 is empty or over 64 KiB");
  }
  if (
    typeof info.rdns !== "string" ||
    info.rdns.length === 0 ||
    !info.rdns.split(".").every((label) => RDNS_LABEL.test(label)) ||
    info.rdns.split(".").length < 2
  ) {
    throw bad("rdns is not lowercase reverse-DNS labels");
  }
}

/**
 * The script the host injects into the page: the fixed provider body plus one
 * `qntxProvider.install` call carrying `info`. `info` is strictly validated — an invalid field
 * throws before the script is produced, so a misconfigured host fails before anything reaches the
 * page.
 */
export function injectedScript(info: ProviderInfo): string {
  checkInfo(info);
  return `${PROVIDER_SCRIPT}\nqntxProvider.install(${JSON.stringify(info)});`;
}

/** SHA-256 (hex) of the fixed provider script — no install call — for the CI freshness check. */
export const PROVIDER_SCRIPT_SHA256: string = bytesToHex(sha256(utf8ToBytes(PROVIDER_SCRIPT)));

/** The bridge the host's WebView message handler calls. */
export type BrowserBridge = {
  /**
   * `onMessage`: `topUrl` is the WebView's `nativeEvent.url` (the observed top-level URL — the only
   * source of truth for the page's origin); `data` is `nativeEvent.data`.
   */
  readonly message: (topUrl: string, data: string) => void;
  /** Top-level navigation completed: an origin change voids the old origin's pending work. */
  readonly navigated: (topUrl: string) => void;
  readonly dispose: () => void;
};

export type BrowserBridgeOptions = {
  readonly eip1193: Pick<Eip1193Handler, "handle" | "subscribe">;
  readonly nip07: Pick<Nip07Handler, "handle">;
  readonly connections: Pick<ConnectionController, "checkOrigin" | "invalidateOrigin">;
  /** The host's `webview.injectJavaScript`. */
  readonly inject: (script: string) => void;
  readonly now: () => number;
};

const MAX_MESSAGE_BYTES = 128 * 1024;
const RATE_LIMIT_PER_MINUTE = 120;
const RATE_WINDOW_MS = 60_000;
const DISCONNECT = { code: 4900, message: "disconnected" };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The EIP-1193 listener payload of an engine event. */
const eventData = (event: Eip1193Event): unknown => {
  if (event.name === "connect") {
    return { chainId: event.chainId };
  }
  if (event.name === "accountsChanged") {
    return event.accounts;
  }
  return event.name === "chainChanged" ? event.chainId : DISCONNECT;
};

/** A provider error keeps its code and message; anything else is an opaque internal error. */
const errorData = (error: unknown): { code: number; message: string } =>
  error instanceof ProviderError
    ? { code: error.code, message: error.message }
    : { code: -32603, message: "internal error" };

export function createBrowserBridge(options: BrowserBridgeOptions): BrowserBridge {
  const { eip1193, nip07, connections, inject, now } = options;
  let topOrigin: string | undefined;
  let disposed = false;
  /** Per-origin request timestamps in the current window, for the 120/min cap. */
  const hits = new Map<string, number[]>();

  const originOf = (topUrl: string): string | undefined => {
    try {
      const { origin } = new URL(topUrl);
      connections.checkOrigin(origin);
      return origin;
    } catch {
      return undefined;
    }
  };

  const receive = (payload: unknown): void => {
    // __qntxReceive takes a JSON *string* (it parses it): embed the payload double-encoded, so the
    // injected script is `globalThis.__qntxReceive("<json>")`, not an object argument.
    inject(`globalThis.__qntxReceive(${JSON.stringify(JSON.stringify(payload))})`);
  };

  const rateLimited = (origin: string): boolean => {
    const window_ = now() - RATE_WINDOW_MS;
    const hitsFor = (hits.get(origin) ?? []).filter((at) => at > window_);
    hits.set(origin, hitsFor);
    if (hitsFor.length >= RATE_LIMIT_PER_MINUTE) {
      return true;
    }
    hitsFor.push(now());
    return false;
  };

  const unsubscribe = eip1193.subscribe((event) => {
    if (disposed || topOrigin === undefined || event.origin !== topOrigin) {
      return;
    }
    receive({ event: event.name, data: eventData(event) });
  });

  const message = (topUrl: string, data: string): void => {
    if (disposed || data.length > MAX_MESSAGE_BYTES) {
      return;
    }
    const origin = originOf(topUrl);
    if (origin === undefined || origin !== topOrigin) {
      return; // the page's top origin is the only source of truth; a foreign frame is dropped.
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isObject(parsed)) {
      return;
    }
    const { id, method, params, qntx, provider } = parsed;
    if (
      qntx !== 1 ||
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      id < 0 ||
      typeof method !== "string"
    ) {
      return;
    }
    // `provider` selects the handler; an unknown or missing value is a malformed message.
    const handler = provider === "eip1193" ? eip1193 : provider === "nostr" ? nip07 : undefined;
    if (handler === undefined) {
      return;
    }
    if (rateLimited(origin)) {
      receive({ id, error: DISCONNECT });
      return;
    }
    void (async (): Promise<void> => {
      try {
        const result = await handler.handle(
          origin,
          params === undefined ? { method } : { method, params },
        );
        if (!disposed && origin === topOrigin) {
          receive({ id, result });
        }
      } catch (error: unknown) {
        if (!disposed && origin === topOrigin) {
          receive({ id, error: errorData(error) });
        }
      }
    })();
  };

  const navigated = (topUrl: string): void => {
    if (disposed) {
      return;
    }
    // An unacceptable origin (http, about:blank, a malformed URL) is no origin: the old page is
    // still gone, its pending work is voided and its late replies are dropped.
    const next = originOf(topUrl);
    if (next !== topOrigin) {
      if (topOrigin !== undefined) {
        connections.invalidateOrigin(topOrigin);
      }
      topOrigin = next;
    }
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    unsubscribe();
    if (topOrigin !== undefined) {
      connections.invalidateOrigin(topOrigin);
      topOrigin = undefined;
    }
  };

  return { message, navigated, dispose };
}
