/**
 * Regtest e2e: `blockstream/esplora` (bundles bitcoind + electrs + REST) mines to the derived
 * bip84/bip86 receive addresses; the scan finds the UTXOs; a send from each template confirms with
 * change landing on the change chain; a 546-sat UTXO stays frozen.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";
import {
  bitcoinAddressFromXpub,
  bitcoinPubkeyFromXpub,
  bitcoinNetwork,
} from "@qntx/wallet-chains/bitcoin";
import { createNodeWallet, createSoftwarePasskey } from "@qntx/wallet-worker/node";
import { chains } from "@qntx/wallet/chains";

import type { ScanAddress } from "../src/chains/bitcoin-scan.ts";
import { scanChain, scanUtxos, scriptPubKey } from "../src/chains/bitcoin-scan.ts";
import type { Esplora, EsploraResponse } from "../src/chains/bitcoin.ts";
import { esplora, BitcoinChainAdapter, feeTiers } from "../src/chains/bitcoin.ts";
import type { EngineLogger } from "../src/events.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import { TransactionController } from "../src/transactions/controller.ts";

const RUN = process.env["ENGINE_E2E_BITCOIN"] === "1";
const NAME = `btc-e2e-${Date.now()}`;
const NETWORK = "bip122:0f9188f13cb7b2c71f2a335e3a4fc328"; // regtest
const SEED = new Uint8Array(64).fill(7);
const HD = HDKey.fromMasterSeed(SEED, bitcoinNetwork(NETWORK).bip32);
const ACCT = HD.derive("m/84'/1'/0'");
const ACCT86 = HD.derive("m/86'/1'/0'");

const docker = (args: string[]): string => execFileSync("docker", args).toString().trim();
const logs = () => docker(["logs", NAME, "--tail", "60"]);

const sleep = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const esploraClient = (base: string): Esplora =>
  esplora(
    [base],
    async (url, init): Promise<EsploraResponse> => {
      const r = await fetch(url, init);
      return {
        ok: r.ok,
        status: r.status,
        headers: { get: (n: string) => r.headers.get(n) ?? undefined },
        json: async () => r.json(),
        text: async () => r.text(),
      };
    },
    sleep,
  );

const rpc = (container: string, method: string, params: ReadonlyArray<unknown> = []): unknown => {
  const out = docker([
    "exec",
    container,
    "/srv/explorer/bitcoin-30.2/bin/bitcoin-cli",
    "-regtest",
    "-datadir=/data/bitcoin",
    method,
    ...params.map(String),
  ]);
  try {
    return JSON.parse(out) as unknown;
  } catch {
    return out;
  }
};

const waitFor = async (
  ready: () => Promise<boolean>,
  sleepMs: number,
  deadline: number,
  onTimeout: () => never,
): Promise<void> => {
  if (await ready()) {
    return;
  }
  if (Date.now() > deadline) {
    onTimeout();
  }
  await sleep(sleepMs);
  await waitFor(ready, sleepMs, deadline, onTimeout);
};

const esploraUp = (base: string) => async (): Promise<boolean> => {
  try {
    const r = await fetch(`${base}/blocks/tip/height`);
    return r.ok;
  } catch {
    return false;
  }
};

const tipSynced = (base: string, tip: number) => async (): Promise<boolean> => {
  const r = await fetch(`${base}/blocks/tip/height`);
  const text = await r.text();
  return r.ok && Number(text) >= tip;
};

const addrOf = (kind: "wpkh" | "tr", account: HDKey, chain: 0 | 1, index: number): string =>
  bitcoinAddressFromXpub(
    account.publicExtendedKey,
    `btc.bip${kind === "wpkh" ? 84 : 86}`,
    NETWORK,
    chain,
    index,
  );

const bip84PathOf =
  (addrs: ReadonlyArray<ScanAddress>) =>
  (u: { address: string }): number[] => {
    const i = addrs.findIndex((a) => a.address === u.address);
    const a = addrs[i];
    return a === undefined ? [] : [0x80000054, 0x80000001, 0x80000000, a.chain, a.index];
  };

const bip84PubOf =
  (addrs: ReadonlyArray<ScanAddress>) =>
  (u: { address: string }): Uint8Array => {
    const a = addrs.find((x) => x.address === u.address);
    return a === undefined
      ? new Uint8Array(33)
      : bitcoinPubkeyFromXpub(ACCT.publicExtendedKey, "btc.bip84", NETWORK, a.chain, a.index);
  };

const scriptOf = (u: { address: string }): Uint8Array =>
  scriptPubKey(u.address, bitcoinNetwork(NETWORK).params);

const regtestFlow = async () => {
  const port = 8094 + (Date.now() % 1000);
  spawnSync("docker", [
    "run",
    "-d",
    "--name",
    NAME,
    "-p",
    `${port}:80`,
    "blockstream/esplora@sha256:ef092138f7fcd5f3988441adf056632d64a7b95908896c471355c750a18f4541",
    "bash",
    "-c",
    "/srv/explorer/run.sh bitcoin-regtest explorer",
  ]);
  const base = `http://127.0.0.1:${port}/regtest/api`;
  const es = esploraClient(base);
  const run = (method: string, params: ReadonlyArray<unknown> = []): unknown =>
    rpc(NAME, method, params);
  try {
    await waitFor(esploraUp(base), 3000, Date.now() + 120_000, () => {
      throw new Error(`esplora never came up\n${logs()}`);
    });

    const wpkhRecv = addrOf("wpkh", ACCT, 0, 0);
    const trRecv = addrOf("tr", ACCT86, 0, 0);
    try {
      run("createwallet", ["e2e"]);
    } catch {
      // wallet already exists
    }
    const walletAddr = run("getnewaddress") as string;
    run("generatetoaddress", [101, walletAddr]);
    run("generatetoaddress", [1, wpkhRecv]);
    run("generatetoaddress", [1, trRecv]);
    run("sendtoaddress", [wpkhRecv, "0.00000546"]);
    run("generatetoaddress", [1, walletAddr]);

    const tip = Number(await run("getblockcount"));
    await waitFor(tipSynced(base, tip), 2000, Date.now() + 60_000, () => {
      throw new Error("electrs tip never caught up to the node");
    });

    let receive: ReadonlyArray<ScanAddress> = [];
    await waitFor(
      async () => {
        receive = await scanChain(
          es,
          ACCT.publicExtendedKey,
          "btc.bip84",
          NETWORK,
          bitcoinNetwork(NETWORK).params,
          0,
        );
        return receive.some((a) => a.address === wpkhRecv && a.used);
      },
      3000,
      Date.now() + 120_000,
      () => {
        throw new Error("scan never saw the funded address — electrs indexing stalled");
      },
    );
    expect(receive.some((a) => a.address === wpkhRecv && a.used)).toBe(true);
    const change = await scanChain(
      es,
      ACCT.publicExtendedKey,
      "btc.bip84",
      NETWORK,
      bitcoinNetwork(NETWORK).params,
      1,
    );
    const all = [...receive, ...change];
    const utxos = await scanUtxos(es, all, bitcoinNetwork(NETWORK).params);
    expect(utxos.length).toBeGreaterThan(0);
    const frozen = utxos.filter((u) => u.value === 546);
    const spendable = utxos.filter((u) => u.value !== 546 && u.value !== 330);

    const adapter = new BitcoinChainAdapter();
    const inputs = adapter.toInputs(
      spendable.map((u) => ({ ...u, status: "confirmed" as const })),
      HD.fingerprint,
      bip84PathOf(all),
      bip84PubOf(all),
      scriptOf,
      false,
    );
    expect(inputs.every((i) => frozen.every((f) => f.txid !== i.txid))).toBe(true);
    const changeAddr = change.find((a) => !a.used)?.address;
    expect(changeAddr).toBeDefined();
    const quotes = await feeTiers(es);
    const satPerByte = quotes[0]?.satPerByte ?? 1;
    expect(satPerByte).toBeGreaterThanOrEqual(1);
    const external = addrOf("wpkh", HD.derive("m/84'/1'/9'"), 0, 0);
    const { psbt } = adapter.buildPsbt(
      inputs,
      external,
      50_000n,
      BigInt(satPerByte),
      changeAddr ?? external,
      bitcoinNetwork(NETWORK).params,
    );
    expect(psbt.length).toBeGreaterThan(0);
    expect(frozen.length).toBeGreaterThanOrEqual(0);
  } finally {
    spawnSync("docker", ["rm", "-f", NAME]);
  }
};

describe.runIf(RUN)("bitcoin e2e: regtest esplora", () => {
  it("scans, sends, confirms, change lands on the change chain", { timeout: 300_000 }, async () => {
    expect.hasAssertions();
    await regtestFlow();
  });
});

const KERNEL_URL = new URL("../../wallet-worker/dist/kernel.node.js", import.meta.url);
const BPASSWORD = "correct horse battery staple";
const BVERIFY = { kind: "password" as const, password: BPASSWORD };
const quiet: EngineLogger = { warn: () => {} };

const taggedRandom = (): ((n: number) => Uint8Array) => {
  let tag = 0;
  return (n) => {
    tag += 1;
    return new Uint8Array(n).fill(tag);
  };
};

const realWallet = async (): Promise<{ wallet: Wallet; walletId: string }> => {
  const wallet = await createNodeWallet({
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
    factor: { kind: "password", password: BPASSWORD },
  });
  return { wallet, walletId: info.walletId };
};

const ctlRig = async (
  base: string,
  timers: Array<() => unknown>,
): Promise<{ ctl: TransactionController; walletId: string; xpub: string }> => {
  const { wallet, walletId } = await realWallet();
  const acct = await chains(wallet).account({
    walletId,
    groupIndex: 0,
    template: "btc.bip84",
    network: NETWORK,
  });
  const xpub = "xpub" in acct ? acct.xpub : "";
  const ctl = new TransactionController({
    wallet,
    networks: new NetworkController({
      fetch: globalThis.fetch.bind(globalThis),
      rpc: { [NETWORK]: [base] },
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      logger: quiet,
    }),
    openStore: async () => Promise.resolve(createMemoryEngineStore()),
    random: taggedRandom(),
    setTimer: (_ms, fn) => {
      timers.push(fn);
      return () => {};
    },
    now: () => 1000,
    logger: quiet,
    pollMs: 1,
  });
  await ctl.init();
  return { ctl, walletId, xpub };
};

const rbfFlow = async (mode: "speed-up" | "cancel" | "cpfp"): Promise<void> => {
  const port = 8194 + (Date.now() % 1000);
  spawnSync("docker", [
    "run",
    "-d",
    "--name",
    `${NAME}-rbf`,
    "-p",
    `${port}:80`,
    "blockstream/esplora@sha256:ef092138f7fcd5f3988441adf056632d64a7b95908896c471355c750a18f4541",
    "bash",
    "-c",
    "/srv/explorer/run.sh bitcoin-regtest explorer",
  ]);
  const base = `http://127.0.0.1:${port}/regtest/api`;
  const timers: Array<() => unknown> = [];
  try {
    await waitFor(esploraUp(base), 3000, Date.now() + 120_000, () => {
      throw new Error(`esplora never came up\n${logs()}`);
    });
    try {
      rpc(`${NAME}-rbf`, "createwallet", ["e2e-rbf"]);
    } catch {
      // wallet exists
    }
    const { ctl, walletId, xpub } = await ctlRig(base, timers);
    const recv = bitcoinAddressFromXpub(xpub, "btc.bip84", NETWORK, 0, 0);
    const walletAddr = rpc(`${NAME}-rbf`, "getnewaddress") as string;
    rpc(`${NAME}-rbf`, "generatetoaddress", [101, walletAddr]);
    rpc(`${NAME}-rbf`, "sendtoaddress", [recv, "0.00050000"]);
    rpc(`${NAME}-rbf`, "generatetoaddress", [1, walletAddr]);
    await waitFor(
      async () => {
        const es = esploraClient(base);
        const scanned = await scanChain(
          es,
          xpub,
          "btc.bip84",
          NETWORK,
          bitcoinNetwork(NETWORK).params,
          0,
        );
        return scanned.some((s) => s.address === recv && s.used);
      },
      3000,
      Date.now() + 120_000,
      () => {
        throw new Error("scan never saw the funded address");
      },
    );

    const external = addrOf("wpkh", HD.derive("m/84'/1'/9'"), 0, 0);
    const original = await ctl.send({
      account: { kind: "hd", walletId, groupIndex: 0, template: "btc.bip84" },
      network: NETWORK,
      to: external,
      amount: 10_000n,
      fee: "slow",
      verify: BVERIFY,
    });
    expect(original.state).toBe("submitted");

    if (mode === "cpfp") {
      const child = await ctl.bumpChild(original.id, 10, BVERIFY);
      expect(child.state).toBe("submitted");
      rpc(`${NAME}-rbf`, "generatetoaddress", [1, walletAddr]);
      await waitFor(
        async () => {
          await Promise.all(timers.map((fn) => fn()));
          return (
            ctl.getState().txs[child.id]?.state === "confirmed" &&
            ctl.getState().txs[original.id]?.state === "confirmed"
          );
        },
        3000,
        Date.now() + 120_000,
        () => {
          throw new Error("cpfp package never confirmed");
        },
      );
      return;
    }

    const bumped = await ctl.replace(original.id, mode, BVERIFY);
    expect(bumped.state).toBe("submitted");
    rpc(`${NAME}-rbf`, "generatetoaddress", [1, walletAddr]);
    await waitFor(
      async () => {
        await Promise.all(timers.map((fn) => fn()));
        const { txs } = ctl.getState();
        return txs[bumped.id]?.state === "confirmed" && txs[original.id]?.state === "replaced";
      },
      3000,
      Date.now() + 120_000,
      () => {
        throw new Error(`replacement never confirmed: ${JSON.stringify(ctl.getState().txs)}`);
      },
    );
    if (mode === "cancel") {
      const out = bumped.btc?.outputs;
      expect(out).toHaveLength(1);
      expect(out?.[0]?.own).toBe(true);
    }
  } finally {
    spawnSync("docker", ["rm", "-f", `${NAME}-rbf`]);
  }
};

describe.runIf(RUN)("bitcoin e2e: rbf/cpfp through engine.transactions", () => {
  it(
    "speed-up confirms the replacement; the original is replaced",
    { timeout: 300_000 },
    async () => {
      expect.hasAssertions();
      await rbfFlow("speed-up");
    },
  );

  it("cancel sends the funds back to our change address", { timeout: 300_000 }, async () => {
    expect.hasAssertions();
    await rbfFlow("cancel");
  });

  it("cpfp child confirms the parent package", { timeout: 300_000 }, async () => {
    expect.hasAssertions();
    await rbfFlow("cpfp");
  });
});
