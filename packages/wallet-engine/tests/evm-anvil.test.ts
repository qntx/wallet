import { execFile } from "node:child_process";

import { createPublicClient, http } from "viem";
import type { PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import { EvmChainAdapter } from "../src/chains/evm.ts";

const RUN = process.env["ENGINE_E2E_ANVIL"] === "1";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const local = `${process.env["HOME"] ?? ""}/.foundry/bin/anvil`;
const anvil = existsSync(local) ? local : execFileSync("which", ["anvil"]).toString().trim();
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const account = mnemonicToAccount(MNEMONIC, { accountIndex: 0 });
const RECIPIENT = "0x00000000000000000000000000000000deadbeef";

const rpcCall = async (url: string, method: string, params: unknown[]): Promise<unknown> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) {
    throw new Error(body.error.message);
  }
  return body.result;
};

const sleep = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  adapter: EvmChainAdapter,
  client: PublicClient,
  hash: string,
  deadline: number,
): Promise<string> => {
  const state = await adapter.status(client, hash);
  if (state !== "pending" || Date.now() >= deadline) {
    return state;
  }
  await sleep(300);
  return waitFor(adapter, client, hash, deadline);
};

const sendOne = async (
  adapter: EvmChainAdapter,
  client: PublicClient,
  nonce: number,
  amount: bigint,
): Promise<void> => {
  const tx = await adapter.build(client, "eip155:31337", account.address, RECIPIENT, amount);
  expect(tx.nonce).toBe(nonce);
  const signed = await account.signTransaction({
    chainId: 31337,
    nonce: tx.nonce,
    gas: tx.gas,
    to: RECIPIENT,
    value: amount,
    maxFeePerGas: 2n * 10n ** 9n,
    maxPriorityFeePerGas: 10n ** 8n,
  });
  const hash = await adapter.broadcast(client, signed);
  const state = await waitFor(adapter, client, hash, Date.now() + 15_000);
  expect(["confirmed", "finalized"]).toContain(state);
};

describe.runIf(RUN)("anvil e2e: native transfer", () => {
  it("sends two sequential transfers, nonces n and n+1, and the recipient balance doubles", async () => {
    const port = 18545;
    const proc = execFile(anvil, ["--port", String(port), "--silent"]);
    await sleep(1500);
    try {
      const url = `http://127.0.0.1:${port}`;
      await rpcCall(url, "anvil_setBalance", [account.address, "0xde0b6b3a7640000"]);
      const client = createPublicClient({ transport: http(url) });
      const adapter = new EvmChainAdapter();
      const amount = 10n ** 15n;
      await sendOne(adapter, client, 0, amount);
      await sendOne(adapter, client, 1, amount);
      const balance = BigInt(
        (await rpcCall(url, "eth_getBalance", [RECIPIENT, "latest"])) as string,
      );
      expect(balance).toBe(2n * amount);
    } finally {
      proc.kill();
    }
  }, 30_000);
});
