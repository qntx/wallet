import * as z from "zod/mini";

import { parseWith } from "@qntx/wallet-engine/gateway/contract";
import type { BridgeQuoteResponse } from "@qntx/wallet-engine/gateway/contract";

import type { ResolvedProvider } from "../types.ts";
import type { Forwarder } from "./forward.ts";

const ACROSS_API = "https://app.across.to";

const PROVIDER: ResolvedProvider = { id: "across", url: ACROSS_API };

const evmAddress = z.string().check(z.regex(/^0x[0-9a-fA-F]{40}$/));
const decimal = z.string().check(z.regex(/^[0-9]+$/));

/** The `/suggested-fees` fields the relay passes through verbatim per the Across docs. */
const acrossUpstreamResponse = z.looseObject({
  inputToken: z.looseObject({ address: evmAddress }),
  outputToken: z.looseObject({ address: evmAddress }),
  timestamp: z.number().check(z.int()),
  isAmountTooLow: z.boolean(),
  exclusiveRelayer: evmAddress,
  exclusivityDeadline: z.number().check(z.int()),
  fillDeadline: z.number().check(z.int()),
  outputAmount: decimal,
  spokePoolAddress: evmAddress,
  limits: z.looseObject({ minDeposit: decimal, maxDeposit: decimal }),
});

export type AcrossQuote = { readonly badRequest: true } | BridgeQuoteResponse;

const CLIENT_ERROR: ReadonlySet<number> = new Set([400, 422]);

const tokenOf = (t: string | { readonly address: string }): string =>
  typeof t === "string" ? t : t.address;

/**
 * Calls Across's `/suggested-fees` and relays the deposit terms. `isAmountTooLow` or an amount
 * outside the returned limits means no route — `{ liquidity: false }`; client errors map to
 * `invalid-request`; transport, rate limit, 5xx and malformed bodies are a 503 like the other
 * providers. Keyless — the public endpoint serves integrator-free traffic.
 */
export async function acrossQuote(
  forwarder: Forwarder,
  fetch: typeof globalThis.fetch,
  query: {
    readonly inputToken: string;
    readonly outputToken: string;
    readonly originChainId: string;
    readonly destinationChainId: string;
    readonly amount: string;
  },
): Promise<AcrossQuote> {
  const url = new URL(`${ACROSS_API}/api/suggested-fees`);
  url.searchParams.set("inputToken", query.inputToken);
  url.searchParams.set("outputToken", query.outputToken);
  url.searchParams.set("originChainId", query.originChainId);
  url.searchParams.set("destinationChainId", query.destinationChainId);
  url.searchParams.set("amount", query.amount);
  const { value } = await forwarder.run([PROVIDER], async (_provider, signal) => {
    const http = await fetch(url, { signal });
    const text = await http.text();
    if (!http.ok) {
      if (CLIENT_ERROR.has(http.status)) {
        return { badRequest: true } as const;
      }
      throw new Error(`across returned ${http.status}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("across returned a non-JSON body");
    }
    const res = parseWith(acrossUpstreamResponse, body);
    if (res === undefined) {
      throw new Error("across returned an unexpected body");
    }
    const amount = BigInt(query.amount);
    if (
      res.isAmountTooLow ||
      amount < BigInt(res.limits.minDeposit) ||
      amount > BigInt(res.limits.maxDeposit)
    ) {
      return { liquidity: false } satisfies BridgeQuoteResponse;
    }
    return {
      liquidity: true,
      provider: "across",
      inputToken: tokenOf(res.inputToken),
      outputToken: tokenOf(res.outputToken),
      inputAmount: query.amount,
      outputAmount: res.outputAmount,
      destinationNetwork: `eip155:${query.destinationChainId}`,
      quoteTimestamp: res.timestamp,
      fillDeadline: res.fillDeadline,
      exclusiveRelayer: res.exclusiveRelayer,
      exclusivityParameter: res.exclusivityDeadline,
      spokePool: res.spokePoolAddress,
      limits: { minDeposit: res.limits.minDeposit, maxDeposit: res.limits.maxDeposit },
    } satisfies BridgeQuoteResponse;
  });
  return value;
}
