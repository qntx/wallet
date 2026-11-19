/**
 * The blind-signing policy over the real decoders: every blind reason code is refused before any
 * prompt while the setting is off and signs with its reason line shown once enabled, while everyday
 * described dApp requests sign on a fresh vault. Signatures are checked against independent oracles
 * (@metamask/eth-sig-util and @noble/curves + a minimal RLP reader).
 */
import { recoverTypedSignature, SignTypedDataVersion } from "@metamask/eth-sig-util";
import type { MessageTypes, TypedMessage } from "@metamask/eth-sig-util";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import { checksumEvmAddress, normalizeEvm } from "@qntx/wallet-chains/evm";
import { normalizeSolana, verifySolanaSignature } from "@qntx/wallet-chains/solana";
import type { ProtocolValue } from "@qntx/wallet/protocol";

import type { KeystorePrompt } from "../src/platform.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import type { KeystoreCall } from "./keystore.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DEVICE = { kind: "device" } as const;
const HARDWARE = { kind: "hardware" } as const;
const SOL_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const SOL_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TO = "0x00000000000000000000000000000000DeaDBeef";
const OTHER = checksumEvmAddress("0x00000000000000000000000000000000000bad00");
const SAFE = "0xD5ffE748B45F5253FC9975FDD96FDDec052E6d52";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

function ok(response: KernelResponse): ProtocolValue {
  if ("err" in response) {
    throw new Error(`expected ok, got ${JSON.stringify(response.err)}`);
  }
  return response.ok;
}

function errCode(response: KernelResponse): string | undefined {
  return "err" in response ? response.err.code : undefined;
}

function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value !== "object" || value === null || Symbol.iterator in value) {
    throw new Error("expected object");
  }
  const v = value[key];
  if (v === undefined) {
    throw new Error(`missing field ${key}`);
  }
  return v;
}

const strField = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};

const bytesField = (value: ProtocolValue, key: string): Uint8Array => {
  const v = field(value, key);
  if (!(v instanceof Uint8Array)) {
    throw new TypeError(`${key} is not bytes`);
  }
  return v;
};

const prompts = (calls: ReadonlyArray<KeystoreCall>, op: "seal" | "open"): KeystorePrompt[] =>
  calls.flatMap((call) => (call.op === op && call.prompt !== undefined ? [call.prompt] : []));

async function importHardware(h: Harness): Promise<{ session: string; walletId: string }> {
  await h.settle();
  const res = ok(
    await h.call("wallet.importMnemonic", { mnemonic: utf8ToBytes(MNEMONIC), factor: DEVICE }),
  );
  return {
    session: strField(res, "session"),
    walletId: strField(field(res, "wallet"), "walletId"),
  };
}

/** The vault's own EVM address at group index 0 — the signer the prompts are drawn for. */
const evmAddress = async (h: Harness, session: string, walletId: string): Promise<string> =>
  strField(
    ok(
      await h.call(
        "wallet.accounts",
        { walletId, groupIndex: 0, template: "evm.bip44", network: "eip155:1" },
        session,
      ),
    ),
    "address",
  );

const evmTx = (
  walletId: string,
  over: { readonly to?: string; readonly data?: string; readonly value?: string },
) =>
  normalizeEvm({
    kind: "evm.transaction",
    network: "eip155:1",
    account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
    tx: {
      type: "eip1559",
      chainId: 1,
      nonce: 0,
      gas: "0x30000",
      to: over.to,
      value: over.value ?? "0x0",
      data: over.data ?? "0x",
      accessList: [],
      maxFeePerGas: "0x3b9aca00",
      maxPriorityFeePerGas: "0x1",
    },
  });

