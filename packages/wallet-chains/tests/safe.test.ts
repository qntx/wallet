import * as AbiFunction from "ox/AbiFunction";
import { describe, expect, it } from "vite-plus/test";

import { checksumEvmAddress, decodeEvm } from "../src/evm/index.ts";

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
          gasToken: "0x0000000000000000000000000000000000000000",
          refundReceiver: REFUND,
        }),
      ),
    );
    expect(refunded?.refund).toStrictEqual({
      gasPrice: "5000000000",
      gasToken: "0x0000000000000000000000000000000000000000",
      refundReceiver: REFUND,
    });
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
