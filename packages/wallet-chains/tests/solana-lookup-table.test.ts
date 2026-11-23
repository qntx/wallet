/**
 * The accounts a decoded intent names to the user must be static keys — the signature binds the
 * compiled message bytes, never the caller-declared lookup-table contents an index resolves
 * through. A named account loaded from a table makes the intent `opaque` with
 * `lookup-table-account`; loaded accounts the intent does not name (pools, vaults, program state)
 * keep `partial`.
 */
import { address } from "@solana/addresses";
import { AccountRole, createNoopSigner } from "@solana/kit";
import {
  getDelegateStakeInstruction,
} from "@solana-program/stake";
import { getTransferSolInstruction } from "@solana-program/system";
import { getApproveInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import {
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/transaction-messages";
import { describe, expect, it } from "vite-plus/test";

import { JUPITER_PROGRAM } from "../src/solana/jupiter.ts";
import {
  decodeSolana,
  namedTableAccounts,
  verifiabilitySolana,
} from "../src/solana/decode.ts";
import { parseCompiledMessage } from "../src/solana/message.ts";
import { PROGRAM_IDS } from "../src/solana/ids.ts";

const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "solana" } as const;
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const FEE_PAYER = address("11111111111111111111111111111112");
const DEST = address("8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR");
const MINT = address("GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq");
const SRC_TOKEN = address("LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY");
const DST_TOKEN = address("QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF");
const DELEGATE = address("US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx");
const STAKE_ACCT = address("YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf");
const VOTE_ACCT = address("cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN");
const POOL = address("6wWVbLeHDVHvCCsLprB85jkbU1JhS9VezABT2ZZFJ5BB");
const BLOCKHASH = address("11111111111111111111111111111111");
const LOOKUP_TABLE = address("AddressLookupTab1e1111111111111111111111111");

const compile = (
  instructions: ReadonlyArray<unknown>,
  lookupAddresses: Record<string, ReadonlyArray<string>>,
): Uint8Array => {
  let message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n } as never,
    setTransactionMessageFeePayer(address(FEE_PAYER), createTransactionMessage({ version: 0 })),
  );
  for (const ix of instructions) {
    message = appendTransactionMessageInstruction(ix as never, message as never);
  }
  const compressed = compressTransactionMessageUsingAddressLookupTables(
    message as never,
    lookupAddresses as never,
  );
  return new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(compressed)),
  );
};

const table = (addresses: ReadonlyArray<string>) => ({
  lookupTables: [{ address: LOOKUP_TABLE, addresses }],
});

const intent = (
  ixs: ReadonlyArray<unknown>,
  addresses: ReadonlyArray<string>,
): ReturnType<typeof decodeSolana> =>
  decodeSolana(
    {
      kind: "solana.transaction",
      network: MAINNET,
      account: ACCOUNT,
      message: compile(ixs, { [LOOKUP_TABLE]: addresses }),
      ...table(addresses),
    } as never,
    FEE_PAYER,
  );

const feePayerSigner = createNoopSigner(FEE_PAYER);

/** route_v2: discriminator + inAmount + quotedOut + slippageBps + platformFeeBps + empty plan. */
const ROUTE_V2 = Uint8Array.from([0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14]);
const routeData = (): Uint8Array => {
  const data = new Uint8Array(34);
  data.set(ROUTE_V2);
  const dv = new DataView(data.buffer);
  dv.setBigUint64(8, 1_000_000n, true);
  dv.setBigUint64(16, 900_000n, true);
  dv.setUint16(24, 50, true);
  dv.setUint16(26, 0, true);
  dv.setUint32(28, 0, true);
  return data;
};

/** route_v2 accounts: authority, pool, destATA, sourceMint, destinationMint, pool,
   destinationTokenProgram, optionalDest, pool, pool. */
const jupiterIx = (loaded: {
  dest?: boolean;
  mints?: boolean;
  pool?: boolean;
}): { ixs: ReadonlyArray<unknown>; tableAddresses: string[] } => {
  const meta = (a: string, role: AccountRole) => ({ address: address(a), role });
  const ixs = [
    {
      programAddress: address(JUPITER_PROGRAM),
      accounts: [
        { address: FEE_PAYER, role: AccountRole.WRITABLE_SIGNER },
        meta(POOL, AccountRole.READONLY),
        meta(DST_TOKEN, AccountRole.WRITABLE),
        meta(MINT, AccountRole.READONLY),
        meta(DEST, AccountRole.READONLY),
        meta(POOL, AccountRole.READONLY),
        meta(PROGRAM_IDS.token, AccountRole.READONLY),
        meta(JUPITER_PROGRAM, AccountRole.READONLY),
        meta(POOL, AccountRole.READONLY),
        meta(POOL, AccountRole.READONLY),
      ],
      data: routeData(),
    },
  ];
  const tableAddresses: string[] = [];
  if (loaded.pool === true) {
    tableAddresses.push(POOL);
  }
  if (loaded.dest === true) {
    tableAddresses.push(DST_TOKEN);
  }
  if (loaded.mints === true) {
    tableAddresses.push(MINT, DEST);
  }
  return { ixs, tableAddresses };
};

