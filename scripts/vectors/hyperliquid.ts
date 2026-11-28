/// <reference types="node" />
/**
 * Regenerates vectors/chains/hyperliquid.json — Hyperliquid typed-data documents as a dApp delivers
 * them for signing, each with its EIP-712 digest and ECDSA signature.
 *
 * Oracles: @nktkas/hyperliquid 0.33.3 builds every document (the `…Types` constants,
 * `canonicalize(<X>Request.entries.action)` and `createL1ActionHash`/`signL1Action`/
 * `signUserSignedAction` from /signing); @metamask/eth-sig-util 9.0.0 signs inside the wallet shim
 * and produces digests — an independent EIP-712 implementation (viem's hashTypedData rejects the
 * "HyperliquidTransaction:" type names; for the L1 `Agent` documents viem's hashTypedData is
 * additionally asserted equal). Published values are asserted verbatim: refs/hyperliquid
 * tests/signing/mod.test.ts and refs/hyperliquid-python-sdk tests/signing_test.py — the script
 * throws rather than emit a file that disagrees with them.
 *
 * `userSigned`: the ten described `HyperliquidTransaction:*` types plus two blind ones; `expected`
 * is the `hyperliquid` content the wallet decodes (null when it stays blind). `l1`: the nine
 * allow-listed L1 action types — the kernel's agent signing consumes them.
 *
 * Run from the repo root: bun scripts/vectors/hyperliquid.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { SignTypedDataVersion, signTypedData, TypedDataUtils } from "@metamask/eth-sig-util";
import type { MessageTypes, TypedMessage } from "@metamask/eth-sig-util";
import {
  ApproveAgentTypes,
  ApproveBuilderFeeTypes,
  BatchModifyRequest,
  CDepositTypes,
  CWithdrawTypes,
  CancelByCloidRequest,
  CancelRequest,
  ConvertToMultiSigUserTypes,
  ModifyRequest,
  OrderRequest,
  SendAssetTypes,
  SpotSendTypes,
  TokenDelegateTypes,
  TwapCancelRequest,
  UpdateIsolatedMarginRequest,
  UpdateLeverageRequest,
  UsdClassTransferTypes,
  UsdSendTypes,
  UserSetAbstractionTypes,
  Withdraw3Types,
} from "@nktkas/hyperliquid/api/exchange";
import {
  canonicalize,
  createL1ActionHash,
  signL1Action,
  signUserSignedAction,
} from "@nktkas/hyperliquid/signing";
import { getAddress, hashTypedData, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

type Field = { readonly name: string; readonly type: string };
type Types = Record<string, ReadonlyArray<Field>>;
type Action = Record<string, unknown>;
type UserAction = Action & { readonly signatureChainId: `0x${string}` };
type Doc = {
  readonly types: Types;
  readonly primaryType: string;
  readonly domain: Record<string, unknown>;
  readonly message: Action;
};
type Rsv = { readonly r: string; readonly s: string; readonly v: number };

/* The nktkas test key — signatures are only test vectors. */
const KEY = "0x822e9959e022b78423eb653a62ea0020cd283e71a2a8133a6ff2aeffaf373cff" as const;
/* The hyperliquid-python-sdk test key. */
const PY_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123" as const;
const ZERO = "0x0000000000000000000000000000000000000000";

/* The fields nktkas injects as types.EIP712Domain (signing/_abstractWallet.ts). */
const EIP712_DOMAIN: ReadonlyArray<Field> = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];
const AGENT_TYPES: Types = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
};

const assert = (ok: boolean, what: string): void => {
  if (!ok) {
    throw new Error(`hyperliquid vector oracle mismatch: ${what}`);
  }
};

/* eth-sig-util's TypedMessage wants mutable field arrays and its own TypedDataDomain — the same
   document shape the script records. */
const asMessage = (
  doc: Doc,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- identical runtime shape
): TypedMessage<MessageTypes> => doc as TypedMessage<MessageTypes>;

/**
 * An `AbstractViemLocalAccount` whose signTypedData runs eth-sig-util — the independent EIP-712
 * oracle, since a real viem account refuses the `HyperliquidTransaction:` struct names.
 */
