/**
 * R4 review-classify PoCs: probes of the F3 described/blind rule. Each `it` pins CURRENT behaviour
 * at f4b5d53 so the report's claims are reproducible; a comment says what the rule should yield.
 */
import { SignTypedDataVersion, TypedDataUtils } from "@metamask/eth-sig-util";
import type { MessageTypes, TypedMessage } from "@metamask/eth-sig-util";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";
import { address, getAddressEncoder } from "@solana/addresses";
import { AccountRole, createNoopSigner } from "@solana/kit";
import {
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/transaction-messages";
import * as TypedData from "ox/TypedData";
import { hashTypedData } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm, normalizeEvm } from "../src/evm/index.ts";
import { parseTypedData } from "../src/evm/typed-data.ts";
import type { SignRequest } from "../src/index.ts";
import { PROGRAM_IDS, decodeSolana } from "../src/solana/index.ts";

const SIGNER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x00000000000000000000000000000000c0ffee00";
const account = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;
const HASH = `0x${"ab".repeat(32)}`;

const typed = (doc: unknown, network = "eip155:1"): SignRequest => ({
  kind: "evm.typed-data",
  network,
  account,
  typedData: JSON.stringify(doc),
});
const personalText = (text: string) =>
  decodeEvm(
    {
      kind: "evm.personal-message",
      network: "eip155:1",
      account,
      message: new TextEncoder().encode(text),
    },
    SIGNER,
  );

