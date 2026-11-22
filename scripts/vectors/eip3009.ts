/// <reference types="node" />
/**
 * Regenerates vectors/chains/eip3009.json: the EIP-3009 authorizations of the ERC-7730
 * clear-signing registry corpus (LedgerHQ/clear-signing-erc7730-registry at
 * 3d332d5fb832b78e4745ee6c7046a0c2ea100426 — the 11 test documents under registry/circle|tether|
 * zkstables/tests* listed inline below), each with its viem `hashTypedData` digest and the fields
 * the decoder must recover.
 *
 * The expected decoded fields follow the registry descriptor's display paths
 * (registry/circle/eip712-TransferWithAuthorization.json at the same commit: From =
 * `$.data.message.from`, To = `$.data.message.to`, Amount = `$.data.message.value` of token `@.to`
 * — the domain's verifyingContract —, Valid after = `$.data.message.validAfter`, Valid before =
 * `$.data.message.validBefore`; the bytes32 nonce is `visible: never` — shown verbatim only on
 * `CancelAuthorization`, where it names the authorization being cancelled).
 *
 * `resigned` re-issues one document per primary type with `from`/`authorizer` replaced by the fixed
 * test key's address and a viem signature — the tests check our EIP-712 signer produces the same
 * signature. `nearMisses` are claimed-shaped variants the decoder must leave blind
 * (`typed-data-variant`): a `from`/`authorizer` that is not the signer, a retyped or extra field, a
 * domain chain id that is not the request's, a salt-only domain, and a `validAfter` beyond uint48.
 *
 * Run from the repo root: bun scripts/vectors/eip3009.ts
 */
import { writeFileSync } from "node:fs";

