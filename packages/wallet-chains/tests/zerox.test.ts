import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { encodeBatchExecute } from "../src/evm/delegation.ts";
import { decodeEvm } from "../src/evm/index.ts";
import type { EvmTokenTable } from "../src/evm/tokens.ts";
import { ALLOWANCE_HOLDER, ZEROX_CHAINS, isZeroExSettler } from "../src/evm/zerox.ts";
import type { EvmTransaction } from "../src/index.ts";

const SIGNER = "0x1111111111111111111111111111111111111111";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const SETTLER = "0xaddC26a3854feaBFd20d6BF658254088D83a425A";

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/evm-zerox.json"), "utf8"),
) as {
  zerox: Array<{
    name: string;
    network: string;
    tx: EvmTransaction;
    expected: unknown;
  }>;
};

const table: EvmTokenTable = {
  "1": { [USDC]: { symbol: "USDC", decimals: 6 } },
};

const txReq = (tx: EvmTransaction, network: string) => ({
  kind: "evm.transaction" as const,
  network,
  account: { kind: "hd" as const, walletId: "w", groupIndex: 0, template: "evm" },
  tx,
});

describe("isZeroExSettler", () => {
  it.each([
    [1, "0x0cEf320d0c5793ade37964E2661a033771e53cd5"],
    [1, "0xaddC26a3854feaBFd20d6BF658254088D83a425A"],
    [8453, "0x103502909141F7025a94b7b99A276dCD128e21a8"],
    [999, "0xf58D4122251F2ACe689F257eAf2688883e30fC6e"],
    [43114, "0x584A4e93F11331D318165B04099e53708b1FA915"],
    [11155111, "0x99eE99e75Ee5a81dA98a28C361a2fed1fE6DE439"],
  ] as const)("chain %d recognises Settler %s", (chainId, address) => {
    expect(isZeroExSettler(chainId, address)).toBe(true);
  });

  it("a feature-5 bridge Settler and a random address are not taker Settlers", () => {
    expect(isZeroExSettler(1, "0x0038Dfb2BBC353DAa6AD22cB11eE1d78F41B59Cd")).toBe(false);
    expect(isZeroExSettler(1, "0x559B33F816fB4d6B24731d77eDb5c5b2f5f5B624")).toBe(false);
    expect(isZeroExSettler(1, SIGNER)).toBe(false);
  });

  it("never matches outside ZEROX_CHAINS", () => {
    expect(isZeroExSettler(5, SETTLER)).toBe(false);
    expect(isZeroExSettler(31337, SETTLER)).toBe(false);
    expect(ZEROX_CHAINS.has(5)).toBe(false);
  });
});

const vector = (index: number) => {
  const entry = vectors.zerox[index];
  if (entry === undefined) {
    throw new Error(`missing vector ${index}`);
  }
  return entry;
};

describe("0x AllowanceHolder decode", () => {
  it.each(vectors.zerox.map((v) => [v.name, v] as const))(
    "mainnet %s decodes to the expected intent",
    (_name, v) => {
      const intent = decodeEvm(txReq(v.tx, v.network), SIGNER, table);
      expect(intent.summary).toBe((v.expected as { summary: string }).summary);
      expect(intent.verifiability).toBe((v.expected as { verifiability: string }).verifiability);
      expect(intent.outflows).toStrictEqual((v.expected as { outflows: unknown[] }).outflows);
      expect(intent.approvals).toStrictEqual((v.expected as { approvals: unknown[] }).approvals);
      const expected = v.expected as { minimumReceived?: unknown };
      expect(intent.minimumReceived).toStrictEqual(expected.minimumReceived);
    },
  );

  const erc20 = vector(0);
  const mutate = (fn: (tx: EvmTransaction) => EvmTransaction): EvmTransaction => fn(erc20.tx);

  it("operator != target is not a swap", () => {
    /* The operator word is bytes 8..40 of the calldata (0x + 4-byte selector + 12-byte pad). */
    const data = `${erc20.tx.data.slice(0, 34)}${"0".repeat(24)}deadbeefdeadbeefdeadbeefdeadbeefdeadbeef${erc20.tx.data.slice(74)}`;
    const intent = decodeEvm(
      txReq(
        mutate((t) => ({ ...t, data })),
        erc20.network,
      ),
      SIGNER,
      table,
    );
    expect(intent.summary).not.toBe("swap");
  });

  it("an ERC-20 sell carrying value is not a swap", () => {
    const intent = decodeEvm(
      txReq(
        mutate((t) => ({ ...t, value: "0x1" })),
        erc20.network,
      ),
      SIGNER,
      table,
    );
    expect(intent.summary).not.toBe("swap");
  });

  it("a native sell whose amount differs from value is not a swap", () => {
    const native = vector(1);
    /* Corrupt the `amount` word (third head word, chars 138..202) so amount != value. */
    const data = `${native.tx.data.slice(0, 138)}${"0".repeat(63)}1${native.tx.data.slice(202)}`;
    const intent = decodeEvm(txReq({ ...native.tx, data }, native.network), SIGNER, table);
    expect(intent.summary).not.toBe("swap");
  });

  it("a non-canonical trailing byte on the exec or the inner execute is not a swap", () => {
    for (const data of [`${erc20.tx.data}ff`, erc20.tx.data.replace("1fff991f", "1fff991f00")]) {
      const intent = decodeEvm(
        txReq(
          mutate((t) => ({ ...t, data })),
          erc20.network,
        ),
        SIGNER,
        table,
      );
      expect(intent.summary).not.toBe("swap");
    }
  });

  it("the same exec on a chain outside ZEROX_CHAINS is not recognised", () => {
    const intent = decodeEvm(txReq({ ...erc20.tx, chainId: 5 }, "eip155:5"), SIGNER, table);
    expect(intent.summary).toBe("contract-call");
    expect(intent.approvals).toStrictEqual([]);
  });

  it("a batch's inner calls get the same AllowanceHolder recognition", () => {
    /* [approve(AllowanceHolder, x), exec(swap)] inside an ERC-7821 batch — each call decodes. */
    const approveData = `0x095ea7b3${ALLOWANCE_HOLDER.slice(2).toLowerCase().padStart(64, "0")}${"5".padStart(64, "0")}`;
    const batch = encodeBatchExecute([
      { to: ALLOWANCE_HOLDER, value: 0n, data: approveData },
      { to: ALLOWANCE_HOLDER, value: 0n, data: erc20.tx.data },
    ]);
    const tx = { ...erc20.tx, to: SIGNER, data: batch };
    const intent = decodeEvm(txReq(tx, erc20.network), SIGNER, table);
    expect(intent.calls).toHaveLength(2);
    const calls = intent.calls as ReadonlyArray<{ summary: string }>;
    expect(calls[0]?.summary).toBe("approve");
    expect(calls[1]?.summary).toBe("swap");
    /* The swap's minimum flattens to the top level like the outflows and approvals. */
    expect(intent.minimumReceived).toStrictEqual([
      {
        to: (vector(0).expected as { minimumReceived: Array<{ to: string }> }).minimumReceived[0]
          ?.to,
        amount: {
          asset: "0x19993B3Cf15c1055063468EB932F5e335A7526ea",
          amount: "751851842450135",
        },
      },
    ]);
  });
});
