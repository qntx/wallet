import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/decode.ts";
import type { EvmTransaction } from "../src/index.ts";

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/evm-across.json"), "utf8"),
) as {
  name: string;
  network: string;
  vectors: Array<{
    name: string;
    signer: string;
    tx: { to: string; value: string; data: string };
    expect: {
      summary: string;
      verifiability: string;
      outflows: unknown[];
      minimumReceived: unknown[];
      bridge: unknown;
    };
  }>;
};

const txReq = (tx: EvmTransaction, network: string) => ({
  kind: "evm.transaction" as const,
  network,
  account: { kind: "hd" as const, walletId: "w", groupIndex: 0, template: "evm" },
  tx,
});

const [dep, dv3] = vectors.vectors;

describe("across decode", () => {
  it.each(vectors.vectors.map((v) => [v.name, v] as const))(
    "%s decodes to the expected intent",
    (_name, v) => {
      const intent = decodeEvm(txReq(v.tx as unknown as EvmTransaction, vectors.network), v.signer);
      expect(intent.summary).toBe(v.expect.summary);
      expect(intent.verifiability).toBe(v.expect.verifiability);
      expect(intent.outflows).toStrictEqual(v.expect.outflows);
      expect(intent.minimumReceived).toStrictEqual(v.expect.minimumReceived);
      expect(intent.bridge).toStrictEqual(v.expect.bridge);
    },
  );

  const mutate = (tx: { to: string; value: string; data: string }, data: string) => ({
    ...tx,
    data,
  });

  it("a deposit carrying a message is not recognised", () => {
    const data = `${dep!.tx.data.slice(0, -2)}01`; // non-empty message length tail won't match
    const intent = decodeEvm(
      txReq(mutate(dep!.tx, data) as unknown as EvmTransaction, "eip155:1"),
      dep!.signer,
    );
    expect(intent.summary).not.toBe("bridge");
  });

  it("a non-EVM bytes32 recipient is not recognised", () => {
    // Swap the left-padded recipient for one with nonzero high bytes.
    const data = dep!.tx.data.replace(
      "00000000000000000000000074a67657afabb38fdc033d1f06c5cae11449ccda",
      "00000000000000000000000174a67657afabb38fdc033d1f06c5cae11449ccda",
    );
    const intent = decodeEvm(
      txReq(mutate(dep!.tx, data) as unknown as EvmTransaction, "eip155:1"),
      dep!.signer,
    );
    expect(intent.summary).not.toBe("bridge");
  });

  it("a call to another chain's SpokePool is not recognised", () => {
    const tx = { ...dep!.tx, to: "0x6f26Bf09B1C792e3228e5467807a900A503c0281" };
    const intent = decodeEvm(txReq(tx as unknown as EvmTransaction, "eip155:1"), dep!.signer);
    expect(intent.summary).not.toBe("bridge");
  });

  it("a call to the SpokePool on a non-registered chain is not recognised", () => {
    const intent = decodeEvm(txReq(dep!.tx as unknown as EvmTransaction, "eip155:5"), dep!.signer);
    expect(intent.summary).not.toBe("bridge");
  });

  it("non-canonical calldata is not recognised", () => {
    // Flip one byte inside an argument word — the args no longer re-encode to the same prefix.
    const data = `${dep!.tx.data.slice(0, -20)}ff${dep!.tx.data.slice(-18)}`;
    const intent = decodeEvm(
      txReq(mutate(dep!.tx, data) as unknown as EvmTransaction, "eip155:1"),
      dep!.signer,
    );
    expect(intent.summary).not.toBe("bridge");
  });

  it("the v3 vector decodes the depositor as recipient too", () => {
    const intent = decodeEvm(txReq(dv3!.tx as unknown as EvmTransaction, "eip155:1"), dv3!.signer);
    expect(intent.bridge).toStrictEqual(dv3!.expect.bridge);
  });
});