const signDocWith = (
  key: `0x${string}`,
  params: {
    domain: Record<string, unknown>;
    types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  },
): `0x${string}` => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same shape; eth-sig-util wants mutable arrays
  const data = params as TypedMessage<MessageTypes>;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- eth-sig-util returns a hex signature string
  return signTypedData({
    privateKey: Buffer.from(hexToBytes(key)),
    data,
    version: SignTypedDataVersion.V4,
  }) as `0x${string}`;
};

/** The params shape `AbstractViemLocalAccount.signTypedData` receives. */
type ViemTypedDataParams = {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
};

const walletFor = (key: `0x${string}`) => ({
  address: privateKeyToAccount(key).address,
  // oxlint-disable-next-line typescript/require-await -- the wallet interface returns a Promise; eth-sig-util signs synchronously
  signTypedData: async (params: ViemTypedDataParams): Promise<`0x${string}`> =>
    signDocWith(key, params),
});

const digestOf = (doc: Doc): `0x${string}` =>
  `0x${TypedDataUtils.eip712Hash(asMessage(doc), SignTypedDataVersion.V4).toString("hex")}`;

const rsv = (signature: Rsv): string =>
  `${signature.r}${signature.s.slice(2)}${signature.v.toString(16).padStart(2, "0")}`;

/* The document a wallet receives for a user-signed action: the domain the SDK builds from
   signatureChainId (nktkas _userSigned.ts; python signing.py user_signed_payload), and the full
   action as message — `type`/`signatureChainId` ride along unhashed. */
const userDoc = (types: Types, action: UserAction): Doc => ({
  types: { EIP712Domain: EIP712_DOMAIN, ...types },
  primaryType: Object.keys(types)[0] ?? "",
  domain: {
    name: "HyperliquidSignTransaction",
    version: "1",
    chainId: Number.parseInt(action.signatureChainId, 16),
    verifyingContract: ZERO,
  },
  message: action,
});

const phantomDoc = (source: "a" | "b", connectionId: `0x${string}`): Doc => ({
  types: { EIP712Domain: EIP712_DOMAIN, ...AGENT_TYPES },
  primaryType: "Agent",
  domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO },
  message: { source, connectionId },
});

const DEST = "0x5e9ee1089755c3435139848e47e6635505d5a13a";
const DEST_E55 = getAddress(DEST);
const TOKEN = "SPOT:0x22222222222222222222222222222222";
const AGENT = "0x1234567890abcdef1234567890abcdef12345678";
const BUILDER = "0x0000000000000000000000000000000000000bad";
const SUB = "0x0123456789abcdef0123456789abcdef01234567";

