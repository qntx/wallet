import { resolveLnurl } from "@qntx/spark/lnurl";

import { PaymentError } from "./errors.ts";
import { parsePayment } from "./parse.ts";
import type { PaymentParse, ParseOptions } from "./parse.ts";

export type ResolveOptions = ParseOptions & {
  readonly fetch: typeof globalThis.fetch;
};

/**
 * `parsePayment` plus LNURL dereferencing: an `lnurl` result is fetched and turned into a concrete
 * `lnurl-pay` / `lnurl-withdraw` request (`tag=login` endpoints report as unsupported). Network
 * failures throw `PaymentError("network")` — remote error bodies never enter the message.
 */
export async function resolvePayment(
  input: string,
  options: ResolveOptions,
): Promise<PaymentParse> {
  const parsed = parsePayment(input, options);
  if (parsed.kind !== "lnurl") {
    return parsed;
  }
  let resolved;
  try {
    resolved = await resolveLnurl(parsed.url, { fetch: options.fetch });
  } catch {
    throw new PaymentError("network", "lnurl: resolution failed");
  }
  if (resolved.tag === "payRequest") {
    return {
      kind: "request",
      request: {
        options: [
          {
            kind: "lnurl-pay",
            request: resolved,
            ...(parsed.address === undefined ? {} : { address: parsed.address }),
          },
        ],
      },
    };
  }
  if (resolved.tag === "withdrawRequest") {
    return {
      kind: "request",
      request: { options: [{ kind: "lnurl-withdraw", request: resolved }] },
    };
  }
  return { kind: "unsupported", format: "lnurl-auth" };
}
