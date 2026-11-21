import * as z from "zod/mini";

export const CLIENT_ID_HEADER = "x-client-id";
export const PROVIDERS_HEADER = "x-gateway-providers";

/**
 * 128 random bits as lowercase hex — drawn per engine session for each gateway scope, never derived
 * from or linked to anything else.
 */
export const clientId = z.string().check(z.regex(/^[0-9a-f]{32}$/));

/** CAIP-2 chain id: `namespace:reference`. */
export const caip2 = z.string().check(z.regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/));

export type Caip2 = z.infer<typeof caip2>;
export type ClientId = z.infer<typeof clientId>;

export const GATEWAY_ERRORS = [
  "invalid-request",
  "unknown-network",
  "not-found",
  "rate-limited",
  "unavailable",
  "outcome-unknown",
  "internal",
  "too-costly",
] as const;

export const gatewayError = z.object({ error: z.enum(GATEWAY_ERRORS) });

export type GatewayErrorCode = (typeof GATEWAY_ERRORS)[number];
