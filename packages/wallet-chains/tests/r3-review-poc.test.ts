/**
 * R3 review proof-of-concept tests: every `POC Fx:` test asserts the CURRENT behaviour, so it
 * passes today and fails once the finding is fixed. They must not be "fixed" by editing them —
 * a failure after a product change is the intended signal.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { encodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { getAssignInstruction } from "@solana-program/system";
import {
  AuthorityType,
  getApproveCheckedInstruction,
  getSetAuthorityInstruction,
  getTransferInstruction,
} from "@solana-program/token";
import { address } from "@solana/addresses";
import { createNoopSigner } from "@solana/kit";
import {
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/transaction-messages";

import {
  checksumEvmAddress,
  decodeEvm,
  evmTokenTable,
  lookupEvmToken,
} from "../src/evm/index.ts";
import { isBlindIntent } from "../src/index.ts";
import type { SignRequest, TypedDataLeaf } from "../src/index.ts";
import { decodeSolana } from "../src/solana/index.ts";

const SIGNER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x00000000000000000000000000000000c0ffee00";
const SAFE = checksumEvmAddress("0xd5ffe748b45f5253fc9975fdd96fddec052e6d52");
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const account = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;

const typed = (doc: unknown): SignRequest => ({
  kind: "evm.typed-data",
  network: "eip155:1",
  account,
  typedData: JSON.stringify(doc),
});

const personal = (bytes: Uint8Array): SignRequest => ({
  kind: "evm.personal-message",
  network: "eip155:1",
  account,
  message: bytes,
});

const tx = (to: string, data: string): SignRequest => ({
  kind: "evm.transaction",
  network: "eip155:1",
  account,
  tx: {
    type: "eip1559",
    chainId: 1,
    nonce: 0,
    gas: "0x30000",
    to,
    value: "0x0",
    data,
    accessList: [],
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x1",
  },
});

const fieldsOf = (
  intent: ReturnType<typeof decodeEvm>,
): ReadonlyArray<TypedDataLeaf> | undefined =>
  intent.message?.kind === "typed-data" ? intent.message.fields : undefined;

/* ------------------------------------------------------------------ Solana */

const SOL_ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "solana" } as const;
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const FEE_PAYER = address("11111111111111111111111111111112");
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const SRC_TOKEN = address("LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY");
const DST_TOKEN = address("QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF");
const USER_ATA = address("CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8");
const MINT = address("GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq");
const DELEGATE = address("US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx");
const ATTACKER = address("8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR");
const BLOCKHASH = address("11111111111111111111111111111111");

const feePayerSigner = createNoopSigner(FEE_PAYER);

const compile = (instructions: ReadonlyArray<unknown>): Uint8Array => {
  let message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n } as never,
    setTransactionMessageFeePayer(FEE_PAYER, createTransactionMessage({ version: "legacy" })),
  );
  for (const ix of instructions) {
    message = appendTransactionMessageInstruction(ix as never, message as never);
  }
  return new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message as never)),
  );
};

const solReq = (message: Uint8Array) =>
  ({
    kind: "solana.transaction",
    network: MAINNET,
    account: SOL_ACCOUNT,
    message,
  }) as never;

