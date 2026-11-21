/**
 * Per-session gateway client ids — a fresh unlinkable id per scope. Lives apart from client.ts so
 * entries that need only session ids (the apps eligibility fetch) don't bundle the contract table
 * that `gatewayScope` requires.
 */
/** A gateway traffic class with its own client id: one per chain family plus the service routes. */
export type GatewayScope = "evm" | "solana" | "bitcoin" | "service";

export type GatewayConfig = {
  readonly url: string;
  readonly clientIds: Readonly<Record<GatewayScope, string>>;
};

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A fresh client id per scope for one engine session — unlinkable across scopes and sessions. */
export function gatewaySession(url: string, random: (length: number) => Uint8Array): GatewayConfig {
  return {
    url,
    clientIds: {
      evm: hex(random(16)),
      solana: hex(random(16)),
      bitcoin: hex(random(16)),
      service: hex(random(16)),
    },
  };
}
