import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import { createMessage } from "@qntx/siwx";
import type { MessageFields } from "@qntx/siwx";
import { evm } from "@qntx/siwx/evm";
import { siws } from "@qntx/siwx/svm";

import { decodeEvm } from "../src/evm/index.ts";
import { parseSignIn } from "../src/index.ts";

const SIGNER = "0x1111111111111111111111111111111111111111";

const ADDRESS = "0xe5A12547fe4E872D192E3eCecb76F2Ce1aeA4946";
const SOLANA_ADDRESS = base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(7)));
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm" } as const;

const fields = (over: Partial<MessageFields> = {}): MessageFields => ({
  domain: "service.org",
  address: ADDRESS,
  statement: "I accept the ToS",
  uri: "https://service.org/login",
  version: "1",
  chainId: "1",
  nonce: "12341234",
  issuedAt: "2022-03-17T12:45:13.610Z",
  ...over,
});

const siwe = (over: Partial<MessageFields> = {}): string =>
  evm().format(createMessage(fields(over)));
const siwsText = (): string =>
  siws.format(createMessage(fields({ address: SOLANA_ADDRESS, chainId: "mainnet" })));

describe("parseSignIn", () => {
  it("recognizes a valid SIWE message and returns plain fields", () => {
    const parsed = parseSignIn(siwe({ expirationTime: "2030-01-01T00:00:00.000Z" }), "evm");
    expect(parsed).toStrictEqual({
      status: "valid",
      fields: fields({ expirationTime: "2030-01-01T00:00:00.000Z" }),
    });
    expect(structuredClone(parsed)).toStrictEqual(parsed);
  });

  it("omits absent optional fields", () => {
    const parsed = parseSignIn(siwe({ statement: undefined }), "evm");
    expect(parsed).toMatchObject({ status: "valid" });
    expect(parsed).not.toHaveProperty("fields.statement");
    expect(parsed).not.toHaveProperty("fields.expirationTime");
  });

  it("a non-checksummed address is malformed", () => {
    expect(
      parseSignIn(siwe().replace(ADDRESS, ADDRESS.toLowerCase().replace("0xe", "0xE")), "evm"),
    ).toStrictEqual({ status: "malformed" });
  });

  it("CRLF line endings are malformed", () => {
    expect(parseSignIn(siwe().replaceAll("\n", "\r\n"), "evm")).toStrictEqual({
      status: "malformed",
    });
  });

  it("trailing junk is malformed", () => {
    expect(parseSignIn(`${siwe()}\nextra`, "evm")).toStrictEqual({ status: "malformed" });
  });

  it("a Solana-labelled message in an EVM request is malformed", () => {
    expect(parseSignIn(siwsText(), "evm")).toStrictEqual({ status: "malformed" });
  });

  it("plain text is not a sign-in message", () => {
    expect(parseSignIn("hello world", "evm")).toBeUndefined();
    expect(parseSignIn("hello world", "solana")).toBeUndefined();
  });

  it("recognizes a valid SIWS message", () => {
    const parsed = parseSignIn(siwsText(), "solana");
    expect(parsed).toMatchObject({ status: "valid", fields: { address: SOLANA_ADDRESS } });
  });

  it("an EVM message in a Solana request is malformed", () => {
    expect(parseSignIn(siwe(), "solana")).toStrictEqual({ status: "malformed" });
  });

  it("a SIWS message with an invalid address is malformed", () => {
    const bad = siws.format(
      createMessage(fields({ address: "11111111111111111111111111111111", chainId: "mainnet" })),
    );
    expect(parseSignIn(bad, "solana")).toStrictEqual({ status: "malformed" });
  });
});

describe("decodeEvm personal-message content", () => {
  const decode = (message: Uint8Array) =>
    decodeEvm(
      { kind: "evm.personal-message", network: "eip155:1", account: ACCOUNT, message },
      SIGNER,
    );

  it("plain UTF-8 is text without a sign-in", () => {
    const intent = decode(new TextEncoder().encode("hello"));
    expect(intent.message).toStrictEqual({ kind: "text", text: "hello" });
    expect(intent.verifiability).toBe("opaque");
  });

  it("invalid UTF-8 is hex bytes", () => {
    expect(decode(new Uint8Array([0xff, 0x00, 0x0a])).message).toStrictEqual({
      kind: "bytes",
      hex: "0xff000a",
    });
  });

  it("carries the sign-in parse", () => {
    const text = siwe();
    const intent = decode(new TextEncoder().encode(text));
    expect(intent.message).toStrictEqual({
      kind: "text",
      text,
      signIn: { status: "valid", fields: fields() },
    });
  });

  it("carries a malformed sign-in", () => {
    const text = `${siwe()}\nextra`;
    expect(decode(new TextEncoder().encode(text)).message).toMatchObject({
      kind: "text",
      signIn: { status: "malformed" },
    });
  });

  it("typed data carries its structured content", () => {
    const intent = decodeEvm(
      {
        kind: "evm.typed-data",
        network: "eip155:1",
        account: ACCOUNT,
        typedData: JSON.stringify({
          types: { EIP712Domain: [{ name: "chainId", type: "uint256" }], T: [] },
          primaryType: "T",
          domain: { chainId: 1 },
          message: {},
        }),
      },
      SIGNER,
    );
    expect(intent.message).toMatchObject({ kind: "typed-data", primaryType: "T" });
  });
});
