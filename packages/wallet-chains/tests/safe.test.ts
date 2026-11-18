import * as fc from "fast-check";
import * as AbiFunction from "ox/AbiFunction";
import { describe, expect, it } from "vite-plus/test";

import { SAFE_MULTISEND_CALL_ONLY, checksumEvmAddress, decodeEvm } from "../src/evm/index.ts";
import { isBlindIntent } from "../src/index.ts";

const SIGNER = "0x1111111111111111111111111111111111111111";

const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm" } as const;
const SAFE = checksumEvmAddress("0xd5ffe748b45f5253fc9975fdd96fddec052e6d52");
const MULTISEND = "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D";
const MULTISEND_141 = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TO = "0x00000000000000000000000000000000DeaDBeef";
const REFUND = checksumEvmAddress("0x0000000000000000000000000000000000000bee");

type Field = { name: string; type: string };
const fields = (spec: string): Field[] =>
  spec.split(",").map((part) => {
    const [type, name] = part.trim().split(" ");
    return { type: type ?? "", name: name ?? "" };
  });

const SAFE_TX_FIELDS = fields(
  "address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce",
);

const MULTISEND_ABI = AbiFunction.from("function multiSend(bytes transactions)");
const TRANSFER_ABI = AbiFunction.from("function transfer(address to, uint256 amount)");

const transferData = AbiFunction.encodeData(TRANSFER_ABI, [TO, 5n]);

/** Packed MultiSend entry: operation(1) | to(20) | value(32) | dataLength(32) | data. */
const packEntry = (to: string, value: bigint, data: string, operation = 0): string => {
  const bytes = data.slice(2);
  const length = BigInt(bytes.length / 2)
    .toString(16)
    .padStart(64, "0");
  return `${operation.toString(16).padStart(2, "0")}${to.slice(2).toLowerCase()}${value
    .toString(16)
    .padStart(64, "0")}${length}${bytes.toLowerCase()}`;
};

const multiSend = (packed: string): string =>
  AbiFunction.encodeData(MULTISEND_ABI, [`0x${packed}`]);

const safeTx = (overrides: Record<string, unknown> = {}) => ({
  to: TO,
  value: "0",
  data: "0x",
  operation: 0,
  safeTxGas: "0",
  baseGas: "0",
  gasPrice: "0",
  gasToken: "0x0000000000000000000000000000000000000000",
  refundReceiver: "0x0000000000000000000000000000000000000000",
  nonce: "42",
  ...overrides,
});

/** The EIP712Domain struct for exactly the keys `domain` carries, in EIP-712 order. */
const domainType = (domain: Record<string, unknown>) =>
  (
    [
      ["name", "string"],
      ["version", "string"],
      ["chainId", "uint256"],
      ["verifyingContract", "address"],
      ["salt", "bytes32"],
    ] as const
  )
    .filter(([name]) => domain[name] !== undefined)
    .map(([name, type]) => ({ name, type }));

const doc = (message: Record<string, unknown>, overrides: Record<string, unknown> = {}) => {
  const domain = { verifyingContract: SAFE, chainId: 1, ...overrides };
  return {
    types: { EIP712Domain: domainType(domain), SafeTx: SAFE_TX_FIELDS },
    primaryType: "SafeTx",
    domain,
    message,
  };
};

const decode = (d: unknown) =>
  decodeEvm(
    {
      kind: "evm.typed-data",
      network: "eip155:1",
      account: ACCOUNT,
      typedData: JSON.stringify(d),
    },
    SIGNER,
  );

const safeOf = (d: unknown) => {
  const { message } = decode(d);
  return message?.kind === "typed-data" ? message.safe : undefined;
};

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/** The token model the decoder should report for a Safe refund paid in `gasToken`. */
const refundToken = (gasToken: string) => {
  if (gasToken === ZERO_ADDR) {
    return { asset: "native", decimals: 18, symbol: "ETH" };
  }
  if (gasToken.toLowerCase() === TOKEN.toLowerCase()) {
    return { asset: TOKEN, decimals: 6, symbol: "USDC" };
  }
  return { asset: checksumEvmAddress(gasToken) };
};

