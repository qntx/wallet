/**
 * Fund-authority typed data with no recognized shape: a Morpho Blue `Authorization` and an Aave v3
 * `DelegationWithSig` (unlimited credit) decode as plain shown leaves — no blind flag, no
 * approvals, no outflows. Pins current behaviour.
 */
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../../src/evm/index.ts";
import type { SignRequest } from "../../src/index.ts";

const SIGNER = "0x2222222222222222222222222222222222222222";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;
const OTHER = "0x00000000000000000000000000000000c0ffee00";
const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const AAVE_VARDEBT_USDC = "0x72E95b8931767C79bA4EeE721354d6E99a61D004";
const MAX_UINT256 =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

const typed = (doc: unknown): SignRequest => ({
  kind: "evm.typed-data",
  network: "eip155:1",
  account: ACCOUNT,
  typedData: JSON.stringify(doc),
});

const MORPHO_DOC = {
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
    authorizer: SIGNER,
    authorized: OTHER,
    isAuthorized: true,
    nonce: "0",
    deadline: "1900000000",
  },
};

const AAVE_DOC = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
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
    value: MAX_UINT256,
    nonce: "0",
    deadline: "1900000000",
  },
};

describe("unrecognised fund-authority typed data shows as plain leaves", () => {
  it.each([
    ["morpho-authorization", MORPHO_DOC],
    ["aave-delegation-with-sig", AAVE_DOC],
  ])("%s", (_id, doc) => {
    const intent = decodeEvm(typed(doc), SIGNER);
    expect(intent.blind).toBeUndefined();
    expect(intent.verifiability).toBe("opaque");
    expect(intent.summary).toBe("message");
    expect(intent.approvals).toStrictEqual([]);
    expect(intent.outflows).toStrictEqual([]);
  });
});
