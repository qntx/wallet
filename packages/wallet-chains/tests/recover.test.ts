/**
 * `recoverEvmSigner` re-derives the signer address from a signed result — the round-trip check the
 * host runs on every `chain.sign`. Each envelope type and message kind recovers the signing key;
 * missing or malformed results raise `invalid-request`.
 */
import * as Address from "ox/Address";
import * as Secp256k1 from "ox/Secp256k1";
import { describe, expect, it } from "vite-plus/test";

import type { SignRequest } from "../src/index.ts";
import { signEvmPersonalMessage, signEvmTransaction, signEvmTypedData } from "../src/evm/sign.ts";
import { recoverEvmSigner } from "../src/evm/recover.ts";

const KEY = new Uint8Array(32).fill(3);
const ADDR = Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey: KEY, isCompressed: false }));
const EIP155 = "eip155:1";

const personal: SignRequest = {
  kind: "evm.personal-message",
  network: EIP155,
  account: { kind: "imported", keyId: "k", family: "evm" },
  message: new TextEncoder().encode("hello"),
};

const TYPED = JSON.stringify({
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
    ],
    Mail: [{ name: "contents", type: "string" }],
  },
  primaryType: "Mail",
  domain: { name: "qntx", version: "1", chainId: 1 },
  message: { contents: "hello" },
});

const typedData: SignRequest = {
  kind: "evm.typed-data",
  network: EIP155,
  account: { kind: "imported", keyId: "k", family: "evm" },
  typedData: TYPED,
};

const txRequest = (type: "legacy" | "eip1559" | "eip2930"): SignRequest => ({
  kind: "evm.transaction",
  network: EIP155,
  account: { kind: "imported", keyId: "k", family: "evm" },
  tx:
    type === "legacy"
      ? { type, chainId: 1, nonce: 0, gas: "0x5208", gasPrice: "0x1", to: "0x00000000000000000000000000000000DeaDBeef", value: "0x1", data: "0x" }
      : type === "eip2930"
        ? { type, chainId: 1, nonce: 0, gas: "0x5208", gasPrice: "0x1", to: "0x00000000000000000000000000000000DeaDBeef", value: "0x1", data: "0x", accessList: [] }
        : { type, chainId: 1, nonce: 0, gas: "0x5208", maxFeePerGas: "0x59682f00", maxPriorityFeePerGas: "0x1", to: "0x00000000000000000000000000000000DeaDBeef", value: "0x1", data: "0x", accessList: [] },
});

describe("recoverEvmSigner", () => {
  it("recovers the signer of a personal message", () => {
    const signature = signEvmPersonalMessage(new TextEncoder().encode("hello"), KEY);
    expect(recoverEvmSigner(personal, { signature })).toBe(ADDR);
  });

  it("recovers the signer of typed data", () => {
    const signature = signEvmTypedData(TYPED, KEY);
    expect(recoverEvmSigner(typedData, { signature })).toBe(ADDR);
  });

  it.each(["legacy", "eip2930", "eip1559"] as const)("recovers the signer of a %s transaction", (type) => {
    const request = txRequest(type);
    const signedTransaction = signEvmTransaction(request.tx as never, KEY);
    expect(recoverEvmSigner(request, { signedTransaction })).toBe(ADDR);
  });

  it("rejects a missing signed transaction", () => {
    expect(() => recoverEvmSigner(txRequest("eip1559"), {})).toThrow(
      expect.objectContaining({ code: "invalid-request" }),
    );
  });

  it("rejects missing and short signatures", () => {
    for (const signature of [undefined, new Uint8Array(64)]) {
      expect(() => recoverEvmSigner(personal, { signature })).toThrow(
        expect.objectContaining({ code: "invalid-request" }),
      );
    }
  });

  it("rejects an envelope that is not a signed transaction", () => {
    expect(() => recoverEvmSigner(txRequest("eip1559"), { signedTransaction: new Uint8Array([0x42]) })).toThrow(
      expect.objectContaining({ code: "invalid-request" }),
    );
  });
});
