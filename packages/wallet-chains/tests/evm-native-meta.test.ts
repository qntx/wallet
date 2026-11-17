import * as AbiFunction from "ox/AbiFunction";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { EVM_NATIVE_ASSET, checksumEvmAddress, decodeEvm } from "../src/evm/index.ts";
import type { AssetAmount, DisplayIntent, SignRequest } from "../src/index.ts";
import { BUILT_IN_NETWORKS, networkMeta } from "../src/networks.ts";

const SIGNER = "0x1111111111111111111111111111111111111111";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm" } as const;
const SAFE = checksumEvmAddress("0xd5ffe748b45f5253fc9975fdd96fddec052e6d52");
const MULTISEND = "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D";
const SEAPORT = "0x0000000000000068F116a894984e2DB1123eB395";
const ZERO = "0x0000000000000000000000000000000000000000";
const TO = "0x00000000000000000000000000000000DeaDBeef";

type Field = { name: string; type: string };
const fields = (spec: string): Field[] =>
  spec.split(",").map((part) => {
    const [type, name] = part.trim().split(" ");
    return { type: type ?? "", name: name ?? "" };
  });

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

const SAFE_TX_FIELDS = fields(
  "address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce",
);

const OFFER_ITEM = fields(
  "uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount",
);
const CONSIDERATION_ITEM = [...OFFER_ITEM, { type: "address", name: "recipient" }];

const MULTISEND_ABI = AbiFunction.from("function multiSend(bytes transactions)");

/** Packed MultiSend entry: operation(1) | to(20) | value(32) | dataLength(32) | data. */
const packEntry = (to: string, value: bigint, data: string): string => {
  const bytes = data.slice(2);
  const length = BigInt(bytes.length / 2)
    .toString(16)
    .padStart(64, "0");
  return `00${to.slice(2).toLowerCase()}${value.toString(16).padStart(64, "0")}${length}${bytes.toLowerCase()}`;
};

const chainIdOf = (network: string): number => Number(network.slice(7));

const safeTx = (overrides: Record<string, unknown> = {}) => ({
  to: TO,
  value: "0",
  data: "0x",
  operation: 0,
  safeTxGas: "0",
  baseGas: "0",
  gasPrice: "0",
  gasToken: ZERO,
  refundReceiver: ZERO,
  nonce: "42",
  ...overrides,
});

const safeDoc = (network: string, message: Record<string, unknown>) => {
  const domain = { verifyingContract: SAFE, chainId: chainIdOf(network) };
  return {
    types: { EIP712Domain: domainType(domain), SafeTx: SAFE_TX_FIELDS },
    primaryType: "SafeTx",
    domain,
    message,
  };
};

const nativeItem = (wei: bigint) => ({
  itemType: 0,
  token: ZERO,
  identifierOrCriteria: "0",
  startAmount: wei.toString(10),
  endAmount: wei.toString(10),
});

const seaportDoc = (network: string, offerWei: bigint, considerationWei: bigint) => ({
  types: {
    EIP712Domain: fields("string name, string version, uint256 chainId, address verifyingContract"),
    OrderComponents: fields(
      "address offerer, address zone, OfferItem[] offer, ConsiderationItem[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 counter",
    ),
    OfferItem: OFFER_ITEM,
    ConsiderationItem: CONSIDERATION_ITEM,
  },
  primaryType: "OrderComponents",
  domain: {
    name: "Seaport",
    version: "1.6",
    chainId: chainIdOf(network),
    verifyingContract: SEAPORT,
  },
  message: {
    offerer: SIGNER,
    zone: ZERO,
    offer: [nativeItem(offerWei)],
    consideration: [{ ...nativeItem(considerationWei), recipient: TO }],
    orderType: 0,
    startTime: "1700000000",
    endTime: "1700001000",
    zoneHash: `0x${"00".repeat(32)}`,
    salt: "123",
    conduitKey: `0x${"00".repeat(32)}`,
    counter: "0",
  },
});

const txReq = (network: string, wei: bigint): SignRequest => ({
  kind: "evm.transaction",
  network,
  account: ACCOUNT,
  tx: {
    type: "legacy",
    chainId: chainIdOf(network),
    to: TO,
    data: "0x",
    value: `0x${wei.toString(16)}`,
    nonce: 0,
    gas: "0x5208",
    gasPrice: "0x1",
  },
});