describe("P1 a readable decoy leaf beside a commitment keeps typed data described", () => {
  it("Msg(bytes32 hash, uint256 nonce) — a 1271-style wrapper with a nonce — is not blind", () => {
    const intent = decodeEvm(
      typed({
        types: {
          EIP712Domain: [
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          Msg: [
            { name: "hash", type: "bytes32" },
            { name: "nonce", type: "uint256" },
          ],
        },
        primaryType: "Msg",
        domain: { chainId: 1, verifyingContract: OTHER },
        message: { hash: HASH, nonce: "0" },
      }),
      SIGNER,
    );
    expect(intent.blind).toBeUndefined();
  });

  it("Msg(address account, bytes32 hash) is not blind", () => {
    const intent = decodeEvm(
      typed({
        types: {
          EIP712Domain: [
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          Msg: [
            { name: "account", type: "address" },
            { name: "hash", type: "bytes32" },
          ],
        },
        primaryType: "Msg",
        domain: { chainId: 1, verifyingContract: OTHER },
        message: { account: SIGNER, hash: HASH },
      }),
      SIGNER,
    );
    expect(intent.blind).toBeUndefined();
  });

  it("Hyperliquid's L1 phantom agent Agent(string source, bytes32 connectionId) is not blind", () => {
    /* https://nktkas.gitbook.io/hyperliquid/signing — connectionId = keccak(msgpack(action)‖…);
       the only readable leaf is source "a". The domain pins chainId 1337. */
    const doc = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Agent: [
          { name: "source", type: "string" },
          { name: "connectionId", type: "bytes32" },
        ],
      },
      primaryType: "Agent",
      domain: {
        name: "Exchange",
        version: "1",
        chainId: 1337,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      message: { source: "a", connectionId: HASH },
    };
    expect(decodeEvm(typed(doc, "eip155:1337"), SIGNER).blind).toBeUndefined();
    /* On any other network the chain-id check refuses it before display. */
    expect(() => normalizeEvm(typed(doc, "eip155:42161"))).toThrow();
  });

  it("a nested struct pairing a commitment with one readable leaf is not blind", () => {
    const intent = decodeEvm(
      typed({
        types: {
          EIP712Domain: [{ name: "chainId", type: "uint256" }],
          Outer: [
            { name: "inner", type: "Inner" },
            { name: "tag", type: "string" },
          ],
          Inner: [{ name: "digest", type: "bytes32" }],
        },
        primaryType: "Outer",
        domain: { chainId: 1 },
        message: { inner: { digest: HASH }, tag: "ok" },
      }),
      SIGNER,
    );
    expect(intent.blind).toBeUndefined();
  });

  it("a commitment split into two string leaves of 31-byte hex each is not blind", () => {
    const intent = decodeEvm(
      typed({
        types: {
          EIP712Domain: [{ name: "chainId", type: "uint256" }],
          Msg: [
            { name: "a", type: "string" },
            { name: "b", type: "string" },
          ],
        },
        primaryType: "Msg",
        domain: { chainId: 1 },
        message: { a: `0x${"ab".repeat(31)}`, b: `0x${"cd".repeat(31)}` },
      }),
      SIGNER,
    );
    expect(intent.blind).toBeUndefined();
  });
});

describe("P2 digest renderings isHexRendering does not recognise", () => {
  const digest = new Uint8Array(32).fill(0xab);
  const renderings: ReadonlyArray<readonly [string, string]> = [
    ["0X prefix", `0X${"ab".repeat(32)}`],
    ["odd nibble count (65 hex digits)", `0x${"ab".repeat(32)}a`],
    ["space-separated bytes", Array.from({ length: 32 }, () => "ab").join(" ")],
    ["colon-separated bytes", Array.from({ length: 32 }, () => "ab").join(":")],
    ["two lines of 32 hex digits", `${"ab".repeat(16)}\n${"ab".repeat(16)}`],
    ["base64 of 32 bytes", base64.encode(digest)],
    ["base58 of 32 bytes", base58.encode(digest)],
  ];

  it.each(renderings)("personal_sign text of a digest as %s is not blind", (_name, text) => {
    expect(new TextEncoder().encode(text).length).not.toBe(32);
    const intent = personalText(text);
    expect(intent.message?.kind).toBe("text");
    expect(intent.blind).toBeUndefined();
  });

  it.each(renderings.filter(([, text]) => !text.includes("\n")))(
    "a typed string leaf holding a digest as %s is not a commitment",
    (_name, text) => {
      const intent = decodeEvm(
        typed({
          types: {
            EIP712Domain: [{ name: "chainId", type: "uint256" }],
            Msg: [{ name: "hash", type: "string" }],
          },
          primaryType: "Msg",
          domain: { chainId: 1 },
          message: { hash: text },
        }),
        SIGNER,
      );
      expect(intent.blind).toBeUndefined();
    },
  );
});

describe("P3 everyday text the 32-byte and code-point rules blind", () => {
  it.each([
    ["32-char hex nonce (randomBytes(16).toString('hex'))", "9f86d081884c7d659a2feaa0c55ad015"],
    ["32-byte login line", "Sign in to app.example.org #4821"],
    ["32-byte CJK login (10 CJK + 2 ASCII)", "请签名以登录示例网站12"],
  ])("%s is shown as raw bytes and blind", (_name, text) => {
    expect(new TextEncoder().encode(text).length).toBe(32);
    const intent = personalText(text);
    expect(intent.message?.kind).toBe("bytes");
    expect(intent.blind).toBe("message-bytes");
  });

  it.each([
    ["ZWJ emoji 👨‍💻", "Welcome back 👨‍💻 — sign to log in"],
    ["flag 🏳️‍🌈", "Sign in to Pride DAO 🏳️‍🌈"],
    ["Persian ZWNJ", "برای ورود به حساب کاربری می‌خواهم امضا کنم"],
    ["Hebrew with RLM", "התחברות לאתר\u200F 2026"],
    ["soft hyphen", "Sign in to Ex\u00ADample"],
  ])("readable text with %s is shown as raw bytes and blind", (_name, text) => {
    const intent = personalText(text);
    expect(intent.message?.kind).toBe("bytes");
    expect(intent.blind).toBe("message-bytes");
  });
});

describe("P4 Permit2 witness orders are described; the witness never reaches the intent", () => {
  /* UniswapX V2DutchOrder witness, https://github.com/Uniswap/UniswapX/blob/main/src/lib/V2DutchOrderLib.sol */
  const REACTOR = "0x00000011F84B9aa48e5f8aA8B9897600006289Be";
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const ATTACKER = "0x000000000000000000000000000000000000beef";
  const doc = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "V2DutchOrder" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      V2DutchOrder: [
        { name: "info", type: "OrderInfo" },
        { name: "cosigner", type: "address" },
        { name: "baseInputToken", type: "address" },
        { name: "baseInputStartAmount", type: "uint256" },
        { name: "baseInputEndAmount", type: "uint256" },
        { name: "baseOutputs", type: "DutchOutput[]" },
      ],
      OrderInfo: [
        { name: "reactor", type: "address" },
        { name: "swapper", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "additionalValidationContract", type: "address" },
        { name: "additionalValidationData", type: "bytes" },
      ],
      DutchOutput: [
        { name: "token", type: "address" },
        { name: "startAmount", type: "uint256" },
        { name: "endAmount", type: "uint256" },
        { name: "recipient", type: "address" },
      ],
    },
    primaryType: "PermitWitnessTransferFrom",
    domain: {
      name: "Permit2",
      chainId: 1,
      verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    },
    message: {
      permitted: { token: USDC, amount: "1000000000" },
      spender: REACTOR,
      nonce: "1",
      deadline: "2000000000",
      witness: {
        info: {
          reactor: REACTOR,
          swapper: SIGNER,
          nonce: "1",
          deadline: "2000000000",
          additionalValidationContract: "0x0000000000000000000000000000000000000000",
          additionalValidationData: "0x",
        },
        cosigner: "0x0000000000000000000000000000000000000000",
        baseInputToken: USDC,
        baseInputStartAmount: "1000000000",
        baseInputEndAmount: "1000000000",
        /* 1 wei of WETH to the attacker for 1000 USDC */
        baseOutputs: [{ token: WETH, startAmount: "1", endAmount: "1", recipient: ATTACKER }],
      },
    },
  };

  it("is recognised partial with only the input approval and a witness warning", () => {
    const intent = decodeEvm(typed(doc), SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(intent.verifiability).toBe("partial");
    expect(intent.approvals).toHaveLength(1);
    expect(intent.warnings.map((w) => w.kind)).toStrictEqual(["permit2-witness"]);
    expect(intent.message?.kind === "typed-data" ? intent.message.fields : "n/a").toBeUndefined();
    expect(JSON.stringify(intent.approvals)).not.toContain(ATTACKER.slice(2));
  });
});

