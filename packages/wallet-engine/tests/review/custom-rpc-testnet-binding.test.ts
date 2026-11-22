// oxlint-disable vitest/no-conditional-in-test -- mocked fetches are inherently conditional
// A custom RPC endpoint on a testnet is trusted outright: `independent()` answers `not-needed`
// the moment any custom endpoint exists, so the pre-signing chain-binding cross-check that a
// gateway-first network gets is skipped — one user-pasted URL is both the read and its proof.

import { describe, expect, it } from "vite-plus/test";

import { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import type { EngineStore } from "../../src/store/port.ts";
import { idleNetworkDeps } from "../send-helpers.ts";

const GATEWAY = "https://gateway.test";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const NILE = "tron:3448148188";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const NILE_GENESIS = "0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc";
const SOL_CUSTOM = "https://sol-custom.example";
const TRON_CUSTOM = "https://tron-custom.example";

const logger = { warn: () => undefined };
const openStore = async (): Promise<EngineStore> => Promise.resolve(createMemoryEngineStore());

/** The gateway's served list names both testnets; the host configures no endpoint for either. */
const servedFetch: typeof globalThis.fetch = async (input) => {
  await Promise.resolve();
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === `${GATEWAY}/v1/networks`) {
    return Response.json({ networks: [DEVNET, NILE] });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const rig = async (fetch: typeof globalThis.fetch): Promise<NetworkController> => {
  const networks = new NetworkController({
    ...idleNetworkDeps,
    fetch,
    rpc: {},
    openStore,
    logger,
    gateway: {
      url: GATEWAY,
      clientIds: { evm: "e", solana: "s", bitcoin: "b", tron: "t", service: "svc" },
    },
  });
  await networks.init();
  return networks;
};

describe("custom rpc testnet binding", () => {
  it("a gateway-only testnet needs a host cross-check; one custom endpoint replaces it", async () => {
    const probeCalls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      await Promise.resolve();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const base = url.endsWith("/") ? url.slice(0, -1) : url;
      if (base === SOL_CUSTOM) {
        const body = JSON.parse(String(init?.body)) as { id: number; method: string };
        probeCalls.push(`solana:${body.method}`);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: DEVNET_GENESIS });
      }
      if (base === `${TRON_CUSTOM}/wallet/getblockbynum`) {
        probeCalls.push("tron:getblockbynum");
        return Response.json({ blockID: NILE_GENESIS });
      }
      return servedFetch(input, init);
    };
    const networks = await rig(fetch);
    expect(networks.info(DEVNET).testnet).toBe(true);
    expect(networks.info(NILE).testnet).toBe(true);
    /* Gateway-first with no host endpoint: a cross-check is required and cannot run. */
    expect(networks.independentSolanaRpc(DEVNET).kind).toBe("unavailable");
    expect(networks.independentTronApi(NILE).kind).toBe("unavailable");
    /* The add-time probe only checks the endpoint's own claimed chain id — then the endpoint is
       trusted for every later read, including the binding proofs themselves. */
    await networks.addRpc(DEVNET, SOL_CUSTOM);
    await networks.addRpc(NILE, TRON_CUSTOM);
    expect(probeCalls).toStrictEqual(["solana:getGenesisHash", "tron:getblockbynum"]);
    expect(networks.independentSolanaRpc(DEVNET).kind).toBe("not-needed");
    expect(networks.independentTronApi(NILE).kind).toBe("not-needed");
    /* …and the gateway drops out of the read path entirely: the custom URL is the whole list. */
    expect(networks.endpoints(DEVNET)).toStrictEqual([SOL_CUSTOM]);
    expect(networks.endpoints(NILE)).toStrictEqual([TRON_CUSTOM]);
  });
});
