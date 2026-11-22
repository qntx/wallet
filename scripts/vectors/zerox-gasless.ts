/// <reference types="node" />
/**
 * Regenerates vectors/chains/evm-zerox-gasless.json: the 0x gasless Settler MetaTxn Permit2 witness
 * documents the `slippageAndActions` decoder (packages/wallet-chains/src/evm/zerox.ts) recognises.
 *
 * `real` is the published 0x gasless-v2 API response document of 0xProject/0x-examples at
 * 3b296df0c46f31298b631442e14d67a16be2f97d, gasless-v2-headless-example/README.md (`trade.eip712`,
 * `trade.hash` and `tradeSignature`) — a real Base sell of 100000 USDC for WETH through the
 * MetaTxn-feature Settler 0x5ce929ddb01804bff35b2f5c77b735bdb094aac8 (Deployer token id 3, feature
 * nonce 4). The script asserts viem `hashTypedData` equals `tradeHash` and
 * `recoverTypedDataAddress` recovers the API's signer.
 *
 * `signed` are variants signed by the fixed test key: a valid mainnet order, near misses that must
 * stay blind (`typed-data-variant` — a feature-2 taker Settler spender, the AllowanceHolder as
 * spender, a zero `minAmountOut`, an extra type, a request/domain chain mismatch, and the
 * PermitBatchWitnessTransferFrom batch form 0x gasless does not use), plus a native-`buyToken`
 * order (0x's 0xEeee… sentinel).
 *
 * The Settler address derivation mirrors isZeroExSettler in packages/wallet-chains/src/evm/zerox.ts
 * (0x Deployer 0x00000000000004533Fe15556B1E086BB1A72cEae: `salt = feature<<128 | chainId<<64 |
 * nonce`, CREATE2 shim then CREATE child) and is asserted against the owners probed in
 * vectors/chains/order-protocols.json (Deployer `ownerOf(3)` per ZEROX chain).
 *
 * Run from the repo root: bun scripts/vectors/zerox-gasless.ts
 */
import { writeFileSync } from "node:fs";

import { concat, getAddress, hashTypedData, keccak256, recoverTypedDataAddress, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const OUT = "vectors/chains/evm-zerox-gasless.json";

/* The evm.json test key (anvil account 0) — the synthetic variants are signed by its account. */
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(TEST_KEY);

/* 0x Deployer + the shared Settler CREATE2 init-code hash (mirrors zerox.ts). */
const DEPLOYER = "0x00000000000004533fe15556b1e086bb1a72ceae" as const;
const SHIM_INIT_CODE_HASH =
  "0x3bf3f97f0be1e2c00023033eefeb4fc062ac552ff36778b17060d90b6764902f" as const;
const ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const settler = (chainId: number, feature: bigint, nonce: number): string => {
  const salt = toHex(feature * 2n ** 128n + BigInt(chainId) * 2n ** 64n + BigInt(nonce), {
    size: 32,
  });
  const shim = keccak256(concat(["0xff", DEPLOYER, salt, SHIM_INIT_CODE_HASH]));
  return getAddress(`0x${keccak256(`0xd694${shim.slice(26)}01`).slice(26)}`);
};

/* The feature-3 (MetaTxn) Settlers probed on-chain — Deployer.ownerOf(3) per ZEROX chain. */
const METATXN_SETTLERS: Readonly<
  Record<number, { readonly owner: string; readonly nonce: number }>
> = {
  1: { owner: "0x9A6350D532ed83a970D452b736bE5847b2856768", nonce: 20 },
  10: { owner: "0x77b78b71B5c9f39Cfdcf6ff562ae5d5d9Bb618D0", nonce: 20 },
  56: { owner: "0x3A6957d477CB89e07502e4E6609c379ee304e618", nonce: 22 },
  137: { owner: "0xF67942DdAad59c56eE827a89ceeD573E462Da40f", nonce: 19 },
  8453: { owner: "0x195a2e68f4e1d278dd1307b327ea5664b97b6731", nonce: 22 },
  999: { owner: "0x36C7534D85Fc7EfB49477726D6eCDCeBA6cFf082", nonce: 11 },
  42161: { owner: "0x8052089eD33bcD8652530871d524CD28aB6f83f1", nonce: 19 },
  43114: { owner: "0x9F26C7B2Bf8aFB1968b7136eC278951e544C3d84", nonce: 19 },
  11155111: { owner: "0x30a91929Ef5D394879dC597AD4B0De92338b3a1b", nonce: 19 },
};

for (const [chainId, { owner, nonce }] of Object.entries(METATXN_SETTLERS)) {
  const derived = settler(Number(chainId), 3n, nonce);
  if (derived.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`feature-3 settler derivation mismatch on chain ${chainId}: ${derived}`);
  }
}

