/// <reference types="node" />
/**
 * Regenerates vectors/chains/solana-v1.json — v1 (SIMD-0385) compiled messages, the unsigned
 * message-first transaction wires, the wallet's signature over each message and the prompt the
 * kernel renders for it (literal expected values under the same rules as the legacy prompts in
 * signing-classes.json). The malformed cases are byte surgery on the valid ones, each naming the
 * Agave/SIMD rule it breaks. Built with @solana/kit 8.5.0 (+ noble/@scure helpers) only, no project
 * imports.
 *
 * Bun scripts/solana-v1-vectors.ts (from packages/wallet-chains)
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  compileTransactionMessage,
  createKeyPairFromBytes,
  createTransactionMessage,
  getAddressFromPublicKey,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
} from "@solana/kit";
import type { Instruction, TransactionMessage, TransactionMessageWithFeePayer } from "@solana/kit";

const OUT = resolve(import.meta.dirname, "../../../vectors/chains/solana-v1.json");
const WALLET_SEED = new Uint8Array(32).fill(0x07);
const SPONSOR_SEED = new Uint8Array(32).fill(0x0b);
const BLOCKHASH = blockhash(base58.encode(new Uint8Array(32).fill(0x0d)));
const SYSTEM = address("11111111111111111111111111111111");
const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const DRAINER = address("Dra1ner111111111111111111111111111111111111");
const DATA_PROGRAM = address("Data1111111111111111111111111111111111111111");
const DEST = address("8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR");
const SRC = address("So11111111111111111111111111111111111111112");
const NONCE = address(base58.encode(new Uint8Array(32).fill(0x0e)));
const NONCE_SYSVAR = address("SysvarRecentB1ockHashes11111111111111111111");
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const hex = (bytes: Uint8Array | Readonly<Uint8Array>): string =>
  Buffer.from(bytes).toString("hex");
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));

const keyPair = async (
  seed: Uint8Array,
): Promise<Awaited<ReturnType<typeof createKeyPairFromBytes>>> =>
  createKeyPairFromBytes(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]));

const addrOf = async (seed: Uint8Array): Promise<string> => {
  const pair = await keyPair(seed);
  return getAddressFromPublicKey(pair.publicKey);
};

const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const u64le = (n: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const cat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const ro = (a: string) => ({ address: address(a), role: AccountRole.READONLY });
const w0 = (a: string) => ({ address: address(a), role: AccountRole.WRITABLE });
const sgn = (a: string) => ({ address: address(a), role: AccountRole.READONLY_SIGNER });
const wsgn = (a: string) => ({ address: address(a), role: AccountRole.WRITABLE_SIGNER });

/** A bare System-program transfer whose `from` must sign. */
const transfer = (from: string, lamports: bigint): Instruction => ({
  programAddress: SYSTEM,
  accounts: [wsgn(from), w0(DEST)],
  data: cat(u32le(2), u64le(lamports)),
});

/** SPL Token TransferChecked — [source, mint, destination, owner]. */
const transferChecked = (from: string, owner: string, amount: bigint, decimals: number) => ({
  programAddress: TOKEN_PROGRAM,
  accounts: [w0(from), ro(USDC_MINT), w0(DEST), sgn(owner)],
  data: cat(new Uint8Array([12]), u64le(amount), new Uint8Array([decimals])),
});

const cuLimit = (units: number): Instruction => ({
  programAddress: COMPUTE_BUDGET,
  accounts: [],
  data: cat(new Uint8Array([2]), u32le(units)),
});
const cuPrice = (microLamports: bigint): Instruction => ({
  programAddress: COMPUTE_BUDGET,
  accounts: [],
  data: cat(new Uint8Array([3]), u64le(microLamports)),
});

/** System AdvanceNonceAccount — [nonce, RecentBlockhashes sysvar, authority]. */
const advanceNonce = (nonce: string, authorityAddress: string): Instruction => ({
  programAddress: SYSTEM,
  accounts: [w0(nonce), ro(NONCE_SYSVAR), sgn(authorityAddress)],
  data: u32le(4),
});

type Config = {
  readonly priorityFeeLamports?: bigint;
  readonly computeUnitLimit?: number;
  readonly loadedAccountsDataSizeLimit?: number;
  readonly heapSize?: number;
};

