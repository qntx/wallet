import * as z from "zod/mini";

import { parseWith } from "@qntx/wallet-engine/gateway/contract";
import type { SwapQuoteSolanaResponse } from "@qntx/wallet-engine/gateway/contract";

import type { ResolvedProvider } from "../types.ts";
import type { Forwarder } from "./forward.ts";

/** An optional Jupiter API key — absent, the `/build` API serves keyless at its public rate. */
export type JupiterConfig = { readonly apiKey?: string };

const JUP_API_BASE = "https://api.jup.ag";

const PROVIDER: ResolvedProvider = { id: "jupiter", url: JUP_API_BASE };

const base58 = z.string().check(z.regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/));
const decimal = z.string().check(z.regex(/^[0-9]+$/));

const upstreamInstruction = z.object({
  programId: base58,
  accounts: z.array(
    z.object({
      pubkey: base58,
      isSigner: z.boolean(),
      isWritable: z.boolean(),
    }),
  ),
  data: z.string(),
});

/**
 * The fields of Jupiter's swap v2 `/build` response the relay needs — `routePlan`, `priceImpactPct`
 * and friends are left on the wire on purpose.
 */
const jupiterUpstreamResponse = z.object({
  inputMint: base58,
  outputMint: base58,
  inAmount: decimal,
  outAmount: decimal,
  otherAmountThreshold: decimal,
  slippageBps: z.number().check(z.int()),
  setupInstructions: z.optional(z.array(upstreamInstruction)),
  swapInstruction: z.optional(upstreamInstruction),
  cleanupInstruction: z.optional(z.union([upstreamInstruction, z.null()])),
  computeBudgetInstructions: z.optional(z.array(upstreamInstruction)),
  otherInstructions: z.optional(z.array(upstreamInstruction)),
  tipInstruction: z.optional(z.union([upstreamInstruction, z.null()])),
  addressesByLookupTableAddress: z.optional(z.record(z.string(), z.array(base58))),
  transactionVersion: z.optional(z.union([z.number(), z.literal("legacy")])),
});

const wireIx = (ix: z.output<typeof upstreamInstruction>) => ({
  programId: ix.programId,
  accounts: ix.accounts.map((a) => ({
    address: a.pubkey,
    signer: a.isSigner,
    writable: a.isWritable,
  })),
  data: ix.data,
});

export type JupiterQuote = { readonly badRequest: true } | SwapQuoteSolanaResponse;

const CLIENT_ERROR: ReadonlySet<number> = new Set([400, 422]);

/**
 * Calls Jupiter's `/build` and relays the instruction set. The upstream error body is never
 * forwarded: `"No routes found"` reports `{ liquidity: false }`, other 4xx are a bare
 * `invalid-request`, and anything else — auth, rate limit, 5xx, transport, malformed body — is a 503.
 * Shapes the engine does not sign (extra or tip instructions, non-v0 transactions) are also 503 —
 * the relay drops compute-budget instructions only, since the engine sets its own.
 */
export async function jupiterQuote(
  forwarder: Forwarder,
  fetch: typeof globalThis.fetch,
  config: JupiterConfig | undefined,
  query: {
    readonly inputMint: string;
    readonly outputMint: string;
    readonly amount: string;
    readonly taker: string;
    readonly slippageBps: number;
  },
): Promise<JupiterQuote> {
  const url = new URL(`${JUP_API_BASE}/swap/v2/build`);
  url.searchParams.set("inputMint", query.inputMint);
  url.searchParams.set("outputMint", query.outputMint);
  url.searchParams.set("amount", query.amount);
  url.searchParams.set("taker", query.taker);
  url.searchParams.set("slippageBps", String(query.slippageBps));
  const { value } = await forwarder.run([PROVIDER], async (_provider, signal) => {
    const http = await fetch(url, {
      ...(config?.apiKey === undefined ? {} : { headers: { "x-api-key": config.apiKey } }),
      signal,
    });
    const text = await http.text();
    if (!http.ok) {
      if (CLIENT_ERROR.has(http.status) && text.includes("No routes found")) {
        return { liquidity: false } satisfies SwapQuoteSolanaResponse;
      }
      if (CLIENT_ERROR.has(http.status)) {
        return { badRequest: true } as const;
      }
      throw new Error(`jupiter returned ${http.status}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("jupiter returned a non-JSON body");
    }
    const res = parseWith(jupiterUpstreamResponse, body);
    if (res === undefined) {
      throw new Error("jupiter returned an unexpected body");
    }
    if (
      res.swapInstruction === undefined ||
      res.transactionVersion !== 0 ||
      (res.otherInstructions !== undefined && res.otherInstructions.length > 0) ||
      (res.tipInstruction !== undefined && res.tipInstruction !== null)
    ) {
      throw new Error("jupiter returned a build the engine cannot verify");
    }
    return {
      liquidity: true,
      provider: "jupiter",
      inputMint: res.inputMint,
      outputMint: res.outputMint,
      inAmount: res.inAmount,
      outAmount: res.outAmount,
      otherAmountThreshold: res.otherAmountThreshold,
      slippageBps: res.slippageBps,
      setup: (res.setupInstructions ?? []).map(wireIx),
      swap: wireIx(res.swapInstruction),
      cleanup:
        res.cleanupInstruction === undefined || res.cleanupInstruction === null
          ? null
          : wireIx(res.cleanupInstruction),
      lookupTables: Object.keys(res.addressesByLookupTableAddress ?? {}),
    } satisfies SwapQuoteSolanaResponse;
  });
  return value;
}
