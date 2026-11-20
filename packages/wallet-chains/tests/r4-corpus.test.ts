/**
 * R4 usability corpus: real everyday signing-request shapes, each expected to decode as
 * "described" (intent.blind undefined). Every failing row is a false-blind — a request a
 * user would plausibly meet that the blind-signing gate would refuse. Results are written
 * to wallet-audit/r4/review-classify/corpus.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  getDeactivateInstruction,
  getDelegateStakeInstruction,
  getInitializeInstruction,
  getSplitInstruction,
  getWithdrawInstruction,
} from "@solana-program/stake";
import {
  getAdvanceNonceAccountInstruction,
  getCreateAccountInstruction,
  getTransferSolInstruction,
} from "@solana-program/system";
import {
  getBurnCheckedInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  getTransferInstruction,
} from "@solana-program/token";
import { getTransferCheckedInstruction as getTransferCheckedInstruction2022 } from "@solana-program/token-2022";
import { AccountRole, address, createNoopSigner } from "@solana/kit";
import {
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/transaction-messages";
import { encodeFunctionData, parseAbi } from "viem";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/index.ts";
import { ChainError } from "../src/index.ts";
import type { EvmTransaction, SignRequest } from "../src/index.ts";
import { decodeSolana } from "../src/solana/index.ts";

/* ------------------------------------------------------------------ constants */

const EVM_SIGNER = "0x2222222222222222222222222222222222222222";
const SOL_SIGNER = "11111111111111111111111111111112";
const JUPITER_SIGNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const EVM_ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;
const SOL_ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "solana" } as const;
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const LINK = "0x514910771AF9Ca656af840dff83E8264EcF986CA";
const COMP = "0xc00e94Cb662C3520282E6f5717214004A7f26888";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const SEAPORT16 = "0x0000000000000068F116a894984e2DB1123eB395";
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const COMET_USDC = "0xc3d688B66703497DAA19211EEdff47f25384cdc3";
const LIDO_STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
const UNIVERSAL_ROUTER = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af";
const BAYC = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";
const OS_STOREFRONT = "0x495f947276749Ce646f68AC8c248420045cb7b5e";
const LOP_V4 = "0x111111125421cA6dc452d289314280a0f8842A65";
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const MULTISEND_141 = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
const OPENSEA_FEE = "0x0000a26b00c1F0DF003000390027140000fAa719";
const OTHER = "0x00000000000000000000000000000000c0ffee00";
const ZERO = "0x0000000000000000000000000000000000000000";
const SAFE = "0xD5Ffe748b45F5253Fc9975fDd96FDdeC052e6D52";

const FEE_PAYER = address(SOL_SIGNER);
const feePayerSigner = createNoopSigner(FEE_PAYER);
const DEST = address("8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR");
const ATA = address("CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8");
const MINT = address("GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq");
const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SRC_TOKEN = address("LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY");
const DST_TOKEN = address("QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF");
const STAKE_ACCT = address("YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf");
const SPLIT_STAKE = address("US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx");
const VOTE_ACCT = address("cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN");
const NONCE_ACCT = address("6wWVbLeHDVHvCCsLprB85jkbU1JhS9VezABT2ZZFJ5BB");
const BLOCKHASH = address("11111111111111111111111111111111");
const LOOKUP_TABLE = address("AddressLookupTab1e1111111111111111111111111");
const MEMO_PROG = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const CANDY_GUARD = "Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g";
const CANDY_MACHINE = "CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR";

/* ------------------------------------------------------------------ helpers (mirroring signing-class.test.ts / solana.test.ts) */

const tx = (
  to: string | undefined,
  data: string,
  value = "0x0",
  chainId = 1,
  network = `eip155:${chainId}`,
): SignRequest => ({
  kind: "evm.transaction",
  network,
  account: EVM_ACCOUNT,
  tx: {
    type: "eip1559",
    chainId,
    nonce: 0,
    gas: "0x30000",
    ...(to === undefined ? {} : { to }),
    value,
    data,
    accessList: [],
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x1",
  } as EvmTransaction,
});

const typed = (doc: unknown, network = "eip155:1"): SignRequest => ({
  kind: "evm.typed-data",
  network,
  account: EVM_ACCOUNT,
  typedData: JSON.stringify(doc),
});

const personal = (bytes: Uint8Array): SignRequest => ({
  kind: "evm.personal-message",
  network: "eip155:1",
  account: EVM_ACCOUNT,
  message: bytes,
});

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const compile = (
  instructions: ReadonlyArray<unknown>,
  version: "legacy" | 0 | 1 = "legacy",
  lookupAddresses?: Record<string, ReadonlyArray<string>>,
): Uint8Array => {
  let message = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n } as never,
    setTransactionMessageFeePayer(FEE_PAYER, createTransactionMessage({ version })),
  );
  for (const ix of instructions) {
    message = appendTransactionMessageInstruction(ix as never, message as never);
  }
  if (lookupAddresses !== undefined && version === 0) {
    const compressed = compressTransactionMessageUsingAddressLookupTables(
      message as never,
      lookupAddresses as never,
    );
    return new Uint8Array(
      getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(compressed)),
    );
  }
  return new Uint8Array(
    getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message as never)),
  );
};

const solReq = (
  message: Uint8Array,
  lookupTables?: ReadonlyArray<{ address: string; addresses: ReadonlyArray<string> }>,
): SignRequest => ({
  kind: "solana.transaction",
  network: MAINNET,
  account: SOL_ACCOUNT,
  message,
  ...(lookupTables === undefined ? {} : { lookupTables }),
});

const ro = (addr: string) => ({ address: address(addr), role: AccountRole.READONLY });
const w0 = (addr: string) => ({ address: address(addr), role: AccountRole.WRITABLE });
const sgn = (addr: string) => ({
  address: address(addr),
  role: AccountRole.READONLY_SIGNER,
  signer: createNoopSigner(address(addr)),
});
const wsgn = (addr: string) => ({
  address: address(addr),
  role: AccountRole.WRITABLE_SIGNER,
  signer: createNoopSigner(address(addr)),
});

const ix = (program: string, accounts: ReadonlyArray<object>, data: Uint8Array) => ({
  programAddress: address(program),
  accounts,
  data,
});

const DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

