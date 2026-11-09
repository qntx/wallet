import type { ParsedSolanaMessage } from "./message.ts";
import { resolveAccountIndex } from "./message.ts";

/** Metaplex Core — recognised by program id; the transfer authority is verified on-chain. */
export const MPL_CORE_PROGRAM = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";

/**
 * `MplAssetInstruction::TransferV1` = 14; `TransferV1Args` is `{ compressionProof: Option }` — a
 * bare transfer carries `[14, 0]` (no compression proof). mpl-core IDL at c8732ac.
 */
const TRANSFER_V1 = Uint8Array.from([14, 0]);

export type CoreTransfer = {
  readonly authority: string;
  readonly asset: string;
  readonly newOwner: string;
};

/**
 * `TransferV1` with the accounts `[asset, collection, payer, authority, newOwner, systemProgram,
 * logWrapper]` — omitted optionals carry the program id itself (the Shank convention). The
 * authority slot resolves to the payer when it is the placeholder; it must be the signer for the
 * call to count as a transfer the wallet is doing.
 */
export const decodeCoreIx = (
  parsed: ParsedSolanaMessage,
  ix: { readonly accountIndices: ReadonlyArray<number>; readonly data: Uint8Array },
  lookups: ReadonlyArray<{ address: string; addresses: ReadonlyArray<string> }> | undefined,
): CoreTransfer | undefined => {
  const { data } = ix;
  const account = (i: number): string | undefined => {
    const index = ix.accountIndices[i];
    return index === undefined ? undefined : resolveAccountIndex(parsed, index, lookups);
  };
  /* Data must be exactly [14, 0] — a compression-proof transfer carries a proof blob. */
  if (data.length !== 2 || data[0] !== TRANSFER_V1[0] || data[1] !== TRANSFER_V1[1]) {
    return undefined;
  }
  const asset = account(0);
  const payer = account(2);
  const authoritySlot = account(3);
  const newOwner = account(4);
  if (
    asset === undefined ||
    payer === undefined ||
    authoritySlot === undefined ||
    newOwner === undefined
  ) {
    return undefined;
  }
  const authority = authoritySlot === MPL_CORE_PROGRAM ? payer : authoritySlot;
  return { authority, asset, newOwner };
};
