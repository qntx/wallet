/**
 * Construction-time policy: a provider without a metered account, or one whose account's cost model
 * cannot price the route it serves, fails the build instead of running unmetered.
 */
import { describe, expect, it } from "vite-plus/test";

import { ALCHEMY_COSTS } from "../src/budget/costs.ts";
import type { Account } from "../src/config/accounts.ts";
import { indexNetworks } from "../src/middleware/network.ts";
import type { GatewayNetwork } from "../src/types.ts";
import { DEVNET, SIGNET, TEST_ACCOUNTS, fakeFetch, gateway } from "./helpers.ts";

const requestPriced = (): Account => ({
  costs: { kind: "request", request: { units: 1, source: "https://test.invalid" } },
  rate: [{ units: 1_000_000, seconds: 60 }],
  clientShare: 0.05,
  source: "https://test.invalid",
});

const rpcPriced = (): Account => ({ ...requestPriced(), costs: ALCHEMY_COSTS });

describe("indexNetworks", () => {
  it.each([SIGNET, "tron:3448148188"])(
    "rejects an RPC-priced account on the request-priced network %s",
    (id) => {
      const networks: ReadonlyArray<GatewayNetwork> = [
        { id, providers: [{ id: "a", url: "https://a.test/x" }] },
      ];
      expect(() => indexNetworks(networks, {}, { ...TEST_ACCOUNTS, a: rpcPriced() })).toThrow(
        `provider a on ${id} has a rpc cost model`,
      );
    },
  );

  it("admits request-priced accounts on request-priced families", () => {
    const networks: ReadonlyArray<GatewayNetwork> = [
      { id: SIGNET, providers: [{ id: "a", url: "https://a.test/btc" }] },
      { id: DEVNET, providers: [{ id: "a", url: "https://a.test/sol" }] },
    ];
    const served = indexNetworks(networks, {}, TEST_ACCOUNTS);
    expect(served.size).toBe(2);
  });

  it("rejects a provider whose account is absent", () => {
    const networks: ReadonlyArray<GatewayNetwork> = [
      { id: DEVNET, providers: [{ id: "ghost", url: "https://ghost.test" }] },
    ];
    expect(() => indexNetworks(networks, {}, TEST_ACCOUNTS)).toThrow(
      `provider ghost on ${DEVNET} has no account "ghost"`,
    );
  });
});

describe("code-built providers", () => {
  it("rejects an RPC-priced account for a code-built provider", () => {
    expect(() =>
      gateway({
        fetch: fakeFetch({}).fetch,
        accounts: { ...TEST_ACCOUNTS, "0x": rpcPriced() },
      }),
    ).toThrow("provider 0x has a rpc cost model");
  });

  it("rejects a missing account for a code-built provider", () => {
    const { jupiter: _removed, ...accounts } = TEST_ACCOUNTS;
    expect(() => gateway({ fetch: fakeFetch({}).fetch, accounts })).toThrow(
      "provider jupiter has no account",
    );
  });
});
