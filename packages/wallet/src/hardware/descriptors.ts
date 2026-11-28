/**
 * Ledger clear-signing descriptor sources. A source is host code: it may fetch Ledger's CAL or read
 * an offline bundle, but it only supplies public vendor-signed payloads — the kernel decides
 * whether one binds to the request, and the device verifies its signature. The query helper is the
 * seam additional descriptor kinds extend.
 */
import type { ChainSignRequest } from "../protocol/chains.ts";
import type { LedgerDescriptors } from "../protocol/hardware.ts";

export const LEDGER_CAL_URL = "https://global.api.prd.ledger.com/cal/v1";

export type LedgerDescriptorSource = (
  request: ChainSignRequest,
) => Promise<LedgerDescriptors | undefined>;

export type LedgerDescriptorBundle = {
  readonly tokens?: ReadonlyArray<{
    readonly chainId: number;
    readonly address: string;
    /** Hex of the legacy `E0 0A 00 00` payload, without a `0x` prefix. */
    readonly descriptor: string;
  }>;
};

type TokenNeed = { readonly chainId: number; readonly address: string };

const TRANSFER_OR_APPROVE = /^0x(?:a9059cbb|095ea7b3)/i;

const unhex = (value: string): Uint8Array | undefined => {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(value)) {
    return undefined;
  }
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
};

/** The one token descriptor an EVM transfer/approve can use, when the request names one. */
const tokenNeed = (request: ChainSignRequest): TokenNeed | undefined => {
  if (request.kind !== "evm.transaction" || request.tx.to === undefined) {
    return undefined;
  }
  if (!TRANSFER_OR_APPROVE.test(request.tx.data)) {
    return undefined;
  }
  const [family, reference] = request.network.split(":", 2);
  if (family !== "eip155" || reference === undefined || !/^[0-9]+$/.test(reference)) {
    return undefined;
  }
  const chainId = Number(reference);
  if (!Number.isSafeInteger(chainId) || chainId < 0 || chainId > 0xffffffff) {
    return undefined;
  }
  return { chainId, address: request.tx.to };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array);

type CalToken = { readonly data: string; readonly prod: string };

/** Strict shape admission of CAL's token answer; malformed metadata is a source failure. */
const calTokens = (body: unknown): ReadonlyArray<CalToken> => {
  if (!Array.isArray(body) || body.length > 16) {
    throw new Error("CAL token answer is not a bounded array");
  }
  return body.map((entry): CalToken => {
    if (!isRecord(entry) || !isRecord(entry["descriptor"])) {
      throw new Error("CAL token entry has an unexpected shape");
    }
    const { data, descriptorType, signatures } = entry["descriptor"];
    if (
      typeof data !== "string" ||
      !/^(?:[0-9a-fA-F]{2})*$/.test(data) ||
      (descriptorType !== undefined && descriptorType !== "token") ||
      !isRecord(signatures) ||
      typeof signatures["prod"] !== "string" ||
      !/^(?:[0-9a-fA-F]{2})*$/.test(signatures["prod"])
    ) {
      throw new Error("CAL token descriptor fields are malformed");
    }
    return { data, prod: signatures["prod"] };
  });
};

/** Builds the legacy payload exactly as DMK's HttpTokenDataSource does. */
const tokenPayload = ({ data, prod }: CalToken): Uint8Array | undefined => {
  const descriptor = unhex(data);
  const signature = unhex(prod);
  if (descriptor === undefined || signature === undefined || descriptor.length < 29) {
    return undefined;
  }
  const tickerLength = descriptor.length - 28;
  if (tickerLength < 1 || tickerLength > 50) {
    return undefined;
  }
  const payload = new Uint8Array(1 + descriptor.length + signature.length);
  payload[0] = tickerLength;
  payload.set(descriptor, 1);
  payload.set(signature, 1 + descriptor.length);
  return payload;
};

type StreamChunk = { readonly done: boolean; readonly value?: Uint8Array };

const isStreamChunk = (value: unknown): value is StreamChunk =>
  typeof value === "object" &&
  value !== null &&
  "done" in value &&
  typeof value.done === "boolean" &&
  (!("value" in value) || value.value === undefined || value.value instanceof Uint8Array);

const readBounded = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new Error("CAL response exceeds the byte bound");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error("CAL response exceeds the byte bound");
    }
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a response stream is sequential
    const chunk: unknown = await reader.read();
    if (!isStreamChunk(chunk)) {
      throw new Error("CAL response stream is malformed");
    }
    if (chunk.done) {
      break;
    }
    if (chunk.value === undefined) {
      throw new Error("CAL response stream chunk carries no bytes");
    }
    total += chunk.value.length;
    if (total > maxBytes) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- cancellation is part of the sequential read
      await reader.cancel();
      throw new Error("CAL response exceeds the byte bound");
    }
    chunks.push(chunk.value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

/**
 * Ledger's public CAL token source. One request needs at most one token lookup; the timeout covers
 * the whole source call, and every response body is bounded while it is read.
 */
export function calDescriptorSource(options: {
  readonly fetch: typeof globalThis.fetch;
  readonly url?: string;
  /** Sent as X-Ledger-Client-Origin; CAL `/dapps` requires one. */
  readonly originToken?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}): LedgerDescriptorSource {
  const base = options.url ?? LEDGER_CAL_URL;
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBytes = options.maxBytes ?? 65_536;
  return async (request) => {
    const need = tokenNeed(request);
    if (need === undefined) {
      return undefined;
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const url = new URL(`${base}/tokens`);
      url.searchParams.set("contract_address", need.address.toLowerCase());
      url.searchParams.set("chain_id", String(need.chainId));
      url.searchParams.set("output", "descriptor");
      url.searchParams.set("ref", "branch:main");
      const headers: Record<string, string> = {};
      if (options.originToken !== undefined) {
        headers["X-Ledger-Client-Origin"] = options.originToken;
      }
      const response = await options.fetch(url, { headers, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`CAL answered HTTP ${String(response.status)}`);
      }
      const bytes = await readBounded(response, maxBytes);
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
      const first = calTokens(body)
        .map(tokenPayload)
        .find((payload) => payload !== undefined);
      return first === undefined ? undefined : { tokens: [first] };
    } catch (error) {
      if (timedOut) {
        throw new Error("CAL descriptor fetch timed out", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Offline source for host-shipped or test-signed descriptors. Bundle entries are hex payloads. */
export function bundleDescriptorSource(bundle: LedgerDescriptorBundle): LedgerDescriptorSource {
  const tokens = (bundle.tokens ?? []).map((entry) => {
    const payload = unhex(entry.descriptor);
    if (payload === undefined) {
      throw new Error("bundle token descriptor is not hex");
    }
    return {
      chainId: entry.chainId,
      address: entry.address.toLowerCase(),
      descriptor: entry.descriptor,
      payload,
    };
  });
  // oxlint-disable-next-line typescript/require-await -- the source contract is async even for local bytes
  return async (request) => {
    const need = tokenNeed(request);
    if (need === undefined) {
      return undefined;
    }
    const matches = tokens.filter(
      (entry) => entry.chainId === need.chainId && entry.address === need.address.toLowerCase(),
    );
    if (matches.length === 0) {
      return undefined;
    }
    return { tokens: matches.map((entry) => entry.payload) };
  };
}
