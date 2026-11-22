/**
 * Engine ↔ gateway capacity: measures the engine's real upstream call counts through the real
 * in-process gateway on the production account table, before any engine read-path change.
 *
 * Host actions (what "cold start" means here): after the engine is ready, for every enabled network
 * of the scenario — `assets.refresh(address, network)` (EVM/Solana/TRON) or
 * `assets.refreshBitcoinGroup(group, network)` — then `prices.setVisible(true)` +
 * `prices.refresh()`, `history.load(group)`, and finally wait until no gateway request has been in
 * flight for 500 ms (background inits — phishing, network list, token lists — count too).
 * "Foreground refresh" is the same assets refreshes plus `prices.refresh()` counted alone. "One
 * send" is `requests.prepare` + `approve` of a native transfer on eip155:1, Solana mainnet, Bitcoin
 * mainnet and TRON mainnet from the `used` wallet, counted from prepare until approve resolves.
 *
 * Output: a markdown table + JSON under `CAPACITY_REPORT` (`<path>.md`/`<path>.json`) when set.
 * Assertions in this layer: every scenario completes and no upstream path is unstubbed.
 */
import { writeFileSync } from "node:fs";

import { NETWORK } from "@scure/btc-signer";
// oxlint-disable vitest/no-conditional-in-test -- the scenario matrix is inherently conditional
import { describe, expect, it } from "vite-plus/test";

import { PRODUCTION_NETWORKS } from "../../../apps/gateway/src/config/networks.ts";
import { approval } from "./approval.ts";
import {
  createHarnessWallet,
  createWorld,
  diffReadings,
  quietFor,
  TRC20,
  VERIFY,
  walletAddresses,
} from "./gateway-capacity/harness.ts";
import type { Readings, World } from "./gateway-capacity/harness.ts";
import {
  bitcoinAddresses,
  bitcoinUsed,
  freshModel,
  usedModel,
} from "./gateway-capacity/upstream.ts";
import type { WalletModel } from "./gateway-capacity/upstream.ts";

const EVM1 = "eip155:1";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BITCOIN = "bip122:000000000019d6689c085ae165831e93";
const TRON = "tron:728126428";

const byId = (id: string) => PRODUCTION_NETWORKS.filter((n) => n.id === id);
const firstEvm = (count: number) =>
  PRODUCTION_NETWORKS.filter((n) => n.id.startsWith("eip155:")).slice(0, count);

const REPORT = process.env["CAPACITY_REPORT"];

type Row = { readonly name: string } & Readings;

const table = (rows: ReadonlyArray<Row>): string => {
  const accounts = [...new Set(rows.flatMap((r) => [...r.upstream.keys()]))].toSorted();
  const routes = [...new Set(rows.flatMap((r) => [...r.routes.keys()]))].toSorted();
  const head = `| scenario | ${routes.join(" | ")} | statuses | ${accounts.map((a) => `${a} calls/units`).join(" | ")} | max share |`;
  const sep = `|${"---|".repeat(3 + routes.length + accounts.length)}`;
  const lines = rows.map((r) => {
    const cells = [
      r.name,
      ...routes.map((c) => String(r.routes.get(c) ?? 0)),
      [...r.statuses].map(([s, n]) => `${String(s)}×${String(n)}`).join(","),
      ...accounts.map((a) => {
        const u = r.upstream.get(a);
        return u === undefined ? "0/0" : `${String(u.calls)}/${String(u.units)}`;
      }),
      String(Math.max(0, ...r.share.values())),
    ];
    return `| ${cells.join(" | ")} |`;
  });
  return [head, sep, ...lines].join("\n");
};

const toJson = (rows: ReadonlyArray<Row>): string =>
  JSON.stringify(
    rows.map((r) => ({
      scenario: r.name,
      routes: Object.fromEntries(r.routes),
      statuses: Object.fromEntries([...r.statuses].map(([k, v]) => [String(k), v])),
      upstream: Object.fromEntries(r.upstream),
      budgetUnits: Object.fromEntries(r.budget),
      maxShareDeltaSum: Math.max(0, ...r.share.values()),
    })),
    undefined,
    2,
  );

/** Retries an action across rate-limit windows: a 429 is real measured behavior, not a failure. */
const withRetry = async (fn: () => Promise<unknown>, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- bounded sequential retry
      await fn();
      return;
    } catch (error) {
      const msg = String(error);
      const { status } = error as { status?: number };
      const retriable =
        status === 429 ||
        status === 503 ||
        status === 500 ||
        status === 408 ||
        /rate-limited|too-costly|ECONNRESET|fetch failed|Spark|HTTP request failed/i.test(msg);
      if (!retriable) {
        throw error;
      }
      // oxlint-disable-next-line no-await-in-loop -- bounded sequential retry
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 11_000);
      });
      if (attempt === 9) {
        console.log(`${label}: exhausted retries (${msg.slice(0, 120)})`);
      }
    }
  }
};

