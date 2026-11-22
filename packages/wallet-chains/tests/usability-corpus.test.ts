/**
 * Usability corpus: real-world signing-request shapes across EVM typed data and Solana and TRON
 * mainnet transactions, each pinned to the classifier's outcome. `blind` undefined is recorded as
 * "described". Setting CORPUS_EVIDENCE_OUT to a file path makes the run also write the observed
 * outcomes there as JSON.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { base64 } from "@scure/base";
import { encodeAbiParameters, encodeFunctionData, hashMessage, parseAbi } from "viem";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/index.ts";
import { ChainError } from "../src/index.ts";
import type { SignRequest } from "../src/index.ts";
import { decodeSolana } from "../src/solana/index.ts";
import { decodeTron, tronAddressFromHex } from "../src/tron/index.ts";

const EVM_SIGNER = "0x2222222222222222222222222222222222222222";
const EVM_ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;
const SOL_ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "solana" } as const;
const TRON_ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "tron.bip44" } as const;
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TRON_MAINNET = "tron:728126428";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const UNIVERSAL_ROUTER = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af";
const SEAPORT16 = "0x0000000000000068F116a894984e2DB1123eB395";
const BAYC = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";
const LOP_V4 = "0x111111125421cA6dc452d289314280a0f8842A65";
const OPENSEA_FEE = "0x0000a26b00c1F0DF003000390027140000fAa719";
const OTHER = "0x00000000000000000000000000000000c0ffee00";
const ZERO = "0x0000000000000000000000000000000000000000";
const SAFE = "0xD5Ffe748b45F5253Fc9975fDd96FDdeC052e6D52";
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

const ENS_TOKEN = "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72";
const UNI_TOKEN = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
const AAVE_VARDEBT_USDC = "0x72E95b8931767C79bA4EeE721354d6E99a61D004";
const AAVE_A_USDC = "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c";
const LENS_HUB = "0xDb46d1Dc155634FbC732f92E853b10B288AD5a1d";
const KEY_GATEWAY = "0x00000000fC56947c7E7183f8CA4B62398CaADf0B";
const ID_GATEWAY = "0x00000000fC25870C6eD6b6c7E41FB078b7656f69";
const FNAME_VERIFIER = "0xe3BE01D99bAa8dB9905b33a3cA391238234B79D1";
const BLUR_EXCHANGE = "0x000000000000Ad05Ccc4F10045630fb830B95127";
const BLUR_POLICY = "0x00000000006411739DA1c40B106F8511de5D1FAC";
const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const NFPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734";
const COW_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";

const USDC_INK = "0x2D270e6886d130D724215A266106e6832161EAEd";
const USDC_UNICHAIN = "0x078D782b760474a361dDA0AF3839290b0EF57AD6";
const USDC_WORLD = "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1";
const USDC_CELO = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH_ARBITRUM = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const WETH_BASE = "0x4200000000000000000000000000000000000006";

const UNISWAPX_V3_REACTOR_ARB = "0xb274d5f4b833b61b340b654d600a864fb604a87c";
const UNISWAPX_PRIORITY_REACTOR_BASE = "0x000000001ec5656dcdb24d90dfa42742738de729";

const typed = (doc: unknown, network = "eip155:1"): SignRequest => ({
  kind: "evm.typed-data",
  network,
  account: EVM_ACCOUNT,
  typedData: JSON.stringify(doc),
});

const solReq = (
  message: Uint8Array,
  lookupTables?: ReadonlyArray<{ address: string; addresses: ReadonlyArray<string> }>,
): SignRequest => ({
  kind: "solana.transaction",
  network: SOLANA_MAINNET,
  account: SOL_ACCOUNT,
  message,
  ...(lookupTables === undefined ? {} : { lookupTables }),
});

const tronReq = (rawDataHex: string): SignRequest => ({
  kind: "tron.transaction",
  network: TRON_MAINNET,
  account: TRON_ACCOUNT,
  rawData: Uint8Array.from(Buffer.from(rawDataHex, "hex")),
});

const DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];
const COMPACT_DOMAIN = [
  { name: "name", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

const PERMIT_FIELDS = [
  { name: "owner", type: "address" },
  { name: "spender", type: "address" },
  { name: "value", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
];
const eip2612 = (name: string, chainId: number, token: string, spender: string, value: string) => ({
  types: { EIP712Domain: DOMAIN_FIELDS, Permit: PERMIT_FIELDS },
  primaryType: "Permit",
  domain: { name, version: "2", chainId, verifyingContract: token },
  message: {
    owner: EVM_SIGNER,
    spender,
    value,
    nonce: 0,
    deadline: 1_900_000_000,
  },
});

const PERMIT2_DOMAIN_TYPES = [
  { name: "name", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];
const permit2Domain = (chainId: number) => ({
  name: "Permit2",
  chainId,
  verifyingContract: PERMIT2,
});
const TOKEN_PERMISSIONS = [
  { name: "token", type: "address" },
  { name: "amount", type: "uint256" },
];
const PERMIT_DETAILS = [
  { name: "token", type: "address" },
  { name: "amount", type: "uint160" },
  { name: "expiration", type: "uint48" },
  { name: "nonce", type: "uint48" },
];
const ORDER_INFO = [
  { name: "reactor", type: "address" },
  { name: "swapper", type: "address" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
  { name: "additionalValidationContract", type: "address" },
  { name: "additionalValidationData", type: "bytes" },
];
const NONLINEAR_DECAY = [
  { name: "relativeBlocks", type: "uint256" },
  { name: "relativeAmounts", type: "int256[]" },
];

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

const transferData = encodeFunctionData({
  abi: parseAbi(["function transfer(address,uint256)"]),
  args: [OTHER as `0x${string}`, 1_000_000n],
});

const polymarketVector = (
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/polymarket.json"), "utf8"),
  ) as {
    cases: Array<{ name: string; network: string; typedData: Record<string, unknown> }>;
  }
).cases.find((c) => c.name === "CTF Exchange buy (EOA)")!;

const solanaFixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "fixtures/usability-corpus/solana-mainnet-fresh.json"),
    "utf8",
  ),
) as Array<{
  label: string;
  signature: string;
  slot: number;
  signer: string;
  message: string;
  lookupTables?: Array<{ address: string; addresses: string[] }>;
  skippedV1?: number;
}>;
const solEntry = (label: string) => {
  const entry = solanaFixture.find((e) => e.label === label);
  if (entry === undefined) {
    throw new Error(`fixture: no ${label}`);
  }
  return entry;
};

const tronFixture = (
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "fixtures/usability-corpus/tron-mainnet-fresh.json"),
      "utf8",
    ),
  ) as {
    transactions: Array<{ bucket: string; txid: string; rawDataHex: string; ownerHex: string }>;
  }
).transactions;
const tronEntry = (bucket: string) => {
  const entry = tronFixture.find((e) => e.bucket === bucket);
  if (entry === undefined) {
    throw new Error(`fixture: no ${bucket}`);
  }
  return entry;
};

const zeroxGasless = (
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../vectors/chains/evm-zerox-gasless.json"),
      "utf8",
    ),
  ) as {
    real: { data: Record<string, unknown>; signer: string };
  }
).real;

const farcasterMetadata = encodeAbiParameters(
  [
    {
      type: "tuple",
      components: [
        { name: "requestFid", type: "uint256" },
        { name: "requestSigner", type: "address" },
        { name: "signature", type: "bytes" },
        { name: "deadline", type: "uint256" },
      ],
    },
  ],
  [
    {
      requestFid: 440n,
      requestSigner: EVM_SIGNER,
      signature: `0x${"ab".repeat(65)}`,
      deadline: 1_900_000_000n,
    },
  ],
);

const siweText = `example.com wants you to sign in with your Ethereum account:
${EVM_SIGNER}

URI: https://example.com/login
Version: 1
Chain ID: 1
Nonce: 32891756
Issued At: 2021-09-30T16:25:24Z`;

type Observed = {
  blind: string;
  verifiability: string;
  summary: string;
};

type Row = {
  id: string;
  family: "evm" | "solana" | "tron";
  source: string;
  signer?: string;
  request: SignRequest;
};

const evm = (id: string, source: string, request: SignRequest, signer = EVM_SIGNER): Row => ({
  id,
  family: "evm",
  source,
  signer,
  request,
});
const sol = (label: string, source: string): Row => ({
  id: `sol-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`,
  family: "solana",
  source,
  signer: solEntry(label).signer,
  request: solReq(base64.decode(solEntry(label).message), solEntry(label).lookupTables),
});
const tron = (id: string, bucket: string, source: string): Row => ({
  id,
  family: "tron",
  source,
  signer: tronAddressFromHex(tronEntry(bucket).ownerHex),
  request: tronReq(tronEntry(bucket).rawDataHex),
});

const corpus: ReadonlyArray<Row> = [
  evm(
    "ens-delegation",
    "refs/erc7730-registry/registry/tally/eip712-tally-ethereum-ens-token.json (Delegation type + 'Ethereum Name Service' domain)",
    typed({
      types: {
        EIP712Domain: DOMAIN_FIELDS,
        Delegation: [
          { name: "delegatee", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "expiry", type: "uint256" },
        ],
      },
      primaryType: "Delegation",
      domain: {
        name: "Ethereum Name Service",
        version: "1",
        chainId: 1,
        verifyingContract: ENS_TOKEN,
      },
      message: { delegatee: OTHER, nonce: "0", expiry: "1900000000" },
    }),
  ),
  evm(
    "uni-delegation",
    "refs/erc7730-registry/registry/tally/eip712-tally-ethereum-uni-token.json (Delegation type + 'Uniswap' domain, no version field)",
    typed({
      types: {
        EIP712Domain: COMPACT_DOMAIN,
        Delegation: [
          { name: "delegatee", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "expiry", type: "uint256" },
        ],
      },
      primaryType: "Delegation",
      domain: { name: "Uniswap", chainId: 1, verifyingContract: UNI_TOKEN },
      message: { delegatee: OTHER, nonce: "0", expiry: "1900000000" },
    }),
  ),
  evm(
    "aave-credit-delegation",
    "aave/aave-v3-core DebtTokenBase.sol: DelegationWithSig typehash, EIP712_REVISION '1'; 0x72E95b8931767C79bA4EeE721354d6E99a61D004 (variableDebtEthUSDC)",
    typed({
      types: {
        EIP712Domain: DOMAIN_FIELDS,
        DelegationWithSig: [
          { name: "delegatee", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "DelegationWithSig",
      domain: {
        name: "Aave Ethereum Variable Debt USDC",
        version: "1",
        chainId: 1,
        verifyingContract: AAVE_VARDEBT_USDC,
      },
      message: {
        delegatee: OTHER,
        value: "1000000",
        nonce: "0",
        deadline: "1900000000",
      },
    }),
  ),
  evm(
    "aave-atoken-permit",
    "aave/aave-v3-core AToken.sol: EIP-2612 Permit, EIP712_REVISION '1'; 0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c (aEthUSDC)",
    typed({
      types: { EIP712Domain: DOMAIN_FIELDS, Permit: PERMIT_FIELDS },
      primaryType: "Permit",
      domain: {
        name: "Aave Ethereum USDC",
        version: "1",
        chainId: 1,
        verifyingContract: AAVE_A_USDC,
      },
      message: {
        owner: EVM_SIGNER,
        spender: AAVE_POOL,
        value: "25000000",
        nonce: 0,
        deadline: 1_900_000_000,
      },
    }),
  ),
  evm(
    "lens-post",
    "refs/erc7730-registry/registry/lens/eip712-lens-lenshub.json:120 (Post type); LensHub 0xDb46d1Dc155634FbC732f92E853b10B288AD5a1d Polygon",
    typed(
      {
        types: {
          EIP712Domain: DOMAIN_FIELDS,
          Post: [
            { name: "profileId", type: "uint256" },
            { name: "contentURI", type: "string" },
            { name: "actionModules", type: "address[]" },
            { name: "actionModulesInitDatas", type: "bytes[]" },
            { name: "referenceModule", type: "address" },
            { name: "referenceModuleInitData", type: "bytes" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Post",
        domain: {
          name: "Lens Protocol Profiles",
          version: "2",
          chainId: 137,
          verifyingContract: LENS_HUB,
        },
        message: {
          profileId: 42817,
          contentURI: "ipfs://bafybeid5n5x7m2z4j4q4s5j2xjv4f4m/metadata.json",
          actionModules: ["0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"],
          actionModulesInitDatas: [
            "0x0000000000000000000000002791bca1f2de4661ed88a30c99a7a9449aa8417400000000000000000000000000000000000000000000000000000000000f4240",
          ],
          referenceModule: ZERO,
          referenceModuleInitData: "0x",
          nonce: 12,
          deadline: 1_776_681_600,
        },
      },
      "eip155:137",
    ),
  ),
  evm(
    "lens-follow",
    "refs/erc7730-registry/registry/lens/tests/eip712-lens-lenshub.tests.json (Follow typed data vector)",
    typed(
      {
        types: {
          EIP712Domain: DOMAIN_FIELDS,
          Follow: [
            { name: "followerProfileId", type: "uint256" },
            { name: "idsOfProfilesToFollow", type: "uint256[]" },
            { name: "followTokenIds", type: "uint256[]" },
            { name: "datas", type: "bytes[]" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Follow",
        domain: {
          name: "Lens Protocol Profiles",
          version: "2",
          chainId: 137,
          verifyingContract: LENS_HUB,
        },
        message: {
          followerProfileId: "84521",
          idsOfProfilesToFollow: ["12", "1043"],
          followTokenIds: ["0", "0"],
          datas: ["0x", "0x"],
          nonce: "27",
          deadline: "1777680000",
        },
      },
      "eip155:137",
    ),
  ),
  evm(
    "farcaster-key-add",
    "ethereum-optimism/optimism farcaster KeyGateway.sol (or farcasterxyz/contracts): Add type; KeyGateway 0x00000000fC56947c7E7183f8CA4B62398CaADf0B Optimism",
    typed(
      {
        types: {
          EIP712Domain: DOMAIN_FIELDS,
          Add: [
            { name: "owner", type: "address" },
            { name: "keyType", type: "uint32" },
            { name: "key", type: "bytes" },
            { name: "metadataType", type: "uint8" },
            { name: "metadata", type: "bytes" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Add",
        domain: {
          name: "Farcaster KeyGateway",
          version: "1",
          chainId: 10,
          verifyingContract: KEY_GATEWAY,
        },
        message: {
          owner: EVM_SIGNER,
          keyType: 1,
          key: `0x${"11".repeat(32)}`,
          metadataType: 1,
          metadata: farcasterMetadata,
          nonce: "0",
          deadline: "1900000000",
        },
      },
      "eip155:10",
    ),
  ),
  evm(
    "farcaster-id-register",
    "farcasterxyz/contracts IdGateway.sol: Register type; IdGateway 0x00000000fC25870C6eD6b6c7E41FB078b7656f69 Optimism",
    typed(
      {
        types: {
          EIP712Domain: DOMAIN_FIELDS,
          Register: [
            { name: "to", type: "address" },
            { name: "recovery", type: "address" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Register",
        domain: {
          name: "Farcaster IdGateway",
          version: "1",
          chainId: 10,
          verifyingContract: ID_GATEWAY,
        },
        message: { to: EVM_SIGNER, recovery: OTHER, nonce: "0", deadline: "1900000000" },
      },
      "eip155:10",
    ),
  ),
  evm(
    "farcaster-username-proof",
    "farcasterxyz/fname-registry UserNameProofVerifier: UserNameProof type; 0xe3be01d99baa8db9905b33a3ca391238234b79d1 mainnet",
    typed({
      types: {
        EIP712Domain: DOMAIN_FIELDS,
        UserNameProof: [
          { name: "name", type: "string" },
          { name: "timestamp", type: "uint256" },
          { name: "owner", type: "address" },
        ],
      },
      primaryType: "UserNameProof",
      domain: {
        name: "Farcaster name verification",
        version: "1",
        chainId: 1,
        verifyingContract: FNAME_VERIFIER,
      },
      message: { name: "somebody.eth", timestamp: "1700000000", owner: EVM_SIGNER },
    }),
  ),
  evm(
    "seaport-nft-listing",
    "ProjectOpenSea/seaport ConsiderationStructs.sol (OrderComponents); Seaport 1.6 0x0000000000000068F116a894984e2DB1123eB395",
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
            itemType: 1,
            token: WETH,
            identifierOrCriteria: "0",
            startAmount: "14250000000000000000",
            endAmount: "14250000000000000000",
            recipient: EVM_SIGNER,
          },
          {
            itemType: 1,
            token: WETH,
            identifierOrCriteria: "0",
            startAmount: "375000000000000000",
            endAmount: "375000000000000000",
            recipient: OPENSEA_FEE,
          },
          {
            itemType: 1,
            token: WETH,
            identifierOrCriteria: "0",
            startAmount: "375000000000000000",
            endAmount: "375000000000000000",
            recipient: OTHER,
          },
        ],
      ),
    ),
  ),
  evm(
    "seaport-collection-offer",
    "ProjectOpenSea/seaport: ERC721_WITH_CRITERIA itemType 4, criteria root 0 = any token in the collection",
    typed(
      seaportDoc(
        [
          {
            itemType: 1,
            token: WETH,
            identifierOrCriteria: "0",
            startAmount: "1500000000000000000",
            endAmount: "1500000000000000000",
          },
        ],
        [
          {
            itemType: 4,
            token: BAYC,
            identifierOrCriteria: "0",
            startAmount: "1",
            endAmount: "1",
            recipient: EVM_SIGNER,
          },
        ],
      ),
    ),
  ),
  evm(
    "blur-bid",
    "blur-io/blur OrderStructs.sol + EIP712.sol (Order/Fee types, 'Blur Exchange' 1.0); 0x000000000000Ad05Ccc4F10045630fb830B95127; StandardPolicyERC721 0x00000000006411739DA1c40B106F8511de5D1FAC",
    typed({
      types: {
        EIP712Domain: DOMAIN_FIELDS,
        Fee: [
          { name: "rate", type: "uint16" },
          { name: "recipient", type: "address" },
        ],
        Order: [
          { name: "trader", type: "address" },
          { name: "side", type: "uint8" },
          { name: "matchingPolicy", type: "address" },
          { name: "collection", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "amount", type: "uint256" },
          { name: "paymentToken", type: "address" },
          { name: "price", type: "uint256" },
          { name: "listingTime", type: "uint256" },
          { name: "expirationTime", type: "uint256" },
          { name: "fees", type: "Fee[]" },
          { name: "salt", type: "uint256" },
          { name: "extraParams", type: "bytes" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "Order",
      domain: {
        name: "Blur Exchange",
        version: "1.0",
        chainId: 1,
        verifyingContract: BLUR_EXCHANGE,
      },
      message: {
        trader: EVM_SIGNER,
        side: 0,
        matchingPolicy: BLUR_POLICY,
        collection: BAYC,
        tokenId: "1234",
        amount: "1",
        paymentToken: WETH,
        price: "1500000000000000000",
        listingTime: "1700000000",
        expirationTime: "1700864000",
        fees: [{ rate: 100, recipient: OTHER }],
        salt: "42",
        extraParams: "0x",
        nonce: "0",
      },
    }),
  ),
  evm(
    "snapshot-vote",
    "refs/snapshot.js/src/sign/types.ts voteTypes (domain 'snapshot' 0.1.4)",
    typed({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
        ],
        Vote: [
          { name: "from", type: "string" },
          { name: "space", type: "string" },
          { name: "timestamp", type: "uint64" },
          { name: "proposal", type: "string" },
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
    "snapshot-proposal",
    "refs/snapshot.js/src/sign/types.ts proposalTypes",
    typed({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
        ],
        Proposal: [
          { name: "from", type: "string" },
          { name: "space", type: "string" },
          { name: "timestamp", type: "uint64" },
          { name: "type", type: "string" },
          { name: "title", type: "string" },
          { name: "body", type: "string" },
          { name: "discussion", type: "string" },
          { name: "choices", type: "string[]" },
          { name: "labels", type: "string[]" },
          { name: "start", type: "uint64" },
          { name: "end", type: "uint64" },
          { name: "snapshot", type: "uint64" },
          { name: "plugins", type: "string" },
          { name: "privacy", type: "string" },
          { name: "app", type: "string" },
        ],
      },
      primaryType: "Proposal",
      domain: { name: "snapshot", version: "0.1.4" },
      message: {
        from: EVM_SIGNER,
        space: "ens.eth",
        timestamp: 1_700_000_000,
        type: "single-choice",
        title: "Select the next working group steward",
        body: "This proposal elects the steward for the coming term.",
        discussion: "",
        choices: ["alice.eth", "bob.eth"],
        labels: [],
        start: 1_700_000_000,
        end: 1_700_100_000,
        snapshot: 19_500_000,
        plugins: "{}",
        privacy: "",
        app: "snapshot",
      },
    }),
  ),
  evm(
    "snapshot-follow",
    "refs/snapshot.js/src/sign/types.ts followTypes",
    typed({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
        ],
        Follow: [
          { name: "from", type: "address" },
          { name: "network", type: "string" },
          { name: "space", type: "string" },
          { name: "timestamp", type: "uint64" },
        ],
      },
      primaryType: "Follow",
      domain: { name: "snapshot", version: "0.1.4" },
      message: {
        from: EVM_SIGNER,
        network: "1",
        space: "ens.eth",
        timestamp: 1_700_000_000,
      },
    }),
  ),
  evm(
    "permit2-single-mainnet",
    "Uniswap/permit2 PermitSingle/PermitDetails typehashes; spender Universal Router mainnet",
    typed({
      types: {
        EIP712Domain: PERMIT2_DOMAIN_TYPES,
        PermitDetails: PERMIT_DETAILS,
        PermitSingle: [
          { name: "details", type: "PermitDetails" },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
      },
      primaryType: "PermitSingle",
      domain: permit2Domain(1),
      message: {
        details: {
          token: USDC,
          amount: "1461501637330902918203684832716283019655932542975",
          expiration: 1_900_000_000,
          nonce: 0,
        },
        spender: UNIVERSAL_ROUTER,
        sigDeadline: 1_900_000_000,
      },
    }),
  ),
  evm(
    "permit2-single-base",
    "Uniswap/permit2 PermitSingle on Base 8453 (Permit2 is CREATE2-uniform)",
    typed(
      {
        types: {
          EIP712Domain: PERMIT2_DOMAIN_TYPES,
          PermitDetails: PERMIT_DETAILS,
          PermitSingle: [
            { name: "details", type: "PermitDetails" },
            { name: "spender", type: "address" },
            { name: "sigDeadline", type: "uint256" },
          ],
        },
        primaryType: "PermitSingle",
        domain: permit2Domain(8453),
        message: {
          details: {
            token: USDC_BASE,
            amount: "1461501637330902918203684832716283019655932542975",
            expiration: 1_900_000_000,
            nonce: 0,
          },
          spender: UNIVERSAL_ROUTER,
          sigDeadline: 1_900_000_000,
        },
      },
      "eip155:8453",
    ),
  ),
  evm(
    "permit2-batch",
    "Uniswap/permit2 PermitBatch typehash (two tokens)",
    typed({
      types: {
        EIP712Domain: PERMIT2_DOMAIN_TYPES,
        PermitDetails: PERMIT_DETAILS,
        PermitBatch: [
          { name: "details", type: "PermitDetails[]" },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
      },
      primaryType: "PermitBatch",
      domain: permit2Domain(1),
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
    "safe-safetx-usdc",
    "safe-global/safe-contracts SafeTx type (operation 0 USDC transfer, gasPrice 0)",
    typed(safeDoc({ to: USDC, data: transferData })),
  ),
  evm(
    "safe-message",
    "safe-global/safe-contracts SignMessageLib: SafeMessage(bytes message) signing a SIWE message hash",
    typed({
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        SafeMessage: [{ name: "message", type: "bytes" }],
      },
      primaryType: "SafeMessage",
      domain: { chainId: 1, verifyingContract: SAFE },
      message: { message: hashMessage(siweText) },
    }),
  ),
  evm(
    "usdc-permit-ink",
    "Circle USDC 0x2D270e6886d130D724215A266106e6832161EAEd Ink 57073; name()/version() 'USDC'/'2' verified by RPC",
    typed(eip2612("USDC", 57073, USDC_INK, PERMIT2, "2500000"), "eip155:57073"),
  ),
  evm(
    "usdc-permit-unichain",
    "Circle USDC 0x078D782b760474a361dDA0AF3839290b0EF57AD6 Unichain 130; 'USDC'/'2' verified by RPC",
    typed(eip2612("USDC", 130, USDC_UNICHAIN, PERMIT2, "2500000"), "eip155:130"),
  ),
  evm(
    "usdc-permit-worldchain",
    "Circle USDC 0x79A02482A880bCE3F13e09Da970dC34db4CD24d1 World Chain 480; 'USDC'/'2' verified by RPC",
    typed(eip2612("USDC", 480, USDC_WORLD, PERMIT2, "2500000"), "eip155:480"),
  ),
  evm(
    "usdc-permit-celo",
    "Circle USDC 0xcebA9300f2b948710d2653dD7B07f33A8B32118C Celo 42220; 'USDC'/'2' verified by RPC",
    typed(eip2612("USDC", 42220, USDC_CELO, PERMIT2, "2500000"), "eip155:42220"),
  ),
  evm(
    "usdc-permit-arbitrum",
    "Circle USDC 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 Arbitrum 42161; 'USD Coin'/'2' verified by RPC",
    typed(eip2612("USD Coin", 42161, USDC_ARBITRUM, PERMIT2, "2500000"), "eip155:42161"),
  ),
  evm(
    "usdc-permit-base",
    "Circle USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 Base 8453; 'USD Coin'/'2' verified by RPC",
    typed(eip2612("USD Coin", 8453, USDC_BASE, PERMIT2, "2500000"), "eip155:8453"),
  ),
  evm(
    "dai-permit",
    "makerdao/dss dai.sol Permit(holder,spender,nonce,expiry,allowed), 'Dai Stablecoin' '1'",
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
    "usdc-eip3009-base",
    "EIP-3009 TransferWithAuthorization (circlefin/stablecoin-evm FiatTokenV2_2); x402-style payment on Base",
    typed(
      {
        types: {
          EIP712Domain: DOMAIN_FIELDS,
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
        domain: {
          name: "USD Coin",
          version: "2",
          chainId: 8453,
          verifyingContract: USDC_BASE,
        },
        message: {
          from: EVM_SIGNER,
          to: OTHER,
          value: "2500000",
          validAfter: "0",
          validBefore: "1900000000",
          nonce: `0x${"ab".repeat(32)}`,
        },
      },
      "eip155:8453",
    ),
  ),
  {
    ...evm(
      "polymarket-ctf",
      "vectors/chains/polymarket.json — CTF Exchange buy (EOA) (clob-client-v2 order shape)",
      typed(polymarketVector.typedData, polymarketVector.network),
    ),
    signer:
      typeof polymarketVector.typedData["message"] === "object" &&
      polymarketVector.typedData["message"] !== null
        ? String((polymarketVector.typedData["message"] as Record<string, unknown>)["signer"])
        : EVM_SIGNER,
  },
  evm(
    "hl-approve-builder-fee",
    "refs/hyperliquid + vectors/chains/hyperliquid.json 'approveBuilderFee' (HyperliquidTransaction domain, Arbitrum signing chain)",
    typed(
      {
        types: {
          EIP712Domain: DOMAIN_FIELDS,
          "HyperliquidTransaction:ApproveBuilderFee": [
            { name: "hyperliquidChain", type: "string" },
            { name: "maxFeeRate", type: "string" },
            { name: "builder", type: "address" },
            { name: "nonce", type: "uint64" },
          ],
        },
        primaryType: "HyperliquidTransaction:ApproveBuilderFee",
        domain: {
          name: "HyperliquidSignTransaction",
          version: "1",
          chainId: 42161,
          verifyingContract: ZERO,
        },
        message: {
          hyperliquidChain: "Mainnet",
          maxFeeRate: "0.1%",
          builder: OTHER,
          nonce: 1_700_000_001_500,
        },
      },
      "eip155:42161",
    ),
  ),
  evm(
    "hl-usd-send",
    "refs/hyperliquid + vectors/chains/hyperliquid.json 'usdSend' (lowercase destination, canonical SDK form)",
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
          destination: OTHER.toLowerCase(),
          amount: "25.5",
          time: 1_700_000_000_000,
        },
      },
      "eip155:42161",
    ),
  ),
  evm(
    "oneinch-fusion",
    "refs/1inch-lop-4.0.0 OrderLib.sol Order fields; Fusion sets HAS_EXTENSION(249)+POST_INTERACTION(251)+ALLOW_MULTIPLE_FILLS(254), salt low-160 = extension hash",
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
        salt: `0x${"ab".repeat(12)}${"cd".repeat(20)}`,
        maker: EVM_SIGNER,
        receiver: ZERO,
        makerAsset: USDC,
        takerAsset: WETH,
        makingAmount: "1000000",
        takingAmount: "400000000000000",
        /* (1900000000 << 80) | 1<<254 | 1<<251 | 1<<249 — expiry + ALLOW_MULTIPLE_FILLS +
           POST_INTERACTION_CALL + HAS_EXTENSION */
        makerTraits:
          "33471150795161712739625987854073848363835857239370782810451139819021789036544",
      },
    }),
  ),
  evm(
    "oneinch-plain",
    "refs/1inch-lop-4.0.0 OrderLib.sol: a plain limit order (makerTraits 0)",
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
        salt: "123456789",
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
    "cow-base",
    "cowprotocol/contracts GPv2 Order type + 'Gnosis Protocol' v2 domain; GPv2Settlement 0x9008D19f58AAbD9eD0D60971565AA8510560ab41 on Base",
    typed(
      {
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
          chainId: 8453,
          verifyingContract: COW_SETTLEMENT,
        },
        message: {
          sellToken: USDC_BASE,
          buyToken: WETH_BASE,
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
      },
      "eip155:8453",
    ),
  ),
  evm(
    "uniswapx-v3dutch-arbitrum",
    "UniswapX V3DutchOrderLib.sol PERMIT2_ORDER_TYPE; Arbitrum V3 reactor 0xb274d5f4b833b61b340b654d600a864fb604a87c (src/evm/uniswapx.ts REACTORS)",
    typed(
      {
        types: {
          EIP712Domain: PERMIT2_DOMAIN_TYPES,
          TokenPermissions: TOKEN_PERMISSIONS,
          PermitWitnessTransferFrom: [
            { name: "permitted", type: "TokenPermissions" },
            { name: "spender", type: "address" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "witness", type: "V3DutchOrder" },
          ],
          OrderInfo: ORDER_INFO,
          V3DutchOrder: [
            { name: "info", type: "OrderInfo" },
            { name: "cosigner", type: "address" },
            { name: "startingBaseFee", type: "uint256" },
            { name: "baseInput", type: "V3DutchInput" },
            { name: "baseOutputs", type: "V3DutchOutput[]" },
          ],
          V3DutchInput: [
            { name: "token", type: "address" },
            { name: "startAmount", type: "uint256" },
            { name: "curve", type: "NonlinearDutchDecay" },
            { name: "maxAmount", type: "uint256" },
            { name: "adjustmentPerGweiBaseFee", type: "uint256" },
          ],
          V3DutchOutput: [
            { name: "token", type: "address" },
            { name: "startAmount", type: "uint256" },
            { name: "curve", type: "NonlinearDutchDecay" },
            { name: "recipient", type: "address" },
            { name: "minAmount", type: "uint256" },
            { name: "adjustmentPerGweiBaseFee", type: "uint256" },
          ],
          NonlinearDutchDecay: NONLINEAR_DECAY,
        },
        primaryType: "PermitWitnessTransferFrom",
        domain: permit2Domain(42161),
        message: {
          permitted: { token: USDC_ARBITRUM, amount: "5000000" },
          spender: UNISWAPX_V3_REACTOR_ARB,
          nonce: "42",
          deadline: "1900000000",
          witness: {
            info: {
              reactor: UNISWAPX_V3_REACTOR_ARB,
              swapper: EVM_SIGNER,
              nonce: "42",
              deadline: "1900000000",
              additionalValidationContract: ZERO,
              additionalValidationData: "0x",
            },
            cosigner: OTHER,
            startingBaseFee: "0",
            baseInput: {
              token: USDC_ARBITRUM,
              startAmount: "5000000",
              curve: { relativeBlocks: "0", relativeAmounts: ["0"] },
              maxAmount: "5000000",
              adjustmentPerGweiBaseFee: "0",
            },
            baseOutputs: [
              {
                token: WETH_ARBITRUM,
                startAmount: "2000000000000000",
                curve: { relativeBlocks: "0", relativeAmounts: ["0"] },
                recipient: EVM_SIGNER,
                minAmount: "2000000000000000",
                adjustmentPerGweiBaseFee: "0",
              },
            ],
          },
        },
      },
      "eip155:42161",
    ),
  ),
  evm(
    "uniswapx-priority-base",
    "UniswapX PriorityOrderLib.sol TOPLEVEL_PRIORITY_ORDER_TYPE; Base Priority reactor 0x000000001ec5656dcdb24d90dfa42742738de729 (src/evm/uniswapx.ts REACTORS)",
    typed(
      {
        types: {
          EIP712Domain: PERMIT2_DOMAIN_TYPES,
          TokenPermissions: TOKEN_PERMISSIONS,
          PermitWitnessTransferFrom: [
            { name: "permitted", type: "TokenPermissions" },
            { name: "spender", type: "address" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "witness", type: "PriorityOrder" },
          ],
          OrderInfo: ORDER_INFO,
          PriorityOrder: [
            { name: "info", type: "OrderInfo" },
            { name: "cosigner", type: "address" },
            { name: "auctionStartBlock", type: "uint256" },
            { name: "baselinePriorityFeeWei", type: "uint256" },
            { name: "input", type: "PriorityInput" },
            { name: "outputs", type: "PriorityOutput[]" },
          ],
          PriorityInput: [
            { name: "token", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "mpsPerPriorityFeeWei", type: "uint256" },
          ],
          PriorityOutput: [
            { name: "token", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "mpsPerPriorityFeeWei", type: "uint256" },
            { name: "recipient", type: "address" },
          ],
        },
        primaryType: "PermitWitnessTransferFrom",
        domain: permit2Domain(8453),
        message: {
          permitted: { token: USDC_BASE, amount: "5000000" },
          spender: UNISWAPX_PRIORITY_REACTOR_BASE,
          nonce: "42",
          deadline: "1900000000",
          witness: {
            info: {
              reactor: UNISWAPX_PRIORITY_REACTOR_BASE,
              swapper: EVM_SIGNER,
              nonce: "42",
              deadline: "1900000000",
              additionalValidationContract: ZERO,
              additionalValidationData: "0x",
            },
            cosigner: OTHER,
            auctionStartBlock: "38000000",
            baselinePriorityFeeWei: "0",
            input: { token: USDC_BASE, amount: "5000000", mpsPerPriorityFeeWei: "0" },
            outputs: [
              {
                token: WETH_BASE,
                amount: "2000000000000000",
                mpsPerPriorityFeeWei: "0",
                recipient: EVM_SIGNER,
              },
            ],
          },
        },
      },
      "eip155:8453",
    ),
  ),
  evm(
    "zerox-gasless-base",
    "0xProject/0x-examples@3b296df0c46f31298b631442e14d67a16be2f97d gasless-v2-headless-example README trade.eip712: PermitWitnessTransferFrom(...,SlippageAndActions slippageAndActions) on Base; the published response document, vector vectors/chains/evm-zerox-gasless.json",
    typed(zeroxGasless.data, "eip155:8453"),
    zeroxGasless.signer,
  ),
  evm(
    "zerox-allowance-holder",
    "0x gasless PermitWitnessTransferFrom near miss: the same witness shape but the spender is the 0x AllowanceHolder — Permit2 requires spender == msg.sender, so a forwarded metaTx with this spender is not a Settler order",
    typed({
      types: {
        EIP712Domain: PERMIT2_DOMAIN_TYPES,
        TokenPermissions: TOKEN_PERMISSIONS,
        SlippageAndActions: [
          { name: "recipient", type: "address" },
          { name: "buyToken", type: "address" },
          { name: "minAmountOut", type: "uint256" },
          { name: "actions", type: "bytes[]" },
        ],
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "slippageAndActions", type: "SlippageAndActions" },
        ],
      },
      primaryType: "PermitWitnessTransferFrom",
      domain: permit2Domain(1),
      message: {
        permitted: { token: USDC, amount: "1000000" },
        spender: ALLOWANCE_HOLDER,
        nonce: "7",
        deadline: "1900000000",
        slippageAndActions: {
          recipient: EVM_SIGNER,
          buyToken: WETH,
          minAmountOut: "400000000000000",
          actions: ["0xe4c1fb420000000000000000000000002222222222222222222222222222222222222222"],
        },
      },
    }),
  ),
  evm(
    "morpho-authorization",
    "morpho-org/morpho-blue Morpho.sol: Authorization typehash, compact EIP-712 domain (chainId+verifyingContract only); Morpho Blue 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    typed({
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Authorization: [
          { name: "authorizer", type: "address" },
          { name: "authorized", type: "address" },
          { name: "isAuthorized", type: "bool" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Authorization",
      domain: { chainId: 1, verifyingContract: MORPHO_BLUE },
      message: {
        authorizer: EVM_SIGNER,
        authorized: OTHER,
        isAuthorized: true,
        nonce: "0",
        deadline: "1900000000",
      },
    }),
  ),
  evm(
    "uniswap-v3-nft-permit",
    "Uniswap v3 NonfungiblePositionManager ERC721Permit: Permit type; 'Uniswap V3 Positions NFT-V1' domain; 0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    typed({
      types: {
        EIP712Domain: DOMAIN_FIELDS,
        Permit: [
          { name: "spender", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      domain: {
        name: "Uniswap V3 Positions NFT-V1",
        version: "1",
        chainId: 1,
        verifyingContract: NFPM,
      },
      message: { spender: OTHER, tokenId: "123456", nonce: "0", deadline: "1900000000" },
    }),
  ),
  sol(
    "Jupiter v6",
    "fresh mainnet-beta tx via getSignaturesForAddress(Jupiter v6) + getTransaction (fixtures/solana-mainnet-fresh.json); ALT contents cross-checked with meta.loadedAddresses",
  ),
  sol("Raydium AMM v4", "fresh mainnet-beta tx, fixtures/solana-mainnet-fresh.json"),
  sol("Raydium CLMM", "fresh mainnet-beta tx, fixtures/solana-mainnet-fresh.json"),
  sol("Pump.fun", "fresh mainnet-beta tx (buy), fixtures/solana-mainnet-fresh.json"),
  sol("PumpSwap", "fresh mainnet-beta tx, fixtures/solana-mainnet-fresh.json"),
  sol("Meteora DLMM", "fresh mainnet-beta tx, fixtures/solana-mainnet-fresh.json"),
  sol("Orca Whirlpool", "fresh mainnet-beta tx, fixtures/solana-mainnet-fresh.json"),
  sol(
    "SPL TransferChecked",
    "fresh mainnet-beta tx: compute-budget + SPL TransferChecked only, fixtures/solana-mainnet-fresh.json",
  ),
  tron(
    "tron-usdt-transfer",
    "usdt-transfer",
    "fresh mainnet TRC-20 USDT transfer (fixtures/tron-mainnet-fresh.json, TronGrid gettransactionbyid)",
  ),
  tron(
    "tron-usdt-approve-sunswap",
    "usdt-approve-sunswap",
    "fresh mainnet TRC-20 USDT approve to SunSwap v2 router TNJVzGqKBWkJxJB5XYSqGAwUTV15U24pPq",
  ),
  tron(
    "tron-sunswap-swap",
    "sunswap-swap",
    "fresh mainnet TriggerSmartContract to a SunSwap v2 router",
  ),
  tron(
    "tron-delegate-resource",
    "delegate-resource",
    "fresh mainnet DelegateResourceContract (energy delegation to another account)",
  ),
  tron("tron-freeze-v2", "freeze-v2", "fresh mainnet FreezeBalanceV2Contract"),
  tron("tron-vote-witness", "vote-witness", "fresh mainnet VoteWitnessContract"),
];

