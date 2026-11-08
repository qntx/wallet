import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { address, getAddressDecoder, getAddressEncoder } from "@solana/addresses";

import { ChainError } from "../index.ts";
import { PROGRAM_IDS } from "./ids.ts";

const PDA_SEED = new TextEncoder().encode("ProgramDerivedAddress");
const encoder = getAddressEncoder();
const decoder = getAddressDecoder();

const onCurve = (candidate: Uint8Array): boolean => {
  try {
    ed25519.Point.fromBytes(candidate);
    return true;
  } catch {
    return false;
  }
};

/**
 * Sync Associated Token Account derivation for the kernel: `findAssociatedTokenPda` is async, so
 * the decoder derives `sha256(owner ‖ tokenProgram ‖ mint ‖ bump ‖ ata ‖ "ProgramDerivedAddress")`
 * over bump 255→0 and takes the first hash off the ed25519 curve — matching the on-chain rule.
 */
export const associatedTokenAddress = (
  owner: string,
  mint: string,
  tokenProgram: string,
): string => {
  const ownerBytes = encoder.encode(address(owner));
  const programBytes = encoder.encode(address(tokenProgram));
  const mintBytes = encoder.encode(address(mint));
  const ataBytes = encoder.encode(address(PROGRAM_IDS.associatedToken));
  const input = new Uint8Array(
    ownerBytes.length +
      programBytes.length +
      mintBytes.length +
      1 +
      ataBytes.length +
      PDA_SEED.length,
  );
  let o = 0;
  const put = (bytes: ArrayLike<number>) => {
    input.set(bytes, o);
    o += bytes.length;
  };
  put(ownerBytes);
  put(programBytes);
  put(mintBytes);
  const bumpAt = o;
  o += 1;
  put(ataBytes);
  put(PDA_SEED);
  for (let bump = 255; bump >= 0; bump -= 1) {
    input[bumpAt] = bump;
    const candidate = sha256(input);
    if (!onCurve(candidate)) {
      return decoder.decode(candidate);
    }
  }
  throw new ChainError("invalid-request", "no PDA bump for the associated token account");
};