const userSignedCases: ReadonlyArray<{
  readonly name: string;
  readonly source?: string;
  readonly types: Types;
  readonly action: UserAction;
  readonly expected: unknown;
  readonly published?: Rsv;
  readonly key?: `0x${string}`;
}> = [
  {
    name: "usdSend mainnet (nktkas published)",
    source: "refs/hyperliquid/tests/signing/mod.test.ts:59-80",
    types: UsdSendTypes,
    action: {
      type: "usdSend",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Mainnet",
      destination: "0x1234567890123456789012345678901234567890",
      amount: "1000",
      time: 1234567890,
    },
    published: {
      r: "0xf777c38efe7c24cc71209526ae608f4e384d0586edf578f0e97b4b9f7c7adcc6",
      s: "0x104a4a97c48ae77bf5bd777bdd45fe72d8f5ff29116b5ff64fd8cfe4ea610786",
      v: 28,
    },
    expected: {
      kind: "usd-send",
      chain: "Mainnet",
      destination: "0x1234567890123456789012345678901234567890",
      amount: "1000",
    },
  },
  {
    name: "usdSend Arbitrum One signing chain",
    types: UsdSendTypes,
    action: {
      type: "usdSend",
      signatureChainId: "0xa4b1",
      hyperliquidChain: "Mainnet",
      destination: DEST,
      amount: "2.5",
      time: 1700000000000,
    },
    expected: { kind: "usd-send", chain: "Mainnet", destination: DEST_E55, amount: "2.5" },
  },
  {
    name: "python usdSend (published)",
    source: "refs/hyperliquid-python-sdk/tests/signing_test.py:189-199",
    types: UsdSendTypes,
    key: PY_KEY,
    action: {
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
      destination: DEST,
      amount: "1",
      time: 1687816341423,
    },
    published: {
      r: "0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073",
      s: "0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7",
      v: 27,
    },
    expected: { kind: "usd-send", chain: "Testnet", destination: DEST_E55, amount: "1" },
  },
  {
    name: "withdraw3 testnet",
    types: Withdraw3Types,
    action: {
      type: "withdraw3",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
      destination: DEST,
      amount: "25",
      time: 1700000000123,
    },
    expected: { kind: "withdraw", chain: "Testnet", destination: DEST_E55, amount: "25" },
  },
  {
    name: "python withdraw (published)",
    source: "refs/hyperliquid-python-sdk/tests/signing_test.py:202-212",
    types: Withdraw3Types,
    key: PY_KEY,
    action: {
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
      destination: DEST,
      amount: "1",
      time: 1687816341423,
    },
    published: {
      r: "0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9",
      s: "0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881",
      v: 28,
    },
    expected: { kind: "withdraw", chain: "Testnet", destination: DEST_E55, amount: "1" },
  },
  {
    name: "spotSend testnet",
    types: SpotSendTypes,
    action: {
      type: "spotSend",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
      destination: DEST,
      token: TOKEN,
      amount: "10.25",
      time: 1700000000456,
    },
    expected: {
      kind: "spot-send",
      chain: "Testnet",
      destination: DEST_E55,
      token: TOKEN,
      amount: "10.25",
    },
  },
  {
    name: "usdClassTransfer to perps",
    types: UsdClassTransferTypes,
    action: {
      type: "usdClassTransfer",
      signatureChainId: "0xa4b1",
      hyperliquidChain: "Mainnet",
      amount: "5",
      toPerp: true,
      nonce: 1700000000789,
    },
    expected: { kind: "usd-class-transfer", chain: "Mainnet", amount: "5", toPerp: true },
  },
  {
    name: "usdClassTransfer to spot",
    types: UsdClassTransferTypes,
    action: {
      type: "usdClassTransfer",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
      amount: "0.75",
      toPerp: false,
      nonce: 1700000000800,
    },
    expected: { kind: "usd-class-transfer", chain: "Testnet", amount: "0.75", toPerp: false },
  },
  {
    name: "sendAsset perps to spot",
    types: SendAssetTypes,
    action: {
      type: "sendAsset",
      signatureChainId: "0xa4b1",
      hyperliquidChain: "Mainnet",
      destination: DEST,
      sourceDex: "",
      destinationDex: "spot",
      token: TOKEN,
      amount: "1.5",
      fromSubAccount: "",
      nonce: 1700000000900,
    },
    expected: {
      kind: "send-asset",
      chain: "Mainnet",
      destination: DEST_E55,
      sourceDex: "",
      destinationDex: "spot",
      token: TOKEN,
      amount: "1.5",
    },
  },
  {
    name: "sendAsset from a sub-account",
    types: SendAssetTypes,
    action: {
      type: "sendAsset",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
      destination: DEST,
      sourceDex: "spot",
      destinationDex: "builder01",
      token: TOKEN,
      amount: "3",
      fromSubAccount: SUB,
      nonce: 1700000000950,
    },
    expected: {
      kind: "send-asset",
      chain: "Testnet",
      destination: DEST_E55,
      sourceDex: "spot",
      destinationDex: "builder01",
      token: TOKEN,
      amount: "3",
      fromSubAccount: getAddress(SUB),
    },
  },
  {
    name: "cDeposit",
    types: CDepositTypes,
    action: {
      type: "cDeposit",
      signatureChainId: "0xa4b1",
      hyperliquidChain: "Mainnet",
      wei: 150000000,
      nonce: 1700000001000,
    },
    expected: { kind: "staking-deposit", chain: "Mainnet", wei: "150000000" },
  },
  {
    name: "cWithdraw",
    types: CWithdrawTypes,
    action: {
      type: "cWithdraw",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
      wei: 250000000,
      nonce: 1700000001100,
    },
    expected: { kind: "staking-withdraw", chain: "Testnet", wei: "250000000" },
  },
  {
    name: "tokenDelegate",
    types: TokenDelegateTypes,
    action: {
      type: "tokenDelegate",
      signatureChainId: "0xa4b1",
      hyperliquidChain: "Mainnet",
      validator: "0x0000000000000000000000000000000000000123",
      wei: 10000000000,
      isUndelegate: false,
      nonce: 1700000001200,
    },
    expected: {
      kind: "token-delegate",
      chain: "Mainnet",
      validator: getAddress("0x0000000000000000000000000000000000000123"),
      wei: "10000000000",
      undelegate: false,
    },
  },
  {
    name: "tokenDelegate undelegate",
    types: TokenDelegateTypes,
    action: {
      type: "tokenDelegate",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
      validator: "0x0000000000000000000000000000000000000456",
      wei: 500000000,
      isUndelegate: true,
      nonce: 1700000001250,
    },
    expected: {
      kind: "token-delegate",
      chain: "Testnet",
      validator: getAddress("0x0000000000000000000000000000000000000456"),
      wei: "500000000",
      undelegate: true,
    },
  },
  {
    name: "approveAgent named",
    types: ApproveAgentTypes,
    action: {
      type: "approveAgent",
      signatureChainId: "0xa4b1",
      hyperliquidChain: "Mainnet",
      agentAddress: AGENT,
      agentName: "bot-1",
      nonce: 1700000001300,
    },
    expected: {
      kind: "approve-agent",
      chain: "Mainnet",
      agent: getAddress(AGENT),
      name: "bot-1",
    },
  },
  {
    name: "approveAgent with valid_until",
    types: ApproveAgentTypes,
    action: {
      type: "approveAgent",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
      agentAddress: AGENT,
      agentName: "bot-2 valid_until 1798765432000",
      nonce: 1700000001400,
    },
    expected: {
      kind: "approve-agent",
      chain: "Testnet",
      agent: getAddress(AGENT),
      name: "bot-2",
      validUntil: 1798765432000,
    },
  },
  {
    name: "approveAgent unnamed",
    types: ApproveAgentTypes,
    action: {
      type: "approveAgent",
      signatureChainId: "0xa4b1",
      hyperliquidChain: "Mainnet",
      agentAddress: AGENT,
      agentName: "",
      nonce: 1700000001450,
    },
    expected: {
      kind: "approve-agent",
      chain: "Mainnet",
      agent: getAddress(AGENT),
      name: "",
    },
  },
  {
    name: "approveBuilderFee",
    types: ApproveBuilderFeeTypes,
    action: {
      type: "approveBuilderFee",
      signatureChainId: "0xa4b1",
      hyperliquidChain: "Mainnet",
      maxFeeRate: "0.1%",
      builder: BUILDER,
      nonce: 1700000001500,
    },
    expected: {
      kind: "approve-builder-fee",
      chain: "Mainnet",
      builder: getAddress(BUILDER),
      maxFeeRate: "0.1%",
    },
  },
  {
    name: "convertToMultiSigUser (blind)",
    types: ConvertToMultiSigUserTypes,
    action: {
      type: "convertToMultiSigUser",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
      signers:
        '["0x1111111111111111111111111111111111111111","0x2222222222222222222222222222222222222222"]',
      nonce: 1700000001600,
    },
    expected: null,
  },
  {
    name: "userSetAbstraction (blind)",
    source: "refs/hyperliquid/tests/signing/mod.test.ts:140-154",
    types: UserSetAbstractionTypes,
    action: {
      type: "userSetAbstraction",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
      user: "0x3b4d2cc2e144a0044002506c8b44508e9ace82e9",
      abstraction: "disabled",
      nonce: 1780130409592,
    },
    expected: null,
  },
];

