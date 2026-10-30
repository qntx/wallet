import { utf8ToBytes } from "@noble/hashes/utils.js";
/**
 * `chains(wallet)` host proxy: `account` forwards `wallet.accounts` to the kernel and returns the
 * validated result. The kernel-side derivation is covered in packages/wallet-kernel/tests.
 */
import { describe, expect, it } from "vite-plus/test";

import { signEvmPersonalMessage } from "@qntx/wallet-chains/evm/sign";

import { chains } from "../src/chains/index.ts";
import { connectKernel } from "../src/wallet.ts";
import { FakeKernel, unlockedStatus, PASSKEY, ScriptedPort, walletError } from "./host.test.ts";

const RESULT = {
  template: "evm.bip44" as const,
  network: "eip155:1",
  address: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
};

describe("chains(wallet)", () => {
  it("forwards wallet.accounts and returns the result", async () => {
    const kernel = new FakeKernel(unlockedStatus());
    const params = {
      walletId: "0a".repeat(8),
      groupIndex: 0,
      template: "evm.bip44" as const,
      network: "eip155:1",
    };
    kernel.handlers.set("wallet.accounts", () => ({ ok: RESULT }));
    const wallet = await connectKernel({
      spawn: () => {
        const port = new ScriptedPort(kernel);
        kernel.attach(port);
        return port;
      },
      passkey: PASSKEY,
      ceremony: undefined,
      setTimer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
    });
    const account = await chains(wallet).account(params);
    expect(account).toStrictEqual(RESULT);
    expect(kernel.received).toContain("wallet.accounts");
  });

  const PRIV = new Uint8Array(32).fill(7);
  const ADDRESS = "0x4a62316623ad457F02cDC5D997deD67a383EC569";
  const MESSAGE = utf8ToBytes("hello");

  const connect = async (signature: Uint8Array) => {
    const kernel = new FakeKernel(unlockedStatus());
    kernel.handlers.set("chain.sign", () => ({ ok: { kind: "evm.personal-message", signature } }));
    kernel.handlers.set("wallet.accounts", () => ({
      ok: { template: "evm.bip44", network: "eip155:1", address: ADDRESS },
    }));
    const wallet = await connectKernel({
      spawn: () => {
        const port = new ScriptedPort(kernel);
        kernel.attach(port);
        return port;
      },
      passkey: PASSKEY,
      ceremony: undefined,
      setTimer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
    });
    return { kernel, wallet };
  };

  const signParams = () => ({
    request: {
      kind: "evm.personal-message" as const,
      network: "eip155:1",
      account: {
        kind: "hd" as const,
        walletId: "0a".repeat(8),
        groupIndex: 0,
        template: "evm.bip44" as const,
      },
      message: MESSAGE,
    },
    verify: { kind: "password" as const, password: "test password" },
  });

  it("returns the kernel's signature when it verifies for the account", async () => {
    const { kernel, wallet } = await connect(signEvmPersonalMessage(MESSAGE, PRIV));
    const result = await chains(wallet).sign(signParams());
    expect(result.kind).toBe("evm.personal-message");
    expect(kernel.received).toContain("chain.sign");
    expect(kernel.received).toContain("wallet.accounts");
  });

  it("rejects a forged kernel signature with integrity", async () => {
    const { wallet } = await connect(signEvmPersonalMessage(MESSAGE, new Uint8Array(32).fill(8)));
    await expect(chains(wallet).sign(signParams())).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
  });
});