const typedDoc = (walletId: string, doc: unknown) =>
  normalizeEvm({
    kind: "evm.typed-data",
    network: "eip155:1",
    account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
    typedData: JSON.stringify(doc),
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
const ZERO = "0x0000000000000000000000000000000000000000";
const safeTxDoc = (message: Record<string, unknown>) => ({
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
    to: TO,
    value: "0",
    data: "0x",
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: "7",
    ...message,
  },
});

/* `transfer(to, 1000000)` — arbitrary calldata the Safe delegatecall test needs to be non-trivial. */
const transferData = `0xa9059cbb${TO.slice(2).toLowerCase().padStart(64, "0")}${(1_000_000)
  .toString(16)
  .padStart(64, "0")}`;

/* ---------------------------------------------------------------------------
 * Minimal RLP reader/writer — enough to split a signed EIP-1559 payload into
 * its fields and re-encode the unsigned prefix for the sighash.
 * ------------------------------------------------------------------------ */
type Rlp = Uint8Array | Rlp[];
const uint = (b: Uint8Array): bigint => BigInt(`0x${bytesToHex(b) || "00"}`);

const rlpItem = (buf: Uint8Array, at: number): [Rlp, number] => {
  const tag = buf[at];
  if (tag === undefined) {
    throw new Error("rlp: truncated input");
  }
  if (tag < 0x80) {
    return [buf.slice(at, at + 1), at + 1];
  }
  if (tag < 0xb8) {
    const len = tag - 0x80;
    return [buf.slice(at + 1, at + 1 + len), at + 1 + len];
  }
  if (tag < 0xc0) {
    const n = tag - 0xb7;
    const len = Number(uint(buf.slice(at + 1, at + 1 + n)));
    return [buf.slice(at + 1 + n, at + 1 + n + len), at + 1 + n + len];
  }
  const n = tag < 0xf8 ? 0 : tag - 0xf7;
  const len = tag < 0xf8 ? tag - 0xc0 : Number(uint(buf.slice(at + 1, at + 1 + n)));
  const start = at + 1 + n;
  const end = start + len;
  const items: Rlp[] = [];
  let pos = start;
  while (pos < end) {
    const [item, next] = rlpItem(buf, pos);
    items.push(item);
    pos = next;
  }
  return [items, end];
};

const rlpEncode = (item: Rlp): Uint8Array => {
  const head = (len: number, short: number, long: number): Uint8Array => {
    if (len <= 55) {
      return new Uint8Array([short + len]);
    }
    const even = len.toString(16).padStart(Math.ceil(len.toString(16).length / 2) * 2, "0");
    const lb = Uint8Array.from({ length: even.length / 2 }, (_, i) =>
      Number.parseInt(even.slice(i * 2, i * 2 + 2), 16),
    );
    return new Uint8Array([long + lb.length, ...lb]);
  };
  if (!Array.isArray(item)) {
    return item.length === 1 && (item[0] ?? 0) < 0x80
      ? item
      : concatBytes(head(item.length, 0x80, 0xb7), item);
  }
  const body = concatBytes(...item.map(rlpEncode));
  return concatBytes(head(body.length, 0xc0, 0xf7), body);
};

const bytesAt = (item: Rlp, index: number): Uint8Array => {
  if (!Array.isArray(item)) {
    throw new TypeError("rlp: expected list");
  }
  const v = item[index];
  if (!(v instanceof Uint8Array)) {
    throw new TypeError(`rlp: field ${index} is not bytes`);
  }
  return v;
};

/** The signer of a signed EIP-1559 transaction, recovered without any wallet code. */
const recover1559 = (signed: Uint8Array): string => {
  if (signed[0] !== 0x02) {
    throw new Error("not an eip1559 envelope");
  }
  const [list] = rlpItem(signed, 1);
  if (!Array.isArray(list) || list.length !== 12) {
    throw new Error("unexpected field count in signed transaction");
  }
  const sighash = keccak_256(concatBytes(new Uint8Array([0x02]), rlpEncode(list.slice(0, 9))));
  const point = new secp256k1.Signature(
    uint(bytesAt(list, 10)),
    uint(bytesAt(list, 11)),
    Number(uint(bytesAt(list, 9))),
  ).recoverPublicKey(sighash);
  return `0x${bytesToHex(keccak_256(point.toBytes(false).subarray(1)).subarray(12))}`;
};

/* ------------------------------------------------------------------------ */

describe("blind signing policy", () => {
  const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const SOL_PAYER = base58.decode(SOL_ADDRESS);
  const SOL_SRC = new Uint8Array(32).fill(0x22);
  const SOL_DST = new Uint8Array(32).fill(0x44);
  const SOL_TOKEN = base58.decode(TOKEN_PROGRAM);

  /* A legacy Solana message: header, accounts (signer, writable, readonly), blockhash, ixs. */
  const solMessage = (
    keys: ReadonlyArray<Uint8Array>,
    readonlyUnsigned: number,
    ixs: ReadonlyArray<{
      program: number;
      accounts: ReadonlyArray<number>;
      data: Uint8Array;
    }>,
  ): Uint8Array =>
    new Uint8Array([
      1,
      0,
      readonlyUnsigned,
      keys.length,
      ...keys.flatMap((k) => [...k]),
      ...new Uint8Array(32).fill(0x33),
      ixs.length,
      ...ixs.flatMap((ix) => [
        ix.program,
        ix.accounts.length,
        ...ix.accounts,
        ix.data.length,
        ...ix.data,
      ]),
    ]);

  const tokenTransferIx = (): Uint8Array =>
    solMessage(
      [SOL_PAYER, SOL_SRC, SOL_DST, SOL_TOKEN],
      1,
      [{ program: 3, accounts: [1, 2, 0], data: new Uint8Array([3, 5, 0, 0, 0, 0, 0, 0, 0]) }],
    );
  const setAuthorityIx = (): Uint8Array =>
    solMessage(
      [SOL_PAYER, SOL_SRC, SOL_TOKEN],
      1,
      [
        {
          program: 2,
          accounts: [1, 0],
          data: new Uint8Array([6, 0, 1, ...new Uint8Array(32).fill(0x55)]),
        },
      ],
    );

  const solanaCoreIx = (walletId: string, message: Uint8Array) =>
    normalizeSolana(
      {
        kind: "solana.transaction",
        network: SOL_NETWORK,
        account: { kind: "hd", walletId, groupIndex: 0, template: "solana.bip44-change" },
        message,
      },
      SOL_ADDRESS,
    );

  const cases: ReadonlyArray<
    readonly [
      name: string,
      build: (walletId: string, address: string) => unknown,
      prompt: (address: string) => KeystorePrompt,
    ]
  > = [
    [
      "message-bytes (evm personal_sign)",
      (walletId) =>
        normalizeEvm({
          kind: "evm.personal-message",
          network: "eip155:1",
          account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
          message: new Uint8Array(32).fill(0xff),
        }),
      () => ({
        title: "Confirm blind signing",
        description: `The wallet cannot show what this signs. Sign only if you fully trust the app.\nData 0x${"ff".repeat(32)}`,
      }),
    ],
    [
      "message-bytes (solana signMessage)",
      (walletId) =>
        normalizeSolana(
          {
            kind: "solana.message",
            network: SOL_NETWORK,
            account: { kind: "hd", walletId, groupIndex: 0, template: "solana.bip44-change" },
            message: new Uint8Array([0xff]),
            format: "raw",
          },
          SOL_ADDRESS,
        ),
      () => ({
        title: "Confirm blind signing",
        description:
          "The wallet cannot show what this signs. Sign only if you fully trust the app.\nData 0xff",
      }),
    ],
    [
      "typed-data-oversize",
      (walletId) =>
        typedDoc(walletId, {
          types: {
            EIP712Domain: [
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            Big: Array.from({ length: 17 }, (_, i) => ({ name: `f${i}`, type: "uint256" })),
          },
          primaryType: "Big",
          domain: { chainId: 1, verifyingContract: OTHER },
          message: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, "1"])),
        }),
      () => ({
        title: "Confirm blind signing",
        description: `Network: Ethereum\nVerifying contract ${OTHER}\nType: Big\nThis typed data is too large to show in full`,
      }),
    ],
    [
      "typed-data-commitment",
      (walletId) =>
        typedDoc(walletId, {
          types: {
            EIP712Domain: [
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            SafeMessage: [{ name: "message", type: "bytes" }],
          },
          primaryType: "SafeMessage",
          domain: { chainId: 1, verifyingContract: SAFE },
          message: { message: `0x${bytesToHex(keccak_256(utf8ToBytes("permit2 digest")))}` },
        }),
      () => ({
        title: "Confirm blind signing",
        description:
          `Network: Ethereum\nVerifying contract ${SAFE}\nType: SafeMessage\n` +
          "It signs only hashes or raw bytes; the wallet cannot see what they commit to\n" +
          `The wallet cannot verify what this signature authorises\n` +
          `message: 0x${bytesToHex(keccak_256(utf8ToBytes("permit2 digest")))}`,
      }),
    ],
    [
      "token-function",
      (walletId) => evmTx(walletId, { to: USDC, data: "0xdeadbeef" }),
      () => ({
        title: "Confirm blind signing",
        description: `Network: Ethereum\nAn unrecognised function of token USDC ${USDC} can move this token\nCall contract ${USDC}, function 0xdeadbeef\nMax fee 0.000196608 ETH`,
      }),
    ],
    [
      "account-code",
      (walletId, address) => evmTx(walletId, { to: address, data: "0xdeadbeef" }),
      (address) => ({
        title: "Confirm blind signing",
        description: `Network: Ethereum\nRuns this account's own code with full authority\nCall contract ${address}, function 0xdeadbeef\nMax fee 0.000196608 ETH`,
      }),
    ],
    [
      "safe-delegatecall",
      (walletId) => typedDoc(walletId, safeTxDoc({ to: OTHER, operation: 1, data: transferData })),
      () => ({
        title: "Confirm blind signing",
        description: `Network: Ethereum\nVerifying contract ${SAFE}\nType: SafeTx\nSafe ${SAFE}, transaction 7\nRuns the code of ${OTHER} with the Safe's full authority (delegatecall)\nThe wallet cannot verify what this call does\nCall contract ${OTHER}, function 0xa9059cbb`,
      }),
    ],
    [
      "safe-refund-unbounded",
      (walletId) => typedDoc(walletId, safeTxDoc({ gasPrice: "2000000000", baseGas: "100000" })),
      () => ({
        title: "Confirm blind signing",
        description: `Network: Ethereum\nVerifying contract ${SAFE}\nType: SafeTx\nSafe ${SAFE}, transaction 7\nSend 0 ETH to ${TO}\nPays whoever executes it a gas refund of up to 0.0002 ETH, plus 0.000000002 ETH per gas of call overhead`,
      }),
    ],
    [
      "typed-data-variant (legacy SafeTx)",
      (walletId) =>
        typedDoc(walletId, {
          types: {
            EIP712Domain: [
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            SafeTx: SAFE_TX_FIELDS.map((f) =>
              f.name === "baseGas" ? { name: "dataGas", type: f.type } : f,
            ),
          },
          primaryType: "SafeTx",
          domain: { chainId: 1, verifyingContract: SAFE },
          message: {
            to: OTHER,
            value: "0",
            data: "0x",
            operation: 0,
            safeTxGas: "0",
            dataGas: "0",
            gasPrice: "0",
            gasToken: ZERO,
            refundReceiver: ZERO,
            nonce: "7",
          },
        }),
      () => ({
        title: "Confirm blind signing",
        description:
          `Network: Ethereum\nVerifying contract ${SAFE}\nType: SafeTx\n` +
          "The wallet recognises this kind of signature but not this form of it; it may authorise moving assets\n" +
          "The wallet cannot verify what this signature authorises\n" +
          `to: ${OTHER}\nvalue: 0\ndata: 0x\noperation: 0\nsafeTxGas: 0\ndataGas: 0\ngasPrice: 0\n` +
          `gasToken: ${ZERO}\nrefundReceiver: ${ZERO}\nnonce: 7`,
      }),
    ],
    [
      "typed-data-variant (EIP-3009 on a listed token)",
      (walletId) =>
        typedDoc(walletId, {
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
            ],
          },
          primaryType: "TransferWithAuthorization",
          domain: { name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC },
          message: { from: "0x2222222222222222222222222222222222222222", to: OTHER, value: "1" },
        }),
      () => ({
        title: "Confirm blind signing",
        description:
          `App: USD Coin\nNetwork: Ethereum\nVerifying contract ${USDC}\n` +
          "Type: TransferWithAuthorization\n" +
          "The wallet recognises this kind of signature but not this form of it; it may authorise moving assets\n" +
          "The wallet cannot verify what this signature authorises\n" +
          `from: 0x2222222222222222222222222222222222222222\nto: ${OTHER}\nvalue: 1`,
      }),
    ],
    [
      "core-instruction (SPL Token Transfer)",
      (walletId) => solanaCoreIx(walletId, tokenTransferIx()),
      () => ({
        title: "Confirm blind signing",
        description: `Network: Solana\nProgram calls the wallet cannot decode: ${TOKEN_PROGRAM}\nThese programs can move assets from the accounts in this transaction\nMax fee 0.000005 SOL`,
      }),
    ],
    [
      "core-instruction (SPL SetAuthority)",
      (walletId) => solanaCoreIx(walletId, setAuthorityIx()),
      () => ({
        title: "Confirm blind signing",
        description: `Network: Solana\nProgram calls the wallet cannot decode: ${TOKEN_PROGRAM}\nThese programs can move assets from the accounts in this transaction\nMax fee 0.000005 SOL`,
      }),
    ],
  ];

  describe.each(cases)("%s", (_name, build, prompt) => {
    it("is refused before any prompt while off, then signs with the reason shown", async () => {
      const fake = fakeKeystore();
      const h = createHarness({ keystore: fake.keystore });
      const { session, walletId } = await importHardware(h);
      const address = await evmAddress(h, session, walletId);
      const request = build(walletId, address);

      expect(errCode(await h.call("chain.sign", { request, verify: HARDWARE }, session))).toBe(
        "blind-signing-disabled",
      );
      expect(prompts(fake.calls, "open")).toStrictEqual([]);

      ok(await h.call("vault.setBlindSigning", { enabled: true, verify: HARDWARE }, session));
      const response = await h.call("chain.sign", { request, verify: HARDWARE }, session);
      expect(errCode(response)).toBeUndefined();
      expect("ok" in response).toBe(true);
      expect(prompts(fake.calls, "open").at(-1)).toStrictEqual(prompt(address));
    });
  });
});