const typedReq = (network: string, doc: unknown): SignRequest => ({
  kind: "evm.typed-data",
  network,
  account: ACCOUNT,
  typedData: JSON.stringify(doc),
});

/**
 * Every amount a prompt can show: outflows, minimum-received, fee, staking, nested calls, and
 * typed-data content (Seaport items, Safe calls). The requester's raw `message.data` is not walked.
 */
const amountsOf = (intent: DisplayIntent): AssetAmount[] => {
  const out: AssetAmount[] = [];
  const walk = (i: DisplayIntent): void => {
    out.push(...i.outflows.map((f) => f.amount));
    if (i.fee !== undefined) {
      out.push(i.fee.max);
      if (i.fee.l1Data !== undefined) {
        out.push(i.fee.l1Data);
      }
    }
    out.push(...(i.minimumReceived ?? []).map((m) => m.amount));
    for (const a of i.staking ?? []) {
      if (a.kind === "lido-submit") {
        out.push(a.amount, a.receive);
      }
    }
    (i.calls ?? []).forEach(walk);
    const { message } = i;
    if (message !== undefined && message.kind === "typed-data") {
      if (message.seaport !== undefined) {
        for (const item of [...message.seaport.offer, ...message.seaport.consideration]) {
          out.push(item.startAmount, item.endAmount);
        }
      }
      (message.safe?.calls ?? []).forEach(walk);
    }
  };
  walk(intent);
  return out;
};

/**
 * The decode contract: every native amount is marked 18-decimal and carries the network's registry
 * symbol (none for an unregistered chain) — never a symbol the decoder made up.
 */
const expectNativeMeta = (intent: DisplayIntent, network: string): void => {
  const symbol = networkMeta(network)?.symbol;
  const amounts = amountsOf(intent);
  expect(amounts.length).toBeGreaterThan(0);
  expect(amounts.some((a) => a.asset === EVM_NATIVE_ASSET)).toBe(true);
  for (const a of amounts) {
    if (a.asset === EVM_NATIVE_ASSET) {
      expect(a.decimals).toBe(18);
      expect(a.symbol).toBe(symbol);
    }
    if (symbol !== "ETH") {
      expect(a.symbol).not.toBe("ETH");
    }
  }
};

describe("decodeEvm native amounts carry the request network's metadata", () => {
  const networks = fc.oneof(
    fc.constantFrom(...BUILT_IN_NETWORKS.filter((n) => n.family === "evm").map((n) => n.id)),
    // Above the largest built-in chainId (11,155,420), so the chain is never registered.
    fc.integer({ min: 20_000_000, max: 2_000_000_000 }).map((n) => `eip155:${n}`),
  );
  const wei = fc.bigInt({ min: 0n, max: 10n ** 24n });

  it("a native transaction's send and fee", () => {
    fc.assert(
      fc.property(networks, wei, (network, value) => {
        expectNativeMeta(decodeEvm(txReq(network, value), SIGNER, {}), network);
      }),
    );
  });

  it("a SafeTx call's inner native send", () => {
    fc.assert(
      fc.property(networks, wei, (network, value) => {
        const doc = safeDoc(network, safeTx({ value: value.toString(10) }));
        expectNativeMeta(decodeEvm(typedReq(network, doc), SIGNER, {}), network);
      }),
    );
  });

  it("a SafeTx MultiSend's native entries", () => {
    fc.assert(
      fc.property(networks, wei, wei, (network, a, b) => {
        const packed = packEntry(TO, a, "0x") + packEntry(SAFE, b, "0x");
        const data = AbiFunction.encodeData(MULTISEND_ABI, [`0x${packed}`]);
        const doc = safeDoc(network, safeTx({ to: MULTISEND, operation: 1, data }));
        expectNativeMeta(decodeEvm(typedReq(network, doc), SIGNER, {}), network);
      }),
    );
  });

  it("a Seaport order's native offer and consideration", () => {
    fc.assert(
      fc.property(networks, wei, wei, (network, offerWei, considerationWei) => {
        const doc = seaportDoc(network, offerWei, considerationWei);
        expectNativeMeta(decodeEvm(typedReq(network, doc), SIGNER, {}), network);
      }),
    );
  });
});
