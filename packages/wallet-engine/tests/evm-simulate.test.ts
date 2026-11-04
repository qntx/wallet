import type { PublicClient } from "viem";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const simulateCalls = vi.fn();
vi.mock("viem/actions", () => ({ simulateCalls }));

const { EvmChainAdapter } = await import("../src/chains/evm.ts");
const { SIMULATION_TIMEOUT_MS } = await import("../src/requests/simulation.ts");

const FROM = `0x${"11".repeat(20)}`;
const TO = `0x${"22".repeat(20)}`;
const CALL = { to: TO, value: 5n, data: "0x" };
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const OTHER = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const client = {} as PublicClient;
const noTimer = (): (() => void) => () => undefined;

const diff = (address: string, value: bigint, token: object = {}) => ({
  token: { address, ...token },
  value: { pre: 0n, post: value, diff: value },
});

beforeEach(() => {
  simulateCalls.mockReset();
});

describe("EvmChainAdapter.simulate", () => {
  it("maps the native marker, skips zero diffs and reads the built-in token table", async () => {
    simulateCalls.mockResolvedValue({
      results: [{ status: "success" }],
      assetChanges: [
        diff(NATIVE, -5n),
        diff(USDC, -7n, { symbol: "FAKE", decimals: 18 }),
        diff(OTHER, 0n),
      ],
    });
    const outcome = await new EvmChainAdapter().simulate(client, 1, FROM, CALL, noTimer);
    expect(outcome).toStrictEqual({
      status: "success",
      changes: [
        { asset: "native", amount: "-5", verified: true },
        { asset: USDC, amount: "-7", decimals: 6, symbol: "USDC", verified: true },
      ],
    });
    expect(simulateCalls).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ account: FROM, traceAssetChanges: true }),
    );
  });

  it("keeps a contract-reported token but marks it unverified", async () => {
    simulateCalls.mockResolvedValue({
      results: [{ status: "success" }],
      assetChanges: [
        diff(OTHER, 3n, { symbol: "DAI", decimals: 18 }),
        diff(USDC.toLowerCase(), 1n),
      ],
    });
    const outcome = await new EvmChainAdapter().simulate(client, 56, FROM, CALL, noTimer);
    expect(outcome).toStrictEqual({
      status: "success",
      changes: [
        { asset: OTHER, amount: "3", decimals: 18, symbol: "DAI", verified: false },
        { asset: USDC, amount: "1", verified: false },
      ],
    });
  });

  it("reports a failed call as reverted", async () => {
    simulateCalls.mockResolvedValue({
      results: [{ status: "failure", error: new Error("execution reverted") }],
      assetChanges: [],
    });
    await expect(
      new EvmChainAdapter().simulate(client, 1, FROM, CALL, noTimer),
    ).resolves.toStrictEqual({ status: "reverted", error: "execution reverted" });
  });

  it("reports a thrown error as unavailable", async () => {
    simulateCalls.mockRejectedValue(new Error("method not found"));
    await expect(
      new EvmChainAdapter().simulate(client, 1, FROM, CALL, noTimer),
    ).resolves.toStrictEqual({ status: "unavailable", error: "method not found" });
  });

  it("reports a malformed call as unavailable without calling the node", async () => {
    const outcome = await new EvmChainAdapter().simulate(
      client,
      1,
      FROM,
      { ...CALL, data: "0xzz" },
      noTimer,
    );
    expect(outcome.status).toBe("unavailable");
    expect(simulateCalls).not.toHaveBeenCalled();
  });

  it("gives up after the injected 10 s timer", async () => {
    simulateCalls.mockReturnValue(new Promise(() => undefined));
    const fire: { run: () => unknown } = { run: () => undefined };
    const pending = new EvmChainAdapter().simulate(client, 1, FROM, CALL, (ms, fn) => {
      expect(ms).toBe(SIMULATION_TIMEOUT_MS);
      fire.run = fn;
      return () => undefined;
    });
    fire.run();
    await expect(pending).resolves.toStrictEqual({ status: "unavailable", error: "timeout" });
  });

  it("cancels the timer when the node answers", async () => {
    simulateCalls.mockResolvedValue({ results: [{ status: "success" }], assetChanges: [] });
    const cancelled = vi.fn();
    await new EvmChainAdapter().simulate(client, 1, FROM, CALL, () => cancelled);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
