/// <reference types="node" />
/**
 * Regenerates vectors/chains/polymarket.json — Polymarket typed-data documents as a dApp delivers
 * them for signing, each with its EIP-712 digest and ECDSA signature.
 *
 * Oracles: @polymarket/clob-client-v2 1.2.1 (OrderBuilder.buildOrder / createL1Headers) builds the
 * orders and the ClobAuth signature through a viem `WalletClient` shim whose `signTypedData`
 * captures the exact parameters the SDK asks the wallet to sign and signs them with the fixed test
 * key. The SDK strips `types.EIP712Domain` before calling the signer (its buildOrderSignature
 * deletes the entry); the recorded document re-adds the field list derived from the domain keys —
 * the wallet's typed-data contract requires it and the signed bytes are unchanged. `Math.random`
 * and `Date.now` are stubbed inside `stubbed` (the SDK's salt is `Math.round(Math.random() *
 * Date.now())` and its timestamp `Date.now()`), so the file is deterministic. Digests come from
 * viem `hashTypedData` and are cross-checked with
 *
 * @metamask/eth-sig-util; Batch documents are built from the docs JSON and signed with viem. The
 * published ClobAuth signature (refs/clob-client-v2 tests/signing/eip712.test.ts) is asserted
 * verbatim. `onchain`: `hashOrder` on the exchange over publicnode, asserted equal to the digest
 * for plain orders (the 1271 envelope is checked against the app digest its blob carries).
 *
 * Run from the repo root: bun scripts/vectors/polymarket.ts (needs network access for onchain)
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { SignTypedDataVersion, TypedDataUtils } from "@metamask/eth-sig-util";
import type { MessageTypes, TypedMessage } from "@metamask/eth-sig-util";
import {
  Chain,
  OrderBuilder,
  SignatureTypeV2,
  Side,
  createL1Headers,
} from "@polymarket/clob-client-v2";
import type { UserOrderV2 } from "@polymarket/clob-client-v2";
import {
  concat,
  createPublicClient,
  getAddress,
  hashTypedData,
  hexToString,
  http,
  keccak256,
  parseAbi,
} from "viem";
import type { WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";

type Field = { readonly name: string; readonly type: string };
type Types = Record<string, ReadonlyArray<Field>>;
type Doc = {
  readonly types: Types;
  readonly primaryType: string;
  readonly domain: Record<string, unknown>;
  readonly message: Record<string, unknown>;
};

/* The clob-client test key — signatures are only test vectors. */
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const ACCOUNT = privateKeyToAccount(KEY);
const PROXY = "0x1000000000000000000000000000000000000001";
const SAFE = "0x2000000000000000000000000000000000000002";
const DEPOSIT_WALLET = "0x3000000000000000000000000000000000000003";
const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const CTF_POLYGON = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const CTF_AMOY = "0x69308FB512518e39F9b16112fA8d994F4e2Bf8bB";
const POSITION_MANAGER = "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF";

const assert: (ok: boolean, what: string) => asserts ok = (ok, what) => {
  if (!ok) {
    throw new Error(`polymarket vector oracle mismatch: ${what}`);
  }
};

/* eth-sig-util's TypedMessage wants mutable field arrays — the same document shape the script
   records. */
const asMessage = (
  doc: Doc,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- identical runtime shape
): TypedMessage<MessageTypes> => doc as TypedMessage<MessageTypes>;

/* The SDK's message values are always hex strings or decimal strings; `Record` cannot say so. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- message values are hex
const hx = (value: unknown): `0x${string}` => value as `0x${string}`;
const str = String;

const digestOf = (doc: Doc): `0x${string}` => {
  const digest =
    `0x${TypedDataUtils.eip712Hash(asMessage(doc), SignTypedDataVersion.V4).toString("hex")}` as const;
  const viem = hashTypedData(doc);
  assert(viem === digest, `viem and eth-sig-util disagree on ${doc.primaryType}`);
  return digest;
};

const sign = async (doc: Doc): Promise<`0x${string}`> => ACCOUNT.signTypedData(doc);

/* Runs `fn` with the SDK's two entropy sources pinned: the order salt and the message timestamp. */
const stubbed = async <T>(saltSeed: number, ms: number, fn: () => Promise<T>): Promise<T> => {
  const { random } = Math;
  const { now } = Date;
  Math.random = () => saltSeed;
  Date.now = () => ms;
  try {
    return await fn();
  } finally {
    Math.random = random;
    Date.now = now;
  }
};

