import type { OffchainOrder } from "../index.ts";
import { checksumEvmAddress } from "./address.ts";
import { MAX_UINT256 } from "./approval.ts";
import { ORDER_ITEMS, orderAmount } from "./order.ts";
import type { EvmTokenTable } from "./tokens.ts";
import {
  domainChainId,
  isTypedDataMessage,
  sameFields,
  typedDataAddress,
  typedDataBytes,
  typedDataUint,
} from "./typed-data.ts";
import type { TypedDataInput, TypedDataMessage } from "./typed-data.ts";

/**
 * Decoding of UniswapX orders carried as the witness of a Permit2 `PermitWitnessTransferFrom`
 * (`refs/uniswapx` at eb7ce07: the *OrderLib.sol PERMIT2_ORDER_TYPE strings give the exact field
 * lists; the reactors' bounds give the amounts shown). An order is decoded only when:
 *
 * - The document's `types` are exactly the canonical set for the order type — no extra type and no
 *   extra, missing or retyped field;
 * - `message.spender` equals `witness.info.reactor` and is the reactor verified for this chain and
 *   order type (README "Deployment Addresses", code present, `permit2()` returning the Permit2
 *   address — `evidence/onchain/reactors.txt`);
 * - `witness.info.swapper` is the signer and the order's input token is the permitted token.
 *
 * The amount shown is the protocol bound, not the start value: Exclusive/V2 input can rise to
 * `max(start, end)` and an output can decay to `min(start, end)`; V3 is bounded by `maxAmount` /
 * `minAmount`; Priority by `amount`. The `cosignerData` of V2/V3/Priority orders is signed by the
 * cosigner, not the swapper, so it is not part of the witness.
 */

export type UniswapXRecognition =
  | { readonly kind: "order"; readonly order: OffchainOrder }
  | { readonly kind: "oversize" };

type WitnessType = "ExclusiveDutchOrder" | "V2DutchOrder" | "V3DutchOrder" | "PriorityOrder";

/* refs/uniswapx/src/lib/OrderInfoLib.sol ORDER_INFO_TYPE. */
const ORDER_INFO = [
  "address reactor",
  "address swapper",
  "uint256 nonce",
  "uint256 deadline",
  "address additionalValidationContract",
  "bytes additionalValidationData",
] as const;

/* refs/uniswapx/src/lib/DutchOrderLib.sol DUTCH_OUTPUT_TYPE. */
const DUTCH_OUTPUT = [
  "address token",
  "uint256 startAmount",
  "uint256 endAmount",
  "address recipient",
] as const;

/* The canonical `types` of the order document, minus the Permit2 framing. */
const ORDER_TYPES: Readonly<Record<WitnessType, Record<string, ReadonlyArray<string>>>> = {
  /* refs/uniswapx/src/lib/ExclusiveDutchOrderLib.sol EXCLUSIVE_DUTCH_LIMIT_ORDER_TYPE. */
  ExclusiveDutchOrder: {
    ExclusiveDutchOrder: [
      "OrderInfo info",
      "uint256 decayStartTime",
      "uint256 decayEndTime",
      "address exclusiveFiller",
      "uint256 exclusivityOverrideBps",
      "address inputToken",
      "uint256 inputStartAmount",
      "uint256 inputEndAmount",
      "DutchOutput[] outputs",
    ],
    OrderInfo: ORDER_INFO,
    DutchOutput: DUTCH_OUTPUT,
  },
  /* refs/uniswapx/src/lib/V2DutchOrderLib.sol V2_DUTCH_ORDER_TYPE. */
  V2DutchOrder: {
    V2DutchOrder: [
      "OrderInfo info",
      "address cosigner",
      "address baseInputToken",
      "uint256 baseInputStartAmount",
      "uint256 baseInputEndAmount",
      "DutchOutput[] baseOutputs",
    ],
    OrderInfo: ORDER_INFO,
    DutchOutput: DUTCH_OUTPUT,
  },
  /* refs/uniswapx/src/lib/V3DutchOrderLib.sol V3_DUTCH_*_TYPE and NON_LINEAR_DECAY_TYPE. */
  V3DutchOrder: {
    V3DutchOrder: [
      "OrderInfo info",
      "address cosigner",
      "uint256 startingBaseFee",
      "V3DutchInput baseInput",
      "V3DutchOutput[] baseOutputs",
    ],
    OrderInfo: ORDER_INFO,
    V3DutchInput: [
      "address token",
      "uint256 startAmount",
      "NonlinearDutchDecay curve",
      "uint256 maxAmount",
      "uint256 adjustmentPerGweiBaseFee",
    ],
    V3DutchOutput: [
      "address token",
      "uint256 startAmount",
      "NonlinearDutchDecay curve",
      "address recipient",
      "uint256 minAmount",
      "uint256 adjustmentPerGweiBaseFee",
    ],
    NonlinearDutchDecay: ["uint256 relativeBlocks", "int256[] relativeAmounts"],
  },
  /* refs/uniswapx/src/lib/PriorityOrderLib.sol TOPLEVEL_PRIORITY_ORDER_TYPE and the input/output
     token types. */
  PriorityOrder: {
    PriorityOrder: [
      "OrderInfo info",
      "address cosigner",
      "uint256 auctionStartBlock",
      "uint256 baselinePriorityFeeWei",
      "PriorityInput input",
      "PriorityOutput[] outputs",
    ],
    OrderInfo: ORDER_INFO,
    PriorityInput: ["address token", "uint256 amount", "uint256 mpsPerPriorityFeeWei"],
    PriorityOutput: [
      "address token",
      "uint256 amount",
      "uint256 mpsPerPriorityFeeWei",
      "address recipient",
    ],
  },
};