describe("P5 EIP-712 domain filtering agrees with independent hashers on odd domains", () => {
  const MAIL = [{ name: "x", type: "uint256" }];
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, unknown[]]> = [
    ["standard four fields", { name: "A", version: "1", chainId: 1, verifyingContract: OTHER }, [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ]],
    ["reordered declaration", { name: "A", chainId: 1 }, [
      { name: "chainId", type: "uint256" },
      { name: "name", type: "string" },
    ]],
    ["custom domain field", { name: "A", foo: "bar", chainId: 1 }, [
      { name: "name", type: "string" },
      { name: "foo", type: "string" },
      { name: "chainId", type: "uint256" },
    ]],
    ["empty declaration with undeclared keys", { name: "A", chainId: 1, verifyingContract: OTHER }, []],
    ["chainId declared as string", { chainId: "1" }, [{ name: "chainId", type: "string" }]],
  ];

  it.each(cases)("%s: wallet payload = eth-sig-util V4 = viem", (_name, domain, declared) => {
    const doc = {
      types: { EIP712Domain: declared, Mail: MAIL },
      primaryType: "Mail",
      domain,
      message: { x: "7" },
    };
    const wallet = TypedData.getSignPayload(parseTypedData(JSON.stringify(doc)).json);
    const metamask = `0x${bytesToHex(
      TypedDataUtils.eip712Hash(doc as unknown as TypedMessage<MessageTypes>, SignTypedDataVersion.V4),
    )}`;
    const viem = hashTypedData(doc as never);
    expect({ wallet, viem }).toStrictEqual({ wallet: metamask, viem: metamask });
  });

  it("a declared domain field with no value is rejected by the wallet", () => {
    const doc = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        Mail: MAIL,
      },
      primaryType: "Mail",
      domain: { name: "A" },
      message: { x: "7" },
    };
    let outcome: string;
    try {
      outcome = TypedData.getSignPayload(parseTypedData(JSON.stringify(doc)).json);
    } catch (error) {
      outcome = `throws ${(error as Error).name}`;
    }
    let metamask: string;
    try {
      metamask = `0x${bytesToHex(
        TypedDataUtils.eip712Hash(doc as unknown as TypedMessage<MessageTypes>, SignTypedDataVersion.V4),
      )}`;
    } catch (error) {
      metamask = `throws ${(error as Error).name}`;
    }
    // Recorded for the report: both sides must agree or the wallet must refuse.
    expect({ outcome, metamask }).toMatchSnapshot();
  });
});

