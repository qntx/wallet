/**
 * `chains(wallet)` host proxy: `account` forwards `wallet.accounts` to the kernel and returns the
 * validated result. The kernel-side derivation is covered in packages/wallet-kernel/tests.
 */
import { describe, expect, it } from "vite-plus/test";

import { chains } from "../src/chains/index.ts";
import { connectKernel } from "../src/wallet.ts";
import { FakeKernel, unlockedStatus, PASSKEY, ScriptedPort } from "./host.test.ts";

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
});