/** The expected decoded refund, including the dropped-receiver and priced-amount rules. */
const expectedRefund = (
  gasPrice: bigint,
  baseGas: bigint,
  safeTxGas: bigint,
  gasToken: string,
  refundReceiver: string,
) => ({
  ...(refundReceiver === ZERO_ADDR ? {} : { receiver: checksumEvmAddress(refundReceiver) }),
  gasPrice: { ...refundToken(gasToken), amount: gasPrice.toString(10) },
  amount: { ...refundToken(gasToken), amount: ((baseGas + safeTxGas) * gasPrice).toString(10) },
});

/** Oracle: re-parses packed MultiSend entries; `undefined` unless every byte is valid. */
const packedEntries = (d: string) => {
  if (!d.toLowerCase().startsWith("0x8d80ff0a")) {
    return undefined;
  }
  let body: string;
  try {
    const decoded: unknown = AbiFunction.decodeData(MULTISEND_ABI, d as `0x${string}`);
    const first: unknown = Array.isArray(decoded) ? decoded[0] : undefined;
    if (typeof first !== "string" || !first.startsWith("0x")) {
      return undefined;
    }
    body = first.slice(2);
  } catch {
    return undefined;
  }
  const entries: Array<{ data: string }> = [];
  let offset = 0;
  while (offset < body.length) {
    if (body.length - offset < 170) {
      return undefined;
    }
    const operation = Number.parseInt(body.slice(offset, offset + 2), 16);
    if (operation !== 0) {
      return undefined;
    }
    const length = Number(BigInt(`0x${body.slice(offset + 106, offset + 170)}`));
    offset += 170;
    if (length * 2 > body.length - offset) {
      return undefined;
    }
    entries.push({ data: `0x${body.slice(offset, offset + length * 2)}` });
    offset += length * 2;
  }
  return entries;
};

/** Whether the intent for this outer SafeTx should be blind — the property's oracle. */
const expectedBlind = (operation: number, to: string, data: string): boolean => {
  const entries = packedEntries(data);
  // A call is blind unless the inner call decodes; a delegatecall is blind unless it unpacks
  // on a canonical MultiSendCallOnly target with no opaque inner calls.
  if (operation === 0) {
    return data !== "0x" && data !== transferData;
  }
  return (
    !(SAFE_MULTISEND_CALL_ONLY.has(to.toLowerCase()) && entries !== undefined) ||
    (entries?.some((e) => e.data !== "0x") ?? false)
  );
};