describe("Solana named accounts loaded from lookup tables", () => {
  it("a system transfer recipient loaded from a table is opaque and blind", () => {
    const ix = getTransferSolInstruction({
      source: feePayerSigner,
      destination: DEST,
      amount: 1000n,
    });
    const i = intent([ix], [DEST]);
    expect(i.verifiability).toBe("opaque");
    expect(i.blind).toBe("lookup-table-account");
    /* The table-resolved address is never shown as the recipient. */
    expect(i.outflows.some((o) => o.to === DEST)).toBe(false);
  });

  it("a token destination account and mint loaded from a table are opaque", () => {
    const ix = getTransferCheckedInstruction({
      source: SRC_TOKEN,
      mint: MINT,
      destination: DST_TOKEN,
      authority: feePayerSigner,
      amount: 50n,
      decimals: 6,
    });
    const i = intent([ix], [DST_TOKEN, MINT]);
    expect(i.verifiability).toBe("opaque");
    expect(i.blind).toBe("lookup-table-account");
  });

  it("an approve delegate loaded from a table is opaque", () => {
    const ix = getApproveInstruction({
      source: SRC_TOKEN,
      delegate: DELEGATE,
      owner: feePayerSigner,
      amount: 5n,
    });
    const i = intent([ix], [DELEGATE]);
    expect(i.verifiability).toBe("opaque");
    expect(i.blind).toBe("lookup-table-account");
  });

  it("a Jupiter destination account loaded from a table is opaque", () => {
    const { ixs, tableAddresses } = jupiterIx({ dest: true });
    const i = intent(ixs, tableAddresses);
    expect(i.verifiability).toBe("opaque");
    expect(i.blind).toBe("lookup-table-account");
  });

  it("Jupiter mints loaded from a table are opaque", () => {
    const { ixs, tableAddresses } = jupiterIx({ mints: true });
    const i = intent(ixs, tableAddresses);
    expect(i.verifiability).toBe("opaque");
    expect(i.blind).toBe("lookup-table-account");
  });

  it("a stake account loaded from a table is opaque", () => {
    const ix = getDelegateStakeInstruction({
      stake: STAKE_ACCT as never,
      vote: VOTE_ACCT,
      stakeAuthority: feePayerSigner,
    });
    const i = intent([ix], [STAKE_ACCT]);
    expect(i.verifiability).toBe("opaque");
    expect(i.blind).toBe("lookup-table-account");
  });

  it("a vote account loaded from a table is opaque", () => {
    const ix = getDelegateStakeInstruction({
      stake: STAKE_ACCT as never,
      vote: VOTE_ACCT,
      stakeAuthority: feePayerSigner,
    });
    const i = intent([ix], [VOTE_ACCT]);
    expect(i.verifiability).toBe("opaque");
    expect(i.blind).toBe("lookup-table-account");
  });

  it("a loaded pool account the intent does not name stays partial", () => {
    const { ixs, tableAddresses } = jupiterIx({ pool: true });
    const i = intent(ixs, tableAddresses);
    expect(i.verifiability).toBe("partial");
    expect(i.blind).toBeUndefined();
  });

  it("namedTableAccounts returns the table-resolved named addresses", () => {
    const ix = getTransferSolInstruction({
      source: feePayerSigner,
      destination: DEST,
      amount: 1000n,
    });
    const message = compile([ix], { [LOOKUP_TABLE]: [DEST] });
    expect(namedTableAccounts(parseCompiledMessage(message), table([DEST]).lookupTables)).toStrictEqual([
      DEST,
    ]);
    expect(
      verifiabilitySolana(
        {
          kind: "solana.transaction",
          network: MAINNET,
          account: ACCOUNT,
          message,
          ...table([DEST]),
        } as never,
        FEE_PAYER,
      ),
    ).toBe("opaque");
  });
});