const PERMIT2_TYPES: Record<string, ReadonlyArray<string>> = {
  /* Permit2's EIP-712 domain carries no version. */
  EIP712Domain: ["string name", "uint256 chainId", "address verifyingContract"],
  TokenPermissions: ["address token", "uint256 amount"],
};

/**
 * The reactors verified for each chain and order type (`refs/uniswapx` README "Deployment
 * Addresses"; `evidence/onchain/reactors.txt` — code present, `permit2()` = the Permit2 address).
 * Chains whose deployment could not be verified are left out, so their orders fall back.
 */
export const REACTORS: Readonly<Record<number, Partial<Record<WitnessType, string>>>> = {
  1: {
    ExclusiveDutchOrder: "0x6000da47483062a0d734ba3dc7576ce6a0b645c4",
    V2DutchOrder: "0x00000011f84b9aa48e5f8aa8b9897600006289be",
    V3DutchOrder: "0x0000000015757c461808ea25eb309638b62681cf",
  },
  10: { V3DutchOrder: "0x000000000923439a92dae8930613568824108631" },
  56: { V3DutchOrder: "0x00000000a55e50c71b70db3c8b58749cd1e18eb2" },
  130: { V3DutchOrder: "0x000000005af66799d1a6317714d66800f9ca1406" },
  137: { V3DutchOrder: "0x00000000bab6e234db8ad638b6a6395b7c499bc4" },
  143: { V3DutchOrder: "0x000000000ac008f7e07210cfb6648e40249232c2" },
  196: { V3DutchOrder: "0x000000005af66799d1a6317714d66800f9ca1406" },
  480: { V3DutchOrder: "0x00000000d714ea34028930b762e96bfbe50f42c2" },
  1868: { V3DutchOrder: "0x000000005af66799d1a6317714d66800f9ca1406" },
  8453: {
    V3DutchOrder: "0x000000008a8330b5d1f43a62bf4c673a49f27ba0",
    PriorityOrder: "0x000000001ec5656dcdb24d90dfa42742738de729",
  },
  42161: { V3DutchOrder: "0xb274d5f4b833b61b340b654d600a864fb604a87c" },
  42220: { V3DutchOrder: "0x00000000b8077fdf2281a80be96f6c282b5d943a" },
  43114: { V3DutchOrder: "0x00000000862ccf095823fc7576fa6c7e6b7385ef" },
};

const ZERO = "0x0000000000000000000000000000000000000000";

const isWitnessType = (type: string): type is WitnessType => Object.hasOwn(ORDER_TYPES, type);