describe("P6 Solana: an unknown program reaching the signer's token account stays described", () => {
  const BLOCKHASH = address("11111111111111111111111111111111");
  const PAYER = address("11111111111111111111111111111112");
  const SRC = address("LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY");
  const DST = address("QWmroo4YnnMqYW3cnxWkFdaTxGD3P7vMSzwMHGbUzwF");
  const OTHER_KEY = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const DRAINER = "Dra1ner111111111111111111111111111111111111";
  const req = (message: Uint8Array) => ({
    kind: "solana.transaction",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    account: { kind: "hd", walletId: "w", groupIndex: 0, template: "solana" },
    message,
  });
  const compile = (instructions: ReadonlyArray<unknown>): Uint8Array => {
    let message = setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n } as never,
      setTransactionMessageFeePayer(PAYER, createTransactionMessage({ version: 0 })),
    );
    for (const ix of instructions) {
      message = appendTransactionMessageInstruction(ix as never, message as never);
    }
    return new Uint8Array(
      getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message as never)),
    );
  };
  const w = (a: string) => ({ address: address(a), role: AccountRole.WRITABLE });
  const r = (a: string) => ({ address: address(a), role: AccountRole.READONLY });
  const s = (a: string) => ({
    address: address(a),
    role: AccountRole.READONLY_SIGNER,
    signer: createNoopSigner(address(a)),
  });
  const ix = (program: string, accounts: ReadonlyArray<object>, data: Uint8Array) => ({
    programAddress: address(program),
    accounts,
    data,
  });
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const u64 = (n: bigint) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return b;
  };
  const cat = (...p: ReadonlyArray<Uint8Array>) => Uint8Array.from(p.flatMap((x) => [...x]));

  it("a direct SPL Transfer the signer signs is blind", () => {
    const direct = ix(PROGRAM_IDS.token, [w(SRC), w(DST), s(PAYER)], cat(new Uint8Array([3]), u64(5n)));
    expect(decodeSolana(req(compile([direct])) as never, PAYER).blind).toBe("core-instruction");
  });

  it("the same transfer through an unknown CPI wrapper program is opaque and NOT blind", () => {
    const wrapped = ix(
      DRAINER,
      [s(PAYER), w(SRC), w(DST), r(PROGRAM_IDS.token)],
      cat(new Uint8Array([0]), u64(5n)),
    );
    const intent = decodeSolana(req(compile([wrapped])) as never, PAYER);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.blind).toBeUndefined();
    expect(intent.programs).toStrictEqual([DRAINER]);
  });

  it.each([
    ["System TransferWithSeed", ix(PROGRAM_IDS.system, [w(SRC), s(PAYER), w(DST)], cat(u32(11), u64(5n), u64(4n), new TextEncoder().encode("seed"), Uint8Array.from(getAddressEncoder().encode(OTHER_KEY))))],
    ["System AllocateWithSeed", ix(PROGRAM_IDS.system, [w(SRC), s(PAYER)], cat(u32(9), Uint8Array.from(getAddressEncoder().encode(PAYER)), u64(4n), new TextEncoder().encode("seed"), u64(10n), Uint8Array.from(getAddressEncoder().encode(OTHER_KEY))))],
    ["System AuthorizeNonceAccount", ix(PROGRAM_IDS.system, [w(SRC), s(PAYER)], cat(u32(7), Uint8Array.from(getAddressEncoder().encode(OTHER_KEY))))],
    ["System WithdrawNonceAccount", ix(PROGRAM_IDS.system, [w(SRC), w(DST), r("SysvarRecentB1ockHashes11111111111111111111"), r("SysvarRent111111111111111111111111111111111"), s(PAYER)], cat(u32(5), u64(5n)))],
    ["ATA RecoverNested", ix(PROGRAM_IDS.associatedToken, [w(SRC), r(OTHER_KEY), w(DST), r(OTHER_KEY), r(OTHER_KEY), { ...s(PAYER), role: AccountRole.WRITABLE_SIGNER }, r(PROGRAM_IDS.token)], new Uint8Array([2]))],
    ["Token-2022 TransferCheckedWithFee", ix(PROGRAM_IDS.token2022, [w(SRC), r(OTHER_KEY), w(DST), s(PAYER)], cat(new Uint8Array([26, 1]), u64(5n), new Uint8Array([6]), u64(0n)))],
    ["Token Burn", ix(PROGRAM_IDS.token, [w(SRC), w(OTHER_KEY), s(PAYER)], cat(new Uint8Array([8]), u64(5n)))],
  ])("%s the signer signs is blind", (_name, instruction) => {
    expect(decodeSolana(req(compile([instruction])) as never, PAYER).blind).toBe("core-instruction");
  });
});