const PERMIT_TYPES = {
  EIP712Domain: DOMAIN_FIELDS,
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const PERMIT2_DOMAIN_TYPES = [
  { name: "name", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];
const PERMIT2_DOMAIN = { name: "Permit2", chainId: 1, verifyingContract: PERMIT2 };
const TOKEN_PERMISSIONS = [
  { name: "token", type: "address" },
  { name: "amount", type: "uint256" },
];

const ORDER_INFO = [
  { name: "reactor", type: "address" },
  { name: "swapper", type: "address" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
  { name: "additionalValidationContract", type: "address" },
  { name: "additionalValidationData", type: "bytes" },
];
const DUTCH_OUTPUT = [
  { name: "token", type: "address" },
  { name: "startAmount", type: "uint256" },
  { name: "endAmount", type: "uint256" },
  { name: "recipient", type: "address" },
];
const V2_DUTCH_ORDER = [
  { name: "info", type: "OrderInfo" },
  { name: "cosigner", type: "address" },
  { name: "baseInputToken", type: "address" },
  { name: "baseInputStartAmount", type: "uint256" },
  { name: "baseInputEndAmount", type: "uint256" },
  { name: "baseOutputs", type: "DutchOutput[]" },
];
const EXCLUSIVE_DUTCH_ORDER = [
  { name: "info", type: "OrderInfo" },
  { name: "decayStartTime", type: "uint256" },
  { name: "decayEndTime", type: "uint256" },
  { name: "exclusiveFiller", type: "address" },
  { name: "exclusivityOverrideBps", type: "uint256" },
  { name: "inputToken", type: "address" },
  { name: "inputStartAmount", type: "uint256" },
  { name: "inputEndAmount", type: "uint256" },
  { name: "outputs", type: "DutchOutput[]" },
];

/* UniswapX V2 Dutch Order Reactor, mainnet (REACTOR_ADDRESS_MAPPING, uniswapx-sdk). */
const UNISWAPX_V2_REACTOR = "0x00000011F84B9aa48e5f8aA8B9897600006289Be";

const seaportDoc = (offer: unknown[], consideration: unknown[]) => ({
  types: {
    EIP712Domain: DOMAIN_FIELDS,
    OrderComponents: [
      { name: "offerer", type: "address" },
      { name: "zone", type: "address" },
      { name: "offer", type: "OfferItem[]" },
      { name: "consideration", type: "ConsiderationItem[]" },
      { name: "orderType", type: "uint8" },
      { name: "startTime", type: "uint256" },
      { name: "endTime", type: "uint256" },
      { name: "zoneHash", type: "bytes32" },
      { name: "salt", type: "uint256" },
      { name: "conduitKey", type: "bytes32" },
      { name: "counter", type: "uint256" },
    ],
    OfferItem: [
      { name: "itemType", type: "uint8" },
      { name: "token", type: "address" },
      { name: "identifierOrCriteria", type: "uint256" },
      { name: "startAmount", type: "uint256" },
      { name: "endAmount", type: "uint256" },
    ],
    ConsiderationItem: [
      { name: "itemType", type: "uint8" },
      { name: "token", type: "address" },
      { name: "identifierOrCriteria", type: "uint256" },
      { name: "startAmount", type: "uint256" },
      { name: "endAmount", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
  },
  primaryType: "OrderComponents",
  domain: { name: "Seaport", version: "1.6", chainId: 1, verifyingContract: SEAPORT16 },
  message: {
    offerer: EVM_SIGNER,
    zone: ZERO,
    offer,
    consideration,
    orderType: 0,
    startTime: "1700000000",
    endTime: "1700001000",
    zoneHash: `0x${"00".repeat(32)}`,
    salt: "123456789",
    conduitKey: `0x${"00".repeat(32)}`,
    counter: "0",
  },
});

const SAFE_TX_FIELDS = [
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "data", type: "bytes" },
  { name: "operation", type: "uint8" },
  { name: "safeTxGas", type: "uint256" },
  { name: "baseGas", type: "uint256" },
  { name: "gasPrice", type: "uint256" },
  { name: "gasToken", type: "address" },
  { name: "refundReceiver", type: "address" },
  { name: "nonce", type: "uint256" },
];

const safeDoc = (message: Record<string, unknown>) => ({
  types: {
    EIP712Domain: [
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    SafeTx: SAFE_TX_FIELDS,
  },
  primaryType: "SafeTx",
  domain: { chainId: 1, verifyingContract: SAFE },
  message: {
    value: "0",
    data: "0x",
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: "42",
    ...message,
  },
});

const ERC20_TRANSFER = parseAbi(["function transfer(address,uint256)"]);
const transferData = encodeFunctionData({
  abi: ERC20_TRANSFER,
  args: [OTHER as `0x${string}`, 1_000_000n],
});

/** Packed MultiSend entry: operation(1) | to(20) | value(32) | dataLength(32) | data. */
const packEntry = (to: string, value: bigint, data: string, operation = 0): string => {
  const bytes = data.slice(2);
  const length = BigInt(bytes.length / 2)
    .toString(16)
    .padStart(64, "0");
  return `${operation.toString(16).padStart(2, "0")}${to.slice(2).toLowerCase()}${value
    .toString(16)
    .padStart(64, "0")}${length}${bytes.toLowerCase()}`;
};

const multiSend = (packed: string): string =>
  encodeFunctionData({
    abi: parseAbi(["function multiSend(bytes transactions)"]),
    args: [`0x${packed}`],
  });

/* ------------------------------------------------------------------ corpus */

type CorpusEntry = {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly expected: "described";
  readonly signer: string;
  readonly request: SignRequest;
};

const evm = (
  id: string,
  name: string,
  source: string,
  request: SignRequest,
): CorpusEntry => ({ id, name, source, expected: "described", signer: EVM_SIGNER, request });

const sol = (
  id: string,
  name: string,
  source: string,
  request: SignRequest,
  signer: string = SOL_SIGNER,
): CorpusEntry => ({ id, name, source, expected: "described", signer, request });

const siweExample = `example.com wants you to sign in with your Ethereum account:
0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2

I accept the ExampleOrg Terms of Service: https://example.com/tos

URI: https://example.com/login
Version: 1
Chain ID: 1
Nonce: 32891756
Issued At: 2021-09-30T16:25:24Z
Resources:
- ipfs://bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq/
- https://example.com/my-web2-claim.json`;

const openSeaLogin = `Welcome to OpenSea!

Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).

This request will not trigger a blockchain transaction or cost any gas fees.

Wallet address:
${EVM_SIGNER.toLowerCase()}

Nonce:
ea499f2f-fdbc-4d04-92c4-b60aba887e06`;

const jupiterVector = (
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/solana.json"), "utf8"),
  ) as {
    jupiter: Array<{
      name: string;
      message: string;
      lookupTables?: ReadonlyArray<{ address: string; addresses: ReadonlyArray<string> }>;
    }>;
  }
).jupiter[0]!;

const hex = (h: string): Uint8Array =>
  Uint8Array.from(Buffer.from(h.startsWith("0x") ? h.slice(2) : h, "hex"));

const corpus: CorpusEntry[] = [
  /* ------------------------------------------------ EVM personal_sign */
  evm(
    "emsg-siwe",
    "SIWE login — EIP-4361 spec example",
    "https://eips.ethereum.org/EIPS/eip-4361",
    personal(utf8(siweExample)),
  ),
  evm(
    "emsg-opensea",
    "OpenSea 'Welcome to OpenSea!' login (address + UUID nonce)",
    "https://github.com/Cyfrin/clearsig/blob/main/examples/opensea_signin.txt",
    personal(utf8(openSeaLogin)),
  ),
  evm(
    "emsg-32byte-ascii",
    "plain login text of exactly 32 ASCII bytes",
    "https://eips.ethereum.org/EIPS/eip-191 (32-byte text is indistinguishable from a digest preimage)",
    personal(utf8("Login nonce: 7f3a9b2c1d4e5f6a8b0")),
  ),
  evm(
    "emsg-32byte-hex-nonce",
    "randomBytes(16).toString('hex') 32-char nonce as the whole message",
    "https://docs.metamask.io/wallet/how-to/sign-data/#personal_sign (common dApp nonce convention)",
    personal(utf8("9f2b8c1d4e5a6f708192a3b4c5d6e7f8")),
  ),
  evm(
    "emsg-31byte-ascii",
    "plain login text of exactly 31 ASCII bytes",
    "https://eips.ethereum.org/EIPS/eip-191",
    personal(utf8("Login nonce: 7f3a9b2c1d4e5f6a8b")),
  ),
  evm(
    "emsg-33byte-ascii",
    "plain login text of exactly 33 ASCII bytes",
    "https://eips.ethereum.org/EIPS/eip-191",
    personal(utf8("Login nonce: 7f3a9b2c1d4e5f6a8b0c")),
  ),
  evm(
    "emsg-cjk-32byte",
    "CJK login text of exactly 32 UTF-8 bytes (10 CJK chars + 2 ASCII)",
    "https://eips.ethereum.org/EIPS/eip-191 (32-byte rule counts UTF-8 bytes, not characters)",
    personal(utf8("登录我的账户确认登录OK")),
  ),
  evm(
    "emsg-cjk-long",
    "CJK login text longer than 32 bytes",
    "https://eips.ethereum.org/EIPS/eip-191",
    personal(utf8("请登录你的账户以继续使用本应用程序")),
  ),
  evm(
    "emsg-emoji-fox",
    "text with a plain emoji",
    "https://unicode.org/emoji/charts/full-emoji-list.html",
    personal(utf8("Sign in to MetaMask 🦊")),
  ),
  evm(
    "emsg-emoji-skin-tone",
    "text with an emoji + skin-tone modifier (👋🏽)",
    "https://unicode.org/emoji/charts/full-emoji-modifiers.html",
    personal(utf8("gm 👋🏽 sign me in")),
  ),
  evm(
    "emsg-emoji-zwj-technologist",
    "text with a ZWJ emoji sequence (👨‍💻)",
    "https://unicode.org/emoji/charts/emoji-zwj-sequences.html",
    personal(utf8("Sign in 👨‍💻")),
  ),
  evm(
    "emsg-emoji-zwj-flag",
    "text with a ZWJ emoji sequence (🏳️‍🌈)",
    "https://unicode.org/emoji/charts/emoji-zwj-sequences.html",
    personal(utf8("gm 🏳️‍🌈")),
  ),
  evm(
    "emsg-persian-zwnj",
    "Persian text with ZWNJ U+200C (می‌خواهم وارد شوم)",
    "https://en.wikipedia.org/wiki/Zero-width_non-joiner",
    personal(utf8("می‌خواهم وارد شوم")),
  ),
  evm(
    "emsg-hebrew-rlm",
    "Hebrew text with RLM U+200F as an RTL editor emits",
    "https://en.wikipedia.org/wiki/Right-to-left_mark",
    personal(utf8("שלום, היכנס לחשבון שלי\u200F")),
  ),
  evm(
    "emsg-arabic-alm",
    "Arabic text with ALM U+061C",
    "https://en.wikipedia.org/wiki/Arabic_letter_mark",
    personal(utf8("\u061Cمرحبا، تسجيل الدخول إلى حسابي")),
  ),
  evm(
    "emsg-soft-hyphen",
    "text with a soft hyphen U+00AD",
    "https://en.wikipedia.org/wiki/Soft_hyphen",
    personal(utf8("Vertrags\u00ADbedingungen akzeptieren")),
  ),
  evm(
    "emsg-nbsp",
    "text with a no-break space U+00A0",
    "https://en.wikipedia.org/wiki/Non-breaking_space",
    personal(utf8("Sign in\u00A0to Example")),
  ),

  /* ------------------------------------------------ EVM typed data */
  evm(
    "etd-permit-usdc",
    "EIP-2612 Permit on USDC (domain 'USD Coin' v2)",
    "https://eips.ethereum.org/EIPS/eip-2612 + https://github.com/circlefin/stablecoin-evm (USD Coin domain v2)",
    typed({
      types: PERMIT_TYPES,
      primaryType: "Permit",
      domain: { name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC },
      message: {
        owner: EVM_SIGNER,
        spender: UNIVERSAL_ROUTER,
        value: "1000000",
        nonce: 0,
        deadline: 1_900_000_000,
      },
    }),
  ),
  evm(
    "etd-permit-link",
    "EIP-2612 Permit on a non-table token (LINK)",
    "https://eips.ethereum.org/EIPS/eip-2612",
    typed({
      types: PERMIT_TYPES,
      primaryType: "Permit",
      domain: { name: "ChainLink Token", version: "1", chainId: 1, verifyingContract: LINK },
      message: {
        owner: EVM_SIGNER,
        spender: UNIVERSAL_ROUTER,
        value: "1000000000000000000",
        nonce: 0,
        deadline: 1_900_000_000,
      },
    }),
  ),
  evm(
    "etd-permit-dai",
    "DAI Permit (holder/spender/nonce/expiry/allowed)",
    "https://github.com/makerdao/dss/blob/master/src/dai.sol",
    typed({
      types: {
        EIP712Domain: DOMAIN_FIELDS,
        Permit: [
          { name: "holder", type: "address" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "expiry", type: "uint256" },
          { name: "allowed", type: "bool" },
        ],
      },
      primaryType: "Permit",
      domain: { name: "Dai Stablecoin", version: "1", chainId: 1, verifyingContract: DAI },
      message: {
        holder: EVM_SIGNER,
        spender: UNIVERSAL_ROUTER,
        nonce: 0,
        expiry: 1_900_000_000,
        allowed: true,
      },
    }),
  ),
  evm(
    "etd-permit2-single",
    "Permit2 PermitSingle (Uniswap allowance approval)",
    "https://github.com/Uniswap/permit2 (PermitSingle/PermitDetails typehashes)",
    typed({
      types: {
        EIP712Domain: PERMIT2_DOMAIN_TYPES,
        PermitDetails: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
          { name: "nonce", type: "uint48" },
        ],
        PermitSingle: [
          { name: "details", type: "PermitDetails" },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
      },
      primaryType: "PermitSingle",
      domain: PERMIT2_DOMAIN,
      message: {
        details: { token: USDC, amount: "1461501637330902918203684832716283019655932542975", expiration: 1_900_000_000, nonce: 0 },
        spender: UNIVERSAL_ROUTER,
        sigDeadline: 1_900_000_000,
      },
    }),
  ),
  evm(
    "etd-permit2-batch",
    "Permit2 PermitBatch (two tokens)",
    "https://github.com/Uniswap/permit2 (PermitBatch typehash)",
    typed({
      types: {
        EIP712Domain: PERMIT2_DOMAIN_TYPES,
        PermitDetails: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
          { name: "nonce", type: "uint48" },
        ],
        PermitBatch: [
          { name: "details", type: "PermitDetails[]" },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
      },
      primaryType: "PermitBatch",
      domain: PERMIT2_DOMAIN,
      message: {
        details: [
          { token: USDC, amount: "1000000", expiration: 1_900_000_000, nonce: 0 },
          { token: WETH, amount: "1000000000000000000", expiration: 1_900_000_000, nonce: 0 },
        ],
        spender: UNIVERSAL_ROUTER,
        sigDeadline: 1_900_000_000,
      },
    }),
  ),
  evm(
    "etd-permit2-witness-v2dutch",
    "Permit2 PermitWitnessTransferFrom — UniswapX V2DutchOrder witness",
    "https://github.com/Uniswap/UniswapX/blob/main/src/lib/V2DutchOrderLib.sol",
    typed({
      types: {
        EIP712Domain: PERMIT2_DOMAIN_TYPES,
        DutchOutput: DUTCH_OUTPUT,
        OrderInfo: ORDER_INFO,
        TokenPermissions: TOKEN_PERMISSIONS,
        V2DutchOrder: V2_DUTCH_ORDER,
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "V2DutchOrder" },
        ],
      },
      primaryType: "PermitWitnessTransferFrom",
      domain: PERMIT2_DOMAIN,
      message: {
        permitted: { token: USDC, amount: "1000000" },
        spender: UNISWAPX_V2_REACTOR,
        nonce: "123456",
        deadline: "1800000000",
        witness: {
          info: {
            reactor: UNISWAPX_V2_REACTOR,
            swapper: EVM_SIGNER,
            nonce: "123456",
            deadline: "1800000000",
            additionalValidationContract: ZERO,
            additionalValidationData: "0x",
          },
          cosigner: "0x1111111254fb6c44bAC0beD2854e76F90643097d",
          baseInputToken: USDC,
          baseInputStartAmount: "1000000",
          baseInputEndAmount: "1000000",
          baseOutputs: [
            {
              token: WETH,
              startAmount: "400000000000000",
              endAmount: "390000000000000",
              recipient: EVM_SIGNER,
            },
          ],
        },
      },
    }),
  ),
  evm(
    "etd-permit2-witness-exclusive",
    "Permit2 PermitWitnessTransferFrom — UniswapX ExclusiveDutchOrder witness",
    "https://github.com/Uniswap/UniswapX/blob/main/src/lib/ExclusiveDutchOrderLib.sol",
    typed({
      types: {
        EIP712Domain: PERMIT2_DOMAIN_TYPES,
        DutchOutput: DUTCH_OUTPUT,
        ExclusiveDutchOrder: EXCLUSIVE_DUTCH_ORDER,
        OrderInfo: ORDER_INFO,
        TokenPermissions: TOKEN_PERMISSIONS,
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "ExclusiveDutchOrder" },
        ],
      },
      primaryType: "PermitWitnessTransferFrom",
      domain: PERMIT2_DOMAIN,
      message: {
        permitted: { token: USDC, amount: "1000000" },
        spender: "0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4",
        nonce: "123456",
        deadline: "1800000000",
        witness: {
          info: {
            reactor: "0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4",
            swapper: EVM_SIGNER,
            nonce: "123456",
            deadline: "1800000000",
            additionalValidationContract: ZERO,
            additionalValidationData: "0x",
          },
          decayStartTime: "1700000100",
          decayEndTime: "1700001000",
          exclusiveFiller: "0x1111111254fb6c44bAC0beD2854e76F90643097d",
          exclusivityOverrideBps: "300",
          inputToken: USDC,
          inputStartAmount: "1000000",
          inputEndAmount: "1010000",
          outputs: [
            {
              token: WETH,
              startAmount: "400000000000000",
              endAmount: "390000000000000",
              recipient: EVM_SIGNER,
            },
          ],
        },
      },
    }),
  ),
  evm(
    "etd-seaport-listing",
    "Seaport 1.6 OpenSea listing — 1 NFT offer, 3 considerations (seller + OpenSea fee + creator fee)",
    "https://github.com/ProjectOpenSea/seaport-js/blob/main/src/constants.ts (EIP_712_ORDER_TYPE)",
    typed(
      seaportDoc(
        [
          {
            itemType: 2,
            token: BAYC,
            identifierOrCriteria: "1234",
            startAmount: "1",
            endAmount: "1",
          },
        ],
        [
          {
            itemType: 0,
            token: ZERO,
            identifierOrCriteria: "0",
            startAmount: "48750000000000000",
            endAmount: "48750000000000000",
            recipient: EVM_SIGNER,
          },
          {
            itemType: 0,
            token: ZERO,
            identifierOrCriteria: "0",
            startAmount: "1250000000000000",
            endAmount: "1250000000000000",
            recipient: OPENSEA_FEE,
          },
          {
            itemType: 0,
            token: ZERO,
            identifierOrCriteria: "0",
            startAmount: "5000000000000000",
            endAmount: "5000000000000000",
            recipient: OTHER,
          },
        ],
      ),
    ),
  ),
  evm(
    "etd-seaport-bundle-5",
    "Seaport 1.6 five-item bundle listing",
    "https://github.com/ProjectOpenSea/seaport-js/blob/main/src/constants.ts (EIP_712_ORDER_TYPE)",
    typed(
      seaportDoc(
        [11, 22, 33, 44, 55].map((id) => ({
          itemType: 2,
          token: BAYC,
          identifierOrCriteria: String(id),
          startAmount: "1",
          endAmount: "1",
        })),
        [
          {
            itemType: 0,
            token: ZERO,
            identifierOrCriteria: "0",
            startAmount: "500000000000000000",
            endAmount: "500000000000000000",
            recipient: EVM_SIGNER,
          },
        ],
      ),
    ),
  ),
  evm(
    "etd-seaport-collection-offer",
    "Seaport 1.6 collection offer — offer WETH, consideration ERC721 criteria",
    "https://github.com/ProjectOpenSea/seaport-js/blob/main/src/constants.ts (EIP_712_ORDER_TYPE)",
    typed(
      seaportDoc(
        [
          {
            itemType: 1,
            token: WETH,
            identifierOrCriteria: "0",
            startAmount: "500000000000000000",
            endAmount: "500000000000000000",
          },
        ],
        [
          {
            itemType: 4,
            token: BAYC,
            identifierOrCriteria: "897651711111111111111111111111111111111111",
            startAmount: "1",
            endAmount: "1",
            recipient: EVM_SIGNER,
          },
        ],
      ),
    ),
  ),
  evm(
    "etd-cow-gpv2-order",
    "CoW Protocol GPv2 order",
    "https://github.com/cowprotocol/contracts (GPv2 Order type + 'Gnosis Protocol' v2 domain)",
    typed({
      types: {
        EIP712Domain: DOMAIN_FIELDS,
        Order: [
          { name: "sellToken", type: "address" },
          { name: "buyToken", type: "address" },
          { name: "receiver", type: "address" },
          { name: "sellAmount", type: "uint256" },
          { name: "buyAmount", type: "uint256" },
          { name: "validTo", type: "uint32" },
          { name: "appData", type: "bytes32" },
          { name: "feeAmount", type: "uint256" },
          { name: "kind", type: "string" },
          { name: "partiallyFillable", type: "bool" },
          { name: "sellTokenBalance", type: "string" },
          { name: "buyTokenBalance", type: "string" },
        ],
      },
      primaryType: "Order",
      domain: {
        name: "Gnosis Protocol",
        version: "v2",
        chainId: 1,
        verifyingContract: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
      },
      message: {
        sellToken: USDC,
        buyToken: WETH,
        receiver: EVM_SIGNER,
        sellAmount: "1000000",
        buyAmount: "1",
        validTo: 2_000_000_000,
        appData: `0x${"00".repeat(32)}`,
        feeAmount: "0",
        kind: "sell",
        partiallyFillable: false,
        sellTokenBalance: "erc20",
        buyTokenBalance: "erc20",
      },
    }),
  ),
  evm(
    "etd-1inch-lop-v4",
    "1inch Limit Order Protocol v4 Order",
    "https://github.com/1inch/limit-order-protocol (Order struct; '1inch Aggregation Router' v6 domain, 0x111111125421cA6dc452d289314280a0f8842A65)",
    typed({
      types: {
        EIP712Domain: DOMAIN_FIELDS,
        Order: [
          { name: "salt", type: "uint256" },
          { name: "maker", type: "address" },
          { name: "receiver", type: "address" },
          { name: "makerAsset", type: "address" },
          { name: "takerAsset", type: "address" },
          { name: "makingAmount", type: "uint256" },
          { name: "takingAmount", type: "uint256" },
          { name: "makerTraits", type: "uint256" },
        ],
      },
      primaryType: "Order",
      domain: {
        name: "1inch Aggregation Router",
        version: "6",
        chainId: 1,
        verifyingContract: LOP_V4,
      },
      message: {
        salt: "97281746358237869230001",
        maker: EVM_SIGNER,
        receiver: ZERO,
        makerAsset: USDC,
        takerAsset: WETH,
        makingAmount: "1000000",
        takingAmount: "400000000000000",
        makerTraits: "0",
      },
    }),
  ),
  evm(
    "etd-polymarket-ctf",
    "Polymarket CTF Exchange Order (Polygon)",
    "https://github.com/Polymarket/ctf-exchange/blob/main/src/exchange/libraries/OrderStructs.sol",
    typed(
      {
        types: {
          EIP712Domain: DOMAIN_FIELDS,
          Order: [
            { name: "salt", type: "uint256" },
            { name: "maker", type: "address" },
            { name: "signer", type: "address" },
            { name: "taker", type: "address" },
            { name: "tokenId", type: "uint256" },
            { name: "makerAmount", type: "uint256" },
            { name: "takerAmount", type: "uint256" },
            { name: "expiration", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "feeRateBps", type: "uint256" },
            { name: "side", type: "uint8" },
            { name: "signatureType", type: "uint8" },
          ],
        },
        primaryType: "Order",
        domain: {
          name: "Polymarket CTF Exchange",
          version: "1",
          chainId: 137,
          verifyingContract: CTF_EXCHANGE,
        },
        message: {
          salt: "987654321",
          maker: EVM_SIGNER,
          signer: EVM_SIGNER,
          taker: ZERO,
          tokenId: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
          makerAmount: "100000000",
          takerAmount: "50000000",
          expiration: "0",
          nonce: "0",
          feeRateBps: "0",
          side: 0,
          signatureType: 0,
        },
      },
      "eip155:137",
    ),
  ),
  evm(
    "etd-snapshot-vote",
    "Snapshot vote",
    "https://github.com/snapshot-labs/snapshot.js (Vote type, domain 'snapshot' 0.1.4)",
    typed({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
        ],
        Vote: [
          { name: "from", type: "address" },
          { name: "space", type: "string" },
          { name: "timestamp", type: "uint64" },
          { name: "proposal", type: "bytes32" },
          { name: "choice", type: "uint32" },
          { name: "reason", type: "string" },
          { name: "app", type: "string" },
          { name: "metadata", type: "string" },
        ],
      },
      primaryType: "Vote",
      domain: { name: "snapshot", version: "0.1.4" },
      message: {
        from: EVM_SIGNER,
        space: "ens.eth",
        timestamp: 1_700_000_000,
        proposal: `0x${"ab".repeat(32)}`,
        choice: 1,
        reason: "",
        app: "snapshot",
        metadata: "{}",
      },
    }),
  ),
  evm(
    "etd-compound-delegation",
    "Compound governance delegation (COMP)",
    "https://github.com/compound-finance/compound-protocol (Comp.sol: 'Compound' domain, Delegation type)",
    typed({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Delegation: [
          { name: "delegatee", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "expiry", type: "uint256" },
        ],
      },
      primaryType: "Delegation",
      domain: { name: "Compound", chainId: 1, verifyingContract: COMP },
      message: { delegatee: OTHER, nonce: "0", expiry: "1900000000" },
    }),
  ),
  evm(
    "etd-hyperliquid-approve-agent",
    "Hyperliquid ApproveAgent (API wallet approval, Arbitrum)",
    "https://github.com/nktkas/hyperliquid/blob/main/src/api/exchange/_methods/approveAgent.ts",
    typed(
      {
        types: {
          EIP712Domain: DOMAIN_FIELDS,
          "HyperliquidTransaction:ApproveAgent": [
            { name: "hyperliquidChain", type: "string" },
            { name: "agentAddress", type: "address" },
            { name: "agentName", type: "string" },
            { name: "nonce", type: "uint64" },
          ],
        },
        primaryType: "HyperliquidTransaction:ApproveAgent",
        domain: {
          name: "HyperliquidSignTransaction",
          version: "1",
          chainId: 42161,
          verifyingContract: ZERO,
        },
        message: {
          hyperliquidChain: "Mainnet",
          agentAddress: "0x1111111254fb6c44bAC0beD2854e76F90643097d",
          agentName: "r4-corpus-agent",
          nonce: 1_700_000_000_000,
        },
      },
      "eip155:42161",
    ),
  ),
  evm(
    "etd-hyperliquid-usd-send",
    "Hyperliquid UsdSend (transfer between users, Arbitrum)",
    "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint (UsdSend action types)",
    typed(
      {
        types: {
          EIP712Domain: DOMAIN_FIELDS,
          "HyperliquidTransaction:UsdSend": [
            { name: "hyperliquidChain", type: "string" },
            { name: "destination", type: "string" },
            { name: "amount", type: "string" },
            { name: "time", type: "uint64" },
          ],
        },
        primaryType: "HyperliquidTransaction:UsdSend",
        domain: {
          name: "HyperliquidSignTransaction",
          version: "1",
          chainId: 42161,
          verifyingContract: ZERO,
        },
        message: {
          hyperliquidChain: "Mainnet",
          destination: "0x1111111254fb6c44bAC0beD2854e76F90643097d",
          amount: "25.5",
          time: 1_700_000_000_000,
        },
      },
      "eip155:42161",
    ),
  ),
  evm(
    "etd-safe-eth-transfer",
    "Safe SafeTx — operation 0 plain ETH transfer, gasPrice 0",
    "https://github.com/safe-global/safe-contracts (SafeTx type)",
    typed(safeDoc({ to: OTHER, value: "1000000000000000000" })),
  ),
  evm(
    "etd-safe-usdc-transfer",
    "Safe SafeTx — operation 0 USDC transfer, gasPrice 0",
    "https://github.com/safe-global/safe-contracts (SafeTx type)",
    typed(safeDoc({ to: USDC, data: transferData })),
  ),
  evm(
    "etd-safe-multisend",
    "Safe SafeTx — operation 1 delegatecall to canonical MultiSendCallOnly v1.4.1 batching two transfers",
    "https://github.com/safe-global/safe-deployments (MultiSendCallOnly 1.4.1 0x9641d764fc13c8B624c04430C7356C1C7C8102e2)",
    typed(
      safeDoc({
        to: MULTISEND_141,
        operation: 1,
        data: multiSend(packEntry(OTHER, 7n, "0x") + packEntry(USDC, 0n, transferData)),
      }),
    ),
  ),

  /* ------------------------------------------------ EVM transactions */
  evm(
    "etx-weth-deposit",
    "WETH deposit() wrap 1 ETH",
    "https://etherscan.io/address/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2#code",
    tx(WETH, encodeFunctionData({ abi: parseAbi(["function deposit() payable"]) }), "0xde0b6b3a7640000"),
  ),
  evm(
    "etx-weth-withdraw",
    "WETH withdraw(uint256) unwrap",
    "https://etherscan.io/address/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2#code",
    tx(
      WETH,
      encodeFunctionData({
        abi: parseAbi(["function withdraw(uint256)"]),
        args: [1_000_000_000_000_000_000n],
      }),
    ),
  ),
  evm(
    "etx-aave-supply",
    "Aave v3 supply USDC",
    "https://github.com/aave/aave-v3-core (Pool.supply; pool 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2)",
    tx(
      AAVE_POOL,
      encodeFunctionData({
        abi: parseAbi(["function supply(address,uint256,address,uint16)"]),
        args: [USDC as `0x${string}`, 1_000_000n, EVM_SIGNER as `0x${string}`, 0],
      }),
    ),
  ),
  evm(
    "etx-aave-withdraw",
    "Aave v3 withdraw USDC",
    "https://github.com/aave/aave-v3-core (Pool.withdraw)",
    tx(
      AAVE_POOL,
      encodeFunctionData({
        abi: parseAbi(["function withdraw(address,uint256,address)"]),
        args: [USDC as `0x${string}`, 500_000n, EVM_SIGNER as `0x${string}`],
      }),
    ),
  ),
  evm(
    "etx-aave-borrow",
    "Aave v3 borrow USDC",
    "https://github.com/aave/aave-v3-core (Pool.borrow)",
    tx(
      AAVE_POOL,
      encodeFunctionData({
        abi: parseAbi(["function borrow(address,uint256,uint256,uint16,address)"]),
        args: [USDC as `0x${string}`, 250_000n, 2n, 0, EVM_SIGNER as `0x${string}`],
      }),
    ),
  ),
  evm(
    "etx-aave-repay",
    "Aave v3 repay USDC",
    "https://github.com/aave/aave-v3-core (Pool.repay)",
    tx(
      AAVE_POOL,
      encodeFunctionData({
        abi: parseAbi(["function repay(address,uint256,uint256,address)"]),
        args: [USDC as `0x${string}`, 250_000n, 2n, EVM_SIGNER as `0x${string}`],
      }),
    ),
  ),
  evm(
    "etx-comet-supply",
    "Compound v3 (Comet) supply USDC",
    "https://github.com/compound-finance/comet (Comet.supply; cUSDCv3 0xc3d688B66703497DAA19211EEdff47f25384cdc3)",
    tx(
      COMET_USDC,
      encodeFunctionData({
        abi: parseAbi(["function supply(address,uint256)"]),
        args: [USDC as `0x${string}`, 1_000_000n],
      }),
    ),
  ),
  evm(
    "etx-lido-submit",
    "Lido stETH submit (stake 1 ETH)",
    "https://github.com/lidofinance/lido-dao (stETH.submit; 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84)",
    tx(
      LIDO_STETH,
      encodeFunctionData({
        abi: parseAbi(["function submit(address referral) payable"]),
        args: [ZERO as `0x${string}`],
      }),
      "0xde0b6b3a7640000",
    ),
  ),
  evm(
    "etx-usdc-transfer",
    "USDC transfer",
    "https://eips.ethereum.org/EIPS/eip-20",
    tx(
      USDC,
      encodeFunctionData({
        abi: ERC20_TRANSFER,
        args: [OTHER as `0x${string}`, 1_000_000n],
      }),
    ),
  ),
  evm(
    "etx-usdc-approve",
    "USDC approve spender",
    "https://eips.ethereum.org/EIPS/eip-20",
    tx(
      USDC,
      encodeFunctionData({
        abi: parseAbi(["function approve(address,uint256)"]),
        args: [OTHER as `0x${string}`, 2_000_000n],
      }),
    ),
  ),
  evm(
    "etx-erc721-safe-transfer",
    "ERC-721 safeTransferFrom on BAYC",
    "https://eips.ethereum.org/EIPS/eip-721 (BAYC 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D)",
    tx(
      BAYC,
      encodeFunctionData({
        abi: parseAbi(["function safeTransferFrom(address,address,uint256)"]),
        args: [EVM_SIGNER as `0x${string}`, OTHER as `0x${string}`, 1234n],
      }),
    ),
  ),
  evm(
    "etx-erc721-approve",
    "ERC-721 approve on BAYC",
    "https://eips.ethereum.org/EIPS/eip-721",
    tx(
      BAYC,
      encodeFunctionData({
        abi: parseAbi(["function approve(address,uint256)"]),
        args: [SEAPORT16 as `0x${string}`, 1234n],
      }),
    ),
  ),
  evm(
    "etx-erc721-set-approval",
    "ERC-721 setApprovalForAll on BAYC (list on OpenSea)",
    "https://eips.ethereum.org/EIPS/eip-721",
    tx(
      BAYC,
      encodeFunctionData({
        abi: parseAbi(["function setApprovalForAll(address,bool)"]),
        args: ["0x1e0049783f008a0085193e00003d00cd54003c71", true],
      }),
    ),
  ),
  evm(
    "etx-erc1155-safe-transfer",
    "ERC-1155 safeTransferFrom (OpenSea shared storefront)",
    "https://eips.ethereum.org/EIPS/eip-1155 (0x495f947276749Ce646f68AC8c248420045cb7b5e)",
    tx(
      OS_STOREFRONT,
      encodeFunctionData({
        abi: parseAbi(["function safeTransferFrom(address,address,uint256,uint256,bytes)"]),
        args: [EVM_SIGNER as `0x${string}`, OTHER as `0x${string}`, 42n, 1n, "0x"],
      }),
    ),
  ),
  evm(
    "etx-universal-router",
    "Uniswap Universal Router execute",
    "https://github.com/Uniswap/universal-router (execute(bytes,bytes[],uint256); 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af)",
    tx(
      UNIVERSAL_ROUTER,
      encodeFunctionData({
        abi: parseAbi(["function execute(bytes,bytes[],uint256)"]),
        args: ["0x0b00", ["0x", "0x"], 2_000_000_000n],
      }),
      "0x2386f26fc10000",
    ),
  ),

  /* ------------------------------------------------ Solana */
  sol(
    "sol-transfer",
    "SOL transfer (signer = fee payer)",
    "https://github.com/solana-program/system (getTransferSolInstruction)",
    solReq(compile([getTransferSolInstruction({ source: feePayerSigner, destination: DEST, amount: 1_000_000n })])),
  ),
  sol(
    "sol-spl-transfer-checked",
    "SPL TransferChecked USDC",
    "https://github.com/solana-program/token (TransferChecked ix=12)",
    solReq(
      compile([
        getTransferCheckedInstruction({
          source: SRC_TOKEN as never,
          mint: USDC_MINT,
          destination: DST_TOKEN,
          authority: feePayerSigner,
          amount: 1_000_000n,
          decimals: 6,
        }),
      ]),
    ),
  ),
  sol(
    "sol-spl-ata-transfer-checked",
    "ATA CreateIdempotent + SPL TransferChecked (first-send to a new recipient)",
    "https://github.com/solana-program/associated-token-account (CreateIdempotent) + https://github.com/solana-program/token",
    solReq(
      compile([
        getCreateAssociatedTokenIdempotentInstruction({
          payer: feePayerSigner,
          ata: ATA,
          owner: DEST,
          mint: USDC_MINT,
        }),
        getTransferCheckedInstruction({
          source: SRC_TOKEN as never,
          mint: USDC_MINT,
          destination: ATA,
          authority: feePayerSigner,
          amount: 1_000_000n,
          decimals: 6,
        }),
      ]),
    ),
  ),
  sol(
    "sol-spl-transfer-unchecked",
    "SPL Token unchecked Transfer (ix 3, as @solana/spl-token createTransferInstruction emits)",
    "https://github.com/solana-program/token (getTransferInstruction → spl-token Transfer ix=3)",
    solReq(
      compile([
        getTransferInstruction({
          source: SRC_TOKEN as never,
          destination: DST_TOKEN,
          authority: feePayerSigner,
          amount: 1_000_000n,
        }),
      ]),
    ),
  ),
  sol(
    "sol-token2022-transfer-checked",
    "Token-2022 TransferChecked",
    "https://github.com/solana-program/token-2022 (getTransferCheckedInstruction)",
    solReq(
      compile([
        getTransferCheckedInstruction2022({
          source: SRC_TOKEN as never,
          mint: MINT,
          destination: DST_TOKEN,
          authority: feePayerSigner,
          amount: 50n,
          decimals: 6,
        }),
      ]),
    ),
  ),
  sol(
    "sol-compute-budget-transfer",
    "Priority-fee SOL transfer (SetComputeUnitLimit + SetComputeUnitPrice)",
    "https://github.com/solana-program/compute-budget (ix 2 limit, ix 3 price)",
    solReq(
      compile([
        getSetComputeUnitLimitInstruction({ units: 200_000 }),
        getSetComputeUnitPriceInstruction({ microLamports: 1000n }),
        getTransferSolInstruction({ source: feePayerSigner, destination: DEST, amount: 1_000_000n }),
      ]),
    ),
  ),
  sol(
    "sol-durable-nonce",
    "Durable-nonce transaction (AdvanceNonceAccount, then SOL transfer)",
    "https://github.com/solana-program/system (getAdvanceNonceAccountInstruction; durable nonce must be first)",
    solReq(
      compile([
        getAdvanceNonceAccountInstruction({
          nonceAccount: NONCE_ACCT,
          nonceAuthority: feePayerSigner,
        }),
        getTransferSolInstruction({ source: feePayerSigner, destination: DEST, amount: 1_000_000n }),
      ]),
    ),
  ),
  sol(
    "sol-memo-transfer",
    "Memo v2 instruction signed by the payer alongside a SOL transfer",
    "https://github.com/solana-program/memo (MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr)",
    solReq(
      compile([
        ix(MEMO_PROG, [sgn(SOL_SIGNER)], utf8("order ref: web-order-88231")),
        getTransferSolInstruction({ source: feePayerSigner, destination: DEST, amount: 1_000_000n }),
      ]),
    ),
  ),
  sol(
    "sol-jupiter-route",
    "Jupiter v6 route (real /build v0 message: wSOL ATA create + SyncNative + CloseAccount-to-self + route)",
    "repo vectors/chains/solana.json jupiter[0] 'route_v2-sol-usdc' (program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4)",
    solReq(hex(jupiterVector.message), jupiterVector.lookupTables),
    JUPITER_SIGNER,
  ),
  sol(
    "sol-stake-create-delegate",
    "Stake create + initialize + delegate",
    "https://github.com/solana-program/stake (create/Initialize/DelegateStake)",
    solReq(
      compile([
        getCreateAccountInstruction({
          payer: feePayerSigner,
          newAccount: createNoopSigner(STAKE_ACCT),
          lamports: 2_000_000_000n,
          space: 200n,
          programAddress: address("Stake11111111111111111111111111111111111111"),
        }),
        getInitializeInstruction({
          stake: STAKE_ACCT,
          arg0: { staker: FEE_PAYER, withdrawer: FEE_PAYER },
          arg1: {
            custodian: address("11111111111111111111111111111111"),
            epoch: 0n,
            unixTimestamp: 0n,
          },
        }),
        getDelegateStakeInstruction({
          stake: STAKE_ACCT,
          vote: VOTE_ACCT,
          stakeAuthority: feePayerSigner,
        }),
      ]),
    ),
  ),
  sol(
    "sol-stake-deactivate",
    "Stake deactivate",
    "https://github.com/solana-program/stake (Deactivate)",
    solReq(
      compile([getDeactivateInstruction({ stake: STAKE_ACCT, stakeAuthority: feePayerSigner })]),
    ),
  ),
  sol(
    "sol-stake-withdraw",
    "Stake withdraw to self",
    "https://github.com/solana-program/stake (Withdraw)",
    solReq(
      compile([
        getWithdrawInstruction({
          stake: STAKE_ACCT,
          recipient: FEE_PAYER,
          withdrawAuthority: feePayerSigner,
          args: 500_000_000n,
        }),
      ]),
    ),
  ),
  sol(
    "sol-stake-partial-unstake",
    "Partial unstake flow — Stake Split + Deactivate of the split account",
    "https://github.com/solana-program/stake (Split ix=3; wallets' partial-unstake flow)",
    solReq(
      compile([
        getSplitInstruction({
          stake: STAKE_ACCT,
          splitStake: createNoopSigner(SPLIT_STAKE),
          stakeAuthority: feePayerSigner,
          args: 1_000_000_000n,
        }),
        getDeactivateInstruction({
          stake: SPLIT_STAKE,
          stakeAuthority: feePayerSigner,
        }),
      ]),
    ),
  ),
  sol(
    "sol-nft-mint-candy-guard",
    "NFT mint via Candy Guard mintV2 (unknown program) with ATA create",
    "https://github.com/metaplex-foundation/mpl-candy-machine (Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g mint_v2)",
    solReq(
      compile([
        ix(
          CANDY_GUARD,
          [
            w0(address("9Y34Wev18pdowy32Akobj4JpWWko4JhzhvoyzJNrX94v")),
            w0(address(CANDY_MACHINE)),
            w0(MINT),
            wsgn(SOL_SIGNER),
            ro(address("11111111111111111111111111111111")),
            ro(address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")),
          ],
          Uint8Array.from([0x78, 0x79, 0x17, 0x92, 0xad, 0x6e, 0xc7, 0xcd, 0x00]),
        ),
        getCreateAssociatedTokenIdempotentInstruction({
          payer: feePayerSigner,
          ata: ATA,
          owner: FEE_PAYER,
          mint: MINT,
        }),
      ]),
    ),
  ),
  sol(
    "sol-spl-burn-checked",
    "SPL BurnChecked of one NFT (wallet 'burn' feature)",
    "https://github.com/solana-program/token (getBurnCheckedInstruction → BurnChecked ix=15)",
    solReq(
      compile([
        getBurnCheckedInstruction({
          account: SRC_TOKEN as never,
          mint: MINT,
          authority: feePayerSigner,
          amount: 1n,
          decimals: 0,
        }),
      ]),
    ),
  ),
  sol(
    "sol-lookup-table",
    "v0 message using an address lookup table for non-signer accounts",
    "https://solana.com/developers/guides/advanced/lookup-tables (versioned tx + ALT)",
    solReq(compile(
      [getTransferSolInstruction({ source: feePayerSigner, destination: DEST, amount: 1_000_000n })],
      0,
      { [LOOKUP_TABLE]: [DEST] },
    ), [{ address: LOOKUP_TABLE, addresses: [DEST] }]),
  ),
];