/** The spec's cold-start action set on one scenario world. */
const coldStart = async (
  world: World,
  networks: ReadonlyArray<{ id: string }>,
  walletId: string,
  addresses: { evm: string; solana: string; tron: string },
): Promise<void> => {
  const { engine } = world;
  const group = { walletId, groupIndex: 0 };
  for (const network of networks) {
    if (network.id.startsWith("bip122:")) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await withRetry(
        async () => engine.assets.refreshBitcoinGroup(group, network.id),
        `btc-refresh ${network.id}`,
      );
    } else {
      const address = network.id.startsWith("eip155:")
        ? addresses.evm
        : network.id.startsWith("solana:")
          ? addresses.solana
          : addresses.tron;
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await withRetry(
        async () => engine.assets.refresh(address, network.id),
        `assets.refresh ${network.id}`,
      );
    }
  }
  engine.prices.setVisible(true);
  await withRetry(async () => engine.prices.refresh(), "prices.refresh");
  await withRetry(async () => engine.history.load(group), "history.load");
  await quietFor(world);
};

describe("engine gateway capacity", () => {
  it("measures the real upstream call counts through the production gateway", async () => {
    const { wallet, walletId } = await createHarnessWallet();
    // Engine-internal background tasks (network probes, phishing inits) can reject on transient
    // 429/503s outside our awaited calls — swallow only retriable classes, count the rest.
    const strayRejections: string[] = [];
    const onRejection = (e: unknown): void => {
      const msg = String(e);
      const status = (e as { status?: number })?.status;
      if (
        status === 429 ||
        status === 503 ||
        status === 408 ||
        /rate-limited|too-costly|ECONNRESET|fetch failed|HTTP request failed/i.test(msg)
      ) {
        strayRejections.push(`retriable: ${msg.slice(0, 80)}`);
      } else {
        strayRejections.push(`FATAL: ${msg.slice(0, 200)}`);
      }
    };
    process.on("unhandledRejection", onRejection);
    const addresses = await walletAddresses(wallet, walletId, PRODUCTION_NETWORKS);
    const { xpubs } = addresses;
    const btcAddrs = bitcoinAddresses(xpubs, [
      { chain: 0, max: 3 },
      { chain: 1, max: 1 },
    ]);
    const fresh = freshModel();
    const used: WalletModel = usedModel({
      evmAddress: addresses.evm,
      bitcoin: bitcoinUsed(NETWORK, btcAddrs),
      trc20Contract: TRC20,
    });

    const rows: Row[] = [];
    const scenarioSets: ReadonlyArray<{
      name: string;
      networks: typeof PRODUCTION_NETWORKS;
    }> = [
      { name: "evm-1", networks: byId(EVM1) },
      { name: "evm-10", networks: firstEvm(10) },
      { name: "solana", networks: byId(SOLANA) },
      { name: "bitcoin", networks: byId(BITCOIN) },
      { name: "tron", networks: byId(TRON) },
      { name: "all", networks: PRODUCTION_NETWORKS },
    ];

    const run = async (
      name: string,
      networks: typeof PRODUCTION_NETWORKS,
      model: WalletModel,
      actions: (world: World) => Promise<void>,
    ): Promise<Row> => {
      const world = await createWorld({
        wallet,
        model,
        networks,
        tronAddress: addresses.tron,
      });
      const before = world.snapshot();
      await actions(world);
      const snap = world.snapshot();
      expect(
        world.stub.unstubbed,
        `${name}: unstubbed upstreams ${world.stub.unstubbed.join(", ")}`,
      ).toStrictEqual([]);
      return { name, ...diffReadings(snap, before) };
    };

    for (const { name, networks } of scenarioSets) {
      // oxlint-disable-next-line no-await-in-loop -- scenarios run one at a time
      const freshRow = await run(`${name} fresh cold`, networks, fresh, async (w) =>
        coldStart(w, networks, walletId, addresses),
      );
      rows.push(freshRow);
      // oxlint-disable-next-line no-await-in-loop -- scenarios run one at a time
      const usedWorld = await run(`${name} used cold`, networks, used, async (w) =>
        coldStart(w, networks, walletId, addresses),
      );
      rows.push(usedWorld);
      // Foreground refresh reuses the used world: same refreshes + prices, counted alone.
      // oxlint-disable-next-line no-await-in-loop -- scenarios run one at a time
      const refreshWorld = await createWorld({
        wallet,
        model: used,
        networks,
        tronAddress: addresses.tron,
      });
      const waitReady = async () => {
        for (
          let i = 0;
          i < 300 && refreshWorld.engine.accounts.getState().status !== "ready";
          i += 1
        ) {
          // oxlint-disable-next-line no-await-in-loop -- sequential polling
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
          });
        }
      };
      // oxlint-disable-next-line no-await-in-loop -- scenarios run one at a time
      await waitReady();
      // oxlint-disable-next-line no-await-in-loop -- scenarios run one at a time
      await coldStart(refreshWorld, networks, walletId, addresses);
      const before = refreshWorld.snapshot();
      const group = { walletId, groupIndex: 0 };
      for (const network of networks) {
        if (network.id.startsWith("bip122:")) {
          // oxlint-disable-next-line no-await-in-loop -- sequential by design
          await refreshWorld.engine.assets.refreshBitcoinGroup(group, network.id);
        } else {
          const address = network.id.startsWith("eip155:")
            ? addresses.evm
            : network.id.startsWith("solana:")
              ? addresses.solana
              : addresses.tron;
          // oxlint-disable-next-line no-await-in-loop -- sequential by design
          await refreshWorld.engine.assets.refresh(address, network.id);
        }
      }
      // oxlint-disable-next-line no-await-in-loop -- scenarios run one at a time
      await withRetry(async () => refreshWorld.engine.prices.refresh(), "prices.refresh fg");
      const snap = refreshWorld.snapshot();
      expect(refreshWorld.stub.unstubbed).toStrictEqual([]);
      rows.push({ name: `${name} refresh`, ...diffReadings(snap, before) });
    }

    // One send per family on the `all` used world.
    const sendWorld = await createWorld({
      wallet,
      model: used,
      networks: PRODUCTION_NETWORKS,
      tronAddress: addresses.tron,
    });
    for (let i = 0; i < 300 && sendWorld.engine.accounts.getState().status !== "ready"; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential polling
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    await coldStart(sendWorld, PRODUCTION_NETWORKS, walletId, addresses);
    const sends: ReadonlyArray<{
      name: string;
      account: object;
      network: string;
      to: string;
      amount: bigint;
    }> = [
      {
        name: "send evm",
        account: { kind: "hd" as const, walletId, groupIndex: 0, template: "evm.bip44" as const },
        network: EVM1,
        to: "0x000000000000000000000000000000000000dEaD",
        amount: 1000n,
      },
      {
        name: "send solana",
        account: {
          kind: "hd" as const,
          walletId,
          groupIndex: 0,
          template: "solana.bip44-change" as const,
        },
        network: SOLANA,
        to: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM",
        amount: 1000n,
      },
      {
        name: "send bitcoin",
        account: { kind: "hd" as const, walletId, groupIndex: 0, template: "btc.bip84" as const },
        network: BITCOIN,
        to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        // Above the P2WPKH dust bound — coin selection rightly refuses a 1-sat output.
        amount: 10_000n,
      },
      {
        name: "send tron",
        account: { kind: "hd" as const, walletId, groupIndex: 0, template: "tron.bip44" as const },
        network: TRON,
        to: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
        amount: 1_000_000n,
      },
    ];
    for (const send of sends) {
      const before = sendWorld.snapshot();
      let pending: { id: string; risk?: unknown; checks?: unknown } | undefined;
      // oxlint-disable-next-line no-await-in-loop -- sends run one at a time
      await withRetry(async () => {
        pending = (await sendWorld.engine.requests.prepare({
          method: "send",
          account: send.account as never,
          network: send.network,
          to: send.to,
          amount: send.amount,
          fee: "normal",
        } as never)) as never;
      }, `${send.name} prepare`);
      if (pending === undefined) {
        throw new Error(`${send.name}: prepare never succeeded`);
      }
      // oxlint-disable-next-line no-await-in-loop -- sends run one at a time
      const tx = await sendWorld.engine.requests.approve(
        pending.id,
        "send",
        approval(pending as never, VERIFY),
      );
      expect(tx.hash).toBeDefined();
      const snap = sendWorld.snapshot();
      rows.push({ name: send.name, ...diffReadings(snap, before) });
    }
    expect(sendWorld.stub.unstubbed).toStrictEqual([]);

    process.off("unhandledRejection", onRejection);
    expect(
      strayRejections.filter((r) => r.startsWith("FATAL")),
      `non-retriable background rejections: ${strayRejections.join(" | ")}`,
    ).toStrictEqual([]);
    if (strayRejections.length > 0) {
      console.log(`stray retriable rejections: ${strayRejections.length}`);
    }

    const md = table(rows);
    const json = toJson(rows);
    if (REPORT !== undefined) {
      writeFileSync(`${REPORT}.md`, `${md}\n`);
      writeFileSync(`${REPORT}.json`, `${json}\n`);
    }
    console.log(md);
    expect(rows.length).toBeGreaterThan(0);
  }, 3_600_000);
});
