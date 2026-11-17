import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { verifyEvent } from "@qntx/nostr";
import type { Wallet, WalletOptions } from "@qntx/wallet";
import { chains } from "@qntx/wallet/chains";
import { spark } from "@qntx/wallet/spark";

import sparkAccounts from "../../../../vectors/spark-accounts.json" with { type: "json" };
import { createWebWallet } from "../../src/browser/index.ts";
import { startBrowserKernel } from "../../src/worker/browser-kernel.ts";

// Vite serves the built wasm for this literal form, as a bundler does for the worker's own URL.
const SPARK_WASM = new URL("../../dist/spark.wasm", import.meta.url);
const REGTEST_VECTOR = sparkAccounts.vectors.find((vector) => vector.network === "regtest") ?? {
  groupIndex: 0,
  identityPublicKey: "",
};
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct horse battery staple";
const VERIFY = { kind: "password" as const, password: PASSWORD };
const OPTIONS: WalletOptions = {
  passkey: {
    rpId: "localhost",
    rpName: "localhost",
    walletSalt: "qntx/wallet",
    vaultSalt: "qntx/vault",
    backupSalt: "qntx/backup",
  },
  autoLock: { platform: "web", idleMinutes: 15 },
  verifyEvent,
};

/**
 * `Worker` with the kernel running in the page: the host's port wiring, the kernel entry and the
 * IndexedDB store all execute from source here, where coverage sees them. The real worker boundary
 * — the bundle, its chunks, Trusted Types — is the Playwright suite's subject.
 */
class PageKernelWorker extends EventTarget {
  static spawned = 0;
  static terminated = 0;
  private readonly host: MessagePort;
  private readonly kernel: MessagePort;

  constructor() {
    super();
    const { port1, port2 } = new MessageChannel();
    this.host = port1;
    this.kernel = port2;
    PageKernelWorker.spawned += 1;
    this.host.addEventListener("message", (event) => {
      this.dispatchEvent(new MessageEvent("message", { data: event.data }));
    });
    this.host.start();
    startBrowserKernel(this.kernel, SPARK_WASM);
    this.kernel.start();
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.host.postMessage(message, transfer);
  }

  terminate(): void {
    PageKernelWorker.terminated += 1;
    this.host.close();
    this.kernel.close();
  }
}

async function deleteVault(): Promise<void> {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("qntx-wallet");
    request.addEventListener("success", resolve);
    request.addEventListener("error", reject);
  });
}

describe("createWebWallet", () => {
  let wallet: Wallet | undefined;

  beforeEach(async () => {
    PageKernelWorker.spawned = 0;
    PageKernelWorker.terminated = 0;
    vi.stubGlobal("Worker", PageKernelWorker);
    await deleteVault();
  });

  afterEach(async () => {
    await wallet?.destroy();
    wallet = undefined;
    vi.unstubAllGlobals();
  });

  it("rejects a policy that is not the web one before spawning anything", async () => {
    await expect(
      createWebWallet({ ...OPTIONS, autoLock: { platform: "native", backgroundSeconds: 60 } }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(PageKernelWorker.spawned).toBe(0);
  });

  it("creates a vault in IndexedDB, signs, locks by ending the worker and unlocks a new one", async () => {
    wallet = await createWebWallet(OPTIONS);
    expect(wallet.getSnapshot().vault).toBe("uninitialized");
    const created = await wallet.wallets.importMnemonic({ mnemonic: MNEMONIC, factor: VERIFY });
    expect(wallet.getSnapshot().vault).toBe("unlocked");

    const account = await chains(wallet).account({
      walletId: created.walletId,
      groupIndex: 0,
      template: "evm.bip44",
      network: "eip155:1",
    });
    expect(account).toMatchObject({ address: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" });

    const { spawned } = PageKernelWorker;
    await wallet.vault.lock();
    expect(wallet.getSnapshot().vault).toBe("locked");
    expect(PageKernelWorker.terminated).toBeGreaterThan(0);
    expect(PageKernelWorker.spawned).toBeGreaterThan(spawned);

    await wallet.vault.unlock(VERIFY);
    expect(wallet.getSnapshot().wallets.map((w) => w.walletId)).toStrictEqual([created.walletId]);
  });

  it("loads spark.wasm past its integrity check and derives the vector identity key", async () => {
    wallet = await createWebWallet(OPTIONS);
    const created = await wallet.wallets.importMnemonic({
      mnemonic: sparkAccounts.mnemonic,
      factor: VERIFY,
    });
    const signer = spark(wallet).signer({
      walletId: created.walletId,
      groupIndex: REGTEST_VECTOR.groupIndex,
      network: "regtest",
    });
    const identity = await signer.identityPublicKey();
    expect(bytesToHex(identity)).toBe(REGTEST_VECTOR.identityPublicKey);
  });

  it("locks when the page is hidden", async () => {
    wallet = await createWebWallet(OPTIONS);
    await wallet.wallets.importMnemonic({ mnemonic: MNEMONIC, factor: VERIFY });
    globalThis.dispatchEvent(new PageTransitionEvent("pagehide"));
    await vi.waitFor(() => {
      expect(wallet?.getSnapshot().vault).toBe("locked");
    });
  });

  it("asks the browser to persist storage once a vault exists", async () => {
    const persist = vi.spyOn(navigator.storage, "persist").mockResolvedValue(true);
    wallet = await createWebWallet(OPTIONS);
    expect(persist).not.toHaveBeenCalled();
    await wallet.wallets.importMnemonic({ mnemonic: MNEMONIC, factor: VERIFY });
    await vi.waitFor(() => {
      expect(persist).toHaveBeenCalledTimes(1);
    });
    persist.mockRestore();
  });

  it("stops listening to the page once destroyed", async () => {
    const removed = vi.spyOn(globalThis, "removeEventListener");
    wallet = await createWebWallet(OPTIONS);
    await wallet.destroy();
    wallet = undefined;
    expect(removed.mock.calls.map(([type]) => type)).toContain("pagehide");
    removed.mockRestore();
  });
});

describe("startBrowserKernel", () => {
  it("stays silent until a valid init message arrives", async () => {
    const { port1, port2 } = new MessageChannel();
    const messages: unknown[] = [];
    port1.addEventListener("message", (event) => {
      messages.push(event.data);
    });
    port1.start();
    startBrowserKernel(port2, SPARK_WASM);
    port2.start();
    port1.postMessage({ t: "init", idleMinutes: 7 });
    port1.postMessage({ v: 3, id: 1, method: "status", params: null });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(messages).toStrictEqual([]);
    port1.postMessage({ t: "init", idleMinutes: 5 });
    await vi.waitFor(() => {
      expect(messages.length).toBeGreaterThan(0);
    });
    port1.close();
    port2.close();
  });
});
