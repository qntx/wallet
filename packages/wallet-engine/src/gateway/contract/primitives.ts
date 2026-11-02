import * as z from "zod/mini";

export const INSTALL_ID_HEADER = "x-install-id";
export const PROVIDERS_HEADER = "x-gateway-providers";

/** 128 random bits as lowercase hex — generated once per install, unrelated to wallet secrets. */
export const installId = z.string().check(z.regex(/^[0-9a-f]{32}$/));

/** CAIP-2 chain id: `namespace:reference`. */
export const caip2 = z.string().check(z.regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/));

export type Caip2 = z.infer<typeof caip2>;
export type InstallId = z.infer<typeof installId>;

export const GATEWAY_ERRORS = [
  "invalid-request",
  "unknown-network",
  "not-found",
  "rate-limited",
  "unavailable",
  "internal",
] as const;

export const gatewayError = z.object({ error: z.enum(GATEWAY_ERRORS) });

export type GatewayErrorCode = (typeof GATEWAY_ERRORS)[number];