/* Mirrors the decoder's address checksum (EIP-55). */
const checksum = (address: string): string => getAddress(address.toLowerCase());

type TypedDataDoc = {
  readonly types: Record<string, ReadonlyArray<{ readonly name: string; readonly type: string }>>;
  readonly primaryType: string;
  readonly domain: Record<string, unknown>;
  readonly message: Record<string, unknown>;
};

/* trade.eip712 verbatim (addresses lowercased) from the 0x-examples README output. */
const REAL: TypedDataDoc = {
  types: {
    PermitWitnessTransferFrom: [
      {
        name: "permitted",
        type: "TokenPermissions",
      },
      {
        name: "spender",
        type: "address",
      },
      {
        name: "nonce",
        type: "uint256",
      },
      {
        name: "deadline",
        type: "uint256",
      },
      {
        name: "slippageAndActions",
        type: "SlippageAndActions",
      },
    ],
    EIP712Domain: [
      {
        name: "name",
        type: "string",
      },
      {
        name: "chainId",
        type: "uint256",
      },
      {
        name: "verifyingContract",
        type: "address",
      },
    ],
    TokenPermissions: [
      {
        name: "token",
        type: "address",
      },
      {
        name: "amount",
        type: "uint256",
      },
    ],
    SlippageAndActions: [
      {
        name: "recipient",
        type: "address",
      },
      {
        name: "buyToken",
        type: "address",
      },
      {
        name: "minAmountOut",
        type: "uint256",
      },
      {
        name: "actions",
        type: "bytes[]",
      },
    ],
  },
  domain: {
    name: "Permit2",
    chainId: 8453,
    verifyingContract: "0x000000000022d473030f116ddee9f6b43ac78ba3",
  },
  message: {
    permitted: {
      token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      amount: "100000",
    },
    spender: "0x5ce929ddb01804bff35b2f5c77b735bdb094aac8",
    nonce: "2241959297937691820908574931991581",
    deadline: "1721085355",
    slippageAndActions: {
      recipient: "0x4d2a422db44144996e855ce15fb581a477dbb947",
      buyToken: "0x4200000000000000000000000000000000000006",
      minAmountOut: "25345560227526",
      actions: [
        "0x0dfeb4190000000000000000000000005ce929ddb01804bff35b2f5c77b735bdb094aac8000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000000186a00000000000000000000000000000000000006e898131631616b1779bad70bc1d000000000000000000000000000000000000000000000000000000006695adab",
        "0x38c9c147000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000000000539000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000044a9059cbb0000000000000000000000009f6601854dee374b1bfaf6350ffd27a97309d431000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        "0x38c9c147000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000000002710000000000000000000000000195fbc5b8fbd5ac739c1ba57d4ef6d5a704f34f7000000000000000000000000000000000000000000000000000000000000006400000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000104b858183f000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000800000000000000000000000005ce929ddb01804bff35b2f5c77b735bdb094aac800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002b833589fcd6edb6e08f4c7c32d4f71b54bda02913002710420000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      ],
    },
  },
  primaryType: "PermitWitnessTransferFrom",
};

