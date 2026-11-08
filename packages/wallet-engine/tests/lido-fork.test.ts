// oxlint-disable vitest/no-conditional-in-test -- fork e2e is inherently conditional
/**
 * Manual fork check — NOT run in CI. `ENGINE_E2E_FORK_RPC=<mainnet rpc>` runs anvil on a mainnet
 * fork and drives stake → approve → withdrawal request through the request pipeline.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import { LIDO_QUEUE, LIDO_STETH } from "@qntx/wallet-chains/evm";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";
import type { TrackedTransaction } from "../src/transactions/route.ts";
import { rpc, sleep, waitReceipt } from "./fork-helpers.ts";
import { idleNetworkDeps, requestsFor } from "./send-helpers.ts";

const FORK = process.env["ENGINE_E2E_FORK_RPC"];
const RUN = FORK !== undefined && FORK !== "" && process.env["ANVIL"] !== "skip";
const N1 = "eip155:1";
const PORT = 18545;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const BVERIFY = { kind: "password" as const, password: "correct horse battery staple" };
const KERNEL_URL: URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);

const taggedRandom = (): ((n: number) => Uint8Array) => {
  let tag = 0;
  return (n) => {
    tag += 1;
    return new Uint8Array(n).fill(tag);
  };
};

describe.skipIf(!RUN)("lido mainnet fork", () => {
  it("stakes, approves and requests a withdrawal through the pipeline", async () => {
    const ledger = mkdtempSync(join(tmpdir(), "lido-fork-"));
    const anvil = spawn("anvil", ["--fork-url", FORK ?? "", "--port", String(PORT), "--silent"], {
      stdio: "ignore",
    });
    try {
      for (let i = 0; i < 60; i++) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- sequential polling
          await rpc(RPC_URL, "eth_chainId", []);
          break;
        } catch {
          // oxlint-disable-next-line no-await-in-loop -- sequential polling
          await sleep(1000);
        }
      }
      const wallet = await createNodeWallet({
        verifyEvent,
        passkey: {
          rpId: "qntx.test",
          rpName: "qntx",
          walletSalt: "qntx/wallet",
          backupSalt: "qntx/backup",
          vaultSalt: "qntx/vault",
        },
        autoLock: { platform: "web", idleMinutes: 15 },
        authenticator: createSoftwarePasskey(randomBytes(32)),
        kernelUrl: KERNEL_URL,
      });
      const info = await wallet.wallets.importMnemonic({
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        factor: BVERIFY,
      });
      const { walletId } = info;
      const acct = await chains(wallet).account({
        walletId,
        groupIndex: 0,
        template: "evm.bip44",
        network: N1,
      });
      const from = (acct as { address?: string }).address ?? "";
      await rpc(RPC_URL, "anvil_setBalance", [from, "0x56BC75E2D63100000"]);
      const ctl = new TransactionController({
        wallet,
        networks: new NetworkController({
          ...idleNetworkDeps,
          fetch: globalThis.fetch.bind(globalThis),
          rpc: { [N1]: [RPC_URL] },
          openStore: async () => Promise.resolve(createMemoryEngineStore()),
          logger: { warn: () => {} },
        }),
        openStore: async () => Promise.resolve(createMemoryEngineStore()),
        random: taggedRandom(),
        setTimer: () => () => undefined,
        now: () => 1000,
        logger: { warn: () => {} },
        pollMs: 1,
      });
      await ctl.init();
      const requests = await requestsFor(ctl);
      const account = {
        kind: "hd" as const,
        walletId,
        groupIndex: 0,
        template: "evm.bip44" as const,
      };
      const stakeAmount = 200_000_000_000_000_000n;
      const run = async (
        method: "evm-lido" | "evm-approve",
        extra: Record<string, unknown>,
      ): Promise<TrackedTransaction> => {
        const pending = await requests.prepare({
          method,
          account,
          network: N1,
          fee: "normal",
          ...extra,
        } as never);
        return requests.approve(pending.id, method, BVERIFY);
      };
      const stakeTx = await run("evm-lido", { action: { kind: "stake", amount: stakeAmount } });
      expect(stakeTx.intent?.summary).toBe("stake");
      await waitReceipt(RPC_URL, stakeTx.hash ?? "", Date.now() + 180_000);
      const balAfter = (await rpc(RPC_URL, "eth_call", [
        {
          to: LIDO_STETH,
          data: `0x70a08231000000000000000000000000${from.slice(2)}`,
        },
        "latest",
      ])) as string;
      expect(BigInt(balAfter)).toBeGreaterThan(0n);
      await run("evm-approve", {
        token: LIDO_STETH,
        spender: LIDO_QUEUE,
        amount: stakeAmount,
      }).then(async (t) => waitReceipt(RPC_URL, t.hash ?? "", Date.now() + 180_000));
      const requestTx = await run("evm-lido", {
        action: { kind: "request", amount: stakeAmount / 2n },
      });
      expect(requestTx.intent?.summary).toBe("stake");
      expect(requestTx.intent?.staking?.[0]?.kind).toBe("lido-request");
      await waitReceipt(RPC_URL, requestTx.hash ?? "", Date.now() + 180_000);
    } finally {
      anvil.kill("SIGKILL");
      spawnSync("pkill", ["-f", `anvil.*--port.*${PORT}`]);
      rmSync(ledger, { recursive: true, force: true });
    }
  }, 600_000);
});
