import { base64 } from "@scure/base";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransactionMessage,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Address, Instruction } from "@solana/kit";
import { describe, expect, it } from "vite-plus/test";

import { PROGRAM_IDS } from "@qntx/wallet-chains/solana";

import { SolanaChainAdapter } from "../src/chains/solana.ts";
import type { SolanaRpc } from "../src/networks/controller.ts";

const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const decoder = getAddressDecoder();
const addr = (n: number): Address => decoder.decode(new Uint8Array(32).fill(n));

const OWNER = addr(1);
const OTHER = addr(2);
const ATA_A = addr(3);
const ATA_B = addr(4);
const FOREIGN_ATA = addr(5);
const TABLE = addr(6);
const LOOKED_UP = addr(7);
const READONLY_LOOKED_UP = addr(8);
const PROGRAM = addr(9);

const message = (
  accounts: Array<{ address: Address; role: AccountRole }>,
  tables?: Record<Address, Address[]>,
): Uint8Array => {
  const instruction: Instruction = {
    programAddress: PROGRAM,
    accounts: [{ address: OWNER, role: AccountRole.WRITABLE_SIGNER }, ...accounts],
    data: new Uint8Array([1]),
  };
  const base = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: blockhash(addr(10)), lastValidBlockHeight: 1n },
    setTransactionMessageFeePayer(OWNER, createTransactionMessage({ version: 0 })),
  );
  const withIx = appendTransactionMessageInstructions([instruction], base);
  const final =
    tables === undefined
      ? withIx
      : compressTransactionMessageUsingAddressLookupTables(withIx, tables);
  return new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(final)),
  );
};

type Account = { lamports: number; owner: string; data: Uint8Array };

const tokenAccount = (mint: string, owner: string, amount: bigint): Uint8Array => {
  const data = new Uint8Array(165);
  data.set(decoderBytes(mint), 0);
  data.set(decoderBytes(owner), 32);
  let rest = amount;
  for (let i = 0; i < 8; i += 1) {
    data[64 + i] = Number(rest % 256n);
    rest /= 256n;
  }
  return data;
};

const addressEncoder = getAddressEncoder();
function decoderBytes(address: string): Uint8Array {
  return new Uint8Array(addressEncoder.encode(address as Address));
}

const wire = (account: Account | undefined) =>
  account === undefined
    ? null
    : {
        lamports: account.lamports,
        owner: account.owner,
        data: [base64.encode(account.data), "base64"],
      };

type Fake = {
  readonly rpc: SolanaRpc;
  readonly calls: Array<{ method: string; params: unknown[] }>;
};

function fakeRpc(options: {
  pre: Record<string, Account | undefined>;
  post: Record<string, Account | undefined>;
  err?: unknown;
  logs?: string[];
  tables?: Record<string, Uint8Array>;
  failWith?: string;
}): Fake {
  const calls: Fake["calls"] = [];
  return {
    calls,
    rpc: {
      call: async (method, params) => {
        calls.push({ method, params });
        await Promise.resolve();
        if (options.failWith !== undefined) {
          throw new Error(options.failWith);
        }
        const addresses = (params[0] as string[] | undefined) ?? [];
        if (method === "getMultipleAccounts") {
          const tables = options.tables ?? {};
          return {
            value: addresses.map((a) =>
              a in tables
                ? wire({ lamports: 1, owner: PROGRAM, data: tables[a] ?? new Uint8Array() })
                : wire(options.pre[a]),
            ),
          };
        }
        const config = params[1] as { accounts: { addresses: string[] } };
        return {
          value: {
            err: options.err ?? null,
            logs: options.logs ?? [],
            accounts: config.accounts.addresses.map((a) => wire(options.post[a])),
          },
        };
      },
    },
  };
}

const noTimer = (): (() => void) => () => undefined;
const simulate = async (fake: Fake, msg: Uint8Array) =>
  new SolanaChainAdapter().simulate(fake.rpc, MAINNET, OWNER, msg, noTimer);

