/**
 * PoC for r3-review: history/evm.ts `verifyEntry` checks that every transfer the gateway CLAIMS
 * matches the chain receipt — it never checks that the claims are COMPLETE. A malicious or buggy
 * gateway that omits the user's outflow yields a `verified: true` incoming-only entry; and a
 * native value leg is not even looked up (`eth_getTransactionByHash` is only fetched when a
 * "native" transfer is claimed).
 * Correct behaviour: compare the full receipt (and transaction, when the tx touched the user)
 * against the claims, and flag/leave-unverified any on-chain transfer the gateway did not list.
 * This test ASSERTS THE CURRENT (BUGGY) BEHAVIOUR.
 */
import { describe, expect, it } from "vite-plus/test";

import type { HistoryItem } from "../../src/gateway/contract/index.ts";
import { evmHistoryStream } from "../../src/history/evm.ts";
import type { HistoryEntry } from "../../src/history/types.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ATTACKER = "0x3333333333333333333333333333333333333333";
const X = "0x4444444444444444444444444444444444444444";
const TOKEN_A = "0x1111111111111111111111111111111111111111";
const TOKEN_B = "0x2222222222222222222222222222222222222222";
const H1 = `0x${"ab".repeat(32)}`;
const H2 = `0x${"cd".repeat(32)}`;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const addrTopic = (addr: string): string => `0x${"0".repeat(24)}${addr.slice(2)}`;
const word = (v: bigint): string => `0x${v.toString(16).padStart(64, "0")}`;

const erc20Log = (
  contract: string,
  from: string,
  to: string,
  amount: bigint,
  logIndex: number,
): Record<string, unknown> => ({
  address: contract,
  topics: [TRANSFER_TOPIC, addrTopic(from), addrTopic(to)],
  data: word(amount),
  logIndex: `0x${logIndex.toString(16)}`,
});

type RpcCall = { readonly method: string; readonly params: unknown[] };

/** A `PublicClient`-shaped transport answering from `handlers`, recording every call. */
const clientFor = (
  handlers: Record<string, (params: unknown[]) => unknown>,
  calls: RpcCall[],
): unknown =>
  ({
    transport: {
      request: async ({ method, params }: { method: string; params: unknown[] }) => {
        calls.push({ method, params });
        const handler = handlers[method];
        return handler === undefined
          ? Promise.reject(new Error(`unmocked ${method}`))
          : Promise.resolve(handler(params));
      },
    },
  }) as never;

const stream = (options: { network: string; page: unknown; client: unknown }) => {
  const fetch = (async () => Promise.resolve(Response.json(options.page))) as typeof globalThis.fetch;
  return evmHistoryStream(
    {
      gateway: { url: "https://gateway.test", fetch },
      networks: {
        client: () => options.client,
        independentClient: () => ({ kind: "unavailable" }),
      },
      setTimer: () => () => {},
    } as never,
    options.network,
    OWNER,
    new Map(),
  );
};

const item = (hash: string, block: number, transfers: HistoryItem["transfers"]): HistoryItem => ({
  hash,
  block: String(block),
  timestamp: 1700000000000,
  transfers,
});

const page = (items: HistoryItem[], cursor: string | null = null) => ({ items, cursor });

const entryOf = (items: ReadonlyArray<HistoryEntry>, hash: string) =>
  items.find((e) => e.hash === hash);

const erc20Transfer = (options: {
  from: string;
  to: string;
  contract: string;
  amount: string;
  logIndex: number;
  symbol?: string;
}): HistoryItem["transfers"][number] => ({
  kind: "erc20",
  from: options.from,
  to: options.to,
  contract: options.contract,
  amount: options.amount,
  logIndex: options.logIndex,
  decimals: 6,
  symbol: options.symbol ?? "TKX",
  tokenId: null,
});

describe("PoC: EVM history verification never checks claim completeness", () => {
  it("PoC: a gateway that omits the user's token outflow yields a verified incoming-only entry", async () => {
    const receipt = {
      blockNumber: "0x64",
      status: "0x1",
      from: OWNER,
      to: TOKEN_A,
      gasUsed: "0x5208",
      effectiveGasPrice: "0x1",
      logs: [
        // On-chain truth: the user sent 1_000_000 TOKEN_A out AND received 1 TOKEN_B.
        erc20Log(TOKEN_A, OWNER, ATTACKER, 1_000_000n, 0),
        erc20Log(TOKEN_B, ATTACKER, OWNER, 1n, 1),
      ],
    };
    const calls: RpcCall[] = [];
    const s = stream({
      network: "eip155:1",
      // …but the gateway claims only the incoming leg.
      page: page([
        item(H1, 100, [
          erc20Transfer({
            from: ATTACKER,
            to: OWNER,
            contract: TOKEN_B,
            amount: "1",
            logIndex: 1,
            symbol: "TKB",
          }),
        ]),
      ]),
      client: clientFor({ eth_getTransactionReceipt: () => receipt }, calls),
    });
    const { items } = await s.next();
    const e = entryOf(items, H1);
    expect(e?.verified).toBe(true);
    expect(e?.direction).toBe("in");
    expect(e?.changes).toHaveLength(1);
    expect(e?.changes.some((c) => c.direction === "out")).toBe(false);
    expect(e?.flags).not.toContain("chain-mismatch");
    console.log("entry:", JSON.stringify(e, null, 2));
  });

  it("PoC: an unclaimed native outflow is never even fetched — still verified, incoming-only", async () => {
    const receipt = {
      blockNumber: "0x64",
      status: "0x1",
      from: OWNER,
      to: ATTACKER,
      gasUsed: "0x5208",
      effectiveGasPrice: "0x1",
      logs: [erc20Log(TOKEN_A, X, OWNER, 7n, 0)],
    };
    // The transaction moved 1 ETH of native value OUT of the user's account.
    const tx = { from: OWNER, to: ATTACKER, value: "0xde0b6b3a7640000" };
    const calls: RpcCall[] = [];
    const s = stream({
      network: "eip155:1",
      // The gateway claims only the ERC-20 incoming transfer — no native leg at all.
      page: page([
        item(H2, 100, [
          erc20Transfer({ from: X, to: OWNER, contract: TOKEN_A, amount: "7", logIndex: 0 }),
        ]),
      ]),
      client: clientFor(
        {
          eth_getTransactionReceipt: () => receipt,
          eth_getTransactionByHash: () => tx,
        },
        calls,
      ),
    });
    const { items } = await s.next();
    const e = entryOf(items, H2);
    expect(e?.verified).toBe(true);
    expect(e?.changes.some((c) => c.direction === "out")).toBe(false);
    // eth_getTransactionByHash is only read when a "native" transfer is claimed, so the
    // native outflow is never checked at all.
    expect(calls.some((c) => c.method === "eth_getTransactionByHash")).toBe(false);
    console.log("rpc methods called:", calls.map((c) => c.method));
    console.log("entry:", JSON.stringify(e, null, 2));
  });
});
