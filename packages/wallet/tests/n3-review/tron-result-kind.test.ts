/**
 * A `tron.transaction` request must refuse a result that declares `tron.message` even when the
 * signature it carries would verify as a transaction signature for the account — the kind check
 * fires before signature verification.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { signTronTransaction } from "@qntx/wallet-chains/tron/sign";

import { chains } from "../../src/chains/index.ts";
import type { ProtocolValue } from "../../src/protocol/index.ts";
import { connectKernel } from "../../src/wallet.ts";
import { FakeKernel, PASSKEY, ScriptedPort, unlockedStatus, walletError } from "../host.test.ts";

const TRON_PRIV = hexToBytes("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const TRON_ADDR = "TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG";
const RAW = hexToBytes(
  "0a026e5022081a2b3c4d5e6f789040e0a4eeb6b7335a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541f39fd6e51aad88f6f4ce6ab8827279cfffb922661215415cd0fb0ab3ce40f3051414c604b27756e69e43db18c0843d7080d0eab6b733",
);

const tronConnect = async (result: ProtocolValue) => {
  const kernel = new FakeKernel(unlockedStatus());
  kernel.handlers.set("chain.sign", () => ({ ok: result }));
  kernel.handlers.set("wallet.accounts", () => ({
    ok: { template: "tron.bip44", network: "tron:728126428", address: TRON_ADDR },
  }));
  return connectKernel({
    verifyEvent,
    spawn: () => {
      const port = new ScriptedPort(kernel);
      kernel.attach(port);
      return port;
    },
    factors: "software",
    passkey: PASSKEY,
    ceremony: undefined,
    setTimer: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  });
};

describe("tron result kind check", () => {
  it("refuses a tron.message result whose signature verifies as a transaction signature", async () => {
    const wallet = await tronConnect({
      kind: "tron.message",
      signature: signTronTransaction(RAW, TRON_PRIV),
    });
    await expect(
      chains(wallet).sign({
        request: {
          kind: "tron.transaction",
          network: "tron:728126428",
          account: {
            kind: "hd",
            walletId: "0a".repeat(8),
            groupIndex: 0,
            template: "tron.bip44",
          },
          rawData: RAW,
        },
        verify: { kind: "password", password: "test password" },
      }),
    ).rejects.toSatisfy((e) => walletError(e).code === "integrity");
  });
});