const expected: Record<string, Observed> = {
  "ens-delegation": { blind: "described", verifiability: "opaque", summary: "message" },
  "uni-delegation": { blind: "described", verifiability: "opaque", summary: "message" },
  "aave-credit-delegation": {
    blind: "described",
    verifiability: "partial",
    summary: "authorization",
  },
  "aave-atoken-permit": { blind: "described", verifiability: "partial", summary: "approve" },
  "lens-post": { blind: "typed-data-oversize", verifiability: "opaque", summary: "message" },
  "lens-follow": { blind: "described", verifiability: "opaque", summary: "message" },
  "farcaster-key-add": {
    blind: "described",
    verifiability: "partial",
    summary: "authorization",
  },
  "farcaster-id-register": { blind: "described", verifiability: "opaque", summary: "message" },
  "farcaster-username-proof": { blind: "described", verifiability: "opaque", summary: "message" },
  "seaport-nft-listing": { blind: "described", verifiability: "opaque", summary: "swap" },
  "seaport-collection-offer": { blind: "described", verifiability: "opaque", summary: "swap" },
  "blur-bid": { blind: "typed-data-variant", verifiability: "opaque", summary: "message" },
  "snapshot-vote": { blind: "described", verifiability: "opaque", summary: "message" },
  "snapshot-proposal": { blind: "described", verifiability: "opaque", summary: "message" },
  "snapshot-follow": { blind: "described", verifiability: "opaque", summary: "message" },
  "permit2-single-mainnet": { blind: "described", verifiability: "partial", summary: "approve" },
  "permit2-single-base": { blind: "described", verifiability: "partial", summary: "approve" },
  "permit2-batch": { blind: "described", verifiability: "partial", summary: "approve" },
  "safe-safetx-usdc": { blind: "described", verifiability: "opaque", summary: "transfer" },
  "safe-message": { blind: "typed-data-commitment", verifiability: "opaque", summary: "message" },
  "usdc-permit-ink": { blind: "described", verifiability: "partial", summary: "approve" },
  "usdc-permit-unichain": { blind: "described", verifiability: "partial", summary: "approve" },
  "usdc-permit-worldchain": { blind: "described", verifiability: "partial", summary: "approve" },
  "usdc-permit-celo": { blind: "described", verifiability: "partial", summary: "approve" },
  "usdc-permit-arbitrum": { blind: "described", verifiability: "partial", summary: "approve" },
  "usdc-permit-base": { blind: "described", verifiability: "partial", summary: "approve" },
  "dai-permit": { blind: "described", verifiability: "partial", summary: "approve" },
  "usdc-eip3009-base": { blind: "described", verifiability: "full", summary: "transfer" },
  "polymarket-ctf": { blind: "described", verifiability: "partial", summary: "swap" },
  "hl-approve-builder-fee": { blind: "described", verifiability: "partial", summary: "approve" },
  "hl-usd-send": { blind: "described", verifiability: "full", summary: "transfer" },
  "oneinch-fusion": { blind: "typed-data-variant", verifiability: "opaque", summary: "message" },
  "oneinch-plain": { blind: "described", verifiability: "partial", summary: "swap" },
  "cow-base": { blind: "described", verifiability: "partial", summary: "swap" },
  "uniswapx-v3dutch-arbitrum": { blind: "described", verifiability: "partial", summary: "swap" },
  "uniswapx-priority-base": { blind: "described", verifiability: "partial", summary: "swap" },
  "zerox-gasless-base": { blind: "described", verifiability: "partial", summary: "swap" },
  "zerox-allowance-holder": {
    blind: "typed-data-variant",
    verifiability: "opaque",
    summary: "message",
  },
  "morpho-authorization": {
    blind: "described",
    verifiability: "partial",
    summary: "authorization",
  },
  "uniswap-v3-nft-permit": {
    blind: "typed-data-variant",
    verifiability: "opaque",
    summary: "message",
  },
  "sol-jupiter-v6": { blind: "program-authority", verifiability: "opaque", summary: "transfer" },
  "sol-raydium-amm-v4": { blind: "described", verifiability: "partial", summary: "swap" },
  "sol-raydium-clmm": { blind: "described", verifiability: "opaque", summary: "transfer" },
  "sol-pump-fun": { blind: "described", verifiability: "opaque", summary: "contract-call" },
  "sol-pumpswap": { blind: "described", verifiability: "opaque", summary: "contract-call" },
  "sol-meteora-dlmm": {
    blind: "described",
    verifiability: "opaque",
    summary: "swap",
  },
  "sol-orca-whirlpool": { blind: "described", verifiability: "opaque", summary: "swap" },
  "sol-spl-transferchecked": { blind: "described", verifiability: "full", summary: "transfer" },
  "tron-usdt-transfer": { blind: "described", verifiability: "full", summary: "transfer" },
  "tron-usdt-approve-sunswap": { blind: "described", verifiability: "partial", summary: "approve" },
  "tron-sunswap-swap": { blind: "described", verifiability: "opaque", summary: "contract-call" },
  "tron-delegate-resource": { blind: "described", verifiability: "full", summary: "stake" },
  "tron-freeze-v2": { blind: "described", verifiability: "full", summary: "stake" },
  "tron-vote-witness": { blind: "described", verifiability: "full", summary: "stake" },
};

