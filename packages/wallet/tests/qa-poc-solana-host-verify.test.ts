/**
 * Audit QA PoC (QA-04): the host-side check of a `chain.sign` result. For EVM and Bitcoin requests
 * a result of another kind is an `integrity` failure; for a Solana request the check only runs when
 * both kinds are Solana, so a result of any other kind is returned to the caller unverified.
 */
import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";

import { chains } from "../src/chains/index.ts";
import type { ProtocolValue } from "../src/protocol/index.ts";
import { connectKernel } from "../src/wallet.ts";
import { FakeKernel, unlockedStatus, PASSKEY, ScriptedPort, walletError } from "./host.test.ts";

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
// The first address of vectors/chains/solana.json (a real curve point; the all-zero key is small-order).
const SOLANA_ADDRESS = "oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96";
const EVM_ADDRESS = "0x4a62316623ad457F02cDC5D997deD67a383EC569";

const connect = async (
  result: ProtocolValue,
  account: ProtocolValue,
): Promise<Awaited<ReturnType<typeof connectKernel>>> => {
  const kernel = new FakeKernel(unlockedStatus());
  kernel.handlers.set("chain.sign", () => ({ ok: result }));
  kernel.handlers.set("wallet.accounts", () => ({ ok: account }));
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
      return () => {
        clearTimeout(id);
      };
    },
  });
};

const account = {
  kind: "hd" as const,
  walletId: "0a".repeat(8),
  groupIndex: 0,
};
const verify = { kind: "password" as const, password: "test password" };

describe("QA PoC: host verification of chain.sign results by family", () => {
  it("control: an EVM request answered with a Solana result is an integrity failure", async () => {
    const wallet = await connect(
      { kind: "solana.message", signature: new Uint8Array(64) },
      { template: "evm.bip44", network: "eip155:1", address: EVM_ADDRESS },
    );
    const request = {
      kind: "evm.personal-message" as const,
      network: "eip155:1",
      account: { ...account, template: "evm.bip44" as const },
      message: new Uint8Array([1, 2, 3]),
    };
    await expect(chains(wallet).sign({ request, verify })).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
  });

  it("control: a Solana message with a forged signature is an integrity failure", async () => {
    const wallet = await connect(
      { kind: "solana.message", signature: new Uint8Array(64) },
      { template: "solana.bip44-change", network: SOLANA_MAINNET, address: SOLANA_ADDRESS },
    );
    const request = {
      kind: "solana.message" as const,
      network: SOLANA_MAINNET,
      account: { ...account, template: "solana.bip44-change" as const },
      message: new Uint8Array([1, 2, 3]),
      format: "raw" as const,
    };
    await expect(chains(wallet).sign({ request, verify })).rejects.toSatisfy(
      (e) => walletError(e).code === "integrity",
    );
  });

  it("FINDING: a Solana request answered with an EVM result is returned unverified", async () => {
    const wallet = await connect(
      { kind: "evm.personal-message", signature: new Uint8Array(65) },
      { template: "solana.bip44-change", network: SOLANA_MAINNET, address: SOLANA_ADDRESS },
    );
    const request = {
      kind: "solana.message" as const,
      network: SOLANA_MAINNET,
      account: { ...account, template: "solana.bip44-change" as const },
      message: new Uint8Array([1, 2, 3]),
      format: "raw" as const,
    };
    const result = await chains(wallet).sign({ request, verify });
    expect(result.kind).toBe("evm.personal-message");
  });
});
