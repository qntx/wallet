/**
 * F-03 the kernel does not refuse an EIP-7702 authorization for chainId 0 before the prompt.
 *
 * ChainId 0 is the "any chain" authorization of EIP-7702 — replayable on every chain. The kernel's
 * normalize/decode/plan path accepts it: with a wrong verify password the request still reaches
 * verification (`wrong-password`, not `invalid-input`), and with the right password it fails only
 * inside assembly (`integrity`), i.e. after the user has verified. The identical transaction on
 * eip155:1 signs cleanly.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { createHarness } from "../harness.ts";
import type { KernelResponse } from "../harness.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = () => utf8ToBytes("correct horse battery staple");
const AUTHORIZE = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";

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

const str = (value: ProtocolValue, key: string): string => {
  const v = field(value, key);
  if (typeof v !== "string") {
    throw new TypeError(`${key} is not a string`);
  }
  return v;
};

describe("F-03 the kernel does not refuse an EIP-7702 authorization for chainId 0 before the prompt", () => {
  it("reaches verification on eip155:0, then fails integrity after it", async () => {
    const h = createHarness();
    await h.settle();
    const imported = ok(
      await h.call("wallet.importMnemonic", {
        mnemonic: utf8ToBytes(MNEMONIC),
        factor: { kind: "password", password: PASSWORD() },
      }),
    );
    const session = str(imported, "session");
    const walletId = str(field(imported, "wallet"), "walletId");
    const account = { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" };
    const own = ok(
      await h.call(
        "wallet.accounts",
        { walletId, groupIndex: 0, template: "evm.bip44", network: "eip155:1" },
        session,
      ),
    );
    const to = str(own, "address");

    const request = (network: string, chainId: number) => ({
      kind: "evm.transaction",
      network,
      account,
      tx: {
        type: "eip7702",
        chainId,
        nonce: 5,
        gas: "0x30000",
        value: "0x0",
        data: "0x",
        to,
        accessList: [],
        maxFeePerGas: "0x3b9aca00",
        maxPriorityFeePerGas: "0x1",
        authorization: { address: AUTHORIZE },
      },
    });

    // (a) normalize/decode/plan accept chainId 0 — the request reaches verification.
    const wrong = await h.call(
      "chain.sign",
      {
        request: request("eip155:0", 0),
        verify: { kind: "password", password: utf8ToBytes("a wrong password") },
      },
      session,
    );
    expect(errCode(wrong)).toBe("wrong-password");

    // (b) with the right password it fails only after verification, inside assembly.
    const right = await h.call(
      "chain.sign",
      {
        request: request("eip155:0", 0),
        verify: { kind: "password", password: PASSWORD() },
      },
      session,
    );
    expect(errCode(right)).toBe("integrity");

    // (c) control: the same transaction on eip155:1 signs.
    const control = await h.call(
      "chain.sign",
      {
        request: request("eip155:1", 1),
        verify: { kind: "password", password: PASSWORD() },
      },
      session,
    );
    expect(errCode(control)).toBeUndefined();
  });
});
