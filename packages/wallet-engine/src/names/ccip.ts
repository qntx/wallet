import type { CcipRequestParameters, Hex } from "viem";

import { timeoutSignal } from "../timer.ts";
import type { SetTimer } from "../timer.ts";

export const CCIP_MAX_FETCHES = 8;
export const CCIP_TIMEOUT_MS = 10_000;
export const CCIP_MAX_BYTES = 256 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const isHexResponse = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const readLimitedBody = async (res: Response): Promise<string> => {
  const contentLength = res.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > CCIP_MAX_BYTES) {
    throw new Error("ccip gateway response exceeds the size limit");
  }
  if (res.body !== null && typeof res.body.getReader === "function") {
    const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- stream chunks are inherently sequential
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.length;
      if (length > CCIP_MAX_BYTES) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- cancel before refusing the oversized body
        await reader.cancel().catch(() => undefined);
        throw new Error("ccip gateway response exceeds the size limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  }
  const text = await res.text();
  if (byteLength(text) > CCIP_MAX_BYTES) {
    throw new Error("ccip gateway response exceeds the size limit");
  }
  return text;
};

const incomingAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted ?? false;

const combinedSignal = (
  timeout: ReturnType<typeof timeoutSignal>,
  incoming: AbortSignal | undefined,
): { readonly signal: AbortSignal; readonly cancel: () => void } => {
  if (incoming === undefined) {
    return { signal: timeout.signal, cancel: timeout.cancel };
  }
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  if (incoming.aborted) {
    abort();
  } else {
    incoming.addEventListener("abort", abort, { once: true });
  }
  timeout.signal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cancel: () => {
      incoming.removeEventListener("abort", abort);
      timeout.signal.removeEventListener("abort", abort);
      timeout.cancel();
    },
  };
};

/**
 * EIP-3668 gateway lookup over the injected plain fetch. Gateway answers remain untrusted input for
 * the on-chain callback; this transport only bounds where it may go (https), how long it may take,
 * how much it may return, and how many fetches one resolution may cause.
 */
export const ccipRequest = ({
  fetch: fetchFn,
  setTimer,
}: {
  readonly fetch: typeof globalThis.fetch;
  readonly setTimer: SetTimer;
}): ((parameters: CcipRequestParameters) => Promise<Hex>) => {
  let fetches = 0;
  return async ({ data, sender, urls, requestOptions }: CcipRequestParameters): Promise<Hex> => {
    const incoming = requestOptions?.signal;
    const attempt = async (template: string, url: URL): Promise<Hex> => {
      if (fetches >= CCIP_MAX_FETCHES) {
        throw new Error("ccip gateway fetch budget exceeded");
      }
      fetches += 1;
      const isGet = template.includes("{data}");
      const timeout = timeoutSignal(CCIP_TIMEOUT_MS, setTimer);
      const bound = combinedSignal(timeout, incoming);
      try {
        const res = await fetchFn(url.href, {
          method: isGet ? "GET" : "POST",
          ...(isGet ? {} : { headers: { "content-type": "application/json" } }),
          ...(isGet ? {} : { body: JSON.stringify({ data, sender }) }),
          signal: bound.signal,
        });
        if (!res.ok) {
          throw new Error(`ccip gateway ${url.href} answered ${res.status}`);
        }
        const text = await readLimitedBody(res);
        const body: unknown =
          res.headers.get("content-type")?.startsWith("application/json") === true
            ? JSON.parse(text)
            : text;
        const result = isObject(body) ? body["data"] : body;
        if (!isHexResponse(result)) {
          throw new Error(`ccip gateway ${url.href} answered a malformed response`);
        }
        return result;
      } finally {
        bound.cancel();
      }
    };
    let error: unknown = new Error("ccip request failed");
    for (const template of urls) {
      if (incomingAborted(incoming)) {
        throw new Error("ccip request aborted");
      }
      const substituted = template
        .replace("{sender}", sender.toLowerCase())
        .replace("{data}", data);
      let url: URL;
      try {
        url = new URL(substituted);
      } catch (error_) {
        error = error_;
        continue;
      }
      if (url.protocol !== "https:") {
        error = new Error(`ccip gateway url is not https: ${url.protocol}`);
        continue;
      }
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- gateways are tried in order
        return await attempt(template, url);
      } catch (error_) {
        error = error_;
        if (incomingAborted(incoming)) {
          throw error;
        }
      }
    }
    throw error;
  };
};