describe("SolanaChainAdapter.simulate", () => {
  it("reports the owner's lamports delta, including fees", async () => {
    const fake = fakeRpc({
      pre: { [OWNER]: { lamports: 10_000_000, owner: PROGRAM_IDS.system, data: new Uint8Array() } },
      post: { [OWNER]: { lamports: 8_995_000, owner: PROGRAM_IDS.system, data: new Uint8Array() } },
    });
    const outcome = await simulate(fake, message([{ address: OTHER, role: AccountRole.WRITABLE }]));
    expect(outcome).toStrictEqual({
      status: "success",
      changes: [{ asset: "lamports", amount: "-1005000", verified: true }],
    });
    const [pre, post] = fake.calls;
    expect(pre?.method).toBe("getMultipleAccounts");
    expect(post?.method).toBe("simulateTransaction");
    expect(post?.params[1]).toMatchObject({
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
  });

  it("sends the message behind zeroed signature placeholders", async () => {
    const fake = fakeRpc({ pre: {}, post: {} });
    const msg = message([]);
    await simulate(fake, msg);
    const sent = base64.decode(String(fake.calls[1]?.params[0]));
    expect(sent[0]).toBe(1);
    expect(sent.slice(1, 65).every((byte) => byte === 0)).toBe(true);
    expect(sent.slice(65)).toStrictEqual(msg);
  });

  it("sums token deltas per mint over the owner's token accounts only", async () => {
    const pre = {
      [ATA_A]: {
        lamports: 1,
        owner: PROGRAM_IDS.token,
        data: tokenAccount(USDC_MINT, OWNER, 1000n),
      },
      [FOREIGN_ATA]: {
        lamports: 1,
        owner: PROGRAM_IDS.token,
        data: tokenAccount(USDC_MINT, OTHER, 9n),
      },
    };
    const post = {
      [ATA_A]: {
        lamports: 1,
        owner: PROGRAM_IDS.token,
        data: tokenAccount(USDC_MINT, OWNER, 600n),
      },
      [ATA_B]: {
        lamports: 1,
        owner: PROGRAM_IDS.token2022,
        data: tokenAccount(addr(20), OWNER, 5n),
      },
      [FOREIGN_ATA]: {
        lamports: 1,
        owner: PROGRAM_IDS.token,
        data: tokenAccount(USDC_MINT, OTHER, 409n),
      },
    };
    const fake = fakeRpc({ pre, post });
    const outcome = await simulate(
      fake,
      message([
        { address: ATA_A, role: AccountRole.WRITABLE },
        { address: ATA_B, role: AccountRole.WRITABLE },
        { address: FOREIGN_ATA, role: AccountRole.WRITABLE },
      ]),
    );
    expect(outcome).toStrictEqual({
      status: "success",
      changes: [
        { asset: USDC_MINT, amount: "-400", decimals: 6, symbol: "USDC", verified: true },
        { asset: addr(20), amount: "5", verified: false },
      ],
    });
  });

  it("watches the writable addresses of a lookup table, not the readonly ones", async () => {
    const tableData = new Uint8Array(56 + 3 * 32);
    tableData.set(decoderBytes(addr(30)), 56);
    tableData.set(decoderBytes(LOOKED_UP), 56 + 32);
    tableData.set(decoderBytes(READONLY_LOOKED_UP), 56 + 64);
    const fake = fakeRpc({
      pre: {},
      post: {},
      tables: { [TABLE]: tableData },
    });
    const msg = message(
      [
        { address: LOOKED_UP, role: AccountRole.WRITABLE },
        { address: READONLY_LOOKED_UP, role: AccountRole.READONLY },
      ],
      { [TABLE]: [addr(30), LOOKED_UP, READONLY_LOOKED_UP] },
    );
    await simulate(fake, msg);
    const config = fake.calls[2]?.params[1] as { accounts: { addresses: string[] } };
    const { addresses: watched } = config.accounts;
    expect(fake.calls[0]?.params[0]).toStrictEqual([TABLE]);
    expect(watched).toContain(LOOKED_UP);
    expect(watched).not.toContain(READONLY_LOOKED_UP);
    expect(new Set(watched).size).toBe(watched.length);
  });

  it("reports an execution error with the last log line as reverted", async () => {
    const fake = fakeRpc({
      pre: {},
      post: {},
      err: { InstructionError: [0, { Custom: 1 }] },
      logs: ["Program log: start", "Program log: insufficient funds"],
    });
    const outcome = await simulate(fake, message([]));
    expect(outcome).toStrictEqual({
      status: "reverted",
      error: '{"InstructionError":[0,{"Custom":1}]} (Program log: insufficient funds)',
    });
  });

  it("reports a node failure or an undecodable message as unavailable", async () => {
    const failed = await simulate(
      fakeRpc({ pre: {}, post: {}, failWith: "node down" }),
      message([]),
    );
    expect(failed).toStrictEqual({ status: "unavailable", error: "node down" });
    const garbage = await simulate(fakeRpc({ pre: {}, post: {} }), new Uint8Array([1, 2, 3]));
    expect(garbage.status).toBe("unavailable");
  });

  it("gives up after the injected timer fires", async () => {
    const hang: SolanaRpc = { call: async () => new Promise(() => undefined) };
    const fire: { run: () => unknown } = { run: () => undefined };
    const pending = new SolanaChainAdapter().simulate(
      hang,
      MAINNET,
      OWNER,
      message([]),
      (_ms, fn) => {
        fire.run = fn;
        return () => undefined;
      },
    );
    fire.run();
    await expect(pending).resolves.toStrictEqual({ status: "unavailable", error: "timeout" });
  });
});