/* nktkas mod.test.ts:23-56 — the published order case in all four vault/expires combinations. */
const NKT_ORDER = {
  type: "order",
  orders: [{ a: 0, b: true, p: "30000", s: "0.1", r: false, t: { limit: { tif: "Gtc" } } }],
  grouping: "na",
};
const NKT_VAULT = "0x1234567890123456789012345678901234567890";

const l1Cases: ReadonlyArray<{
  readonly name: string;
  readonly source?: string;
  readonly schema?: Parameters<typeof canonicalize>[0];
  readonly action: Action;
  readonly nonce: number;
  readonly vaultAddress?: `0x${string}`;
  readonly expiresAfter?: number;
  readonly key?: `0x${string}`;
  readonly connectionId?: `0x${string}`;
  readonly published?: { readonly mainnet: Rsv; readonly testnet: Rsv };
}> = [
  {
    name: "order",
    source: "refs/hyperliquid/tests/signing/mod.test.ts:21-56",
    schema: OrderRequest.entries.action,
    action: NKT_ORDER,
    nonce: 1234567890,
    connectionId: "0x25367e0dba84351148288c2233cd6130ed6cec5967ded0c0b7334f36f957cc90",
    published: {
      mainnet: {
        r: "0x61078d8ffa3cb591de045438a1ae2ed299b271891d1943a33901e7cfb3a31ed8",
        s: "0x0e91df4f9841641d3322dad8d932874b74d7e082cdb5b533f804964a6963aef9",
        v: 28,
      },
      testnet: {
        r: "0x6b0283a894d87b996ad0182b86251cc80d27d61ef307449a2ed249a508ded1f7",
        s: "0x6f884e79f4a0a10af62db831af6f8e03b3f11d899eb49b352f836746ee9226da",
        v: 27,
      },
    },
  },
  {
    name: "order with vault",
    source: "refs/hyperliquid/tests/signing/mod.test.ts:21-56",
    schema: OrderRequest.entries.action,
    action: NKT_ORDER,
    nonce: 1234567890,
    vaultAddress: NKT_VAULT,
    connectionId: "0x214e2ea3270981b6fd18174216691e69f56872663139d396b10ded319cb4bb1e",
  },
  {
    name: "order with expiresAfter",
    source: "refs/hyperliquid/tests/signing/mod.test.ts:21-56",
    schema: OrderRequest.entries.action,
    action: NKT_ORDER,
    nonce: 1234567890,
    expiresAfter: 1234567890,
    connectionId: "0xc30b002ba3775e4c31c43c1dfd3291dfc85c6ae06c6b9f393991de86cad5fac7",
  },
  {
    name: "order with vault and expiresAfter",
    source: "refs/hyperliquid/tests/signing/mod.test.ts:21-56",
    schema: OrderRequest.entries.action,
    action: NKT_ORDER,
    nonce: 1234567890,
    vaultAddress: NKT_VAULT,
    expiresAfter: 1234567890,
    connectionId: "0x2d62412aa0fc57441b5189841d81554a6a9680bf07204e1454983a9ca44f0744",
  },
  {
    name: "order with cloid and builder",
    schema: OrderRequest.entries.action,
    action: {
      type: "order",
      orders: [
        {
          a: 1,
          b: false,
          p: "1500.25",
          s: "0.5",
          r: false,
          t: { limit: { tif: "Alo" } },
          c: "0x00000000000000000000000000000001",
        },
      ],
      grouping: "na",
      builder: { b: BUILDER, f: 10 },
    },
    nonce: 1677777606041,
  },
  {
    name: "cancel",
    schema: CancelRequest.entries.action,
    action: { type: "cancel", cancels: [{ a: 0, o: 5000000001 }] },
    nonce: 1677777606042,
  },
  {
    name: "cancel fast",
    schema: CancelRequest.entries.action,
    action: { type: "cancel", cancels: [{ a: 1, o: 6000000002 }], f: true },
    nonce: 1677777606043,
  },
  {
    name: "cancelByCloid",
    schema: CancelByCloidRequest.entries.action,
    action: {
      type: "cancelByCloid",
      cancels: [{ asset: 2, cloid: "0x0000000000000000000000000000000f" }],
    },
    nonce: 1677777606044,
  },
  {
    name: "modify by oid",
    schema: ModifyRequest.entries.action,
    action: {
      type: "modify",
      oid: 5000000003,
      order: { a: 1, b: true, p: "1600", s: "0.25", r: true, t: { limit: { tif: "Gtc" } } },
    },
    nonce: 1677777606045,
  },
  {
    name: "modify by cloid",
    schema: ModifyRequest.entries.action,
    action: {
      type: "modify",
      oid: "0x00000000000000000000000000000002",
      order: { a: 1, b: false, p: "1600", s: "0.25", r: false, t: { limit: { tif: "Ioc" } } },
    },
    nonce: 1677777606046,
  },
  {
    name: "batchModify",
    schema: BatchModifyRequest.entries.action,
    action: {
      type: "batchModify",
      modifies: [
        {
          oid: 5000000004,
          order: { a: 0, b: true, p: "30000", s: "0.1", r: false, t: { limit: { tif: "Alo" } } },
        },
      ],
    },
    nonce: 1677777606047,
  },
  {
    name: "modify with cloid",
    schema: ModifyRequest.entries.action,
    action: {
      type: "modify",
      oid: 5000000003,
      order: {
        a: 1,
        b: true,
        p: "1600",
        s: "0.25",
        r: true,
        t: { limit: { tif: "Gtc" } },
        c: "0x00000000000000000000000000000002",
      },
    },
    nonce: 1677777606048,
  },
  {
    name: "batchModify with cloid",
    schema: BatchModifyRequest.entries.action,
    action: {
      type: "batchModify",
      modifies: [
        {
          oid: 5000000004,
          order: {
            a: 0,
            b: true,
            p: "30000",
            s: "0.1",
            r: false,
            t: { limit: { tif: "Alo" } },
            c: "0x00000000000000000000000000000003",
          },
        },
        {
          oid: "0x00000000000000000000000000000004",
          order: {
            a: 1,
            b: false,
            p: "1600",
            s: "0.25",
            r: false,
            t: { limit: { tif: "Ioc" } },
            c: "0x00000000000000000000000000000004",
          },
        },
      ],
    },
    nonce: 1677777606049,
  },
  {
    name: "updateLeverage",
    schema: UpdateLeverageRequest.entries.action,
    action: { type: "updateLeverage", asset: 5, isCross: true, leverage: 10 },
    nonce: 1677777606050,
  },
  {
    name: "updateIsolatedMargin",
    schema: UpdateIsolatedMarginRequest.entries.action,
    action: { type: "updateIsolatedMargin", asset: 5, isBuy: true, ntli: -1000000 },
    nonce: 1677777606051,
  },
  {
    name: "twapCancel",
    schema: TwapCancelRequest.entries.action,
    action: { type: "twapCancel", a: 0, t: 123456789 },
    nonce: 1677777606053,
  },
  {
    name: "python production order (connectionId)",
    source: "refs/hyperliquid-python-sdk/tests/signing_test.py:21-35",
    schema: OrderRequest.entries.action,
    action: {
      type: "order",
      orders: [{ a: 4, b: true, p: "1670.1", s: "0.0147", r: false, t: { limit: { tif: "Ioc" } } }],
      grouping: "na",
    },
    nonce: 1677777606040,
    key: PY_KEY,
    connectionId: "0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908",
  },
  {
    name: "python order Gtc",
    source: "refs/hyperliquid-python-sdk/tests/signing_test.py:51-87",
    schema: OrderRequest.entries.action,
    action: {
      type: "order",
      orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }],
      grouping: "na",
    },
    nonce: 0,
    key: PY_KEY,
    published: {
      mainnet: {
        r: "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e",
        s: "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e",
        v: 28,
      },
      testnet: {
        r: "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54",
        s: "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5",
        v: 27,
      },
    },
  },
  {
    name: "python order with cloid",
    source: "refs/hyperliquid-python-sdk/tests/signing_test.py:90-126",
    schema: OrderRequest.entries.action,
    action: {
      type: "order",
      orders: [
        {
          a: 1,
          b: true,
          p: "100",
          s: "100",
          r: false,
          t: { limit: { tif: "Gtc" } },
          c: "0x00000000000000000000000000000001",
        },
      ],
      grouping: "na",
    },
    nonce: 0,
    key: PY_KEY,
    published: {
      mainnet: {
        r: "0x041ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3",
        s: "0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da",
        v: 27,
      },
      testnet: {
        r: "0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d",
        s: "0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988",
        v: 28,
      },
    },
  },
  {
    name: "python tpsl order",
    source: "refs/hyperliquid-python-sdk/tests/signing_test.py:142-178",
    schema: OrderRequest.entries.action,
    action: {
      type: "order",
      orders: [
        {
          a: 1,
          b: true,
          p: "100",
          s: "100",
          r: false,
          t: { trigger: { isMarket: true, triggerPx: "103", tpsl: "sl" } },
        },
      ],
      grouping: "na",
    },
    nonce: 0,
    key: PY_KEY,
    published: {
      mainnet: {
        r: "0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9",
        s: "0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405",
        v: 27,
      },
      testnet: {
        r: "0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4",
        s: "0x206257b104788f80450f8e786c329daa589aa0b32ba96948201ae556d5637eac",
        v: 28,
      },
    },
  },
  {
    name: "python dummy with vault (hash layout)",
    source: "refs/hyperliquid-python-sdk/tests/signing_test.py:129-139",
    action: { type: "dummy", num: 100000000000 },
    nonce: 0,
    vaultAddress: "0x1719884eb866cb12b2287399b15f7db5e7d775ea",
    key: PY_KEY,
    published: {
      mainnet: {
        r: "0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239",
        s: "0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c",
        v: 28,
      },
      testnet: {
        r: "0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b",
        s: "0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60",
        v: 27,
      },
    },
  },
];

