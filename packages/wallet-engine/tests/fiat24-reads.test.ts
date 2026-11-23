/**
 * `createFiat24Account` over the recorded Arbitrum One answers: the live #469709 view, the closed
 * account the test mnemonic's first address owns, the no-account index-2 address, a hostile
 * independent (one altered read), a primary lying about a pinned deployment slot
 * (`contract-changed` is a state, not an error), a malformed word (`invalid-rpc-response`), and the
 * rule that an app error never carries the owner address in its message or serialization.
 */
import { readFileSync } from "node:fs";

import type { PublicClient } from "viem";
import { describe, expect, it } from "vite-plus/test";

import type { AccountView } from "@qntx/fiat24/flows";

import { createFiat24Account } from "../src/apps/fiat24/account.ts";
import type { Fiat24AccountState } from "../src/apps/fiat24/account.ts";
import { Fiat24AppError } from "../src/apps/fiat24/errors.ts";
import { createFiat24Client } from "../src/apps/fiat24/rpc.ts";
import type { AppGroup, AppNetworks } from "../src/apps/types.ts";
import type { Independent } from "../src/networks/controller.ts";

type RecordedCall = {
  method: string;
  params?: unknown;
  result: unknown;
};

type Fixture = {
  readonly source: string;
  readonly recordedAt: number;
  readonly calls: RecordedCall[];
};

const fixture = (name: string): Fixture =>
  JSON.parse(
    readFileSync(new URL(`fixtures/fiat24/rpc-${name}.json`, import.meta.url), "utf8"),
  ) as Fixture;

const LIVE_OWNER = "0x28db0495bc5cFb13573b2286E52e537a70FC71b2";
const CLOSED_OWNER = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const EMPTY_OWNER = "0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A";
const GROUP: AppGroup = { walletId: "w1", groupIndex: 0 };
/** The first EIP-1967 implementation slot in the recording — verifyDeployment's first read. */
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

type Endpoint = {
  readonly client: PublicClient;
  readonly calls: RecordedCall[];
};

type Alter = (call: RecordedCall, result: unknown) => unknown;

/** A transport replaying the recording: exact method+params match, each call consumed once. */
const replay = (calls: RecordedCall[], alter?: Alter): Endpoint => {
  const remaining = [...calls];
  const client = {
    transport: {
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        await Promise.resolve();
        const want = JSON.stringify(params ?? null);
        const index = remaining.findIndex(
          (call) => call.method === method && JSON.stringify(call.params ?? null) === want,
        );
        if (index === -1) {
          throw new Error(`unmatched rpc ${method} ${want}`);
        }
        const [call] = remaining.splice(index, 1);
        if (call === undefined) {
          throw new Error("unreachable: the index was just found");
        }
        return alter === undefined ? call.result : alter(call, call.result);
      },
    },
  };
  return { client: client as unknown as PublicClient, calls: remaining };
};

/** Answer `word` for every EIP-1967 implementation-slot read — every other answer verbatim. */
const alteredImpl =
  (word: string): Alter =>
  (call, result) =>
    call.method === "eth_getStorageAt" && Array.isArray(call.params) && call.params[1] === IMPL_SLOT
      ? word
      : result;

/** Answer `0x` for every storage read — not a 32-byte word. */
const malformedStorage: Alter = (call, result) =>
  call.method === "eth_getStorageAt" ? "0x" : result;

/** Narrow a read to its view — the caller asserted the status already. */
const viewOf = (state: Fiat24AccountState): Exclude<AccountView, { step: "no-account" }> => {
  if (state.status === "no-account" || state.status === "contract-changed") {
    throw new Error(`expected an account view, got ${state.status}`);
  }
  return state.view;
};

const rig = (
  name: string,
  independent?: Independent<PublicClient>,
  alter?: Alter,
): { networks: AppNetworks; remaining: RecordedCall[] } => {
  const primary = replay(fixture(name).calls, alter);
  return {
    networks: {
      client: () => primary.client,
      independentClient: () => independent ?? { kind: "not-needed" },
    },
    remaining: primary.calls,
  };
};

const read = (networks: AppNetworks, owner: `0x${string}`) =>
  createFiat24Account({
    // oxlint-disable-next-line typescript/require-await -- the seam's signature is a promise
    owner: async () => owner,
    client: createFiat24Client(networks),
  });

