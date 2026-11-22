/**
 * EIP-3009 `TransferWithAuthorization` / `ReceiveWithAuthorization` / `CancelAuthorization`
 * documents from the ERC-7730 registry corpus decode as a recognized authorization bound to the
 * signer; variants of the shape fall back to blind `typed-data-variant`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vite-plus/test";

import { decodeEvm } from "../src/evm/index.ts";
import { signEvmTypedData } from "../src/evm/sign.ts";
import type { SignRequest } from "../src/index.ts";

const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm.bip44" } as const;

type Doc = {
  origin: string;
  description: string;
  signer: string;
  digest: string;
  data: {
    types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
    domain: { chainId?: number; verifyingContract?: string };
    primaryType: string;
    message: Record<string, unknown>;
  };
  expected: Record<string, unknown>;
};

type Resigned = { data: Doc["data"]; signature: string; digest: string };

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/chains/eip3009.json"), "utf8"),
) as {
  key: string;
  account: string;
  docs: Doc[];
  resigned: Resigned[];
  nearMisses: Array<{
    description: string;
    data: Doc["data"];
    digest: string;
    signer: string;
    network: string;
  }>;
};

const request = (data: Doc["data"], network?: string): SignRequest => ({
  kind: "evm.typed-data",
  network: network ?? `eip155:${data.domain.chainId}`,
  account: ACCOUNT,
  typedData: JSON.stringify(data),
});

const authorizationOf = (intent: ReturnType<typeof decodeEvm>) => {
  const { message } = intent;
  if (message?.kind !== "typed-data" || message.authorization === undefined) {
    throw new Error("expected a decoded EIP-3009 authorization");
  }
  return message.authorization;
};

const [FIRST_DOC] = vectors.docs;
if (FIRST_DOC === undefined) {
  throw new Error("vector file has no docs");
}
const unlistedTransfer = vectors.docs.find(
  (doc) => doc.expected["verifiability"] === "partial" && doc.expected["kind"] === "transfer",
);
if (unlistedTransfer === undefined) {
  throw new Error("vector file has no unlisted-token transfer doc");
}
const transfers = vectors.docs
  .filter((doc) => doc.expected["kind"] !== "cancel")
  .map((doc) => ({
    ...doc,
    expectedAuthorization: {
      kind: doc.expected["kind"],
      to: doc.expected["to"],
      amount: doc.expected["amount"],
      validAfter: doc.expected["validAfter"],
      ...(doc.expected["validBefore"] === undefined
        ? {}
        : { validBefore: doc.expected["validBefore"] }),
    },
  }));
const cancels = vectors.docs.filter((doc) => doc.expected["kind"] === "cancel");
const [FIRST_CANCEL] = cancels;
if (FIRST_CANCEL === undefined) {
  throw new Error("vector file has no cancel doc");
}

describe("EIP-3009 registry corpus", () => {
  it.each(transfers)("$description", ({ data, signer, expected, expectedAuthorization }) => {
    const intent = decodeEvm(request(data), signer);
    expect(intent.blind).toBeUndefined();
    expect(intent.summary).toBe(expected["summary"]);
    expect(intent.verifiability).toBe(expected["verifiability"]);
    expect(authorizationOf(intent)).toStrictEqual(expectedAuthorization);
    expect(intent.outflows).toHaveLength(1);
    expect(intent.outflows[0]).toMatchObject({
      amount: expected["amount"],
      verified: expected["verifiability"] === "full",
    });
  });

  it.each(cancels)("$description", ({ data, signer, expected }) => {
    const intent = decodeEvm(request(data), signer);
    expect(intent.blind).toBeUndefined();
    expect(intent.summary).toBe("message");
    expect(intent.verifiability).toBe("full");
    expect(authorizationOf(intent)).toStrictEqual({
      kind: "cancel",
      token: expected["token"],
      nonce: expected["nonce"],
    });
    expect(intent.outflows).toStrictEqual([]);
  });

  it.each(vectors.resigned)(
    "our signer reproduces the viem signature ($data.primaryType)",
    ({ data, signature }) => {
      const keyBytes = Uint8Array.from(Buffer.from(vectors.key.slice(2), "hex"));
      const ours = `0x${Buffer.from(signEvmTypedData(JSON.stringify(data), keyBytes)).toString("hex")}`;
      expect(ours).toBe(signature);
      expect(privateKeyToAccount(vectors.key as `0x${string}`).address).toBe(vectors.account);
    },
  );

  it.each(vectors.nearMisses)(
    "$description is blind typed-data-variant",
    ({ data, signer, network }) => {
      const intent = decodeEvm(request(data, network), signer);
      expect(intent.blind).toBe("typed-data-variant");
      expect(intent.summary).toBe("message");
    },
  );
});

describe("EIP-3009 guards", () => {
  const base = (): Doc["data"] => structuredClone(FIRST_DOC.data);

  it("a document signed for a different signer is not decoded", () => {
    const intent = decodeEvm(request(base()), "0x00000000000000000000000000000000deadbeef");
    expect(intent.blind).toBe("typed-data-variant");
    expect(() => authorizationOf(intent)).toThrow("expected a decoded");
  });

  it("a domain chain id other than the request's is not decoded", () => {
    const data = base();
    const intent = decodeEvm(request(data, "eip155:1"), String(data.message["from"]));
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a missing verifyingContract is not decoded", () => {
    const data = base();
    const domain = { ...data.domain };
    delete domain.verifyingContract;
    const intent = decodeEvm(request({ ...data, domain }), String(data.message["from"]));
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("an extra type entry is not decoded", () => {
    const data = base();
    const withExtra = structuredClone(data);
    withExtra.types = {
      ...withExtra.types,
      Unused: [{ name: "x", type: "uint256" }],
    };
    const intent = decodeEvm(request(withExtra), String(data.message["from"]));
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("a validBefore beyond uint48 is simply absent from the decoded authorization", () => {
    const data = base();
    data.message["validBefore"] = "281474976710656";
    const intent = decodeEvm(request(data), String(data.message["from"]));
    expect(intent.blind).toBeUndefined();
    expect(authorizationOf(intent)).not.toHaveProperty("validBefore");
  });

  it("a malformed nonce is not decoded", () => {
    const data = base();
    data.message["nonce"] = "0x1234";
    const intent = decodeEvm(request(data), String(data.message["from"]));
    expect(intent.blind).toBe("typed-data-variant");
  });

  it("an odd-length nonce is not decoded — transfer and cancel alike", () => {
    /* `0x` + 63 nibbles: ox would left-pad it to bytes32 while the decoder must not accept it
       as the document's own bytes. */
    const odd = `0x${"1".repeat(63)}`;
    const transfer = base();
    transfer.message["nonce"] = odd;
    expect(decodeEvm(request(transfer), String(transfer.message["from"])).blind).toBe(
      "typed-data-variant",
    );
    const cancelData = structuredClone(FIRST_CANCEL.data);
    cancelData.message["nonce"] = odd;
    expect(decodeEvm(request(cancelData), String(cancelData.message["authorizer"])).blind).toBe(
      "typed-data-variant",
    );
  });

  it("a document on an unlisted token is partial with an unverified asset", () => {
    const unlisted = unlistedTransfer;
    const intent = decodeEvm(request(unlisted.data), unlisted.signer);
    expect(intent.verifiability).toBe("partial");
    expect(intent.outflows[0]?.verified).toBe(false);
    expect(intent.outflows[0]?.amount.symbol).toBeUndefined();
  });
});