const compile = (options: {
  feePayer: string;
  ixs: ReadonlyArray<Instruction>;
  config?: Config;
}): { message: Uint8Array; wire: Uint8Array } => {
  let message: TransactionMessage & TransactionMessageWithFeePayer =
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n },
      setTransactionMessageFeePayer(
        address(options.feePayer),
        createTransactionMessage({ version: 1 }),
      ),
    );
  if (options.config !== undefined) {
    message = setTransactionMessageConfig(options.config, message);
  }
  for (const ix of options.ixs) {
    message = appendTransactionMessageInstruction(ix, message);
  }
  const compiled = compileTransactionMessage(message);
  const bytes = new Uint8Array(getCompiledTransactionMessageEncoder().encode(compiled));
  const wire = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
  return { message: bytes, wire };
};

type Prompt = { readonly title: string; readonly description: string };
const p = (en: Prompt, zh: Prompt): { en: Prompt; "zh-Hans": Prompt } => ({ en, "zh-Hans": zh });

type Valid = {
  readonly name: string;
  readonly message: string;
  readonly wire: string;
  readonly signature: string;
  readonly signer: string;
  readonly verifiability: string;
  readonly blind: unknown;
  readonly prompt: { en: Prompt; "zh-Hans": Prompt };
};

const valid = async (options: {
  name: string;
  feePayer: string;
  ixs: ReadonlyArray<Instruction>;
  config?: Config;
  signerKey: Awaited<ReturnType<typeof createKeyPairFromBytes>>;
  signer: string;
  verifiability: string;
  blind: unknown;
  prompt: { en: Prompt; "zh-Hans": Prompt };
}): Promise<Valid> => {
  const { message, wire } = compile(options);
  const signature = await signBytes(options.signerKey.privateKey, message);
  return {
    name: options.name,
    message: hex(message),
    wire: hex(wire),
    signature: hex(new Uint8Array(signature)),
    signer: options.signer,
    verifiability: options.verifiability,
    blind: options.blind,
    prompt: options.prompt,
  };
};

/* Byte-built v1 frame for rules no kit-compiled message can violate: 0x81 ‖ header ‖
   mask(u32 LE) ‖ lifetime ‖ numInstructions ‖ numAddresses ‖ addresses ‖ configValues ‖
   instructionHeaders ‖ payloads. `payloads` are numAccounts u8s then dataLen bytes each. */
const frame = (parts: {
  header?: readonly [number, number, number];
  mask?: number;
  numInstructions?: number;
  accounts: ReadonlyArray<Uint8Array>;
  configValues?: Uint8Array;
  headers?: Uint8Array;
  payloads?: Uint8Array;
}): Uint8Array => {
  const mask = new Uint8Array(4);
  new DataView(mask.buffer).setUint32(0, parts.mask ?? 0, true);
  return cat(
    new Uint8Array([0x81]),
    new Uint8Array(parts.header ?? [1, 0, 0]),
    mask,
    base58.decode(BLOCKHASH),
    new Uint8Array([parts.numInstructions ?? 0, parts.accounts.length]),
    ...parts.accounts,
    parts.configValues ?? new Uint8Array(0),
    parts.headers ?? new Uint8Array(0),
    parts.payloads ?? new Uint8Array(0),
  );
};

const distinct = (count: number): Uint8Array[] =>
  Array.from({ length: count }, (_, i) => new Uint8Array(32).fill(i + 1));

const surgery = (base: Uint8Array, offset: number, write: (v: Uint8Array) => void): Uint8Array => {
  const m = new Uint8Array(base);
  write(m.subarray(offset));
  return m;
};

