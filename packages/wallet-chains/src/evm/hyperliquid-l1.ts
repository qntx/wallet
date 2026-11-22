/**
 * Hyperliquid L1 action encoding (research H2): msgpack with the schema key order spelled out
 * literally per action type — the order is semantic, it feeds the phantom-agent connectionId.
 *
 * ConnectionId = keccak256(msgpack(action) ‖ u64be(nonce) ‖ (vaultAddress ? 0x01 ‖ 20 address bytes
 * : 0x00) ‖ (expiresAfter !== undefined ? 0x00 ‖ u64be(expiresAfter) : ε)) (nktkas _l1.ts:31-46,
 * python signing.py action_hash — note the 0x00 marker before expiresAfter; the vault marker is
 * 0x00/0x01.)
 *
 * The connectionId then signs as `Agent(string source,bytes32 connectionId)` under domain
 * {name:"Exchange", version:"1", chainId:1337, verifyingContract:0x0…0}, `source` "a" mainnet / "b"
 * testnet (nktkas _l1.ts:150-170, python signing.py construct_phantom_agent).
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { concat, packArray, packBool, packInt, packMap, packStr } from "./msgpack.ts";

export type HyperliquidNetwork = "Mainnet" | "Testnet";

export type HyperliquidL1Order = {
  readonly a: number;
  readonly b: boolean;
  readonly p: string;
  readonly s: string;
  readonly r: boolean;
  readonly t:
    | { readonly limit: { readonly tif: "Gtc" | "Ioc" | "Alo" | "FrontendMarket" } }
    | {
        readonly trigger: {
          readonly isMarket: boolean;
          readonly triggerPx: string;
          readonly tpsl: "tp" | "sl";
        };
      };
  readonly c?: string;
};

/** The ten allow-listed L1 actions (research H2-T), in the table's order. */
export type HyperliquidL1Action =
  | {
      readonly type: "order";
      readonly orders: ReadonlyArray<HyperliquidL1Order>;
      readonly grouping: "na" | "normalTpsl" | "positionTpsl";
      readonly builder?: { readonly b: string; readonly f: number };
    }
  | {
      readonly type: "cancel";
      readonly cancels: ReadonlyArray<{ readonly a: number; readonly o: number }>;
      readonly f?: true;
    }
  | {
      readonly type: "cancelByCloid";
      readonly cancels: ReadonlyArray<{ readonly asset: number; readonly cloid: string }>;
      readonly f?: true;
    }
  | {
      readonly type: "modify";
      readonly oid: number | string;
      readonly order: HyperliquidL1Order;
      readonly a?: true;
    }
  | {
      readonly type: "batchModify";
      readonly modifies: ReadonlyArray<{
        readonly oid: number | string;
        readonly order: HyperliquidL1Order;
      }>;
      readonly a?: true;
    }
  | { readonly type: "scheduleCancel"; readonly time?: number }
  | {
      readonly type: "updateLeverage";
      readonly asset: number;
      readonly isCross: boolean;
      readonly leverage: number;
    }
  | {
      readonly type: "updateIsolatedMargin";
      readonly asset: number;
      readonly isBuy: boolean;
      readonly ntli: number;
    }
  | {
      readonly type: "twapOrder";
      readonly twap: {
        readonly a: number;
        readonly b: boolean;
        readonly s: string;
        readonly r: boolean;
        readonly m: number;
        readonly t: boolean;
      };
    }
  | { readonly type: "twapCancel"; readonly a: number; readonly t: number };

export type HyperliquidL1Params = {
  readonly action: HyperliquidL1Action;
  readonly nonce: number;
  readonly vaultAddress?: string;
  /** Wall-clock ms after which Hyperliquid rejects the action — at most 60 s after signing. */
  readonly expiresAfter: number;
};

type Entry = readonly [string, Uint8Array];

const u64be = (value: number): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
};

/** The order-wire map, H2-T order: a,b,p,s,r,t,c? — `c` only when present. */
const orderWire = (order: HyperliquidL1Order): Uint8Array => {
  const t =
    "limit" in order.t
      ? packMap([["limit", packMap([["tif", packStr(order.t.limit.tif)]])]])
      : packMap([
          [
            "trigger",
            packMap([
              ["isMarket", packBool(order.t.trigger.isMarket)],
              ["triggerPx", packStr(order.t.trigger.triggerPx)],
              ["tpsl", packStr(order.t.trigger.tpsl)],
            ]),
          ],
        ]);
  const entries: Entry[] = [
    ["a", packInt(order.a)],
    ["b", packBool(order.b)],
    ["p", packStr(order.p)],
    ["s", packStr(order.s)],
    ["r", packBool(order.r)],
    ["t", t],
  ];
  if (order.c !== undefined) {
    entries.push(["c", packStr(order.c)]);
  }
  return packMap(entries);
};

const packOid = (oid: number | string): Uint8Array =>
  typeof oid === "number" ? packInt(oid) : packStr(oid);

/**
 * Msgpack(action) with every map's keys written in the H2-T schema order. The switch is exhaustive
 * over the action union; a trailing return is unreachable code (TS7027).
 */
