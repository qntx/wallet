/**
 * The v0 Solana lookup-table fixture every blind-rule test shares: a compiled 1-SOL transfer whose
 * recipient is table-resolved — unverifiable, so the signature binds bytes any caller's table can
 * describe — plus the `normalizeSolana` call that wraps it for one account.
 */
import { base58 } from "@scure/base";

import type { SignRequest } from "@qntx/wallet-chains";
import { normalizeSolana } from "@qntx/wallet-chains/solana";
import type { ChainTemplate } from "@qntx/wallet/protocol";

export const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

export const LOOKUP_TABLE: string = base58.encode(new Uint8Array(32).fill(0x07));
export const LOOKUP_RECIPIENT: string = base58.encode(new Uint8Array(32).fill(0xa1));
export const LOOKUP_OTHER: string = base58.encode(new Uint8Array(32).fill(0xb2));

/** A v0 transfer of 1 SOL: fee payer index 0 → `to` = lookup table 0, writable index 0. */
export const altTransferMessage = (feePayer: Uint8Array): Uint8Array => {
  const system = new Uint8Array(32); // system program = the zero address
  const blockhash = new Uint8Array(32).fill(0x33);
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true); // system transfer
  dv.setBigUint64(4, 1_000_000_000n, true);
  return new Uint8Array([
    0x80, // version 0
    1,
    0,
    1, // 1 signer, 0 readonly signers, 1 readonly unsigned (system)
    2,
    ...feePayer,
    ...system,
    ...blockhash,
    1, // 1 instruction
    1, // programAddressIndex = system (static index 1)
    2,
    0,
    2, // accountIndices [0 (from), 2 (to = loaded writable #0)]
    12,
    ...data,
    1, // 1 addressTableLookup
    ...base58.decode(LOOKUP_TABLE),
    1,
    0, // 1 writable index: table[0]
    0, // 0 readonly indexes
  ]);
};

/** The lookup-table transfer request for one account — `own` is the signer's address. */
export const lookupTransferRequest = (
  account: { kind: "hd"; walletId: string; groupIndex: number; template: ChainTemplate },
  own: string,
  recipient: string,
): SignRequest =>
  normalizeSolana(
    {
      kind: "solana.transaction",
      network: SOLANA_NETWORK,
      account,
      message: altTransferMessage(base58.decode(own)),
      lookupTables: [{ address: LOOKUP_TABLE, addresses: [recipient] }],
    },
    own,
  );