describe("POC F1: typed data wrapping a raw hash is described, not blind", () => {
  const RAW_HASH = bytesToHex(keccak_256(utf8ToBytes("permit2 digest")));
  const doc = {
    types: {
      EIP712Domain: [
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      SafeMessage: [{ name: "message", type: "bytes" }],
    },
    primaryType: "SafeMessage",
    domain: { chainId: 1, verifyingContract: SAFE },
    message: { message: `0x${RAW_HASH}` },
  };

  it("POC F1: decodeEvm describes the SafeMessage doc with a single raw-hash leaf", () => {
    const intent = decodeEvm(typed(doc), SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(isBlindIntent(intent)).toBe(false);
    expect(intent.message?.kind).toBe("typed-data");
    expect(fieldsOf(intent)).toStrictEqual([{ path: "message", value: `0x${RAW_HASH}` }]);
  });
});

describe("POC F2: core Solana instructions outside the decoder table are opaque, not blind", () => {
  const splTransfer = () =>
    getTransferInstruction({
      source: SRC_TOKEN as never,
      destination: DST_TOKEN as never,
      authority: feePayerSigner,
      amount: 1_000_000n,
    });
  const splSetAuthority = () =>
    getSetAuthorityInstruction({
      owned: USER_ATA as never,
      owner: feePayerSigner,
      authorityType: AuthorityType.AccountOwner,
      newAuthority: ATTACKER as never,
    });
  const systemAssign = () =>
    getAssignInstruction({ account: feePayerSigner, programAddress: ATTACKER });
  const tokenApproveChecked = () =>
    getApproveCheckedInstruction({
      source: SRC_TOKEN as never,
      mint: MINT as never,
      delegate: DELEGATE as never,
      owner: feePayerSigner,
      amount: 2n ** 64n - 1n,
      decimals: 6,
    });

  it.each([
    ["SPL Token Transfer (tag 3)", splTransfer(), TOKEN_PROGRAM],
    ["SPL Token SetAuthority/AccountOwner (tag 6)", splSetAuthority(), TOKEN_PROGRAM],
    ["System Assign", systemAssign(), SYSTEM_PROGRAM],
    ["SPL Token ApproveChecked (tag 13)", tokenApproveChecked(), TOKEN_PROGRAM],
  ] as const)("POC F2: %s decodes opaque with no outflows or approvals", (_name, ix, program) => {
    const intent = decodeSolana(solReq(compile([ix])), FEE_PAYER);
    expect(intent.blind).toBeUndefined();
    expect(intent.outflows).toStrictEqual([]);
    expect(intent.approvals).toStrictEqual([]);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.programs).toContain(program);
  });
});

describe("POC F3: a pre-1.1 SafeTx shape escapes safe-delegatecall blindness", () => {
  const safeTxTypes = (gasField: string) => ({
    EIP712Domain: [
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    SafeTx: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: gasField, type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
  });
  const ZERO = "0x0000000000000000000000000000000000000000";
  const message = {
    to: OTHER,
    value: "0",
    data: "0xdeadbeef",
    operation: 1,
    safeTxGas: "0",
    gasPrice: "0",
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: "42",
  };
  const doc = (gasField: string, messageExtra: Record<string, unknown>) => ({
    types: safeTxTypes(gasField),
    primaryType: "SafeTx",
    domain: { chainId: 1, verifyingContract: SAFE },
    message: { ...message, ...messageExtra },
  });

  it("POC F3: uint256 dataGas instead of baseGas is described, not blind", () => {
    const intent = decodeEvm(typed(doc("dataGas", { dataGas: "0" })), SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(fieldsOf(intent)).toBeDefined();
    expect(fieldsOf(intent)).toHaveLength(10);
  });

  it("POC F3: the identical canonical doc with baseGas is safe-delegatecall", () => {
    const intent = decodeEvm(typed(doc("baseGas", { baseGas: "0" })), SIGNER);
    expect(intent.blind).toBe("safe-delegatecall");
  });
});

describe("POC F4: EIP-3009 on a table token is described while unknown token calls are blind", () => {
  const doc = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    domain: { name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC },
    message: {
      from: SIGNER,
      to: OTHER,
      value: "1000000",
      validAfter: "0",
      validBefore: "2000000000",
      nonce: `0x${"42".repeat(32)}`,
    },
  };

  it("POC F4: TransferWithAuthorization on USDC is a described message", () => {
    expect(lookupEvmToken(evmTokenTable, 1, USDC)).toMatchObject({ symbol: "USDC" });
    const intent = decodeEvm(typed(doc), SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(intent.summary).toBe("message");
    expect(intent.outflows).toStrictEqual([]);
    expect(intent.approvals).toStrictEqual([]);
  });

  it("POC F4: the same transferWithAuthorization as calldata to USDC is blind", () => {
    const data = encodeFunctionData({
      abi: parseAbi([
        "function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32)",
      ]),
      args: [SIGNER, OTHER, 1_000_000n, 0n, 2_000_000_000n, `0x${"42".repeat(32)}`],
    });
    expect(decodeEvm(tx(USDC, data), SIGNER).blind).toBe("token-function");
  });
});

describe("POC F5: personal_sign bytes that decode as UTF-8 are not blind", () => {
  it("POC F5: 32 bytes of valid UTF-8 incl. control chars are described as text", () => {
    const intent = decodeEvm(personal(Uint8Array.from({ length: 32 }, (_, i) => i)), SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(intent.message?.kind).toBe("text");
  });

  /* Found by grind-find.ts: keccak256(u64be(74592939)) is strict-valid UTF-8 — a real digest a
     dApp can hand to personal_sign and the wallet will render as text, not refuse as bytes. */
  const GROUND_DIGEST = "0x5718efa1a01c4e34c7b5481f5450604d1274491d0f310532dcbd7461c9ae3b79";

  it("POC F5: keccak256(u64be(74592939)) — a real hash — decodes as text", () => {
    const digest = hexToBytes(GROUND_DIGEST.slice(2));
    expect(digest).toHaveLength(32);
    const intent = decodeEvm(personal(digest), SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(intent.message?.kind).toBe("text");
  });
});
