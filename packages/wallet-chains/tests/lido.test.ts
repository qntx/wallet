import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/decode.ts";
import { LIDO_QUEUE, LIDO_STETH } from "../src/evm/lido.ts";
import type { EvmTransaction } from "../src/index.ts";

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/evm-lido.json"), "utf8"),
) as {
  lido: Array<{
    name: string;
    network: string;
    signer: string;
    tx: EvmTransaction;
    expected: {
      summary: string;
      verifiability: string;
      outflows: unknown[];
      staking: unknown[];
    };
  }>;
};

const OTHER = "0x1111111111111111111111111111111111111111";

const txReq = (tx: EvmTransaction, network: string) => ({
  kind: "evm.transaction" as const,
  network,
  account: { kind: "hd" as const, walletId: "w", groupIndex: 0, template: "evm" },
  tx,
});

describe("lido decode", () => {
  it.each(vectors.lido.map((v) => [v.name, v] as const))(
    "mainnet %s decodes to the expected intent",
    (_name, v) => {
      const intent = decodeEvm(txReq(v.tx, v.network), v.signer);
      expect(intent.summary).toBe(v.expected.summary);
      expect(intent.verifiability).toBe(v.expected.verifiability);
      expect(intent.outflows).toStrictEqual(v.expected.outflows);
      expect(intent.staking).toStrictEqual(v.expected.staking);
    },
  );

  const submit = vectors.lido[0]!.tx;

  it("a zero-value submit is not a stake", () => {
    const intent = decodeEvm(txReq({ ...submit, value: "0x0" }, "eip155:1"), OTHER);
    expect(intent.summary).not.toBe("stake");
    expect(intent.staking).toBeUndefined();
  });

  it("a padded non-canonical submit is opaque", () => {
    const intent = decodeEvm(txReq({ ...submit, data: `${submit.data}00` }, "eip155:1"), OTHER);
    expect(intent.verifiability).toBe("opaque");
    expect(intent.staking).toBeUndefined();
  });

  it("the same call on another chain is not a stake", () => {
    const intent = decodeEvm(txReq({ ...submit, chainId: 10 }, "eip155:10"), OTHER);
    expect(intent.summary).not.toBe("stake");
    expect(intent.staking).toBeUndefined();
  });

  it("claimWithdrawalsTo and unknown queue calls stay opaque", () => {
    /* claimWithdrawalsTo 0xB9B793C7 — same arg layout, a different (unrecognised) selector. */
    const claim = vectors.lido.find((v) => v.name === "claim")!.tx;
    const intent = decodeEvm(
      txReq({ ...claim, data: `0xb9b793c7${claim.data.slice(10)}` }, "eip155:1"),
      OTHER,
    );
    expect(intent.verifiability).toBe("opaque");
    expect(intent.staking).toBeUndefined();
  });

  it("an approve to the queue decodes as approve, not stake", () => {
    const tx: EvmTransaction = {
      type: "eip1559",
      chainId: 1,
      to: LIDO_STETH,
      value: "0x0",
      nonce: 0,
      gas: "0x0",
      data: `0x095ea7b3${LIDO_QUEUE.slice(2).padStart(64, "0")}${"f".padStart(64, "0")}` as `0x${string}`,
      accessList: [],
      maxFeePerGas: "0x0",
      maxPriorityFeePerGas: "0x0",
    };
    const intent = decodeEvm(txReq(tx, "eip155:1"), OTHER);
    expect(intent.summary).toBe("approve");
    expect(intent.staking).toBeUndefined();
  });
});
