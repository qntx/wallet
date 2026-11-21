/**
 * The verified Permit2 deployments on TRON networks, keyed by CAIP-2 network id. SUN.io's Permit2
 * on mainnet — https://sunio.zendesk.com/hc/en-us/articles/54899665032601 — was confirmed on-chain:
 * its DOMAIN_SEPARATOR() equals the TIP-712 hash of `{name: "Permit2", chainId: 728126428,
 * verifyingContract}` under TronWeb 6.5.2. The Nile deployment is unverified, so the map has no
 * Nile entry and Nile documents stay unclaimed.
 */
export const TRON_PERMIT2: Readonly<Record<string, string>> = {
  "tron:728126428": "TTJxU3P8rHycAyFY4kVtGNfmnMH4ezcuM9",
};