const address = (message: TypedDataMessage, key: string): string | undefined =>
  typedDataAddress(message[key]);

const uint = (message: TypedDataMessage, key: string): bigint | undefined =>
  typedDataUint(message[key], MAX_UINT256);

type Parsed = {
  readonly info: TypedDataMessage;
  readonly inputToken: string;
  readonly giveAmount: bigint;
  readonly outputs: ReadonlyArray<{
    readonly token: string;
    readonly amount: bigint;
    readonly recipient: string;
  }>;
  readonly exclusiveFiller?: string;
};

/** The witness decoded per its order type, or `undefined` when any needed value is malformed. */
const parse = (type: WitnessType, witness: TypedDataMessage): Parsed | undefined => {
  const { info } = witness;
  if (!isTypedDataMessage(info)) {
    return undefined;
  }
  const output = (item: unknown, amount: (m: TypedDataMessage) => bigint | undefined) => {
    if (!isTypedDataMessage(item)) {
      return undefined;
    }
    const token = address(item, "token");
    const value = amount(item);
    const recipient = address(item, "recipient");
    return token === undefined || value === undefined || recipient === undefined
      ? undefined
      : { token, amount: value, recipient };
  };
  const outputsOf = (
    key: string,
    amount: (m: TypedDataMessage) => bigint | undefined,
  ): Parsed["outputs"] | undefined => {
    const raw = witness[key];
    if (!Array.isArray(raw) || raw.length === 0) {
      return undefined;
    }
    const outputs: Array<Parsed["outputs"][number]> = [];
    for (const item of raw) {
      const parsed = output(item, amount);
      if (parsed === undefined) {
        return undefined;
      }
      outputs.push(parsed);
    }
    return outputs;
  };
  /* The least a linear-decay output can settle for is min(startAmount, endAmount). */
  const dutch = (m: TypedDataMessage): bigint | undefined => {
    const start = uint(m, "startAmount");
    const end = uint(m, "endAmount");
    return start === undefined || end === undefined ? undefined : start < end ? start : end;
  };

  if (type === "ExclusiveDutchOrder" || type === "V2DutchOrder") {
    const exclusive = type === "ExclusiveDutchOrder";
    const prefix = exclusive ? "input" : "baseInput";
    const inputToken = address(witness, `${prefix}Token`);
    const start = uint(witness, `${prefix}StartAmount`);
    const end = uint(witness, `${prefix}EndAmount`);
    const outputs = outputsOf(exclusive ? "outputs" : "baseOutputs", (m) => dutch(m));
    const filler = exclusive ? address(witness, "exclusiveFiller") : undefined;
    const decayed =
      uint(witness, "decayStartTime") !== undefined &&
      uint(witness, "decayEndTime") !== undefined &&
      uint(witness, "exclusivityOverrideBps") !== undefined;
    const cosigned = exclusive || address(witness, "cosigner") !== undefined;
    if (
      inputToken === undefined ||
      start === undefined ||
      end === undefined ||
      outputs === undefined ||
      (exclusive && (!decayed || filler === undefined)) ||
      !cosigned
    ) {
      return undefined;
    }
    return {
      info,
      inputToken,
      giveAmount: start > end ? start : end,
      outputs,
      ...(exclusive && filler !== undefined && filler.toLowerCase() !== ZERO
        ? { exclusiveFiller: filler }
        : {}),
    };
  }
  if (type === "V3DutchOrder") {
    const input = witness["baseInput"];
    if (
      !isTypedDataMessage(input) ||
      !isTypedDataMessage(input["curve"]) ||
      address(witness, "cosigner") === undefined ||
      uint(witness, "startingBaseFee") === undefined
    ) {
      return undefined;
    }
    const inputToken = address(input, "token");
    const maxAmount = uint(input, "maxAmount");
    const outputs = outputsOf("baseOutputs", (m) =>
      isTypedDataMessage(m["curve"]) ? uint(m, "minAmount") : undefined,
    );
    return inputToken === undefined || maxAmount === undefined || outputs === undefined
      ? undefined
      : { info, inputToken, giveAmount: maxAmount, outputs };
  }
  const { input } = witness;
  if (
    !isTypedDataMessage(input) ||
    address(witness, "cosigner") === undefined ||
    uint(witness, "auctionStartBlock") === undefined ||
    uint(witness, "baselinePriorityFeeWei") === undefined ||
    uint(input, "mpsPerPriorityFeeWei") === undefined
  ) {
    return undefined;
  }
  const inputToken = address(input, "token");
  const amount = uint(input, "amount");
  const outputs = outputsOf("outputs", (m) =>
    uint(m, "mpsPerPriorityFeeWei") === undefined ? undefined : uint(m, "amount"),
  );
  return inputToken === undefined || amount === undefined || outputs === undefined
    ? undefined
    : { info, inputToken, giveAmount: amount, outputs };
};

