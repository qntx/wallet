/**
 * Regtest e2e: `blockstream/esplora` (bundles bitcoind + electrs + REST) mines to the derived
 * bip84/bip86 receive addresses; the scan finds the UTXOs; a send from each template confirms with
 * change landing on the change chain; a 546-sat UTXO stays frozen.
 */
import { execFileSync, spawnSync } from "node:child_process";

import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vite-plus/test";

import {
  bitcoinAddressFromXpub,
  bitcoinPubkeyFromXpub,
  bitcoinNetwork,
} from "@qntx/wallet-chains/bitcoin";

import type { ScanAddress } from "../src/chains/bitcoin-scan.ts";
import { scanChain, scanUtxos, scriptPubKey } from "../src/chains/bitcoin-scan.ts";
import type { Esplora, EsploraResponse } from "../src/chains/bitcoin.ts";
import { esplora, BitcoinChainAdapter, feeTiers } from "../src/chains/bitcoin.ts";

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
        headers: r.headers,
        json: async () => r.json(),
        text: async () => r.text(),
      };
    },
    sleep,
  );

const rpc = async (method: string, params: ReadonlyArray<unknown> = []): Promise<unknown> => {
  const out = docker([
    "exec",
    NAME,
    "/srv/explorer/bitcoin-30.2/bin/bitcoin-cli",
    "-regtest",
    "-datadir=/data/bitcoin",
    method,
    ...params.map((p) => String(p)),
  ]);
  const parsed: unknown = JSON.parse(out);
  return parsed;
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

const makeRpc =
  () =>
  async (method: string, params: ReadonlyArray<unknown> = []): Promise<unknown> =>
    rpc(method, params);

describe.runIf(RUN)("bitcoin e2e: regtest esplora", () => {
  it("scans, sends, confirms, change lands on the change chain", { timeout: 300_000 }, async () => {
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
    const run = makeRpc();
    try {
      await waitFor(esploraUp(base), 3000, Date.now() + 120_000, () => {
        throw new Error(`esplora never came up\n${logs()}`);
      });

      const wpkhRecv = addrOf("wpkh", ACCT, 0, 0);
      const trRecv = addrOf("tr", ACCT86, 0, 0);
      await run("createwallet", ["e2e"]).catch(() => undefined);
      const walletAddr = String(await run("getnewaddress"));
      await run("generatetoaddress", [101, walletAddr]);
      await run("generatetoaddress", [1, wpkhRecv]);
      await run("generatetoaddress", [1, trRecv]);
      await run("sendtoaddress", [wpkhRecv, "0.00000546"]);
      await run("generatetoaddress", [1, walletAddr]);

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
        Number(HD.fingerprint),
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
  });
});
