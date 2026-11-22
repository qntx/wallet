/**
 * A host configured with only the gateway (no `EngineOptions.rpc` entries) can prepare and send
 * TRON and Solana on a mainnet — the prepare is flagged `reads-unverified` and sign + submit
 * reaches the broadcast upstream — while a testnet send whose chain data comes from the mainnet is
 * refused before anything is signed or broadcast: the signature over a mainnet binding would be
 * valid on the mainnet, so the gateway's word alone is not enough there.
 *
 * The second world makes the gateway answer the testnet network's routes with the mainnet upstream
 * stub (production serves no testnets): `tron:3448148188` and
 * `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` point at the mainnet provider rows, so every read the
 * gateway proxies returns mainnet data. `chains(...).sign` is counted through a module mock: a
 * refusal that still reached the kernel would show up there.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import type { chains } from "@qntx/wallet/chains";

import { PRODUCTION_NETWORKS } from "../../../apps/gateway/src/config/networks.ts";
import { approval } from "./approval.ts";
import {
  createHarnessWallet,
  createWorld,
  TRC20,
  VERIFY,
  walletAddresses,
} from "./gateway-capacity/harness.ts";
import { usedModel } from "./gateway-capacity/upstream.ts";

const signCalls: string[] = [];
vi.mock("@qntx/wallet/chains", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const real = original["chains"] as typeof chains;
  return {
    ...original,
    chains: (wallet: Parameters<typeof chains>[0]) => {
      const api = real(wallet);
      return {
        ...api,
        sign: async (params: Parameters<typeof api.sign>[0]) => {
          signCalls.push(params.request.kind);
          return api.sign(params);
        },
      };
    },
  };
});

const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const TRON = "tron:728126428";
const TRON_NILE = "tron:3448148188";

const byId = (id: string) => PRODUCTION_NETWORKS.filter((n) => n.id === id);
const providersOf = (id: string) => {
  const network = PRODUCTION_NETWORKS.find((n) => n.id === id);
  if (network === undefined) {
    throw new Error(`no production network ${id}`);
  }
  return network.providers;
};

/** The testnet ids served by the mainnet upstreams — the gateway answering for the wrong chain. */
const TESTNET_AS_MAINNET = [
  { id: TRON_NILE, providers: providersOf(TRON) },
  { id: SOLANA_DEVNET, providers: providersOf(SOLANA) },
];

const isBroadcast = (method: string): boolean =>
  method === "tron:/wallet/broadcasthex" || method === "rpc:sendTransaction";

describe("gateway-only host sends", () => {
  it("prepares and sends TRON and Solana on mainnet with reads-unverified", async () => {
    signCalls.length = 0;
    const { wallet, walletId } = await createHarnessWallet();
    const addresses = await walletAddresses(wallet, walletId, PRODUCTION_NETWORKS);
    const world = await createWorld({
      wallet,
      model: usedModel({ evmAddress: addresses.evm, bitcoin: new Map(), trc20Contract: TRC20 }),
      networks: [...byId(TRON), ...byId(SOLANA)],
      tronAddress: addresses.tron,
      rpc: {},
    });
    const group = { kind: "hd" as const, walletId, groupIndex: 0 };

    const tronPending = (await world.engine.requests.prepare({
      method: "send",
      account: { ...group, template: "tron.bip44" as const },
      network: TRON,
      to: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
      amount: 1_000_000n,
      fee: "normal",
    } as never)) as never as { id: string; checks: string[] };
    expect(tronPending.checks).toContain("reads-unverified");
    const tronTx = await world.engine.requests.approve(
      tronPending.id,
      "send",
      approval(tronPending as never, VERIFY),
    );
    expect(tronTx.hash).toBeDefined();

    const solPending = (await world.engine.requests.prepare({
      method: "send",
      account: { ...group, template: "solana.bip44-change" as const },
      network: SOLANA,
      to: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM",
      amount: 1000n,
      fee: "normal",
    } as never)) as never as { id: string; checks: string[] };
    expect(solPending.checks).toContain("reads-unverified");
    const solTx = await world.engine.requests.approve(
      solPending.id,
      "send",
      approval(solPending as never, VERIFY),
    );
    expect(solTx.hash).toBeDefined();

    expect(
      world.stub.calls.filter((c) => c.method === "tron:/wallet/broadcasthex"),
    ).not.toStrictEqual([]);
    expect(world.stub.calls.filter((c) => c.method === "rpc:sendTransaction")).not.toStrictEqual(
      [],
    );
    expect(signCalls).toStrictEqual(["tron.transaction", "solana.transaction"]);
    expect(
      world.stub.unstubbed,
      `unstubbed upstreams ${world.stub.unstubbed.join(", ")}`,
    ).toStrictEqual([]);
  }, 600_000);

  it("refuses a testnet send answered with mainnet chain data before signing or broadcast", async () => {
    signCalls.length = 0;
    const { wallet, walletId } = await createHarnessWallet();
    const addresses = await walletAddresses(wallet, walletId, PRODUCTION_NETWORKS);
    const world = await createWorld({
      wallet,
      model: usedModel({ evmAddress: addresses.evm, bitcoin: new Map(), trc20Contract: TRC20 }),
      networks: TESTNET_AS_MAINNET,
      tronAddress: addresses.tron,
      rpc: {},
    });
    const group = { kind: "hd" as const, walletId, groupIndex: 0 };

    /* TRON Nile: the pinned upstream's block 0 is the mainnet genesis, so the chain-binding pin
       in anchoredSolidHead fires before the shared gateway-only rule is even reached. */
    await expect(
      world.engine.requests.prepare({
        method: "send",
        account: { ...group, template: "tron.bip44" as const },
        network: TRON_NILE,
        to: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
        amount: 1_000_000n,
        fee: "normal",
      } as never),
    ).rejects.toThrow("the endpoint serves another chain than tron:3448148188");

    /* Solana devnet: the shared rule runs first and names the missing host endpoint — the
       genesis pin behind it never runs. */
    await expect(
      world.engine.requests.prepare({
        method: "send",
        account: { ...group, template: "solana.bip44-change" as const },
        network: SOLANA_DEVNET,
        to: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM",
        amount: 1000n,
        fee: "normal",
      } as never),
    ).rejects.toThrow(
      'only the gateway vouches for the recent blockhash on solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1; on a testnet a signature over another network\'s recent blockhash could be valid there — configure a host endpoint in EngineOptions.rpc["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]',
    );

    expect(signCalls).toStrictEqual([]);
    expect(world.stub.calls.filter((c) => isBroadcast(c.method))).toStrictEqual([]);
    expect(
      world.stub.unstubbed,
      `unstubbed upstreams ${world.stub.unstubbed.join(", ")}`,
    ).toStrictEqual([]);
  }, 600_000);
});
