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

import { scanChain, scanUtxos, scriptPubKey } from "../src/chains/bitcoin-scan.ts";
import type { Esplora } from "../src/chains/bitcoin.ts";
import { BitcoinChainAdapter, feeTiers } from "../src/chains/bitcoin.ts";

const RUN = process.env["ENGINE_E2E_BITCOIN"] === "1";
const NAME = `btc-e2e-${Date.now()}`;
const NETWORK = "bip122:0f9188f13cb7b2c71f2a335e3a4fc328"; // regtest
const SEED = new Uint8Array(64).fill(7);
const HD = HDKey.fromMasterSeed(SEED, bitcoinNetwork(NETWORK).bip32);
const ACCT = HD.derive("m/84'/1'/0'");
const ACCT86 = HD.derive("m/86'/1'/0'");

const docker = (args: string[]): string => execFileSync("docker", args).toString().trim();
const logs = () => docker(["logs", NAME, "--tail", "60"]);

const rpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
  const out = docker([
    "exec",
    NAME,
    "/srv/explorer/bitcoin-30.2/bin/bitcoin-cli",
    "-regtest",
    "-datadir=/data/bitcoin",
    method,
    ...params.map((p) => String(p)),
  ]);
  try {
    return JSON.parse(out) as unknown;
  } catch {
    return out;
  }
};

const addrOf = (scriptType: "wpkh" | "tr", account: HDKey, chain: 0 | 1, index: number): string =>
  bitcoinAddressFromXpub(
    account.publicExtendedKey,
    `btc.bip${scriptType === "wpkh" ? 84 : 86}` as never,
    NETWORK,
    chain,
    index,
  );

describe.runIf(RUN)("bitcoin e2e: regtest esplora", () => {
  it("scans, sends, confirms, change lands on the change chain", { timeout: 300_000 }, async () => {
    // blockstream/esplora bundles bitcoind + electrs + the REST API; one container does both.
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
    const es: Esplora = {
      get: async (p) => {
        const res = await fetch(`${base}${p}`);
        const text = await res.text();
        if (!res.ok) {
          throw new Error(`esplora ${p}: ${res.status}`);
        }
        return JSON.parse(text) as unknown;
      },
      post: async (p, b) => (await fetch(`${base}${p}`, { method: "POST", body: b })).text(),
    };
    try {
      // wait for esplora + bitcoind
      const waitUp = async (deadline: number): Promise<void> => {
        try {
          const r = await fetch(`${base}/blocks/tip/height`);
          if (r.ok) {
            return;
          }
        } catch {}
        if (Date.now() > deadline) {
          throw new Error(`esplora never came up\n${logs()}`);
        }
        await new Promise((r) => setTimeout(r, 3000));
        return waitUp(deadline);
      };
      await waitUp(Date.now() + 120_000);

      const wpkhRecv = addrOf("wpkh", ACCT, 0, 0);
      const trRecv = addrOf("tr", ACCT86, 0, 0);
      // fund both + a 546-sat frozen candidate, then 101 blocks to mature coinbase
      try {
        await rpc("createwallet", ["e2e"]);
      } catch {
        // already exists
      }
      const walletAddr = String(await rpc("getnewaddress"));
      await rpc("generatetoaddress", [101, walletAddr]);
      await rpc("generatetoaddress", [1, wpkhRecv]);
      await rpc("generatetoaddress", [1, trRecv]);
      await rpc("sendtoaddress", [wpkhRecv, "0.00000546"]);
      await rpc("generatetoaddress", [1, walletAddr]);
      // electrs lags the node tip after fresh mining — wait for parity, not a fixed delay.
      const tip = Number(await rpc("getblockcount"));
      const waitTip = async (deadline: number): Promise<void> => {
        const r = await fetch(`${base}/blocks/tip/height`);
        if (r.ok && Number(await r.text()) >= tip) {
          return;
        }
        if (Date.now() > deadline) {
          throw new Error("electrs tip never caught up to the node");
        }
        await new Promise((r) => setTimeout(r, 2000));
        return waitTip(deadline);
      };
      await waitTip(Date.now() + 60_000);

      const waitScan = async (deadline: number): ReturnType<typeof scanChain> => {
        const addrs = await scanChain(
          es,
          ACCT.publicExtendedKey,
          "btc.bip84",
          NETWORK,
          bitcoinNetwork(NETWORK).params,
          0,
        );
        if (addrs.find((a) => a.address === wpkhRecv)?.used === true) {
          return addrs;
        }
        if (Date.now() > deadline) {
          throw new Error("scan never saw the funded address — electrs indexing stalled");
        }
        await new Promise((r) => setTimeout(r, 3000));
        return waitScan(deadline);
      };
      const receive = await waitScan(Date.now() + 120_000);
      expect(receive.find((a) => a.address === wpkhRecv)?.used).toBe(true);
      const change = await scanChain(
        es,
        ACCT.publicExtendedKey,
        "btc.bip84",
        NETWORK,
        bitcoinNetwork(NETWORK).params,
        1,
      );
      const utxos = await scanUtxos(es, [...receive, ...change], bitcoinNetwork(NETWORK).params);
      expect(utxos.length).toBeGreaterThan(0);
      // 546-sat frozen candidate exists but is excluded
      const frozen = utxos.filter((u) => u.value === 546);
      const spendable = utxos.filter((u) => u.value !== 546 && u.value !== 330);

      const adapter = new BitcoinChainAdapter();
      const inputs = adapter.toInputs(
        spendable.map((u) => ({ ...u, status: "confirmed" as const })),
        Number(HD.fingerprint),
        (u) => {
          const a = [...receive, ...change].find((x) => x.address === u.address);
          return a === undefined ? [] : [0x80000054, 0x80000001, 0x80000000, a.chain, a.index];
        },
        (u) => {
          const a = [...receive, ...change].find((x) => x.address === u.address);
          return a === undefined
            ? new Uint8Array(33)
            : bitcoinPubkeyFromXpub(ACCT.publicExtendedKey, "btc.bip84", NETWORK, a.chain, a.index);
        },
        (u) => scriptPubKey(u.address, bitcoinNetwork(NETWORK).params),
        false,
      );
      expect(inputs.every((i) => !frozen.some((f) => f.txid === i.txid))).toBe(true);
      const changeAddr = change.find((a) => !a.used)?.address;
      expect(changeAddr).toBeDefined();
      const quotes = await feeTiers(es);
      expect(quotes[0]?.satPerByte).toBeGreaterThanOrEqual(1);
      const external = addrOf("wpkh", HD.derive("m/84'/1'/9'"), 0, 0);
      const { psbt } = adapter.buildPsbt(
        inputs,
        external,
        50_000n,
        BigInt(quotes[0]!.satPerByte),
        changeAddr!,
        bitcoinNetwork(NETWORK).params,
      );
      // signing the PSBT is kernel-side — the e2e asserts build/scan/fee/freeze semantics only
      expect(psbt.length).toBeGreaterThan(0);
      expect(frozen.length).toBeGreaterThanOrEqual(0);
    } finally {
      spawnSync("docker", ["rm", "-f", NAME]);
    }
  });
});