const REAL_HASH = "0x955f2009cc0fafa4f37de4ff5220a3d9028b4cf47f66bbeb09a916cc09fefbc7";
const REAL_SIGNATURE =
  "0x06e359425b5ff37cee27452d927a98e19161011141467822582476e3c75a8d71559f37a9a9b28783e61f228238eb10035d55bd07d0800c9de28b72be3cac18c91b";
const REAL_SIGNER = "0x4d2a422db44144996e855ce15fb581a477dbb947";

const viemArgs = (data: TypedDataDoc) => {
  const args = {
    domain: {
      ...data.domain,
      verifyingContract: String(data.domain["verifyingContract"]).toLowerCase(),
    },
    types: data.types,
    primaryType: data.primaryType,
    message: Object.fromEntries(
      Object.entries(data.message).map(([key, value]) => {
        const declared = data.types[data.primaryType]?.find((field) => field.name === key);
        return [
          key,
          typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
            ? value.toLowerCase()
            : declared !== undefined && declared.type.startsWith("uint")
              ? BigInt(String(value))
              : value,
        ];
      }),
    ),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- identical runtime shape; viem's TypedData types are nominal
  return args as never;
};

const digest = (data: TypedDataDoc): string => hashTypedData(viemArgs(data));

/* The real document must hash to the published tradeHash and recover the published signer. */
const realDigest = digest(REAL);
if (realDigest !== REAL_HASH) {
  throw new Error(`hashTypedData ${realDigest} != published tradeHash ${REAL_HASH}`);
}
const recovered = await recoverTypedDataAddress({
  ...viemArgs(REAL),
  signature: REAL_SIGNATURE,
});
if (recovered.toLowerCase() !== REAL_SIGNER) {
  throw new Error(`recovered ${recovered} != ${REAL_SIGNER}`);
}
/* The README's spender is a chain-8453 feature-3 settler — an earlier redeploy than the
   current owner; find the nonce it derives at to prove it is a MetaTxn Settler, not the
   current one. */
const baseSpender = String(REAL.message["spender"]).toLowerCase();
let baseNonce: number | undefined;
for (let nonce = 1; nonce <= 256 && baseNonce === undefined; nonce++) {
  if (settler(8453, 3n, nonce).toLowerCase() === baseSpender) {
    baseNonce = nonce;
  }
}
if (baseNonce === undefined) {
  throw new Error("the real document's spender is not a feature-3 Settler on chain 8453");
}

type Variant = {
  readonly description: string;
  readonly data: TypedDataDoc;
  readonly network: string;
  readonly expected: "order" | "variant";
};

const base = (
  chainId: number,
  patch: (m: Record<string, unknown>) => void = () => {},
): TypedDataDoc => {
  const message = structuredClone(REAL.message);
  patch(message);
  return {
    ...REAL,
    domain: { name: "Permit2", chainId, verifyingContract: PERMIT2 },
    message,
  };
};

const deadlinePast = (message: Record<string, unknown>) => {
  message["deadline"] = "2000000000";
};

const mainnet = (patch: (m: Record<string, unknown>) => void): TypedDataDoc =>
  base(1, (m) => {
    deadlinePast(m);
    m["permitted"] = { token: MAINNET_USDC, amount: "1000000" };
    m["slippageAndActions"] = {
      recipient: account.address,
      buyToken: MAINNET_WETH,
      minAmountOut: "400000000000000",
      actions: ["0x1234", "0x"],
    };
    patch(m);
  });

const near = (description: string, data: TypedDataDoc, network?: string): Variant => ({
  description,
  data,
  network: network ?? `eip155:${String(data.domain["chainId"])}`,
  expected: "variant",
});

const variants: Variant[] = [
  {
    description: "valid mainnet order to the current feature-3 Settler",
    data: mainnet((m) => {
      m["spender"] = settler(1, 3n, 20);
    }),
    network: "eip155:1",
    expected: "order",
  },
  near(
    "a taker-feature Settler as spender",
    mainnet((m) => {
      m["spender"] = settler(1, 2n, 20);
    }),
  ),
  near(
    "the AllowanceHolder as spender",
    mainnet((m) => {
      m["spender"] = ALLOWANCE_HOLDER;
    }),
  ),
  near(
    "a zero minAmountOut (the contract treats it as no bound)",
    mainnet((m) => {
      m["spender"] = settler(1, 3n, 20);
      (m["slippageAndActions"] as Record<string, unknown>)["minAmountOut"] = "0";
    }),
  ),
  near("an extra type entry", {
    ...mainnet((m) => {
      m["spender"] = settler(1, 3n, 20);
    }),
    types: {
      ...REAL.types,
      PermitTokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
  }),
  /* The request's chain is not the domain's; the spender stays a feature-3 Settler on the
     request chain so the domain check is the only guard that rejects this document. */
  near(
    "a request chain that is not the document's",
    mainnet((m) => {
      m["spender"] = baseSpender;
    }),
    "eip155:8453",
  ),
  {
    description: "a native buyToken (0xEeee… sentinel)",
    data: mainnet((m) => {
      m["spender"] = settler(1, 3n, 20);
      (m["slippageAndActions"] as Record<string, unknown>)["buyToken"] = NATIVE_SENTINEL;
    }),
    network: "eip155:1",
    expected: "order",
  },
  near("the PermitBatchWitnessTransferFrom batch form 0x gasless does not use", {
    ...REAL,
    domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2 },
    types: {
      EIP712Domain: REAL.types["EIP712Domain"] ?? [],
      TokenPermissions: REAL.types["TokenPermissions"] ?? [],
      SlippageAndActions: REAL.types["SlippageAndActions"] ?? [],
      PermitBatchWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions[]" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "slippageAndActions", type: "SlippageAndActions" },
      ],
    },
    primaryType: "PermitBatchWitnessTransferFrom",
    message: {
      permitted: [{ token: MAINNET_USDC, amount: "1000000" }],
      spender: settler(1, 3n, 20),
      nonce: "1",
      deadline: "2000000000",
      slippageAndActions: {
        recipient: account.address,
        buyToken: MAINNET_WETH,
        minAmountOut: "400000000000000",
        actions: ["0x1234"],
      },
    },
  }),
];