describe("fiat24 account reads", () => {
  it("replays the recorded live account #469709", async () => {
    const { networks, remaining } = rig("live");
    const state = await read(networks, LIVE_OWNER)(GROUP);
    expect(remaining).toHaveLength(0);
    expect(state.status).toBe("live");
    const view = viewOf(state);
    expect(state.owner).toBe(LIVE_OWNER);
    expect(view.account.tokenId).toBe(469709n);
    expect(view.iban).toBe("CH1983051000000469709");
    expect(Object.keys(view.balances).length).toBeGreaterThan(0);
    expect(view.account.blockNumber).toBeGreaterThan(0n);
  });

  it("replays the recorded closed account the group-0 address owns", async () => {
    const { networks } = rig("closed");
    const state = await read(networks, CLOSED_OWNER)(GROUP);
    expect(state.status).toBe("closed");
    const view = viewOf(state);
    expect(view.account.tokenId).toBe(72347n);
    expect(view.account.status).toBe("closed");
  });

  it("replays the recorded no-account owner", async () => {
    const { networks, remaining } = rig("no-account");
    const state = await read(networks, EMPTY_OWNER)(GROUP);
    expect(remaining).toHaveLength(0);
    expect(state).toStrictEqual({ status: "no-account", owner: EMPTY_OWNER });
  });

  it("a corroborated live read answers the same view through two endpoints", async () => {
    const primary = replay(fixture("live").calls);
    const second = replay(fixture("live").calls);
    const networks: AppNetworks = {
      client: () => primary.client,
      independentClient: () => ({
        kind: "available",
        source: "host",
        client: second.client,
      }),
    };
    const state = await read(networks, LIVE_OWNER)(GROUP);
    expect(state.status).toBe("live");
    expect(primary.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(0);
  });

  it("a hostile independent endpoint maps to protocol rpc-error", async () => {
    const primary = replay(fixture("live").calls);
    /* One altered read: the implementation slot of the first contract differs. */
    const second = replay(fixture("live").calls, alteredImpl(`0x${"0".repeat(63)}1`));
    const networks: AppNetworks = {
      client: () => primary.client,
      independentClient: () => ({
        kind: "available",
        source: "host",
        client: second.client,
      }),
    };
    const failure = await read(networks, LIVE_OWNER)(GROUP).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Fiat24AppError);
    expect((failure as Fiat24AppError).category).toBe("protocol");
    expect((failure as Fiat24AppError).code).toBe("rpc-error");
  });

  it("a primary lying about a pinned implementation slot answers contract-changed", async () => {
    const { networks } = rig(
      "live",
      undefined,
      alteredImpl(`0x${"0".repeat(24)}0000000000000000000000000000000000000def`),
    );
    const state = await read(networks, LIVE_OWNER)(GROUP);
    expect(state).toStrictEqual({ status: "contract-changed", owner: LIVE_OWNER });
  });

  it("a malformed storage word maps to protocol invalid-rpc-response", async () => {
    const { networks } = rig("live", undefined, malformedStorage);
    const failure = await read(networks, LIVE_OWNER)(GROUP).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Fiat24AppError);
    expect((failure as Fiat24AppError).category).toBe("protocol");
    expect((failure as Fiat24AppError).code).toBe("invalid-rpc-response");
  });

  it("a dead endpoint maps to protocol rpc-error", async () => {
    const networks: AppNetworks = {
      client: () => replay([]).client,
      independentClient: () => ({ kind: "not-needed" }),
    };
    const failure = await read(networks, LIVE_OWNER)(GROUP).catch((error: unknown) => error);
    expect((failure as Fiat24AppError).category).toBe("protocol");
    expect((failure as Fiat24AppError).code).toBe("rpc-error");
  });

  it("an owner-derivation failure maps to unavailable without the kernel message", async () => {
    const state = createFiat24Account({
      owner: async () => {
        await Promise.resolve();
        throw new Error(`kernel detail for ${LIVE_OWNER}`);
      },
      client: createFiat24Client(rig("live").networks),
    });
    const failure = await state(GROUP).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Fiat24AppError);
    expect((failure as Fiat24AppError).category).toBe("unavailable");
    expect((failure as Fiat24AppError).code).toBeUndefined();
    expect((failure as Fiat24AppError).message).not.toContain("kernel detail");
  });

  it("errors never carry the owner address in their message or serialization", async () => {
    const { networks } = rig("live", undefined, malformedStorage);
    const failure = await read(networks, LIVE_OWNER)(GROUP).catch((error: unknown) => error);
    expect((failure as Fiat24AppError).message).not.toContain(LIVE_OWNER);
    expect(JSON.stringify(failure)).not.toContain(LIVE_OWNER);
    expect(JSON.stringify(Object.getOwnPropertyNames(failure))).not.toContain("cause");
  });
});