const userSigned: unknown[] = [];
for (const c of userSignedCases) {
  const wallet = walletFor(c.key ?? KEY);
  const doc = userDoc(c.types, c.action);
  // oxlint-disable-next-line eslint/no-await-in-loop -- vectors are generated serially, each asserting the last
  const signature = await signUserSignedAction({ wallet, action: c.action, types: c.types });
  if (c.published !== undefined) {
    assert(
      BigInt(signature.r) === BigInt(c.published.r) &&
        BigInt(signature.s) === BigInt(c.published.s) &&
        signature.v === c.published.v,
      `${c.name}: signature`,
    );
  }
  userSigned.push({
    name: c.name,
    ...(c.source === undefined ? {} : { source: c.source }),
    typedData: doc,
    digest: digestOf(doc),
    privateKey: c.key ?? KEY,
    signature: rsv(signature),
    expected: c.expected,
  });
}

const l1: unknown[] = [];
for (const c of l1Cases) {
  const key = c.key ?? KEY;
  const wallet = walletFor(key);
  const action = c.schema === undefined ? c.action : canonicalize(c.schema, c.action);
  const connectionId = createL1ActionHash({
    action,
    nonce: c.nonce,
    ...(c.vaultAddress === undefined ? {} : { vaultAddress: c.vaultAddress }),
    ...(c.expiresAfter === undefined ? {} : { expiresAfter: c.expiresAfter }),
  });
  if (c.connectionId !== undefined) {
    assert(connectionId === c.connectionId, `${c.name}: connectionId`);
  }
  for (const network of ["Mainnet", "Testnet"] as const) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- vectors are generated serially, each asserting the last
    const signature = await signL1Action({
      wallet,
      action,
      nonce: c.nonce,
      isTestnet: network === "Testnet",
      ...(c.vaultAddress === undefined ? {} : { vaultAddress: c.vaultAddress }),
      ...(c.expiresAfter === undefined ? {} : { expiresAfter: c.expiresAfter }),
    });
    const published = c.published?.[network === "Mainnet" ? "mainnet" : "testnet"];
    if (published !== undefined) {
      assert(
        BigInt(signature.r) === BigInt(published.r) &&
          BigInt(signature.s) === BigInt(published.s) &&
          signature.v === published.v,
        `${c.name} ${network}: signature`,
      );
    }
    const doc = phantomDoc(network === "Mainnet" ? "a" : "b", connectionId);
    const digest = digestOf(doc);
    assert(
      hashTypedData(doc as Parameters<typeof hashTypedData>[0]) === digest,
      `${c.name} ${network}: viem digest disagrees`,
    );
    l1.push({
      name: network === "Mainnet" ? c.name : `${c.name} (testnet)`,
      ...(c.source === undefined ? {} : { source: c.source }),
      action,
      nonce: c.nonce,
      ...(c.vaultAddress === undefined ? {} : { vaultAddress: c.vaultAddress }),
      ...(c.expiresAfter === undefined ? {} : { expiresAfter: c.expiresAfter }),
      network,
      connectionId,
      typedData: doc,
      digest,
      privateKey: key,
      signature: rsv(signature),
    });
  }
}

writeFileSync(
  resolve(import.meta.dirname, "../../vectors/chains/hyperliquid.json"),
  `${JSON.stringify({ userSigned, l1 }, null, 2)}\n`,
);
console.log(`wrote ${userSigned.length} userSigned and ${l1.length} l1 cases`);
