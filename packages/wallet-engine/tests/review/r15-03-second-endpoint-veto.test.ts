/**
 * Review PoC R15-03: the far-coin cross-check makes the _second_ endpoint the arbiter of a coin the
 * primary reported and the wallet can verify is real — and teaches it the coin's txid in the
 * process. An honest restored wallet, whose change chain really does reach past the scan reach,
 * cannot send at all while the second endpoint answers 4xx or simply does not know the funding
 * transaction yet: a single corroborating read vetoes a spend the primary and the signed bytes both
 * support. And the corroborator a custom-endpoint configuration falls back to is the gateway —
 * `independentEsplora` answers `{ kind: "available", source: "gateway" }`, which
 * `independentTrusted` does not treat as trusted configuration, yet it still learns every far
 * coin's txid the wallet considers spending.
 *
 * Each test asserts today's behaviour — it passes now and fails once a definite "unknown" from the
 * second endpoint no longer vetoes (or once the txid stop leaking to it).
 */
/* oxlint-disable vitest/no-conditional-in-test -- the fake fetch branches on the request url per scripted case */
import { NETWORK } from "@scure/btc-signer";
import { describe, expect, it } from "vite-plus/test";

import { bitcoinAddressFromXpub } from "@qntx/wallet-chains/bitcoin";

import { scripthash } from "../../src/chains/bitcoin-scan.ts";
import { EsploraError } from "../../src/chains/bitcoin.ts";
import { NetworkController } from "../../src/networks/controller.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";
import { ACCOUNT, HD, NET, RECIP, world } from "../support/btc-world.ts";

const FAR = 150;

/** Every change address before `end` reports used — an honest restored wallet's real history. */
const usedUpTo = (w: ReturnType<typeof world>, end: number): void => {
  for (let i = 0; i < end; i += 1) {
    const addr = bitcoinAddressFromXpub(HD.publicExtendedKey, "btc.bip84", NET, 1, i);
    w.markUsed(scripthash(addr, NETWORK), "ab".repeat(32));
  }
};

const worldWithRealCoin = () => {
  const w = world({ independent: true });
  usedUpTo(w, FAR);
  // A REAL coin the world holds raw bytes for — the primary is honest, the history is the
  // wallet's own.
  const coin = w.fundChange(FAR, 9, 200_000);
  return { w, coin };
};

const prepareFarSend = async (w: ReturnType<typeof world>) =>
  w
    .boot()
    .then(async (booted) =>
      booted.ctl.prepareSend(
        { account: { ...ACCOUNT }, network: NET, to: RECIP, amount: 10_000n, fee: "slow" },
        "req-honest",
      ),
    );

describe("R15-03: the second endpoint's word vetoes a real coin", () => {
  it("a definite 4xx refuses the spend and nothing is signed", async () => {
    const { w, coin } = worldWithRealCoin();
    w.setIndependentHex(
      coin.txid,
      new EsploraError(`esplora https://x/tx/${coin.txid}/hex: 403`, false),
    );
    await expect(prepareFarSend(w)).rejects.toMatchObject({
      code: "invalid-request",
      message: expect.stringContaining("the endpoints disagree on a far change coin"),
    });
    expect(w.signedCalls).toStrictEqual([]);
  }, 120_000);

  it("a bare 404 — the endpoint simply does not know the coin — refuses the same way", async () => {
    const { w } = worldWithRealCoin();
    // No scripted answer: the independent stub 404s an unknown txid like a real Esplora.
    await expect(prepareFarSend(w)).rejects.toMatchObject({
      code: "invalid-request",
      message: expect.stringContaining("the endpoints disagree on a far change coin"),
    });
    expect(w.signedCalls).toStrictEqual([]);
  }, 120_000);

  it("the honest-answer case still hands the second endpoint the coin's txid", async () => {
    const { w, coin } = worldWithRealCoin();
    const hex = w.rawHexOf(coin.txid);
    if (hex === undefined) {
      throw new Error("world has no raw bytes for the coin");
    }
    w.setIndependentHex(coin.txid, hex);
    const booted = await w.boot();
    const tx = await w.send(booted, 10_000n, "req-honest");
    expect(tx.state).not.toBe("failed");
    // The corroborating read names the txid: whatever upstream answers it — host or gateway —
    // learns exactly which outpoint this wallet weighed spending.
    expect(w.independentRequests).toContain(`/tx/${coin.txid}/hex`);
  }, 120_000);

  it("the corroborator a custom-endpoint wallet falls back to is the gateway", async () => {
    // A network with a custom endpoint, no host endpoints and a gateway that serves it: the
    // "independent" esplora the far-coin check reads is the gateway itself.
    const seen: string[] = [];
    const fetch = (async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push(url);
      if (url === "https://gateway.test/v1/networks") {
        return Promise.resolve(Response.json({ networks: [NET] }));
      }
      if (url === "https://custom.example/block-height/0") {
        return Promise.resolve(
          new Response("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as typeof globalThis.fetch;
    const networks = new NetworkController({
      fetch,
      rpc: {},
      openStore: async () => Promise.resolve(createMemoryEngineStore()),
      logger: { warn: () => undefined },
      gateway: {
        url: "https://gateway.test",
        clientIds: { evm: "e", solana: "s", bitcoin: "b", tron: "t", service: "x" },
      },
      setTimer: (ms, fn) => {
        const t = setTimeout(fn, ms);
        return () => {
          clearTimeout(t);
        };
      },
      random: (n) => new Uint8Array(n),
      now: () => 1_700_000_000_000,
    });
    await networks.init();
    await networks.addRpc(NET, "https://custom.example");

    const independent = networks.independentEsplora(NET);
    expect(independent.kind).toBe("available");
    if (independent.kind !== "available") {
      throw new Error("expected an available independent");
    }
    expect(independent.source).toBe("gateway");
    networks.lock();
  });
});