/**
 * The UniswapX order a Permit2 witness document signs, `oversize` when its outputs cannot all be
 * shown, or `undefined` — the caller then falls back to the opaque-witness path.
 */
export const recognizeUniswapX = (
  json: TypedDataInput,
  signer: string,
  chainId: number,
  table: EvmTokenTable,
): UniswapXRecognition | undefined => {
  const { types, primaryType, message, domain } = json;
  if (primaryType !== "PermitWitnessTransferFrom") {
    return undefined;
  }
  const witnessField = types[primaryType]?.at(-1);
  const witnessType = witnessField?.name === "witness" ? witnessField.type : undefined;
  if (witnessType === undefined || !isWitnessType(witnessType)) {
    return undefined;
  }
  const expected: Record<string, ReadonlyArray<string>> = {
    ...PERMIT2_TYPES,
    PermitWitnessTransferFrom: [
      "TokenPermissions permitted",
      "address spender",
      "uint256 nonce",
      "uint256 deadline",
      `${witnessType} witness`,
    ],
    ...ORDER_TYPES[witnessType],
  };
  if (
    Object.keys(types).length !== Object.keys(expected).length ||
    !Object.entries(expected).every(([name, fields]) => sameFields(types, name, fields)) ||
    domainChainId(domain) !== chainId
  ) {
    return undefined;
  }
  const { permitted } = message;
  const { witness } = message;
  const spender = address(message, "spender");
  const permittedToken = isTypedDataMessage(permitted) ? address(permitted, "token") : undefined;
  const parsed = isTypedDataMessage(witness) ? parse(witnessType, witness) : undefined;
  if (
    spender === undefined ||
    permittedToken === undefined ||
    parsed === undefined ||
    parsed.inputToken.toLowerCase() !== permittedToken.toLowerCase()
  ) {
    return undefined;
  }
  const { info } = parsed;
  const reactor = address(info, "reactor");
  const swapper = address(info, "swapper");
  const nonce = uint(info, "nonce");
  const deadline = uint(info, "deadline");
  if (
    reactor === undefined ||
    reactor.toLowerCase() !== spender.toLowerCase() ||
    reactor.toLowerCase() !== REACTORS[chainId]?.[witnessType] ||
    swapper === undefined ||
    swapper.toLowerCase() !== signer.toLowerCase() ||
    nonce === undefined ||
    deadline === undefined ||
    deadline > BigInt(Number.MAX_SAFE_INTEGER) ||
    address(info, "additionalValidationContract") === undefined ||
    typedDataBytes(info["additionalValidationData"]) === undefined
  ) {
    return undefined;
  }
  if (parsed.outputs.length > ORDER_ITEMS) {
    return { kind: "oversize" };
  }
  const maker = checksumEvmAddress(signer);
  return {
    kind: "order",
    order: {
      protocol: "uniswapx",
      maker,
      give: orderAmount(parsed.inputToken, parsed.giveAmount, chainId, table),
      receive: parsed.outputs.map((o) => ({
        /* A zero recipient means the swapper keeps the output (UniswapX reactors settle it to the
           order's swapper). */
        recipient: o.recipient.toLowerCase() === ZERO ? maker : o.recipient,
        amount: orderAmount(o.token, o.amount, chainId, table),
      })),
      expiry: Number(deadline),
      partialFill: false,
      ...(parsed.exclusiveFiller === undefined ? {} : { exclusiveFiller: parsed.exclusiveFiller }),
    },
  };
};
