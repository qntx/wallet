import { parseCompiledMessage } from "@qntx/wallet-chains/solana";
import type { ParsedSolanaMessage } from "@qntx/wallet-chains/solana";

/** 0.13.0 typed the version as legacy or v0; a v1 message threw `ChainError("unsupported")`. */
export function versionBefore(message: Uint8Array): "legacy" | 0 {
  // @ts-expect-error -- the version union now includes 1
  return parseCompiledMessage(message).version;
}

/** A v1 message parses; its resource requests and priority fee live in `config`, not in
    ComputeBudget instructions (which a v1 transaction ignores). */
export function priorityFeeLamports(message: Uint8Array): bigint | undefined {
  const parsed: ParsedSolanaMessage = parseCompiledMessage(message);
  return parsed.version === 1 ? (parsed.config.priorityFeeLamports ?? 0n) : undefined;
}