describe("described dApp requests on a fresh vault", () => {
  const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const AAVE_V3 = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
  const ROUTER = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af";
  const word = (hex20: string) => hex20.slice(2).toLowerCase().padStart(64, "0");

  const supplyData = (onBehalfOf: string) =>
    `0x617ba037${word(USDC)}${(1_000_000).toString(16).padStart(64, "0")}${word(onBehalfOf)}${"0".repeat(64)}`;

  /** Uniswap Universal Router execute(0x0b00, ["0x","0x"], 2000000000) as viem encodes it. */
  const EXECUTE =
    "0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000007735940000000000000000000000000000000000000000000000000000000000000000020b0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

  const cowOrder = (receiver: string): TypedMessage<MessageTypes> => ({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
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
      receiver,
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
  });

  const requests = (
    walletId: string,
    address: string,
  ): ReadonlyArray<readonly [name: string, request: unknown, prompt: KeystorePrompt]> => [
    [
      "WETH9 deposit() (wrap 1 ETH)",
      evmTx(walletId, { to: WETH, data: "0xd0e30db0", value: "0xde0b6b3a7640000" }),
      {
        title: "Confirm contract call",
        description: `Network: Ethereum\nThe wallet cannot verify what this call does\nCall contract ${WETH}, function 0xd0e30db0\nSend 1 ETH to ${WETH}\nMax fee 0.000196608 ETH`,
      },
    ],
    [
      "Aave V3 Pool supply(USDC)",
      evmTx(walletId, { to: AAVE_V3, data: supplyData(address) }),
      {
        title: "Confirm contract call",
        description: `Network: Ethereum\nThe wallet cannot verify what this call does\nCall contract ${AAVE_V3}, function 0x617ba037\nMax fee 0.000196608 ETH`,
      },
    ],
    [
      "Uniswap Universal Router execute() (0.01 ETH)",
      evmTx(walletId, { to: ROUTER, data: EXECUTE, value: "0x2386f26fc10000" }),
      {
        title: "Confirm contract call",
        description: `Network: Ethereum\nThe wallet cannot verify what this call does\nCall contract ${ROUTER}, function 0x3593564c\nSend 0.01 ETH to ${ROUTER}\nMax fee 0.000196608 ETH`,
      },
    ],
  ];

  it("everyday opaque requests sign with blind signing off, prompts and signatures checked", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await importHardware(h);
    const address = await evmAddress(h, session, walletId);
    for (const [, request, prompt] of requests(walletId, address)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential protocol calls
      const response = await h.call("chain.sign", { request, verify: HARDWARE }, session);
      expect(errCode(response)).toBeUndefined();
      expect(prompts(fake.calls, "open").at(-1)).toStrictEqual(prompt);
      expect(recover1559(bytesField(ok(response), "signedTransaction"))).toBe(
        address.toLowerCase(),
      );
    }
  });

  it("a CoW GPv2 order signs on a fresh vault and recovers the account", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await importHardware(h);
    const address = await evmAddress(h, session, walletId);
    const doc = cowOrder(address);
    const request = typedDoc(walletId, doc);
    const response = await h.call("chain.sign", { request, verify: HARDWARE }, session);
    expect(errCode(response)).toBeUndefined();
    expect(prompts(fake.calls, "open").at(-1)).toStrictEqual({
      title: "Confirm signature",
      description:
        `App: Gnosis Protocol\nNetwork: Ethereum\nVerifying contract 0x9008D19f58AAbD9eD0D60971565AA8510560ab41\nType: Order\n` +
        `The wallet cannot verify what this signature authorises\n` +
        `sellToken: ${USDC}\nbuyToken: ${WETH}\nreceiver: ${address}\nsellAmount: 1000000\nbuyAmount: 1\n` +
        `validTo: 2000000000\nappData: 0x${"00".repeat(32)}\nfeeAmount: 0\nkind: sell\n` +
        `partiallyFillable: false\nsellTokenBalance: erc20\nbuyTokenBalance: erc20`,
    });
    const signature = `0x${bytesToHex(bytesField(ok(response), "signature"))}`;
    const recovered = recoverTypedSignature({
      data: doc,
      signature,
      version: SignTypedDataVersion.V4,
    });
    expect(recovered.toLowerCase()).toBe(address.toLowerCase());
  });

  it("the same described request prompts in Chinese under a zh-Hans keystore", async () => {
    const fake = fakeKeystore("zh-Hans");
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await importHardware(h);
    const request = evmTx(walletId, { to: WETH, data: "0xd0e30db0", value: "0xde0b6b3a7640000" });
    const response = await h.call("chain.sign", { request, verify: HARDWARE }, session);
    expect(errCode(response)).toBeUndefined();
    expect(prompts(fake.calls, "open").at(-1)).toStrictEqual({
      title: "确认合约调用",
      description: `网络：Ethereum\n钱包无法核实此调用会做什么\n调用合约 ${WETH}，函数 0xd0e30db0\n发送 1 ETH 到 ${WETH}\n最高手续费 0.000196608 ETH`,
    });
  });

  it("a Solana transaction with an unknown program signs on a fresh vault", async () => {
    const fake = fakeKeystore();
    const h = createHarness({ keystore: fake.keystore });
    const { session, walletId } = await importHardware(h);
    const payer = base58.decode(SOL_ADDRESS);
    const dest = new Uint8Array(32).fill(0x22);
    const system = base58.decode("11111111111111111111111111111111");
    const unknown = new Uint8Array(32).fill(0x44);
    const transfer = new Uint8Array(12);
    const dv = new DataView(transfer.buffer);
    dv.setUint32(0, 2, true);
    dv.setBigUint64(4, 1_000_000n, true);
    const message = new Uint8Array([
      1,
      0,
      2,
      4,
      ...payer,
      ...dest,
      ...system,
      ...unknown,
      ...new Uint8Array(32).fill(0x33),
      2,
      2,
      2,
      0,
      1,
      12,
      ...transfer,
      3,
      1,
      0,
      1,
      0xaa,
    ]);
    const request = normalizeSolana(
      {
        kind: "solana.transaction",
        network: SOL_NETWORK,
        account: { kind: "hd", walletId, groupIndex: 0, template: "solana.bip44-change" },
        message,
      },
      SOL_ADDRESS,
    );
    const response = await h.call("chain.sign", { request, verify: HARDWARE }, session);
    expect(errCode(response)).toBeUndefined();
    const program = base58.encode(unknown);
    expect(prompts(fake.calls, "open").at(-1)).toStrictEqual({
      title: "Confirm transfer",
      description: `Network: Solana\nProgram calls the wallet cannot decode: ${program}\nThese programs can move assets from the accounts in this transaction\nSend 0.001 SOL to ${base58.encode(dest)}\nMax fee 0.000005 SOL`,
    });
    expect(verifySolanaSignature(message, bytesField(ok(response), "signature"), SOL_ADDRESS)).toBe(
      true,
    );
  });
});