const main = async (): Promise<void> => {
  const wallet = await keyPair(WALLET_SEED);
  const walletAddress = await addrOf(WALLET_SEED);
  const sponsorAddress = await addrOf(SPONSOR_SEED);

  const cases: Valid[] = [
    await valid({
      name: "v1-sol-transfer",
      feePayer: walletAddress,
      ixs: [transfer(walletAddress, 1000n)],
      signerKey: wallet,
      signer: walletAddress,
      verifiability: "full",
      blind: null,
      prompt: p(
        {
          title: "Confirm transfer",
          description: `Network: Solana\nSend 0.000001 SOL to ${DEST}\nMax fee 0.000005 SOL`,
        },
        {
          title: "确认转账",
          description: `网络：Solana\n发送 0.000001 SOL 到 ${DEST}\n最高手续费 0.000005 SOL`,
        },
      ),
    }),
    await valid({
      name: "v1-transfer-full-config",
      feePayer: walletAddress,
      ixs: [transfer(walletAddress, 1000n)],
      config: {
        priorityFeeLamports: 123456789n,
        computeUnitLimit: 200000,
        loadedAccountsDataSizeLimit: 65536,
        heapSize: 65536,
      },
      signerKey: wallet,
      signer: walletAddress,
      verifiability: "full",
      blind: null,
      prompt: p(
        {
          title: "Confirm transfer",
          description: `Network: Solana\nSend 0.000001 SOL to ${DEST}\nMax fee 0.123461789 SOL`,
        },
        {
          title: "确认转账",
          description: `网络：Solana\n发送 0.000001 SOL 到 ${DEST}\n最高手续费 0.123461789 SOL`,
        },
      ),
    }),
    await valid({
      name: "v1-compute-budget-ignored",
      feePayer: walletAddress,
      ixs: [cuLimit(1_400_000), cuPrice(1_000_000n), transfer(walletAddress, 1000n)],
      config: { priorityFeeLamports: 10000n },
      signerKey: wallet,
      signer: walletAddress,
      verifiability: "full",
      blind: null,
      prompt: p(
        {
          title: "Confirm transfer",
          description: `Network: Solana\nSend 0.000001 SOL to ${DEST}\nMax fee 0.000015 SOL`,
        },
        {
          title: "确认转账",
          description: `网络：Solana\n发送 0.000001 SOL 到 ${DEST}\n最高手续费 0.000015 SOL`,
        },
      ),
    }),
    await valid({
      name: "v1-durable-nonce",
      feePayer: walletAddress,
      ixs: [advanceNonce(NONCE, walletAddress), transfer(walletAddress, 1000n)],
      signerKey: wallet,
      signer: walletAddress,
      verifiability: "full",
      blind: null,
      prompt: p(
        {
          title: "Confirm transfer",
          description: `Network: Solana\nSend 0.000001 SOL to ${DEST}\nMax fee 0.000005 SOL`,
        },
        {
          title: "确认转账",
          description: `网络：Solana\n发送 0.000001 SOL 到 ${DEST}\n最高手续费 0.000005 SOL`,
        },
      ),
    }),

    await valid({
      name: "v1-unknown-program-signer",
      feePayer: walletAddress,
      ixs: [
        {
          programAddress: DRAINER,
          accounts: [sgn(walletAddress), w0(SRC), w0(DEST), ro(TOKEN_PROGRAM)],
          data: cat(new Uint8Array([0]), u64le(5n)),
        },
      ],
      signerKey: wallet,
      signer: walletAddress,
      verifiability: "opaque",
      blind: null,
      prompt: p(
        {
          title: "Confirm contract call",
          description:
            `Program ${DRAINER} receives this account's signature: it can move ALL SOL in this account\n` +
            `Program ${DRAINER} can act with this account's authority on: ${SRC} (may be yours); ${DEST} (may be yours)\n` +
            `Program calls the wallet cannot decode: ${DRAINER}\nThese programs can move assets from the accounts in this transaction\n` +
            `Network: Solana\nMax fee 0.000005 SOL`,
        },
        {
          title: "确认合约调用",
          description:
            `程序 ${DRAINER} 获得本账户的签名：可以转走本账户的全部 SOL\n` +
            `程序 ${DRAINER} 可以以本账户的权限操作：${SRC}（可能属于你）；${DEST}（可能属于你）\n` +
            `钱包无法解码的程序调用：${DRAINER}\n这些程序可以转移本交易涉及账户中的资产\n` +
            `网络：Solana\n最高手续费 0.000005 SOL`,
        },
      ),
    }),

    await valid({
      name: "v1-program-authority-blind",
      feePayer: walletAddress,
      ixs: [
        {
          programAddress: DRAINER,
          accounts: [
            sgn(walletAddress),
            /* One over the prompt's account budget — the reach cannot be listed. */
            ...Array.from({ length: 13 }, (_, i) =>
              w0(base58.encode(new Uint8Array(32).fill(i + 1))),
            ),
          ],
          data: cat(new Uint8Array([0]), u64le(5n)),
        },
      ],
      signerKey: wallet,
      signer: walletAddress,
      verifiability: "opaque",
      blind: "program-authority",
      prompt: p(
        {
          title: "Confirm blind signing",
          description:
            `Program ${DRAINER} receives this account's signature and can reach accounts the wallet cannot list\n` +
            `Program calls the wallet cannot decode: ${DRAINER}\nThese programs can move assets from the accounts in this transaction\n` +
            `Network: Solana\nMax fee 0.000005 SOL`,
        },
        {
          title: "确认盲签",
          description:
            `程序 ${DRAINER} 获得本账户的签名，并可操作钱包无法列出的账户\n` +
            `钱包无法解码的程序调用：${DRAINER}\n这些程序可以转移本交易涉及账户中的资产\n` +
            `网络：Solana\n最高手续费 0.000005 SOL`,
        },
      ),
    }),
    await valid({
      name: "v1-spl-transfer-checked-usdc",
      feePayer: walletAddress,
      ixs: [transferChecked(SRC, walletAddress, 500000n, 6)],
      signerKey: wallet,
      signer: walletAddress,
      verifiability: "full",
      blind: null,
      prompt: p(
        {
          title: "Confirm transfer",
          description: `Network: Solana\nSend 0.5 USDC to ${DEST}\nMax fee 0.000005 SOL`,
        },
        {
          title: "确认转账",
          description: `网络：Solana\n发送 0.5 USDC 到 ${DEST}\n最高手续费 0.000005 SOL`,
        },
      ),
    }),
    await valid({
      name: "v1-sponsored",
      feePayer: sponsorAddress,
      ixs: [transfer(walletAddress, 1000n)],
      signerKey: wallet,
      signer: walletAddress,
      verifiability: "full",
      blind: null,
      prompt: p(
        {
          title: "Confirm transfer",
          description: `Network: Solana\nSend 0.000001 SOL to ${DEST}\nMax fee 0 SOL`,
        },
        {
          title: "确认转账",
          description: `网络：Solana\n发送 0.000001 SOL 到 ${DEST}\n最高手续费 0 SOL`,
        },
      ),
    }),
  ];
  {
    /* v1-large: the v1 frame allows 4096 bytes of transaction where legacy/v0 stop at 1232.
       A data-carrying instruction on an undecoded program pads the message so that
       message + one signature slot is exactly the limit — the class is `opaque`. */
    const probe = compile({ feePayer: walletAddress, ixs: [transfer(walletAddress, 1000n)] });
    const target = 4096 - 64;
    /* The extra instruction adds its program address to the account list (32 bytes) plus a
       4-byte header, then the data itself. */
    const extra = target - probe.message.length - 36;
    const big = await valid({
      name: "v1-large",
      feePayer: walletAddress,
      ixs: [
        transfer(walletAddress, 1000n),
        { programAddress: DATA_PROGRAM, accounts: [], data: new Uint8Array(extra).fill(0xaa) },
      ],
      signerKey: wallet,
      signer: walletAddress,
      verifiability: "opaque",
      blind: null,
      prompt: p(
        {
          title: "Confirm transfer",
          description:
            `Program calls the wallet cannot decode: ${DATA_PROGRAM}\n` +
            `These programs can move assets from the accounts in this transaction\n` +
            `Network: Solana\nSend 0.000001 SOL to ${DEST}\nMax fee 0.000005 SOL`,
        },
        {
          title: "确认转账",
          description:
            `钱包无法解码的程序调用：${DATA_PROGRAM}\n` +
            `这些程序可以转移本交易涉及账户中的资产\n` +
            `网络：Solana\n发送 0.000001 SOL 到 ${DEST}\n最高手续费 0.000005 SOL`,
        },
      ),
    });
    if (unhex(big.message).length + 64 !== 4096) {
      throw new Error(`v1-large is ${unhex(big.message).length + 64} bytes, not 4096`);
    }
    cases.push(big);
  }

  const case1 = unhex(cases[0]?.message ?? "");
  const case2 = unhex(cases[1]?.message ?? "");
  const case9 = unhex(cases[8]?.message ?? "");
  const malformed: Array<{ name: string; message: string; code: string; rule: string }> = [
    {
      name: "v1-mask-unknown-bit",
      message: hex(
        surgery(case1, 4, (m) => {
          // oxlint-disable-next-line eslint/no-bitwise -- the mask is a bit field
          m[0] = (m[0] ?? 0) | 0x20;
        }),
      ),
      code: "unsupported",
      rule: "Agave transaction_config_view.rs sanitize_mask (ALLOWED_TRANSACTION_CONFIG_MASK = 0b1_1111)",
    },
    {
      name: "v1-mask-priority-bit0-only",
      message: hex(
        surgery(case1, 4, (m) => {
          m[0] = 0x01;
        }),
      ),
      code: "invalid-request",
      rule: "SIMD-0385 §TransactionConfigMask: priority-fee bits 0 and 1 are both set or both unset",
    },
    {
      name: "v1-mask-priority-bit1-only",
      message: hex(
        surgery(case1, 4, (m) => {
          m[0] = 0x02;
        }),
      ),
      code: "invalid-request",
      rule: "SIMD-0385 §TransactionConfigMask: priority-fee bits 0 and 1 are both set or both unset",
    },
    {
      name: "v1-exceeds-4096",
      message: hex(cat(case9, new Uint8Array([0]))),
      code: "invalid-request",
      rule: "solana-message src/versions/v1/mod.rs MAX_TRANSACTION_SIZE (message + signatures ≤ 4096)",
    },
    {
      name: "v1-zero-signatures",
      message: hex(
        surgery(case1, 1, (m) => {
          m[0] = 0;
        }),
      ),
      code: "invalid-request",
      rule: "Agave sanitize.rs sanitize_required_signatures (1–12)",
    },
    {
      /* Built from scratch so the 13-signature header is the ONLY violation — a frame with fewer
         accounts would be refused by the accounts-below-header rule either way. */
      name: "v1-thirteen-signatures",
      message: hex(frame({ header: [13, 0, 0], accounts: distinct(13) })),
      code: "invalid-request",
      rule: "transaction_limits.rs MAX_V1_SIGNATURES = 12",
    },
    {
      name: "v1-readonly-signer-count",
      message: hex(
        surgery(case1, 2, (m) => {
          m[0] = 1;
        }),
      ),
      code: "invalid-request",
      rule: "Agave sanitize.rs sanitize_message_header (readonly signed < required)",
    },
    {
      name: "v1-65-accounts",
      message: hex(frame({ accounts: distinct(65) })),
      code: "invalid-request",
      rule: "accounts-db account_locks.rs DEFAULT_TX_ACCOUNT_LOCKS = 64 (SIMD-0596's 96 inactive)",
    },
    {
      name: "v1-accounts-below-header",
      message: hex(frame({ header: [2, 0, 1], accounts: distinct(2) })),
      code: "invalid-request",
      rule: "SIMD-0385 §NumAddresses: addresses ≥ signers + readonly non-signers",
    },
    {
      name: "v1-65-instructions",
      message: hex(
        frame({
          numInstructions: 65,
          accounts: distinct(2),
          headers: new Uint8Array(65 * 4).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0)),
        }),
      ),
      code: "invalid-request",
      rule: "transaction_limits.rs MAX_INSTRUCTION_TRACE_LENGTH = 64",
    },
    {
      name: "v1-duplicate-account",
      message: hex(surgery(case1, 74, (m) => m.set(case1.slice(42, 74)))),
      code: "invalid-request",
      rule: "transaction_limits.rs validate_unique_account_keys",
    },
    {
      name: "v1-program-index-zero",
      message: hex(
        surgery(case1, 138, (m) => {
          m[0] = 0;
        }),
      ),
      code: "invalid-request",
      rule: "SIMD-0385 §InstructionPayloads: 0 < program index < num addresses",
    },
    {
      name: "v1-program-index-range",
      message: hex(
        surgery(case1, 138, (m) => {
          m[0] = 9;
        }),
      ),
      code: "invalid-request",
      rule: "SIMD-0385 §InstructionPayloads: 0 < program index < num addresses",
    },
    {
      name: "v1-account-index-range",
      message: hex(
        surgery(case1, 142, (m) => {
          m[0] = 9;
        }),
      ),
      code: "invalid-request",
      rule: "SIMD-0385 §InstructionPayloads: every account index < num addresses",
    },
    {
      name: "v1-heap-not-1k-multiple",
      message: hex(
        surgery(case2, 154, (m) => new DataView(m.buffer, m.byteOffset).setUint32(0, 33000, true)),
      ),
      code: "invalid-request",
      rule: "transaction_limits.rs validate_heap_size (multiple of 1024 in [32768, 262144])",
    },
    {
      name: "v1-heap-out-of-range",
      message: hex(
        surgery(case2, 154, (m) => new DataView(m.buffer, m.byteOffset).setUint32(0, 1024, true)),
      ),
      code: "invalid-request",
      rule: "transaction_limits.rs validate_heap_size (multiple of 1024 in [32768, 262144])",
    },
    {
      name: "v1-trailing-byte",
      message: hex(cat(case1, new Uint8Array([0]))),
      code: "invalid-request",
      rule: "SIMD-0385 frame is fixed-size: the decoder must end on the last byte",
    },
    {
      name: "v1-truncated",
      message: hex(case1.slice(0, -1)),
      code: "invalid-request",
      rule: "SIMD-0385 frame: payloads must be complete",
    },
    {
      name: "v1-version-2",
      message: hex(cat(new Uint8Array([0x82]), case1.slice(1))),
      code: "unsupported",
      rule: "solana-message src/versions/mod.rs: version byte & 0x7f > 1 is unknown",
    },
  ];

  const json = {
    source:
      "@solana/kit 8.5.0 (SIMD-0385) — regenerate with `bun scripts/solana-v1-vectors.ts` from packages/wallet-chains",
    network: MAINNET,
    account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana" },
    cases,
    malformed,
  };
  writeFileSync(OUT, `${JSON.stringify(json, null, 1)}\n`);
  console.log(`wrote ${OUT}`);
};

await main();