const decodeRow = (row: Row) => {
  switch (row.request.kind) {
    case "evm.transaction":
    case "evm.personal-message":
    case "evm.typed-data":
      return decodeEvm(row.request, row.signer ?? EVM_SIGNER);
    case "solana.transaction":
      return decodeSolana(row.request, row.signer ?? "");
    case "tron.transaction":
      return decodeTron(row.request, row.signer ?? "");
    default:
      throw new Error(`corpus: unhandled request kind ${row.request.kind}`);
  }
};

type Recorded = Observed & { warnings: string[] };

const runRow = (row: Row): Recorded => {
  try {
    const intent = decodeRow(row);
    return {
      blind: intent.blind ?? "described",
      verifiability: intent.verifiability,
      summary: intent.summary,
      warnings: intent.warnings.map((w) => w.kind),
    };
  } catch (error) {
    return {
      blind: `error:${error instanceof ChainError ? error.code : "unknown"}`,
      verifiability: "error",
      summary: error instanceof Error ? error.message.slice(0, 120) : String(error),
      warnings: [],
    };
  }
};

const results = corpus.map((row) => ({ row, observed: runRow(row) }));

describe("usability corpus: observed classifier outcome per real-world request", () => {
  it.each(results)("$row.id", ({ row, observed }) => {
    const { warnings: _warnings, ...pinned } = observed;
    expect(pinned).toStrictEqual(expected[row.id]);
  });
});

afterAll(() => {
  const out = process.env["CORPUS_EVIDENCE_OUT"];
  if (out === undefined || out === "") {
    return;
  }
  const evidence = results.map(({ row, observed }) => ({
    id: row.id,
    family: row.family,
    source: row.source,
    blind: observed.blind,
    verifiability: observed.verifiability,
    summary: observed.summary,
    warnings: observed.warnings,
  }));
  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, `${JSON.stringify(evidence, null, 1)}\n`);
});