// oxlint-disable-next-line typescript/consistent-return
export function encodeL1Action(action: HyperliquidL1Action): Uint8Array {
  switch (action.type) {
    case "order": {
      const entries: Entry[] = [
        ["type", packStr("order")],
        ["orders", packArray(action.orders.map(orderWire))],
        ["grouping", packStr(action.grouping)],
      ];
      if (action.builder !== undefined) {
        entries.push([
          "builder",
          packMap([
            ["b", packStr(action.builder.b)],
            ["f", packInt(action.builder.f)],
          ]),
        ]);
      }
      return packMap(entries);
    }
    case "cancel": {
      const entries: Entry[] = [
        ["type", packStr("cancel")],
        [
          "cancels",
          packArray(
            action.cancels.map((cancel) =>
              packMap([
                ["a", packInt(cancel.a)],
                ["o", packInt(cancel.o)],
              ]),
            ),
          ),
        ],
      ];
      if (action.f !== undefined) {
        entries.push(["f", packBool(action.f)]);
      }
      return packMap(entries);
    }
    case "cancelByCloid": {
      const entries: Entry[] = [
        ["type", packStr("cancelByCloid")],
        [
          "cancels",
          packArray(
            action.cancels.map((cancel) =>
              packMap([
                ["asset", packInt(cancel.asset)],
                ["cloid", packStr(cancel.cloid)],
              ]),
            ),
          ),
        ],
      ];
      if (action.f !== undefined) {
        entries.push(["f", packBool(action.f)]);
      }
      return packMap(entries);
    }
    case "modify": {
      const entries: Entry[] = [
        ["type", packStr("modify")],
        ["oid", packOid(action.oid)],
        ["order", orderWire(action.order)],
      ];
      if (action.a !== undefined) {
        entries.push(["a", packBool(action.a)]);
      }
      return packMap(entries);
    }
    case "batchModify": {
      const entries: Entry[] = [
        ["type", packStr("batchModify")],
        [
          "modifies",
          packArray(
            action.modifies.map((modify) =>
              packMap([
                ["oid", packOid(modify.oid)],
                ["order", orderWire(modify.order)],
              ]),
            ),
          ),
        ],
      ];
      if (action.a !== undefined) {
        entries.push(["a", packBool(action.a)]);
      }
      return packMap(entries);
    }
    case "scheduleCancel": {
      const entries: Entry[] = [["type", packStr("scheduleCancel")]];
      if (action.time !== undefined) {
        entries.push(["time", packInt(action.time)]);
      }
      return packMap(entries);
    }
    case "updateLeverage":
      return packMap([
        ["type", packStr("updateLeverage")],
        ["asset", packInt(action.asset)],
        ["isCross", packBool(action.isCross)],
        ["leverage", packInt(action.leverage)],
      ]);
    case "updateIsolatedMargin":
      return packMap([
        ["type", packStr("updateIsolatedMargin")],
        ["asset", packInt(action.asset)],
        ["isBuy", packBool(action.isBuy)],
        ["ntli", packInt(action.ntli)],
      ]);
    case "twapOrder":
      return packMap([
        ["type", packStr("twapOrder")],
        [
          "twap",
          packMap([
            ["a", packInt(action.twap.a)],
            ["b", packBool(action.twap.b)],
            ["s", packStr(action.twap.s)],
            ["r", packBool(action.twap.r)],
            ["m", packInt(action.twap.m)],
            ["t", packBool(action.twap.t)],
          ]),
        ],
      ]);
    case "twapCancel":
      return packMap([
        ["type", packStr("twapCancel")],
        ["a", packInt(action.a)],
        ["t", packInt(action.t)],
      ]);
  }
}

/**
 * Keccak256(msgpack ‖ u64be(nonce) ‖ (vault ? 0x01 ‖ address : 0x00) ‖ (expiresAfter !== undefined
 * ? 0x00 ‖ u64be(expiresAfter) : ε)).
 */
export function l1ConnectionId(args: {
  readonly action: HyperliquidL1Action;
  readonly nonce: number;
  readonly vaultAddress?: string;
  readonly expiresAfter?: number;
}): Uint8Array {
  const packed = encodeL1Action(args.action);
  const vault =
    args.vaultAddress === undefined
      ? new Uint8Array([0x00])
      : concat(new Uint8Array([0x01]), hexToBytes(args.vaultAddress.slice(2)));
  const expiry =
    args.expiresAfter === undefined
      ? new Uint8Array(0)
      : concat(new Uint8Array([0x00]), u64be(args.expiresAfter));
  return keccak_256(concat(packed, u64be(args.nonce), vault, expiry));
}

/**
 * The phantom-agent document the L1 signature actually covers — the kernel builds it, the host
 * never supplies one. `source` is "a" on mainnet, "b" on testnet.
 */
export function phantomAgentTypedData(
  connectionId: Uint8Array,
  network: HyperliquidNetwork,
): string {
  return JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    domain: {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    message: {
      source: network === "Mainnet" ? "a" : "b",
      connectionId: `0x${bytesToHex(connectionId)}`,
    },
  });
}

/** The phantom-agent typed-data JSON an L1 `params` signs, shared by the kernel and the host. */
export function hyperliquidL1Document(
  params: HyperliquidL1Params,
  network: HyperliquidNetwork,
): string {
  return phantomAgentTypedData(
    l1ConnectionId({
      action: params.action,
      nonce: params.nonce,
      ...(params.vaultAddress === undefined ? {} : { vaultAddress: params.vaultAddress }),
      expiresAfter: params.expiresAfter,
    }),
    network,
  );
}