describe("decodeEvm: Safe transactions", () => {
  it("recognizes a call SafeTx and decodes the inner call", () => {
    const intent = decode(doc(safeTx({ value: "1000000000000000000" })));
    expect(intent.summary).toBe("transfer");
    expect(intent.verifiability).toBe("opaque");
    const safe = safeOf(doc(safeTx({ value: "1000000000000000000" })));
    expect(safe?.operation).toBe("call");
    expect(safe?.safe).toBe(SAFE);
    expect(safe?.nonce).toBe("42");
    expect(safe?.calls).toHaveLength(1);
    expect(safe?.calls[0]?.summary).toBe("transfer");
    expect(safe?.refund).toBeUndefined();
  });

  it("decodes an inner ERC-20 transfer as the call's intent", () => {
    const safe = safeOf(doc(safeTx({ to: TOKEN, data: transferData })));
    expect(safe?.calls[0]?.summary).toBe("transfer");
    expect(safe?.calls[0]?.outflows[0]?.to).toBe(TO);
  });

  it("unpacks a MultiSend delegatecall into one call per entry", () => {
    const packed = packEntry(TO, 7n, "0x") + packEntry(TOKEN, 0n, transferData);
    const intent = decode(doc(safeTx({ to: MULTISEND, operation: 1, data: multiSend(packed) })));
    expect(intent.summary).toBe("batch");
    const safe = safeOf(doc(safeTx({ to: MULTISEND, operation: 1, data: multiSend(packed) })));
    expect(safe?.operation).toBe("delegatecall");
    expect(safe?.calls).toHaveLength(2);
    expect(safe?.calls[0]?.summary).toBe("transfer");
    expect(safe?.calls[1]?.outflows[0]?.to).toBe(TO);
    expect(safe?.calls[1]?.outflows[0]?.amount.asset).toBe(TOKEN);

    const v141 = safeOf(
      doc(safeTx({ to: MULTISEND_141, operation: 1, data: multiSend(packEntry(TO, 0n, "0x")) })),
    );
    expect(v141?.calls).toHaveLength(1);
    expect(
      decode(
        doc(safeTx({ to: MULTISEND_141, operation: 1, data: multiSend(packEntry(TO, 0n, "0x")) })),
      ).summary,
    ).toBe("batch");
  });

  it("falls back to one opaque call on truncated entries or an inner delegatecall", () => {
    const truncated = safeOf(
      doc(safeTx({ to: MULTISEND, operation: 1, data: multiSend("001122") })),
    );
    expect(truncated?.calls).toHaveLength(1);
    expect(
      decode(doc(safeTx({ to: MULTISEND, operation: 1, data: multiSend("001122") }))).summary,
    ).toBe("contract-call");

    const innerDelegate = safeOf(
      doc(
        safeTx({
          to: MULTISEND,
          operation: 1,
          data: multiSend(packEntry(TO, 0n, "0x", 1)),
        }),
      ),
    );
    expect(innerDelegate?.calls).toHaveLength(1);

    const trailing = safeOf(
      doc(
        safeTx({
          to: MULTISEND,
          operation: 1,
          data: multiSend(`${packEntry(TO, 0n, "0x")}ff`),
        }),
      ),
    );
    expect(trailing?.calls).toHaveLength(1);
  });

  it("exposes the gas refund only when gasPrice is non-zero", () => {
    const refunded = safeOf(
      doc(
        safeTx({
          gasPrice: "5000000000",
          baseGas: "21000",
          safeTxGas: "100000",
          gasToken: "0x0000000000000000000000000000000000000000",
          refundReceiver: REFUND,
        }),
      ),
    );
    // (21000 + 100000) × 5 gwei, in the zero gas token — the native asset.
    expect(refunded?.refund).toStrictEqual({
      receiver: REFUND,
      gasPrice: { asset: "native", amount: "5000000000", decimals: 18, symbol: "ETH" },
      amount: { asset: "native", amount: "605000000000000", decimals: 18, symbol: "ETH" },
    });
  });

  it("exposes no refund and stays verifiable when gasPrice is zero", () => {
    const d = doc(
      safeTx({
        gasPrice: "0",
        baseGas: "21000",
        safeTxGas: "100000",
        refundReceiver: REFUND,
      }),
    );
    expect(safeOf(d)?.refund).toBeUndefined();
    // The single inner call ("0x" data) is a plain transfer — nothing opaque.
    expect(isBlindIntent(decode(d))).toBe(false);
  });

  it("prices the refund, drops a zero receiver and is blind", () => {
    const evmAddress = fc
      .uint8Array({ minLength: 20, maxLength: 20 })
      .map((b) => `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`);
    const uint256 = fc.bigInt({ min: 0n, max: 2n ** 256n - 1n });
    fc.assert(
      fc.property(
        fc.record({
          gasPrice: uint256,
          baseGas: uint256,
          safeTxGas: uint256,
          gasToken: fc.oneof(fc.constant(ZERO_ADDR), fc.constant(TOKEN), evmAddress),
          refundReceiver: fc.oneof(fc.constant(ZERO_ADDR), evmAddress),
        }),
        ({ gasPrice, baseGas, safeTxGas, gasToken, refundReceiver }) => {
          // The zero-gasPrice branch (no refund, verifiable) is the dedicated test above.
          fc.pre(gasPrice !== 0n);
          const d = doc(
            safeTx({
              gasPrice: gasPrice.toString(10),
              baseGas: baseGas.toString(10),
              safeTxGas: safeTxGas.toString(10),
              gasToken,
              refundReceiver,
            }),
          );
          expect(safeOf(d)?.refund).toStrictEqual(
            expectedRefund(gasPrice, baseGas, safeTxGas, gasToken, refundReceiver),
          );
          expect(isBlindIntent(decode(d))).toBe(true);
        },
      ),
    );
  });

  it("a delegatecall outside MultiSendCallOnly stays a single opaque call", () => {
    const cases = [
      // Empty data to an arbitrary target.
      doc(safeTx({ to: TO, operation: 1 })),
      // Recognised ERC-20 calldata to an arbitrary target — it runs with the Safe's authority.
      doc(safeTx({ to: TOKEN, operation: 1, data: transferData })),
      // A canonical MultiSendCallOnly target whose data is not a valid multiSend.
      doc(safeTx({ to: MULTISEND, operation: 1, data: transferData })),
    ];
    const targets = [TO, TOKEN, MULTISEND];
    for (const [i, d] of cases.entries()) {
      const safe = safeOf(d);
      expect(safe?.calls).toHaveLength(1);
      expect(safe?.calls[0]?.summary).toBe("contract-call");
      expect(safe?.calls[0]?.verifiability).toBe("opaque");
      expect(safe?.calls[0]?.outflows).toHaveLength(0);
      expect(safe?.calls[0]?.contract).toStrictEqual({
        address: targets[i],
        created: false,
      });
      expect(isBlindIntent(decode(d))).toBe(true);
    }
  });

  it("blind exactly when the delegatecall is not a verifiable MultiSend", () => {
    const hexOf = (b: Uint8Array): string =>
      [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    const evmAddress = fc.uint8Array({ minLength: 20, maxLength: 20 }).map((b) => `0x${hexOf(b)}`);
    // Shorter than any 4-byte selector, so never a decodable call.
    const shortData = fc.uint8Array({ minLength: 1, maxLength: 3 }).map((b) => `0x${hexOf(b)}`);
    const entryData = fc.oneof(fc.constant("0x"), shortData);
    const entry = fc.record({
      to: evmAddress,
      value: fc.bigInt({ min: 0n, max: 10n ** 20n }),
      data: entryData,
      operation: fc.constantFrom(0, 1),
    });
    const packed = fc
      .array(entry, { maxLength: 3 })
      .map((es) =>
        AbiFunction.encodeData(MULTISEND_ABI, [
          `0x${es.map((e) => packEntry(e.to, e.value, e.data, e.operation)).join("")}`,
        ]),
      );
    const data = fc.oneof(packed, fc.constant("0x"), fc.constant(transferData), shortData);

    fc.assert(
      fc.property(
        fc.record({
          operation: fc.constantFrom(0, 1),
          to: fc.oneof(evmAddress, fc.constantFrom(...SAFE_MULTISEND_CALL_ONLY)),
          data,
        }),
        ({ operation, to, data }) => {
          const intent = decode(doc(safeTx({ to, operation, data })));
          expect(isBlindIntent(intent)).toBe(expectedBlind(operation, to, data));
        },
      ),
    );
  });

  it("does not recognize a bad operation, malformed field or missing contract", () => {
    expect(safeOf(doc(safeTx({ operation: 2 })))).toBeUndefined();
    expect(safeOf(doc(safeTx({ operation: "two" })))).toBeUndefined();
    expect(safeOf(doc(safeTx({ to: "0xzz" })))).toBeUndefined();
    expect(safeOf(doc(safeTx(), { verifyingContract: "0xzz" }))).toBeUndefined();

    const renamed = doc(safeTx());
    renamed.types.SafeTx[9] = { name: "nonce", type: "uint8" };
    const extra = doc(safeTx());
    extra.types.SafeTx.push({ name: "extra", type: "uint256" });
    expect(safeOf(renamed)).toBeUndefined();
    expect(safeOf(extra)).toBeUndefined();
  });
});