/* clob-client-v2 order-utils/model/eip712.ts EIP712_DOMAIN; ClobAuth's domain has no
   verifyingContract, so the wallet-facing type list is derived from the domain keys present. */
const EIP712_DOMAIN: ReadonlyArray<Field> = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
];
const domainType = (domain: Record<string, unknown>): ReadonlyArray<Field> =>
  EIP712_DOMAIN.filter((field) => domain[field.name] !== undefined);

/** The wallet-facing document: the SDK's parameters plus the EIP712Domain types entry it strips. */
const docOf = (params: {
  domain: Record<string, unknown>;
  types: Types;
  primaryType: string;
  message: Record<string, unknown>;
}): Doc => ({
  types: { EIP712Domain: domainType(params.domain), ...params.types },
  primaryType: params.primaryType,
  domain: params.domain,
  message: params.message,
});

type SignerParams = {
  readonly domain: Record<string, unknown>;
  readonly types: Types;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
};

/**
 * A `ClobSigner` wallet-client shim: `account` resolves the address checks, `signTypedData`
 * captures the document and signs it with the fixed key.
 */
const signerFor = (capture: Doc[]): WalletClient => {
  const client = {
    account: ACCOUNT,
    signTypedData: async (params: SignerParams) => {
      const doc = docOf(params);
      capture.push(doc);
      return sign(doc);
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SDK only calls signTypedData and reads account.address
  return client as unknown as WalletClient;
};

/* Exchange rows mirroring the decoder's allow-list (docs contracts.md, config.ts, on-chain). */
const EXCHANGE = {
  ctf: {
    chainId: 137,
    address: "0xE111180000d2663C0091e4f400237545B87B996B",
    version: "2",
    name: "CTF Exchange",
    outcomeToken: CTF_POLYGON,
  },
  negRisk: {
    chainId: 137,
    address: "0xe2222d279d744050d28e00520010520000310F59",
    version: "2",
    name: "Neg Risk CTF Exchange",
    outcomeToken: CTF_POLYGON,
  },
  v3: {
    chainId: 137,
    address: "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa",
    version: "3",
    name: "Exchange V3",
    outcomeToken: POSITION_MANAGER,
  },
  amoyCtf: {
    chainId: 80002,
    address: "0xE111180000d2663C0091e4f400237545B87B996B",
    version: "2",
    name: "CTF Exchange",
    outcomeToken: CTF_AMOY,
  },
} as const;
type Exchange = (typeof EXCHANGE)[keyof typeof EXCHANGE];

type OrderExpect = {
  readonly kind: "order";
  readonly exchange: { address: string; name: string; version: "2" | "3" };
  readonly side: "buy" | "sell";
  readonly tokenId: string;
  readonly maker: string;
  readonly signer: string;
  readonly wallet: "account" | "proxy" | "safe" | "deposit-wallet";
  readonly give: Record<string, unknown>;
  readonly receive: Record<string, unknown>;
  readonly price: { amount: string; exact: boolean };
  readonly builder?: string;
  readonly metadata?: string;
};

/** The content the decoder produces for an order document; replicates the recognizer's math. */
const orderExpect = (
  message: Record<string, unknown>,
  exchange: Exchange,
  wallet: OrderExpect["wallet"],
): OrderExpect => {
  const buy = message["side"] === 0;
  const makerAmount = BigInt(str(message["makerAmount"]));
  const takerAmount = BigInt(str(message["takerAmount"]));
  const pusd = { asset: PUSD, decimals: 6, symbol: "pUSD" };
  const shares = {
    asset: exchange.outcomeToken,
    decimals: 6,
    tokenId: str(message["tokenId"]),
  };
  const give = buy
    ? { ...pusd, amount: makerAmount.toString(10) }
    : { ...shares, amount: makerAmount.toString(10) };
  const receive = buy
    ? { ...shares, amount: takerAmount.toString(10) }
    : { ...pusd, amount: takerAmount.toString(10) };
  const collateral = buy ? makerAmount : takerAmount;
  const sharesAmt = buy ? takerAmount : makerAmount;
  const numerator = collateral * 1_000_000n;
  const price = numerator / sharesAmt;
  const zero = `0x${"0".repeat(64)}`;
  const meta = str(message["metadata"]);
  const code = str(message["builder"]);
  return {
    kind: "order",
    exchange: {
      address: exchange.address,
      name: exchange.name,
      version: exchange.version,
    },
    side: buy ? "buy" : "sell",
    tokenId: str(message["tokenId"]),
    maker: getAddress(str(message["maker"])),
    signer: getAddress(str(message["signer"])),
    wallet,
    give,
    receive,
    price: { amount: price.toString(10), exact: price * sharesAmt === numerator },
    ...(code === zero ? {} : { builder: code }),
    ...(meta === zero ? {} : { metadata: meta }),
  };
};

const TOKEN_ID = "21742633143463906290569050155826241533067272736897614950488156847949938836455";
const OTHER_TOKEN = "6048711698446802097821302547443908381638681757684206197981905346932645477957";

const clients = {
  polygon: createPublicClient({
    chain: polygon,
    transport: http("https://polygon-bor-rpc.publicnode.com"),
  }),
  amoy: createPublicClient({
    chain: polygonAmoy,
    transport: http("https://polygon-amoy-bor-rpc.publicnode.com"),
  }),
};
const EXCHANGE_ABI = parseAbi([
  "function hashOrder((uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder,bytes signature) order) view returns (bytes32)",
]);

/* hashOrder(order) on the exchange — the digest the contract validates on-chain. */
const onchainHash = async (
  exchange: Exchange,
  message: Record<string, unknown>,
): Promise<{ block: string; hash: string } | "unavailable"> => {
  const client = exchange.chainId === 137 ? clients.polygon : clients.amoy;
  try {
    const block = await client.getBlockNumber();
    const hash = await client.readContract({
      address: hx(exchange.address),
      abi: EXCHANGE_ABI,
      functionName: "hashOrder",
      args: [
        {
          salt: BigInt(str(message["salt"])),
          maker: hx(message["maker"]),
          signer: hx(message["signer"]),
          tokenId: BigInt(str(message["tokenId"])),
          makerAmount: BigInt(str(message["makerAmount"])),
          takerAmount: BigInt(str(message["takerAmount"])),
          side: Number(message["side"]),
          signatureType: Number(message["signatureType"]),
          timestamp: BigInt(str(message["timestamp"])),
          metadata: hx(message["metadata"]),
          builder: hx(message["builder"]),
          signature: "0x",
        },
      ],
    });
    return { block: block.toString(10), hash };
  } catch {
    return "unavailable";
  }
};

type VectorCase = {
  readonly name: string;
  readonly network: string;
  readonly typedData: Doc;
  readonly digest: string;
  readonly signature: string;
  readonly expected: unknown;
  readonly blind?: string;
  readonly onchain?: { block: string; hash: string } | "unavailable";
};

const cases: VectorCase[] = [];

const ORDER_TYPE_STRING =
  "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)";

const pushOrder = async (
  name: string,
  exchange: Exchange,
  doc: Doc,
  signature: string,
  wallet: OrderExpect["wallet"],
): Promise<void> => {
  const message =
    wallet === "deposit-wallet"
      ? ((): Record<string, unknown> => {
          const { contents } = doc.message;
          assert(
            typeof contents === "object" && contents !== null,
            "TypedDataSign contents missing",
          );
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SDK emits a struct
          return contents as Record<string, unknown>;
        })()
      : doc.message;
  const digest = digestOf(doc);
  if (wallet === "deposit-wallet") {
    /* The 1271 blob is innerSig ‖ appDomainSep ‖ contentsHash ‖ contentsType ‖ uint16 len
       (exchangeOrderBuilderV2.ts buildOrderSignature). */
    const blob = signature;
    const innerSig = `0x${blob.slice(2, 132)}`;
    const appDomainSep = hx(`0x${blob.slice(132, 196)}`);
    const contentsHash = hx(`0x${blob.slice(196, 260)}`);
    const typeString = hx(`0x${blob.slice(260, -4)}`);
    const len = blob.slice(-4);
    assert(innerSig === (await sign(doc)), "1271 blob inner signature mismatch");
    const orderStruct = doc.types["Order"];
    assert(orderStruct !== undefined, "Order type missing");
    const computedContents = `0x${TypedDataUtils.hashStruct(
      "Order",
      message,
      { Order: [...orderStruct] },
      SignTypedDataVersion.V4,
    ).toString("hex")}`;
    assert(computedContents === contentsHash, "1271 contentsHash mismatch");
    assert(len === ORDER_TYPE_STRING.length.toString(16).padStart(4, "0"), "1271 len suffix");
    assert(hexToString(typeString) === ORDER_TYPE_STRING, "1271 blob type string");
    /* The app digest the blob carries is keccak(0x1901 ‖ appDomainSep ‖ contentsHash). */
    const appDigest = keccak256(concat(["0x1901", appDomainSep, contentsHash]));
    const onchain = await onchainHash(exchange, message);
    if (onchain !== "unavailable") {
      assert(onchain.hash === appDigest, "on-chain hashOrder != 1271 app digest");
    }
    cases.push({
      name,
      network: `eip155:${exchange.chainId}`,
      typedData: doc,
      digest,
      signature: blob,
      expected: orderExpect(message, exchange, wallet),
      onchain,
    });
    return;
  }
  const onchain = await onchainHash(exchange, message);
  if (onchain !== "unavailable") {
    assert(onchain.hash === digest, `on-chain hashOrder != digest for ${name}`);
  }
  cases.push({
    name,
    network: `eip155:${exchange.chainId}`,
    typedData: doc,
    digest,
    signature,
    expected: orderExpect(message, exchange, wallet),
    onchain,
  });
};

const ORDER_CASES: ReadonlyArray<{
  readonly name: string;
  readonly exchange: Exchange;
  readonly side: Side;
  readonly signatureType?: SignatureTypeV2;
  readonly funder?: string;
  readonly price: number;
  readonly size: number;
  readonly version?: number;
  readonly negRisk?: boolean;
  readonly builderCode?: string;
  readonly metadata?: string;
  readonly wallet: OrderExpect["wallet"];
  readonly saltSeed: number;
}> = [
  {
    name: "CTF Exchange buy (EOA)",
    exchange: EXCHANGE.ctf,
    side: Side.BUY,
    price: 0.5,
    size: 100,
    wallet: "account",
    saltSeed: 0.42,
  },
  {
    name: "CTF Exchange sell (EOA)",
    exchange: EXCHANGE.ctf,
    side: Side.SELL,
    price: 0.5,
    size: 100,
    wallet: "account",
    saltSeed: 0.43,
  },
  {
    name: "Neg Risk CTF Exchange buy (EOA)",
    exchange: EXCHANGE.negRisk,
    side: Side.BUY,
    price: 0.65,
    size: 40,
    negRisk: true,
    wallet: "account",
    saltSeed: 0.44,
  },
  {
    name: "Exchange V3 buy (EOA)",
    exchange: EXCHANGE.v3,
    side: Side.BUY,
    price: 0.5,
    size: 80,
    version: 3,
    wallet: "account",
    saltSeed: 0.45,
  },
  {
    name: "Exchange V3 sell (EOA)",
    exchange: EXCHANGE.v3,
    side: Side.SELL,
    price: 0.75,
    size: 60,
    version: 3,
    wallet: "account",
    saltSeed: 0.46,
  },
  {
    name: "proxy-wallet buy",
    exchange: EXCHANGE.ctf,
    side: Side.BUY,
    signatureType: SignatureTypeV2.POLY_PROXY,
    funder: PROXY,
    price: 0.5,
    size: 25,
    wallet: "proxy",
    saltSeed: 0.47,
  },
  {
    name: "Safe buy",
    exchange: EXCHANGE.ctf,
    side: Side.BUY,
    signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE,
    funder: SAFE,
    price: 0.5,
    size: 25,
    wallet: "safe",
    saltSeed: 0.48,
  },
  {
    name: "deposit-wallet buy (POLY_1271)",
    exchange: EXCHANGE.ctf,
    side: Side.BUY,
    signatureType: SignatureTypeV2.POLY_1271,
    funder: DEPOSIT_WALLET,
    price: 0.5,
    size: 50,
    wallet: "deposit-wallet",
    saltSeed: 0.49,
  },
  {
    name: "Amoy CTF Exchange buy",
    exchange: EXCHANGE.amoyCtf,
    side: Side.BUY,
    price: 0.5,
    size: 10,
    wallet: "account",
    saltSeed: 0.5,
  },
  {
    name: "builder-code order",
    exchange: EXCHANGE.ctf,
    side: Side.BUY,
    price: 0.4,
    size: 50,
    builderCode: "0x6275696c64657200000000000000000000000000000000000000000000000000",
    metadata: "0x6d65746164617461000000000000000000000000000000000000000000000000",
    wallet: "account",
    saltSeed: 0.51,
  },
];

for (const [index, c] of ORDER_CASES.entries()) {
  const capture: Doc[] = [];
  const builder = new OrderBuilder(
    signerFor(capture),
    c.exchange.chainId,
    c.signatureType ?? SignatureTypeV2.EOA,
    c.funder,
  );
  const userOrder: UserOrderV2 = {
    tokenID: index % 2 === 0 ? TOKEN_ID : OTHER_TOKEN,
    price: c.price,
    size: c.size,
    side: c.side,
    ...(c.builderCode === undefined ? {} : { builderCode: c.builderCode }),
    ...(c.metadata === undefined ? {} : { metadata: c.metadata }),
  };
  // oxlint-disable-next-line eslint/no-await-in-loop -- vectors are generated serially, each asserting the last
  const signed = await stubbed(c.saltSeed, 1_777_777_777_000 + index * 60_000, async () =>
    builder.buildOrder(
      userOrder,
      { tickSize: "0.001", negRisk: c.negRisk ?? false },
      c.version ?? 2,
    ),
  );
  const [doc] = capture;
  assert(doc !== undefined, `no typed data captured for ${c.name}`);
  assert(
    doc.primaryType === (c.wallet === "deposit-wallet" ? "TypedDataSign" : "Order"),
    `unexpected primary type for ${c.name}`,
  );
  // oxlint-disable-next-line eslint/no-await-in-loop -- vectors are generated serially, each asserting the last
  await pushOrder(c.name, c.exchange, doc, signed.signature, c.wallet);
}

/* The SDK's rounding (size 2dp · price ≤4dp ≤ the amount precision of every tick) never yields an
   order whose pUSD-per-share ratio does not divide — a non-exact price still reaches the wallet,
   so this document is crafted by hand and signed with the same key. */
{
  const domain = {
    name: "Polymarket CTF Exchange",
    version: "2",
    chainId: 137,
    verifyingContract: EXCHANGE.ctf.address,
  };
  const doc: Doc = {
    types: {
      EIP712Domain: domainType(domain),
      Order: [
        { name: "salt", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "signer", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "makerAmount", type: "uint256" },
        { name: "takerAmount", type: "uint256" },
        { name: "side", type: "uint8" },
        { name: "signatureType", type: "uint8" },
        { name: "timestamp", type: "uint256" },
        { name: "metadata", type: "bytes32" },
        { name: "builder", type: "bytes32" },
      ],
    },
    primaryType: "Order",
    domain,
    message: {
      salt: "777777",
      maker: ACCOUNT.address,
      signer: ACCOUNT.address,
      tokenId: TOKEN_ID,
      makerAmount: "1000000",
      takerAmount: "3000001",
      side: 0,
      signatureType: 0,
      timestamp: "1777777777",
      metadata: `0x${"0".repeat(64)}`,
      builder: `0x${"0".repeat(64)}`,
    },
  };
  await pushOrder("non-exact price order", EXCHANGE.ctf, doc, await sign(doc), "account");
}

/* ClobAuth — createL1Headers runs buildClobEip712Signature through the same signer shim. The
   published signature for this key on Amoy (refs/clob-client-v2 tests/signing/eip712.test.ts)
   must match verbatim. */
{
  const capture: Doc[] = [];
  const headers = await createL1Headers(signerFor(capture), Chain.AMOY, 23, 10_000_000);
  const [doc] = capture;
  assert(doc !== undefined, "no ClobAuth document captured");
  assert(
    headers.POLY_SIGNATURE ===
      "0xf62319a987514da40e57e2f4d7529f7bac38f0355bd88bb5adbb3768d80de6c1682518e0af677d5260366425f4361e7b70c25ae232aff0ab2331e2b164a1aedc1b",
    "published ClobAuth signature mismatch",
  );
  cases.push({
    name: "ClobAuth (Amoy)",
    network: "eip155:80002",
    typedData: doc,
    digest: digestOf(doc),
    signature: headers.POLY_SIGNATURE,
    expected: {
      kind: "auth",
      address: ACCOUNT.address,
      timestamp: 10_000_000,
      nonce: "23",
    },
  });
}

/* Deposit-wallet Batch — the docs' JSON shape (trading/wallets-auth.md); there is no SDK path, so
   the documents are built directly and signed with viem. */
const batchDomain = {
  name: "DepositWallet",
  version: "1",
  chainId: 137,
  verifyingContract: DEPOSIT_WALLET,
};
const BATCH_TYPES: Types = {
  EIP712Domain: domainType(batchDomain),
  Batch: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "calls", type: "Call[]" },
  ],
  Call: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
};
const ERC20_APPROVE_SELECTOR = "0x095ea7b3";
const SET_APPROVAL_FOR_ALL_SELECTOR = "0xa22cb465";

