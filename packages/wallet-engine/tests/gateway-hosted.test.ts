/**
 * Hosted gateway read test — opt-in (WALLET_E2E_GATEWAY=1). Points a NetworkController with no host
 * endpoints at the staging gateway and reads Sepolia and Bitcoin signet through it with the real
 * fetch. WALLET_GATEWAY_URL overrides the default staging origin.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { PROVIDERS_HEADER, esploraBasePath, rpcPath } from "../src/gateway/contract/index.ts";
import { NetworkController } from "../src/networks/controller.ts";
import { networkById } from "../src/networks/registry.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";

const GATEWAY = process.env["WALLET_E2E_GATEWAY"] === "1";
const URL_BASE = process.env["WALLET_GATEWAY_URL"] ?? "https://wallet-gateway-staging.qntx.org";
const SEPOLIA = "eip155:11155111";
const SIGNET = "bip122:00000008819873e925422c1ff0f99f7c";

describe.skipIf(!GATEWAY)("hosted gateway e2e", () => {
  it("reads Sepolia and signet through the staging gateway", async () => {
    const providers: string[] = [];
    const recordingFetch: typeof globalThis.fetch = async (input, init) => {
      const res = await fetch(input, init);
      providers.push(`${String(input)} -> ${String(res.headers.get(PROVIDERS_HEADER))}`);
      return res;
    };
    const networks = new NetworkController({
      fetch: recordingFetch,
      rpc: {},
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      logger: { warn: (message) => console.log(`warn: ${message}`) },
      gateway: { url: URL_BASE, installId: bytesToHex(crypto.getRandomValues(new Uint8Array(16))) },
    });
    await networks.init();

    expect(networks.endpoints(SEPOLIA)).toStrictEqual([`${URL_BASE}${rpcPath(SEPOLIA)}`]);
    expect(networks.endpoints(SIGNET)).toStrictEqual([`${URL_BASE}${esploraBasePath(SIGNET)}`]);

    const block = await networks.client(SEPOLIA).getBlockNumber();
    expect(block).toBeGreaterThan(0n);

    const genesis = await networks.esplora(SIGNET).get("/block-height/0");
    expect(genesis).toBe(networkById(SIGNET)?.genesisHash);

    console.log(`sepolia blockNumber ${block}; signet genesis ${String(genesis)}`);
    console.log(providers.join("\n"));
  });
});