import { getAddress, hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const OUT = "vectors/chains/eip3009.json";

/* The evm.json test key (anvil account 0) — the re-signed variants are signed by its account. */
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(TEST_KEY);

type TypedDataDoc = {
  readonly types: Record<string, ReadonlyArray<{ readonly name: string; readonly type: string }>>;
  readonly primaryType: string;
  readonly domain: Record<string, unknown>;
  readonly message: Record<string, unknown>;
};

const REGISTRY_DOCS: ReadonlyArray<{
  readonly origin: string;
  readonly description: string;
  readonly data: TypedDataDoc;
}> = [
  {
    origin: "circle/tests/eip712-TransferWithAuthorization.tests.json",
    description: "CoinGecko x402 v2 - USDC transfer authorization for onchain DEX pool search API",
    data: {
      types: {
        EIP712Domain: [
          {
            name: "name",
            type: "string",
          },
          {
            name: "version",
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
        TransferWithAuthorization: [
          {
            name: "from",
            type: "address",
          },
          {
            name: "to",
            type: "address",
          },
          {
            name: "value",
            type: "uint256",
          },
          {
            name: "validAfter",
            type: "uint256",
          },
          {
            name: "validBefore",
            type: "uint256",
          },
          {
            name: "nonce",
            type: "bytes32",
          },
        ],
      },
      primaryType: "TransferWithAuthorization",
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
      message: {
        from: "0x1234567890123456789012345678901234567890",
        to: "0x110cdBba7FE6434Ec4CE3464CC523942ad6Fb784",
        value: "10000",
        validAfter: "0",
        validBefore: "1738886400",
        nonce: "0x0000000000000000000000000000000000000000000000000000000000000001",
      },
    },
  },
  {
    origin: "circle/tests/eip712-TransferWithAuthorization.tests.json",
    description: "Zapper x402 v1 - USDC transfer authorization for token price API",
    data: {
      types: {
        EIP712Domain: [
          {
            name: "name",
            type: "string",
          },
          {
            name: "version",
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
        TransferWithAuthorization: [
          {
            name: "from",
            type: "address",
          },
          {
            name: "to",
            type: "address",
          },
          {
            name: "value",
            type: "uint256",
          },
          {
            name: "validAfter",
            type: "uint256",
          },
          {
            name: "validBefore",
            type: "uint256",
          },
          {
            name: "nonce",
            type: "bytes32",
          },
        ],
      },
      primaryType: "TransferWithAuthorization",
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
      message: {
        from: "0xABCDEF0123456789ABCDEF0123456789ABCDEF01",
        to: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
        value: "3000",
        validAfter: "0",
        validBefore: "1738886410",
        nonce: "0x0000000000000000000000000000000000000000000000000000000000000002",
      },
    },
  },
  {
    origin: "circle/tests/eip712-TransferWithAuthorization.tests.json",
    description: "x402Factory x402 v1 - USDC transfer authorization for text-to-speech API",
    data: {
      types: {
        EIP712Domain: [
          {
            name: "name",
            type: "string",
          },
          {
            name: "version",
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
        TransferWithAuthorization: [
          {
            name: "from",
            type: "address",
          },
          {
            name: "to",
            type: "address",
          },
          {
            name: "value",
            type: "uint256",
          },
          {
            name: "validAfter",
            type: "uint256",
          },
          {
            name: "validBefore",
            type: "uint256",
          },
          {
            name: "nonce",
            type: "bytes32",
          },
        ],
      },
      primaryType: "TransferWithAuthorization",
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
      message: {
        from: "0x9876543210987654321098765432109876543210",
        to: "0x402FaCcC3fAeb72351CC2b68C7966faF5f22B0d4",
        value: "300000",
        validAfter: "0",
        validBefore: "1738886460",
        nonce: "0x0000000000000000000000000000000000000000000000000000000000000003",
      },
    },
  },
  {
    origin: "circle/tests/eip712-TransferWithAuthorization.tests.json",
    description: "SilverbackDeFi x402 v2 - USDC transfer authorization for pool analysis API",
    data: {
      types: {
        EIP712Domain: [
          {
            name: "name",
            type: "string",
          },
          {
            name: "version",
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
        TransferWithAuthorization: [
          {
            name: "from",
            type: "address",
          },
          {
            name: "to",
            type: "address",
          },
          {
            name: "value",
            type: "uint256",
          },
          {
            name: "validAfter",
            type: "uint256",
          },
          {
            name: "validBefore",
            type: "uint256",
          },
          {
            name: "nonce",
            type: "bytes32",
          },
        ],
      },
      primaryType: "TransferWithAuthorization",
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
      message: {
        from: "0xFEDCBA9876543210FEDCBA9876543210FEDCBA98",
        to: "0xD34411a70EffbDd000c529bbF572082ffDcF1794",
        value: "5000",
        validAfter: "0",
        validBefore: "1738886700",
        nonce: "0x0000000000000000000000000000000000000000000000000000000000000004",
      },
    },
  },
  {
    origin: "circle/tests/eip712-TransferWithAuthorization.tests.json",
    description: "Nittarab x402 v1 - USDC transfer authorization for secret content API",
    data: {
      types: {
        EIP712Domain: [
          {
            name: "name",
            type: "string",
          },
          {
            name: "version",
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
        TransferWithAuthorization: [
          {
            name: "from",
            type: "address",
          },
          {
            name: "to",
            type: "address",
          },
          {
            name: "value",
            type: "uint256",
          },
          {
            name: "validAfter",
            type: "uint256",
          },
          {
            name: "validBefore",
            type: "uint256",
          },
          {
            name: "nonce",
            type: "bytes32",
          },
        ],
      },
      primaryType: "TransferWithAuthorization",
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 8453,
        verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
      message: {
        from: "0x0123456789ABCDEF0123456789ABCDEF01234567",
        to: "0x89764c3dEd721c29999A237cF935a34e1C8EDf97",
        value: "50000",
        validAfter: "0",
        validBefore: "1738886700",
        nonce: "0x0000000000000000000000000000000000000000000000000000000000000005",
      },
    },
  },
  {
    origin: "circle/tests/eip712-ReceiveWithAuthorization.tests.json",
    description: "USDC receive authorization on Arbitrum",
    data: {
      types: {
        EIP712Domain: [
          {
            name: "name",
            type: "string",
          },
          {
            name: "version",
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
        ReceiveWithAuthorization: [
          {
            name: "from",
            type: "address",
          },
          {
            name: "to",
            type: "address",
          },
          {
            name: "value",
            type: "uint256",
          },
          {
            name: "validAfter",
            type: "uint256",
          },
          {
            name: "validBefore",
            type: "uint256",
          },
          {
            name: "nonce",
            type: "bytes32",
          },
        ],
      },
      primaryType: "ReceiveWithAuthorization",
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: 42161,
        verifyingContract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      },
      message: {
        from: "0x9d7ae84c1e55c0f2dfd6909a88ba93f48617e750",
        to: "0xa95d9c1f655341597c94393fddc30cf3c08e4fce",
        value: "8080000",
        validAfter: "1772641538",
        validBefore: "1772645198",
        nonce: "0x433e3aad3b685127a168b6faca79fbddc1cb3f8d019325500b3c71baebb6e5ca",
      },
    },
  },
  {
    origin: "tether/testsv2/eip712-TransferWithAuthorization-usdt0-Flare.tests.json",
    description: "Authorize a USDT0 transfer",
    data: {
      types: {
        EIP712Domain: [
          {
            name: "name",
            type: "string",
          },
          {
            name: "version",
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
        TransferWithAuthorization: [
          {
            name: "from",
            type: "address",
          },
          {
            name: "to",
            type: "address",
          },
          {
            name: "value",
            type: "uint256",
          },
          {
            name: "validAfter",
            type: "uint256",
          },
          {
            name: "validBefore",
            type: "uint256",
          },
          {
            name: "nonce",
            type: "bytes32",
          },
        ],
      },
      primaryType: "TransferWithAuthorization",
      domain: {
        name: "USD\u20AE0",
        version: "1",
        chainId: 14,
        verifyingContract: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D",
      },
      message: {
        from: "0x3333333333333333333333333333333333333333",
        to: "0x1111111111111111111111111111111111111111",
        value: "100000000",
        validAfter: "1738886400",
        validBefore: "1782864000",
        nonce: "0x4444444444444444444444444444444444444444444444444444444444444444",
      },
    },
  },
  {
    origin: "tether/testsv2/eip712-ReceiveWithAuthorization-usdt0-Flare.tests.json",
    description: "Authorize a USDT0 receipt",
    data: {
      types: {
        EIP712Domain: [
          {
            name: "name",
            type: "string",
          },
          {
            name: "version",
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
        ReceiveWithAuthorization: [
          {
            name: "from",
            type: "address",
          },
          {
            name: "to",
            type: "address",
          },
          {
            name: "value",
            type: "uint256",
          },
          {
            name: "validAfter",
            type: "uint256",
          },
          {
            name: "validBefore",
            type: "uint256",
          },
          {
            name: "nonce",
            type: "bytes32",
          },
        ],
      },
      primaryType: "ReceiveWithAuthorization",
      domain: {
        name: "USD\u20AE0",
        version: "1",
        chainId: 14,
        verifyingContract: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D",
      },
      message: {
        from: "0x3333333333333333333333333333333333333333",
        to: "0x1111111111111111111111111111111111111111",
        value: "100000000",
        validAfter: "1738886400",
        validBefore: "1782864000",
        nonce: "0x4444444444444444444444444444444444444444444444444444444444444444",
      },
    },
  },
  {
    origin: "tether/testsv2/eip712-CancelAuthorization-usdt0-Flare.tests.json",
    description: "Cancel a USDT0 authorization",
    data: {
      types: {
        EIP712Domain: [
          {
            name: "name",
            type: "string",
          },
          {
            name: "version",
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
        CancelAuthorization: [
          {
            name: "authorizer",
            type: "address",
          },
          {
            name: "nonce",
            type: "bytes32",
          },
        ],
      },
      primaryType: "CancelAuthorization",
      domain: {
        name: "USD\u20AE0",
        version: "1",
        chainId: 14,
        verifyingContract: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D",
      },
      message: {
        authorizer: "0x3333333333333333333333333333333333333333",
        nonce: "0x4444444444444444444444444444444444444444444444444444444444444444",
      },
    },
  },
  {
    origin: "zkstables/testsv2/eip712-zkemt.tests.json",
    description: "TransferWithAuthorization",
    data: {
      domain: {
        name: "ZK Stables USD",
        version: "1",
        chainId: 8453,
        verifyingContract: "0x8ED36a645beF11075283524C01acA742CbAfC832",
      },
      primaryType: "TransferWithAuthorization",
      types: {
        EIP712Domain: [
          {
            name: "name",
            type: "string",
          },
          {
            name: "version",
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
        TransferWithAuthorization: [
          {
            name: "from",
            type: "address",
          },
          {
            name: "to",
            type: "address",
          },
          {
            name: "value",
            type: "uint256",
          },
          {
            name: "validAfter",
            type: "uint256",
          },
          {
            name: "validBefore",
            type: "uint256",
          },
          {
            name: "nonce",
            type: "bytes32",
          },
        ],
      },
      message: {
        from: "0xE6455dEC538F906D28f6910c531e02F560E2f1f9",
        to: "0x1111111111111111111111111111111111111111",
        value: "21370000",
        validAfter: "1767225600",
        validBefore: "1767225600",
        nonce: "0xefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
      },
    },
  },
  {
    origin: "zkstables/testsv2/eip712-zkemt.tests.json",
    description: "ReceiveWithAuthorization",
    data: {
      domain: {
        name: "ZK Stables USD",
        version: "1",
        chainId: 8453,
        verifyingContract: "0x8ED36a645beF11075283524C01acA742CbAfC832",
      },
      primaryType: "ReceiveWithAuthorization",
      types: {
        EIP712Domain: [
          {
            name: "name",
            type: "string",
          },
          {
            name: "version",
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
        ReceiveWithAuthorization: [
          {
            name: "from",
            type: "address",
          },
          {
            name: "to",
            type: "address",
          },
          {
            name: "value",
            type: "uint256",
          },
          {
            name: "validAfter",
            type: "uint256",
          },
          {
            name: "validBefore",
            type: "uint256",
          },
          {
            name: "nonce",
            type: "bytes32",
          },
        ],
      },
      message: {
        from: "0xE6455dEC538F906D28f6910c531e02F560E2f1f9",
        to: "0x1111111111111111111111111111111111111111",
        value: "21370000",
        validAfter: "1767225600",
        validBefore: "1767225600",
        nonce: "0xefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
      },
    },
  },
];

/* The registry corpus writes addresses unchecksummed and uints as decimal strings; viem
   validates EIP-55 and wants bigint uints — the encoded values are unchanged. */
const viemArgs = (data: TypedDataDoc): never => {
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

const LISTED = new Set([
  /* Base USDC and Arbitrum USDC are in the built-in token table; Flare USDT0 and zkstables
     are not. */
  "8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831",
]);

const MAX_UINT48 = 2n ** 48n;

const clone = (data: TypedDataDoc): TypedDataDoc => structuredClone(data);

/* One re-signed document per primary type: `from`/`authorizer` replaced by the test key's
   account, then signed by it. */
const resigned = await Promise.all(
  REGISTRY_DOCS.filter(
    (doc, index) =>
      REGISTRY_DOCS.findIndex((other) => other.data.primaryType === doc.data.primaryType) === index,
  ).map(async (doc) => {
    const data = clone(doc.data);
    if ("from" in data.message) {
      data.message["from"] = account.address;
    } else {
      data.message["authorizer"] = account.address;
    }
    const signature = await account.signTypedData(viemArgs(data));
    return { data, signature, digest: digest(data) };
  }),
);

const first = (primaryType: string): TypedDataDoc => {
  const found = REGISTRY_DOCS.find((doc) => doc.data.primaryType === primaryType);
  if (found === undefined) {
    throw new Error(`no registry document for ${primaryType}`);
  }
  return clone(found.data);
};

/* The request context each variant is presented under: the request's own signer and network —
   the document inside may name a different `from`/`authorizer` or chain id. */
const miss = (
  description: string,
  data: TypedDataDoc,
  signer: string,
  network: string,
): { description: string; data: TypedDataDoc; signer: string; network: string } => ({
  description,
  data,
  signer,
  network,
});

const ORIGINAL_TRANSFER = first("TransferWithAuthorization");
const ORIGINAL_CANCEL = first("CancelAuthorization");

const nearMisses: ReadonlyArray<{
  readonly description: string;
  readonly data: TypedDataDoc;
  readonly signer: string;
  readonly network: string;
}> = (() => {
  const fromNotSigner = first("TransferWithAuthorization");
  fromNotSigner.message["from"] = "0x00000000000000000000000000000000baadf00d";
  const extraField = first("TransferWithAuthorization");
  extraField.types[extraField.primaryType] = [
    ...(extraField.types[extraField.primaryType] ?? []),
    { name: "extra", type: "uint256" },
  ];
  extraField.message["extra"] = "1";
  const retyped = first("TransferWithAuthorization");
  const retypedFields = [...(retyped.types[retyped.primaryType] ?? [])];
  const valueIndex = retypedFields.findIndex((field) => field.name === "value");
  if (valueIndex === -1) {
    throw new Error("TransferWithAuthorization has no value field");
  }
  retypedFields[valueIndex] = { name: "value", type: "uint128" };
  retyped.types[retyped.primaryType] = retypedFields;
  const wrongChain = first("TransferWithAuthorization");
  wrongChain.domain["chainId"] = 999999;
  const saltOnly = first("TransferWithAuthorization");
  delete saltOnly.domain["chainId"];
  saltOnly.domain["salt"] = `0x${"00".repeat(32)}`;
  saltOnly.types["EIP712Domain"] = [
    ...(saltOnly.types["EIP712Domain"] ?? []).filter((field) => field.name !== "chainId"),
    { name: "salt", type: "bytes32" },
  ];
  const lateValid = first("TransferWithAuthorization");
  lateValid.message["validAfter"] = MAX_UINT48.toString();
  const cancelNotSigner = first("CancelAuthorization");
  cancelNotSigner.message["authorizer"] = "0x00000000000000000000000000000000baadf00d";
  const transferSigner = getAddress(String(ORIGINAL_TRANSFER.message["from"]).toLowerCase());
  const cancelSigner = getAddress(String(ORIGINAL_CANCEL.message["authorizer"]).toLowerCase());
  const chain8453 = "eip155:8453";
  return [
    miss("from is not the signer", fromNotSigner, transferSigner, chain8453),
    miss("an extra field", extraField, transferSigner, chain8453),
    miss("a retyped field", retyped, transferSigner, chain8453),
    miss("a domain chain id that is not the request's", wrongChain, transferSigner, chain8453),
    miss("a salt-only domain", saltOnly, transferSigner, chain8453),
    miss("a validAfter beyond uint48", lateValid, transferSigner, chain8453),
    miss(
      "CancelAuthorization whose authorizer is not the signer",
      cancelNotSigner,
      cancelSigner,
      "eip155:14",
    ),
  ];
})();

const docs: Array<Record<string, unknown>> = [];
for (const doc of REGISTRY_DOCS) {
  const { data } = doc;
  const { message } = data;
  const signer = getAddress(String(message["from"] ?? message["authorizer"]).toLowerCase());
  const listed = LISTED.has(
    `${String(data.domain["chainId"])}:${String(data.domain["verifyingContract"]).toLowerCase()}`,
  );
  const token = getAddress(String(data.domain["verifyingContract"]).toLowerCase());
  const expected: Record<string, unknown> =
    data.primaryType === "CancelAuthorization"
      ? {
          kind: "cancel",
          token,
          nonce: String(message["nonce"]).toLowerCase(),
          summary: "message",
          verifiability: "full",
        }
      : {
          kind: data.primaryType === "TransferWithAuthorization" ? "transfer" : "receive",
          to: getAddress(String(message["to"]).toLowerCase()),
          amount: {
            asset: token,
            amount: String(message["value"]),
            ...(listed ? { symbol: "USDC", decimals: 6 } : {}),
          },
          validAfter: Number(message["validAfter"]),
          ...(BigInt(String(message["validBefore"])) < MAX_UINT48
            ? { validBefore: Number(message["validBefore"]) }
            : {}),
          summary: "transfer",
          verifiability: listed ? "full" : "partial",
        };
  docs.push({ ...doc, signer, digest: digest(data), expected });
}

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      source:
        "LedgerHQ/clear-signing-erc7730-registry@3d332d5fb832b78e4745ee6c7046a0c2ea100426 " +
        "registry/{circle,tether,zkstables}/tests*/eip712-*.json; display mapping " +
        "registry/circle/eip712-TransferWithAuthorization.json (From=from, To=to, " +
        "Amount=value @.to, Valid after/before; nonce visible:never).",
      key: TEST_KEY,
      account: account.address,
      docs,
      resigned,
      nearMisses: nearMisses.map((miss) => ({ ...miss, digest: digest(miss.data) })),
    },
    null,
    2,
  )}\n`,
);
console.log(
  `wrote ${OUT}: ${docs.length} docs, ${resigned.length} resigned, ${nearMisses.length} near misses`,
);