/* ------------------------------------------------------------------ run + record */

type CorpusResult = {
  id: string;
  name: string;
  source: string;
  blind: string | null;
  verifiability: string;
  summary: string;
};

const decodeEntry = (entry: CorpusEntry) =>
  entry.request.kind === "solana.transaction"
    ? decodeSolana(entry.request, entry.signer)
    : decodeEvm(entry.request, entry.signer);

/** Classifies one corpus entry; a decoder throw is recorded as `error:<code>`, not a crash. */
const runEntry = (entry: CorpusEntry): CorpusResult => {
  const base = { id: entry.id, name: entry.name, source: entry.source };
  try {
    const { blind, verifiability, summary } = decodeEntry(entry);
    return { ...base, blind: blind ?? null, verifiability, summary };
  } catch (error) {
    return {
      ...base,
      blind: `error:${error instanceof ChainError ? error.code : "unknown"}`,
      verifiability: "error",
      summary: error instanceof Error ? error.message.slice(0, 120) : String(error),
    };
  }
};

const results: CorpusResult[] = [];

describe("r4 usability corpus: everyday requests are described, not blind", () => {
  afterAll(() => {
    const dir = "/Users/xu/Desktop/qntx/wallet-audit/r4/review-classify";
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "corpus.json"),
      `${JSON.stringify(results, null, 2)}\n`,
      "utf8",
    );
  });

  it.each(corpus)("$id $name", (entry) => {
    const result = runEntry(entry);
    results.push(result);
    expect(result.blind).toBeNull();
  });
});