const word = (hex: string): string => hex.slice(2).padStart(64, "0");
const approveData = `${ERC20_APPROVE_SELECTOR}${word(EXCHANGE.ctf.address)}${word(`0x${(25_000_000).toString(16)}`)}`;
const setApprovalData = `${SET_APPROVAL_FOR_ALL_SELECTOR}${word(EXCHANGE.ctf.address)}${"0".repeat(63)}1`;

const batchDoc = (calls: ReadonlyArray<Record<string, unknown>>): Doc => ({
  types: BATCH_TYPES,
  primaryType: "Batch",
  domain: batchDomain,
  message: { wallet: DEPOSIT_WALLET, nonce: 7, deadline: 1_800_000_000, calls },
});

const batchCase = async (
  name: string,
  calls: ReadonlyArray<Record<string, unknown>>,
  expected: unknown,
  blind?: string,
): Promise<void> => {
  const doc = batchDoc(calls);
  cases.push({
    name,
    network: "eip155:137",
    typedData: doc,
    digest: digestOf(doc),
    signature: await sign(doc),
    expected,
    ...(blind === undefined ? {} : { blind }),
  });
};

await batchCase(
  "batch: pUSD approve + CTF setApprovalForAll",
  [
    { target: PUSD, value: 0, data: approveData },
    { target: CTF_POLYGON, value: 0, data: setApprovalData },
  ],
  {
    kind: "batch",
    wallet: DEPOSIT_WALLET,
    nonce: "7",
    deadline: 1_800_000_000,
    /* The decoded call intents are asserted field-wise in the test. */
    calls: [{ summary: "approve" }, { summary: "approve" }],
  },
);
await batchCase(
  "batch: call to the wallet itself",
  [{ target: DEPOSIT_WALLET, value: 0, data: approveData }],
  {
    kind: "batch",
    wallet: DEPOSIT_WALLET,
    nonce: "7",
    deadline: 1_800_000_000,
    calls: [{ summary: "contract-call", blind: "account-code" }],
  },
  "account-code",
);

writeFileSync(
  resolve(import.meta.dirname, "../../vectors/chains/polymarket.json"),
  `${JSON.stringify({ privateKey: KEY, cases }, null, 2)}\n`,
);
console.log(`wrote ${cases.length} cases`);
