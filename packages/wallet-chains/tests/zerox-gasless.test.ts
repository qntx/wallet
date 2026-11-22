import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/index.ts";
import { signEvmTypedData } from "../src/evm/sign.ts";
import type { SignRequest } from "../src/index.ts";

const ACCOUNT = { kind: "hd" as const, walletId: "w", groupIndex: 0, template: "evm" };

type Doc = {
  description: string;
  data: {
    types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
    primaryType: string;
    domain: Record<string, unknown>;
    message: Record<string, unknown>;
  };
  signer: string;
  digest: string;
  signature: string;
  expected: string | Record<string, unknown>;
  network?: string;
};

const vectors = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../vectors/chains/evm-zerox-gasless.json"),
    "utf8",
  ),
) as {
  key: string;
  account: string;
  real: Doc & { expected: Record<string, unknown> };
  signed: Doc[];
};

const nativeVariant = vectors.signed.find((v) => v.description.includes("native"));
if (nativeVariant === undefined) {
  throw new Error("vector file has no native buyToken variant");
}

const request = (data: Doc["data"], network?: string): SignRequest => ({
  kind: "evm.typed-data",
  network: network ?? `eip155:${String(data.domain["chainId"])}`,
  account: ACCOUNT,
  typedData: JSON.stringify(data),
});

const messageOf = (intent: ReturnType<typeof decodeEvm>) => {
  const { message } = intent;
  if (message?.kind !== "typed-data") {
    throw new Error("expected typed-data content");
  }
  return message;
};

describe("decodeEvm: 0x gasless Settler MetaTxn witnesses", () => {
  it("decodes the published 0x-examples document as a 0x order", () => {
    const { real } = vectors;
    const intent = decodeEvm(request(real.data), real.signer);
    expect(intent.blind).toBeUndefined();
    expect(intent.summary).toBe("swap");
    expect(intent.verifiability).toBe("partial");
    expect(messageOf(intent).order).toStrictEqual(real.expected);
    /* The Permit2 approval is a take-once transfer to the Settler spender. */
    expect(intent.approvals).toHaveLength(1);
    expect(intent.approvals[0]).toMatchObject({
      kind: "allowance",
      spender: "0x5CE929DDB01804bfF35B2F5c77b735bdB094AAc8",
      change: "transfer",
      via: "permit2",
      expiration: 1721085355,
    });
  });

  it.each(vectors.signed.filter((v) => v.expected === "order"))(
    "decodes a signed order ($description)",
    ({ data, network }) => {
      const intent = decodeEvm(request(data, network), vectors.account);
      expect(intent.blind).toBeUndefined();
      expect(intent.summary).toBe("swap");
      const { order } = messageOf(intent);
      expect(order?.protocol).toBe("0x");
      expect(order?.maker).toBe(vectors.account);
      expect(order?.partialFill).toBe(false);
    },
  );

  it("an odd-length actions element is not recognised", () => {
    /* "0xabc" is odd: ox would left-pad it when hashing — the decoder must not describe it. */
    const data = structuredClone(vectors.real.data);
    const slippage = data.message["slippageAndActions"] as { actions: unknown[] };
    slippage.actions = ["0xabc"];
    const intent = decodeEvm(request(data), vectors.real.signer);
    expect(intent.blind).toBe("typed-data-variant");
    expect(messageOf(intent).order).toBeUndefined();
  });

  it("shows the native sentinel buyToken as the native asset", () => {
    const { order } = messageOf(decodeEvm(request(nativeVariant.data), vectors.account));
    expect(order?.receive[0]?.amount.asset).toBe("native");
    expect(order?.receive[0]?.amount.symbol).toBe("ETH");
  });

  it.each(vectors.signed.filter((v) => v.expected === "variant"))(
    "stays blind for $description",
    ({ data, network }) => {
      const intent = decodeEvm(request(data, network), vectors.account);
      expect(intent.blind).toBe("typed-data-variant");
      expect(messageOf(intent).order).toBeUndefined();
    },
  );

  it.each(vectors.signed)(
    "our signer reproduces the viem signature ($description)",
    ({ data, signature }) => {
      const keyBytes = Uint8Array.from(Buffer.from(vectors.key.slice(2), "hex"));
      const ours = `0x${Buffer.from(signEvmTypedData(JSON.stringify(data), keyBytes)).toString("hex")}`;
      expect(privateKeyToAccount(vectors.key as `0x${string}`).address).toBe(vectors.account);
      expect(ours).toBe(signature);
    },
  );
});