const signed: Array<Record<string, unknown>> = [];
for (const variant of variants) {
  signed.push({
    ...variant,
    digest: digest(variant.data),
    signature: await account.signTypedData(viemArgs(variant.data)),
  });
}

const orderExpected = {
  protocol: "0x",
  maker: checksum(REAL_SIGNER),
  give: {
    asset: checksum("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
    amount: "100000",
    symbol: "USDC",
    decimals: 6,
  },
  receive: [
    {
      recipient: checksum(REAL_SIGNER),
      amount: {
        asset: checksum("0x4200000000000000000000000000000000000006"),
        amount: "25345560227526",
        symbol: "WETH",
        decimals: 18,
      },
    },
  ],
  expiry: 1721085355,
  partialFill: false,
};

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      source:
        "0xProject/0x-examples@3b296df0c46f31298b631442e14d67a16be2f97d " +
        "gasless-v2-headless-example/README.md (trade.eip712, trade.hash, tradeSignature — " +
        "published 0x gasless-v2 API response). MetaTxn Settler owners probed via Deployer " +
        "ownerOf(3) on chains 1,10,56,137,8453,999,42161,43114,11155111.",
      key: TEST_KEY,
      account: account.address,
      real: {
        description: "the published 0x gasless-v2 Base document (USDC → WETH)",
        data: REAL,
        signer: checksum(REAL_SIGNER),
        digest: REAL_HASH,
        signature: REAL_SIGNATURE,
        expected: orderExpected,
      },
      signed,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${OUT}: 1 real document, ${signed.length} signed variants`);
