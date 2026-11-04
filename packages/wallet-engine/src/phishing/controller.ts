import * as z from "zod/mini";

import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import { gatewayFetch } from "../gateway/client.ts";
import type { GatewayConfig } from "../gateway/client.ts";
import {
  applyDiff,
  contains,
  decodeHashList,
  encodeHashList,
  parseWith,
  phishingCandidates,
  phishingHash,
  phishingListPath,
  phishingListResponse,
} from "../gateway/contract/index.ts";
import type { HashList } from "../gateway/contract/index.ts";
import type { PublicStore } from "../store/port.ts";
import { timeoutSignal } from "../timer.ts";
import type { PhishingStatus } from "./status.ts";

export const PHISHING_REFRESH_MS = 3_600_000;
const SYNC_TIMEOUT_MS = 30_000;
const LIST_KEY = "phishing-list";
const TRUSTED_KEY = "phishing-trusted";

export type PhishingState = {
  // oxlint-disable-next-line typescript/no-restricted-types -- state shape: null until a list is synced
  readonly version: number | null;
  /** Last successful sync in this process, or the stored list's time after a restart. */
  // oxlint-disable-next-line typescript/no-restricted-types -- state shape: null until a list is synced
  readonly updatedAt: number | null;
  readonly trusted: ReadonlyArray<string>;
};

export type PhishingControllerOptions = {
  readonly publicStore: PublicStore;
  readonly gateway?: GatewayConfig | undefined;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  readonly logger: EngineLogger;
};

const storedList = z.object({
  version: z.number().check(z.int(), z.nonnegative()),
  updatedAt: z.number(),
  deny: z.string(),
  allow: z.string(),
});

const storedTrusted = z.array(z.string());

const isOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class PhishingController extends Controller<PhishingState> {
  private readonly options: PhishingControllerOptions;
  private readonly fetchGateway: typeof globalThis.fetch;
  private deny: HashList | undefined;
  private allow: HashList | undefined;
  private inflight: Promise<void> | undefined;
  private abort: { readonly abort: () => void } | undefined;
  private cancelTimer: (() => void) | undefined;
  private epoch = 0;
  private destroyed = false;

  constructor(options: PhishingControllerOptions) {
    super({
      name: "phishing",
      defaultState: () => ({ version: null, updatedAt: null, trusted: [] }),
    });
    this.options = options;
    this.fetchGateway = gatewayFetch(options.fetch, options.gateway);
  }

  async init(): Promise<void> {
    await this.load();
    await this.sync();
    this.arm();
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.epoch += 1;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.abort?.abort();
    await Promise.resolve();
  }

  check(url: string): PhishingStatus {
    const candidates = phishingCandidates(url);
    if (candidates.length === 0) {
      return "clear";
    }
    const { deny, allow } = this;
    if (deny === undefined || allow === undefined) {
      return "unchecked";
    }
    for (const candidate of candidates) {
      const hash = phishingHash(candidate);
      if (contains(allow, hash)) {
        return "clear";
      }
      if (contains(deny, hash)) {
        return this.getState().trusted.includes(new URL(url).origin) ? "trusted" : "blocked";
      }
    }
    return "clear";
  }

  /** Fetches a snapshot or diff from the gateway; one request at a time, never throws. */
  async sync(): Promise<void> {
    const { gateway } = this.options;
    if (gateway === undefined) {
      return;
    }
    if (this.inflight !== undefined) {
      return this.inflight;
    }
    const run = async (): Promise<void> => {
      try {
        await this.fetchAndApply(gateway);
      } finally {
        this.inflight = undefined;
      }
    };
    this.inflight = run();
    return this.inflight;
  }

  async trust(origin: string): Promise<void> {
    this.assertOrigin(origin);
    const { trusted } = this.getState();
    if (!trusted.includes(origin)) {
      await this.saveTrusted([...trusted, origin]);
    }
  }

  async untrust(origin: string): Promise<void> {
    this.assertOrigin(origin);
    const { trusted } = this.getState();
    if (trusted.includes(origin)) {
      await this.saveTrusted(trusted.filter((entry) => entry !== origin));
    }
  }

  private assertOrigin(origin: string): void {
    if (!isOrigin(origin)) {
      throw new Error("a trusted origin must be http(s)://host[:port]");
    }
  }

  private async saveTrusted(trusted: ReadonlyArray<string>): Promise<void> {
    this.update((state) => ({ ...state, trusted }));
    await this.options.publicStore.put(TRUSTED_KEY, encoder.encode(JSON.stringify(trusted)));
  }

  private arm(): void {
    if (this.destroyed) {
      return;
    }
    this.cancelTimer = this.options.setTimer(PHISHING_REFRESH_MS, () => {
      void this.refresh();
    });
  }

  private async refresh(): Promise<void> {
    await this.sync();
    this.arm();
  }

  private async load(): Promise<void> {
    const { publicStore, logger } = this.options;
    try {
      const rawList = await publicStore.get(LIST_KEY);
      if (rawList !== undefined && !this.restoreList(rawList)) {
        logger.warn("ignoring a malformed stored phishing list");
      }
      const rawTrusted = await publicStore.get(TRUSTED_KEY);
      if (rawTrusted !== undefined) {
        const trusted = parseWith(storedTrusted, JSON.parse(decoder.decode(rawTrusted)));
        if (trusted === undefined || !trusted.every(isOrigin)) {
          logger.warn("ignoring a malformed stored trusted-origin list");
        } else {
          this.update((state) => ({ ...state, trusted }));
        }
      }
    } catch (error) {
      logger.warn("phishing list could not be loaded", error);
    }
  }

  private restoreList(raw: Uint8Array): boolean {
    let json: unknown;
    try {
      json = JSON.parse(decoder.decode(raw));
    } catch {
      return false;
    }
    const stored = parseWith(storedList, json);
    const deny = stored === undefined ? undefined : decodeHashList(stored.deny);
    const allow = stored === undefined ? undefined : decodeHashList(stored.allow);
    if (stored === undefined || deny === undefined || allow === undefined) {
      return false;
    }
    this.deny = deny;
    this.allow = allow;
    this.update((state) => ({ ...state, version: stored.version, updatedAt: stored.updatedAt }));
    return true;
  }

  private async fetchAndApply(gateway: GatewayConfig): Promise<void> {
    const { version } = this.getState();
    const base = gateway.url.replace(/\/+$/, "");
    const url = `${base}${phishingListPath}${version === null ? "" : `?since=${String(version)}`}`;
    const { epoch } = this;
    const bound = timeoutSignal(SYNC_TIMEOUT_MS, this.options.setTimer);
    const { cancel } = bound;
    this.abort = bound;
    try {
      const response = await this.fetchGateway(url, { signal: bound.signal });
      if (!response.ok) {
        throw new Error(`status ${String(response.status)}`);
      }
      const body: unknown = await response.json();
      if (epoch !== this.epoch) {
        return;
      }
      await this.apply(body);
    } catch (error) {
      this.options.logger.warn("phishing list sync failed", error);
    } finally {
      cancel();
      this.abort = undefined;
    }
  }

  private async apply(body: unknown): Promise<void> {
    const response = parseWith(phishingListResponse, body);
    if (response === undefined) {
      throw new Error("malformed phishing list response");
    }
    const { version } = this.getState();
    if (response.kind === "current") {
      if (this.deny === undefined || response.version !== version) {
        this.update((state) => ({ ...state, version: null }));
        return;
      }
      const updatedAt = this.options.now();
      this.update((state) => ({ ...state, updatedAt }));
      return;
    }
    if (response.kind === "diff") {
      if (response.from !== version || this.deny === undefined || this.allow === undefined) {
        this.update((state) => ({ ...state, version: null }));
        return;
      }
      const lists = [
        decodeHashList(response.deny.add),
        decodeHashList(response.deny.remove),
        decodeHashList(response.allow.add),
        decodeHashList(response.allow.remove),
      ];
      const [denyAdd, denyRemove, allowAdd, allowRemove] = lists;
      if (
        denyAdd === undefined ||
        denyRemove === undefined ||
        allowAdd === undefined ||
        allowRemove === undefined
      ) {
        throw new Error("malformed phishing list diff");
      }
      await this.persist(
        response.version,
        applyDiff(this.deny, denyAdd, denyRemove),
        applyDiff(this.allow, allowAdd, allowRemove),
      );
      return;
    }
    const deny = decodeHashList(response.deny);
    const allow = decodeHashList(response.allow);
    if (deny === undefined || allow === undefined) {
      throw new Error("malformed phishing list snapshot");
    }
    await this.persist(response.version, deny, allow);
  }

  private async persist(version: number, deny: HashList, allow: HashList): Promise<void> {
    const updatedAt = this.options.now();
    this.deny = deny;
    this.allow = allow;
    this.update((state) => ({ ...state, version, updatedAt }));
    await this.options.publicStore.put(
      LIST_KEY,
      encoder.encode(
        JSON.stringify({
          version,
          updatedAt,
          deny: encodeHashList(deny),
          allow: encodeHashList(allow),
        }),
      ),
    );
  }
}
