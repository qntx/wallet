import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { createPublicClient, http, isHex, keccak256 } from "viem";
import type { PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import { EVM_DELEGATOR, checksumEvmAddress, encodeBatchExecute } from "@qntx/wallet-chains/evm";

import { EvmChainAdapter } from "../src/chains/evm.ts";

const RUN = process.env["ENGINE_E2E_ANVIL"] === "1";
const DELEGATOR = EVM_DELEGATOR.address;
const CODE = readFileSync(
  new URL("fixtures/eip7702-stateless-delegator-1.3.0.hex", import.meta.url).pathname,
  "utf8",
).trim();
const hx = (v: string): `0x${string}` => {
  if (!isHex(v)) {
    throw new Error("expected hex");
  }
  return v;
};
const CODE_HASH = keccak256(hx(CODE));

const anvil = (): string => {
  const local = `${process.env["HOME"] ?? ""}/.foundry/bin/anvil`;
  return existsSync(local) ? local : execFileSync("which", ["anvil"]).toString().trim();
};
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const funder = mnemonicToAccount(MNEMONIC, { accountIndex: 0 });
const account = mnemonicToAccount(MNEMONIC, { accountIndex: 10 });
const RECIPIENT = "0x00000000000000000000000000000000deadbeef";
const RECIPIENT2 = "0x0000000000000000000000000000000000c0ffee";

const rpc = async (url: string, method: string, params: unknown[]): Promise<unknown> => {
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
const getCode = async (client: PublicClient, addr: string) =>
  (await client.getCode({ address: hx(addr) })) ?? "0x";
const waitMined = async (client: PublicClient, hash: string) =>
  client.waitForTransactionReceipt({ hash: hx(hash) });

type SignAuthParams = Parameters<NonNullable<typeof account.signAuthorization>>[0];
const signAuth = async (params: SignAuthParams) => {
  const fn = account.signAuthorization;
  if (fn === undefined) {
    throw new Error("signAuthorization unavailable");
  }
  return fn(params);
};

const sign7702 = async (
  unsigned: { nonce: number; gas: bigint; to: string; data: string },
  authAddress: string | undefined,
) => {
  const authorizationList =
    authAddress === undefined
      ? []
      : [
          await signAuth({
            chainId: 31337,
            contractAddress: hx(authAddress),
            nonce: unsigned.nonce + 1,
          }),
        ];
  return account.signTransaction({
    type: authAddress === undefined ? "eip1559" : "eip7702",
    chainId: 31337,
    nonce: unsigned.nonce,
    gas: unsigned.gas,
    to: hx(unsigned.to),
    value: 0n,
    data: hx(unsigned.data),
    maxFeePerGas: 2n * 10n ** 9n,
    maxPriorityFeePerGas: 10n ** 8n,
    ...(authorizationList.length === 0 ? {} : { authorizationList }),
  } as never);
};

describe.runIf(RUN)("anvil e2e: eip7702 delegation", () => {
  const start = async (port: number) => {
    const proc = execFile(anvil(), ["--port", String(port), "--silent", "--hardfork", "prague"]);
    await sleep(1500);
    const url = `http://127.0.0.1:${port}`;
    await rpc(url, "anvil_setBalance", [funder.address, "0xde0b6b3a7640000"]);
    const funderNonce = Number(
      await rpc(url, "eth_getTransactionCount", [funder.address, "latest"]),
    );
    const fund = await funder.signTransaction({
      chainId: 31337,
      nonce: funderNonce,
      gas: 21000n,
      to: account.address,
      value: 5n * 10n ** 17n,
      maxFeePerGas: 2n * 10n ** 9n,
      maxPriorityFeePerGas: 10n ** 8n,
    });
    await rpc(url, "eth_sendRawTransaction", [fund]);
    await sleep(500);
    await rpc(url, "anvil_setCode", [DELEGATOR, CODE]);
    return { proc, url, client: createPublicClient({ transport: http(url) }) };
  };

  it("upgrade → batch on the delegated account → revoke → code empty", async () => {
    const { proc, url, client } = await start(18560);
    const adapter = new EvmChainAdapter();
    try {
      // (a) upgrade: one eip7702 self-tx installs the designator
      await expect(adapter.delegation(client, account.address)).resolves.toStrictEqual({
        kind: "none",
      });
      await expect(adapter.delegatorVerified(client, CODE_HASH)).resolves.toBe(true);
      const upgrade = await adapter.build(client, "eip155:31337", account.address, {
        kind: "call",
        to: account.address,
        value: 0n,
        data: "0x",
        authorization: { address: DELEGATOR },
      });
      const upHash = await adapter.broadcast(client, await sign7702(upgrade, DELEGATOR));
      await waitMined(client, upHash);
      await expect(getCode(client, account.address)).resolves.toBe(
        `0xef0100${DELEGATOR.slice(2)}`.toLowerCase(),
      );
      await expect(adapter.delegation(client, account.address)).resolves.toStrictEqual({
        kind: "ours",
      });

      // (b) a two-transfer batch on the delegated account, plain eip1559 self-call
      const batch = await adapter.build(client, "eip155:31337", account.address, {
        kind: "call",
        to: account.address,
        value: 0n,
        data: encodeBatchExecute([
          { to: RECIPIENT, value: 10n ** 15n, data: "0x" },
          { to: RECIPIENT2, value: 10n ** 15n, data: "0x" },
        ]),
      });
      const batchHash = await adapter.broadcast(client, await sign7702(batch, undefined));
      await waitMined(client, batchHash);
      const [bal1, bal2] = await Promise.all(
        [RECIPIENT, RECIPIENT2].map(async (r) =>
          BigInt((await rpc(url, "eth_getBalance", [r, "latest"])) as string),
        ),
      );
      expect(bal1).toBe(10n ** 15n);
      expect(bal2).toBe(10n ** 15n);

      // (c) revoke: zero-address authorization clears the designator
      const revoke = await adapter.build(client, "eip155:31337", account.address, {
        kind: "call",
        to: account.address,
        value: 0n,
        data: "0x",
        authorization: { address: "0x0000000000000000000000000000000000000000" },
      });
      const rvHash = await adapter.broadcast(
        client,
        await sign7702(revoke, "0x0000000000000000000000000000000000000000"),
      );
      await waitMined(client, rvHash);
      await expect(getCode(client, account.address)).resolves.toBe("0x");
    } finally {
      proc.kill();
    }
  }, 60_000);

  it("a batch on a non-delegated account upgrades and executes in one tx", async () => {
    const { proc, url, client } = await start(18561);
    const adapter = new EvmChainAdapter();
    try {
      // (d) batch on a non-delegated account: one eip7702 upgrades and executes
      const data = encodeBatchExecute([
        { to: RECIPIENT, value: 10n ** 15n, data: "0x" },
        { to: RECIPIENT2, value: 10n ** 15n, data: "0x" },
      ]);
      const batch = await adapter.build(client, "eip155:31337", account.address, {
        kind: "call",
        to: account.address,
        value: 0n,
        data,
        authorization: { address: DELEGATOR },
      });
      const hash = await adapter.broadcast(client, await sign7702(batch, DELEGATOR));
      await waitMined(client, hash);
      await expect(getCode(client, account.address)).resolves.toBe(
        `0xef0100${DELEGATOR.slice(2)}`.toLowerCase(),
      );
      const bal = BigInt((await rpc(url, "eth_getBalance", [RECIPIENT, "latest"])) as string);
      expect(bal).toBe(10n ** 15n);
    } finally {
      proc.kill();
    }
  }, 60_000);

  it("a foreign designator is 'other'; a tampered delegator fails verification", async () => {
    const { proc, client } = await start(18562);
    const adapter = new EvmChainAdapter();
    try {
      // (e) a designator for another contract is not ours
      await rpc(`http://127.0.0.1:18562`, "anvil_setCode", [
        account.address,
        `0xef0100${RECIPIENT.slice(2)}`,
      ]);
      await expect(adapter.delegation(client, account.address)).resolves.toStrictEqual({
        kind: "other",
        address: checksumEvmAddress(RECIPIENT),
      });
      // (f) altered delegator code fails the registry-hash check
      await rpc(`http://127.0.0.1:18562`, "anvil_setCode", [DELEGATOR, "0xdeadbeef"]);
      await expect(adapter.delegatorVerified(client, CODE_HASH)).resolves.toBe(false);
    } finally {
      proc.kill();
    }
  }, 30_000);
});
