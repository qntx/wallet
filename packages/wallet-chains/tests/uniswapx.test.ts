import { SignTypedDataVersion, TypedDataUtils } from "@metamask/eth-sig-util";
import type { MessageTypes, TypedMessage } from "@metamask/eth-sig-util";
import { hashTypedData } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { EVM_NATIVE_ASSET } from "../src/evm/assets.ts";
import { PERMIT2_ADDRESS, decodeEvm } from "../src/evm/index.ts";
import type { EvmTokenTable } from "../src/evm/tokens.ts";

const SIGNER = "0x1111111111111111111111111111111111111111";
const ACCOUNT = { kind: "hd", walletId: "w", groupIndex: 0, template: "evm" } as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ATTACKER = "0x00000000000000000000000000000000DeaDBeef";
const ZERO = "0x0000000000000000000000000000000000000000";
const FILLER = "0x0000000000000000000000000000000000001234";
/* UniswapX README deployment addresses (eb7ce07), probed in vectors/chains/order-protocols.json. */
const V3_REACTOR_1 = "0x0000000015757c461808EA25Eb309638B62681cf";
const V2_REACTOR_1 = "0x00000011F84B9aa48e5f8aA8B9897600006289Be";
const EXCLUSIVE_REACTOR_1 = "0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4";
const V3_REACTOR_8453 = "0x000000008a8330B5d1F43A62Bf4C673A49f27ba0";
const PRIORITY_REACTOR_8453 = "0x000000001Ec5656dcdB24D90DFa42742738De729";
const table: EvmTokenTable = { "1": { [USDC]: { symbol: "USDC", decimals: 6 } } };

type Field = { name: string; type: string };
const fields = (spec: string): Field[] =>
  spec.split(",").map((part) => {
    const [type, name] = part.trim().split(" ");
    return { type: type ?? "", name: name ?? "" };
  });

const INFO =
  "address reactor,address swapper,uint256 nonce,uint256 deadline,address additionalValidationContract,bytes additionalValidationData";
const DUTCH_OUTPUT = "address token,uint256 startAmount,uint256 endAmount,address recipient";

/* The canonical type strings, verbatim from the UniswapX *OrderLib PERMIT2_ORDER_TYPE constants —
   the oracle the documents are checked against. */
const TYPE_STRINGS = {
  ExclusiveDutchOrder: `PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,ExclusiveDutchOrder witness)DutchOutput(${DUTCH_OUTPUT})ExclusiveDutchOrder(OrderInfo info,uint256 decayStartTime,uint256 decayEndTime,address exclusiveFiller,uint256 exclusivityOverrideBps,address inputToken,uint256 inputStartAmount,uint256 inputEndAmount,DutchOutput[] outputs)OrderInfo(${INFO})TokenPermissions(address token,uint256 amount)`,
  V2DutchOrder: `PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,V2DutchOrder witness)DutchOutput(${DUTCH_OUTPUT})OrderInfo(${INFO})TokenPermissions(address token,uint256 amount)V2DutchOrder(OrderInfo info,address cosigner,address baseInputToken,uint256 baseInputStartAmount,uint256 baseInputEndAmount,DutchOutput[] baseOutputs)`,
  V3DutchOrder: `PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,V3DutchOrder witness)NonlinearDutchDecay(uint256 relativeBlocks,int256[] relativeAmounts)OrderInfo(${INFO})TokenPermissions(address token,uint256 amount)V3DutchInput(address token,uint256 startAmount,NonlinearDutchDecay curve,uint256 maxAmount,uint256 adjustmentPerGweiBaseFee)V3DutchOrder(OrderInfo info,address cosigner,uint256 startingBaseFee,V3DutchInput baseInput,V3DutchOutput[] baseOutputs)V3DutchOutput(address token,uint256 startAmount,NonlinearDutchDecay curve,address recipient,uint256 minAmount,uint256 adjustmentPerGweiBaseFee)`,
  PriorityOrder: `PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,PriorityOrder witness)OrderInfo(${INFO})PriorityInput(address token,uint256 amount,uint256 mpsPerPriorityFeeWei)PriorityOrder(OrderInfo info,address cosigner,uint256 auctionStartBlock,uint256 baselinePriorityFeeWei,PriorityInput input,PriorityOutput[] outputs)PriorityOutput(address token,uint256 amount,uint256 mpsPerPriorityFeeWei,address recipient)TokenPermissions(address token,uint256 amount)`,
};

const orderTypes = (witnessType: keyof typeof TYPE_STRINGS): Record<string, Field[]> => {
  const own = {
    ExclusiveDutchOrder: {
      ExclusiveDutchOrder: fields(
        "OrderInfo info,uint256 decayStartTime,uint256 decayEndTime,address exclusiveFiller,uint256 exclusivityOverrideBps,address inputToken,uint256 inputStartAmount,uint256 inputEndAmount,DutchOutput[] outputs",
      ),
      DutchOutput: fields(DUTCH_OUTPUT),
    },
    V2DutchOrder: {
      V2DutchOrder: fields(
        "OrderInfo info,address cosigner,address baseInputToken,uint256 baseInputStartAmount,uint256 baseInputEndAmount,DutchOutput[] baseOutputs",
      ),
      DutchOutput: fields(DUTCH_OUTPUT),
    },
    V3DutchOrder: {
      V3DutchOrder: fields(
        "OrderInfo info,address cosigner,uint256 startingBaseFee,V3DutchInput baseInput,V3DutchOutput[] baseOutputs",
      ),
      V3DutchInput: fields(
        "address token,uint256 startAmount,NonlinearDutchDecay curve,uint256 maxAmount,uint256 adjustmentPerGweiBaseFee",
      ),
      V3DutchOutput: fields(
        "address token,uint256 startAmount,NonlinearDutchDecay curve,address recipient,uint256 minAmount,uint256 adjustmentPerGweiBaseFee",
      ),
      NonlinearDutchDecay: fields("uint256 relativeBlocks,int256[] relativeAmounts"),
    },
    PriorityOrder: {
      PriorityOrder: fields(
        "OrderInfo info,address cosigner,uint256 auctionStartBlock,uint256 baselinePriorityFeeWei,PriorityInput input,PriorityOutput[] outputs",
      ),
      PriorityInput: fields("address token,uint256 amount,uint256 mpsPerPriorityFeeWei"),
      PriorityOutput: fields(
        "address token,uint256 amount,uint256 mpsPerPriorityFeeWei,address recipient",
      ),
    },
  }[witnessType];
  return {
    EIP712Domain: fields("string name,uint256 chainId,address verifyingContract"),
    TokenPermissions: fields("address token,uint256 amount"),
    PermitWitnessTransferFrom: [
      ...fields("TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline"),
      { name: "witness", type: witnessType },
    ],
    OrderInfo: fields(INFO),
    ...own,
  };
};

const info = (reactor: string, overrides: Record<string, unknown> = {}) => ({
  reactor,
  swapper: SIGNER,
  nonce: "0",
  deadline: "2000000000",
  additionalValidationContract: ZERO,
  additionalValidationData: "0x",
  ...overrides,
});

const permitDoc = (
  witnessType: keyof typeof TYPE_STRINGS,
  witness: Record<string, unknown>,
  options: { spender?: string; chainId?: number; token?: string; amount?: string } = {},
) => {
  const chainId = options.chainId ?? 1;
  return {
    types: orderTypes(witnessType),
    primaryType: "PermitWitnessTransferFrom",
    domain: { name: "Permit2", chainId, verifyingContract: PERMIT2_ADDRESS },
    message: {
      /* Well above every test's input bound, so only the dedicated clamp case limits the give. */
      permitted: { token: options.token ?? WETH, amount: options.amount ?? "1000000000000000000" },
      spender: options.spender ?? V3_REACTOR_1,
      nonce: "0",
      deadline: "2000000000",
      witness,
    },
  };
};

const exclusiveWitness = (reactor: string, overrides: Record<string, unknown> = {}) => ({
  info: info(reactor),
  decayStartTime: "1900000000",
  decayEndTime: "2000000000",
  exclusiveFiller: FILLER,
  exclusivityOverrideBps: "0",
  inputToken: WETH,
  inputStartAmount: "1",
  inputEndAmount: "1",
  outputs: [{ token: USDC, startAmount: "1000000", endAmount: "500000", recipient: ATTACKER }],
  ...overrides,
});

const decodeOn = (network: string, doc: unknown) =>
  decodeEvm(
    { kind: "evm.typed-data", network, account: ACCOUNT, typedData: JSON.stringify(doc) },
    SIGNER,
    table,
  );
const decode = (doc: unknown) => decodeOn("eip155:1", doc);

const orderOf = (doc: unknown, network = "eip155:1") => {
  const { message } = decodeOn(network, doc);
  return message?.kind === "typed-data" ? message.order : undefined;
};
const fieldsOf = (doc: unknown) => {
  const { message } = decode(doc);
  return message?.kind === "typed-data" ? message.fields : undefined;
};

describe("decodeEvm: UniswapX Permit2 witness orders", () => {
  it.each(Object.keys(TYPE_STRINGS) as Array<keyof typeof TYPE_STRINGS>)(
    "the %s document encodes exactly the protocol type string",
    (witnessType) => {
      expect(
        TypedDataUtils.encodeType(
          "PermitWitnessTransferFrom",
          orderTypes(witnessType) as MessageTypes,
        ),
      ).toBe(TYPE_STRINGS[witnessType]);
    },
  );

  it("an ExclusiveDutchOrder paying an attacker recipient decodes as an order", () => {
    const doc = permitDoc("ExclusiveDutchOrder", exclusiveWitness(EXCLUSIVE_REACTOR_1), {
      spender: EXCLUSIVE_REACTOR_1,
    });
    const intent = decode(doc);
    expect(intent.blind).toBeUndefined();
    expect(intent.summary).toBe("swap");
    expect(intent.warnings).toStrictEqual([]);
    expect(intent.approvals).toHaveLength(1);
    expect(orderOf(doc)).toStrictEqual({
      protocol: "uniswapx",
      maker: SIGNER,
      give: { asset: WETH, amount: "1" },
      receive: [
        {
          recipient: ATTACKER,
          amount: { asset: USDC, amount: "500000", symbol: "USDC", decimals: 6 },
        },
      ],
      expiry: 2_000_000_000,
      partialFill: false,
      exclusiveFiller: FILLER,
    });
  });

  it("a rising ExclusiveDutchOrder input is bounded by its end amount", () => {
    const doc = permitDoc(
      "ExclusiveDutchOrder",
      exclusiveWitness(EXCLUSIVE_REACTOR_1, {
        inputStartAmount: "1",
        inputEndAmount: "5",
      }),
      { spender: EXCLUSIVE_REACTOR_1, token: WETH },
    );
    expect(orderOf(doc)?.give).toStrictEqual({ asset: WETH, amount: "5" });
  });

  it("a V2DutchOrder decodes against the mainnet reactor", () => {
    const doc = permitDoc(
      "V2DutchOrder",
      {
        info: info(V2_REACTOR_1),
        cosigner: ATTACKER,
        baseInputToken: WETH,
        baseInputStartAmount: "10",
        baseInputEndAmount: "20",
        baseOutputs: [
          { token: USDC, startAmount: "2000000", endAmount: "1000000", recipient: SIGNER },
        ],
      },
      { spender: V2_REACTOR_1 },
    );
    const order = orderOf(doc);
    expect(order?.protocol).toBe("uniswapx");
    expect(order?.give).toStrictEqual({ asset: WETH, amount: "20" });
    expect(order?.receive[0]?.amount.amount).toBe("1000000");
  });

  it("a V3DutchOrder is bounded by maxAmount in and minAmount out", () => {
    const curve = { relativeBlocks: "10", relativeAmounts: ["0", "-500000000000000000"] };
    const doc = permitDoc(
      "V3DutchOrder",
      {
        info: info(V3_REACTOR_1),
        cosigner: ATTACKER,
        startingBaseFee: "0",
        baseInput: {
          token: WETH,
          startAmount: "1",
          curve,
          maxAmount: "9",
          adjustmentPerGweiBaseFee: "0",
        },
        baseOutputs: [
          {
            token: ZERO,
            startAmount: "2000000",
            curve,
            recipient: SIGNER,
            minAmount: "1000000",
            adjustmentPerGweiBaseFee: "0",
          },
        ],
      },
      { spender: V3_REACTOR_1 },
    );
    const order = orderOf(doc);
    expect(order?.give).toStrictEqual({ asset: WETH, amount: "9" });
    expect(order?.receive[0]).toStrictEqual({
      recipient: SIGNER,
      amount: { asset: EVM_NATIVE_ASSET, amount: "1000000", decimals: 18, symbol: "ETH" },
    });
  });

  it("a PriorityOrder on Base is bounded by its amounts", () => {
    const doc = permitDoc(
      "PriorityOrder",
      {
        info: info(PRIORITY_REACTOR_8453),
        cosigner: ATTACKER,
        auctionStartBlock: "100",
        baselinePriorityFeeWei: "0",
        input: { token: WETH, amount: "7", mpsPerPriorityFeeWei: "0" },
        outputs: [
          { token: USDC, amount: "3000000", mpsPerPriorityFeeWei: "0", recipient: ATTACKER },
        ],
      },
      { spender: PRIORITY_REACTOR_8453, chainId: 8453 },
    );
    const order = orderOf(doc, "eip155:8453");
    expect(order?.give).toStrictEqual({ asset: WETH, amount: "7" });
    expect(order?.partialFill).toBe(false);
  });

  it("each canonical document hashes identically under two independent EIP-712 hashers", () => {
    const docs = [
      permitDoc("ExclusiveDutchOrder", exclusiveWitness(EXCLUSIVE_REACTOR_1), {
        spender: EXCLUSIVE_REACTOR_1,
      }),
    ];
    for (const doc of docs) {
      const reference = `0x${Buffer.from(
        TypedDataUtils.eip712Hash(
          doc as unknown as TypedMessage<MessageTypes>,
          SignTypedDataVersion.V4,
        ),
      ).toString("hex")}`;
      const ours = hashTypedData({
        domain: {
          ...doc.domain,
          verifyingContract: doc.domain.verifyingContract as `0x${string}`,
        },
        types: doc.types,
        primaryType: "PermitWitnessTransferFrom",
        message: doc.message,
      });
      expect(ours).toBe(reference);
    }
  });

  it.each([
    [
      "the reactor is not the Permit2 spender",
      (w: Record<string, unknown>) => ({
        ...w,
        info: info(V3_REACTOR_8453),
      }),
    ],
    [
      "the swapper is not the signer",
      (w: Record<string, unknown>) => ({
        ...w,
        info: info(V3_REACTOR_1, { swapper: ATTACKER }),
      }),
    ],
    [
      "the input token is not the permitted token",
      (w: Record<string, unknown>) => ({
        ...w,
        baseInput: {
          token: USDC,
          startAmount: "1",
          curve: { relativeBlocks: "1", relativeAmounts: ["0"] },
          maxAmount: "9",
          adjustmentPerGweiBaseFee: "0",
        },
      }),
    ],
  ])("a V3 order where %s falls back to the warning", (_name, tweak) => {
    const curve = { relativeBlocks: "10", relativeAmounts: ["0"] };
    const doc = permitDoc(
      "V3DutchOrder",
      tweak({
        info: info(V3_REACTOR_1),
        cosigner: ATTACKER,
        startingBaseFee: "0",
        baseInput: {
          token: WETH,
          startAmount: "1",
          curve,
          maxAmount: "9",
          adjustmentPerGweiBaseFee: "0",
        },
        baseOutputs: [
          {
            token: USDC,
            startAmount: "2000000",
            curve,
            recipient: SIGNER,
            minAmount: "1000000",
            adjustmentPerGweiBaseFee: "0",
          },
        ],
      }),
      { spender: V3_REACTOR_1 },
    );
    const intent = decode(doc);
    expect(orderOf(doc)).toBeUndefined();
    expect(intent.warnings).toStrictEqual([
      { kind: "permit2-witness", message: "the permit carries a witness with further terms" },
    ]);
  });

  it("a V3 reactor from another chain is not recognised", () => {
    const curve = { relativeBlocks: "10", relativeAmounts: ["0"] };
    const doc = permitDoc(
      "V3DutchOrder",
      {
        info: info(V3_REACTOR_8453),
        cosigner: ATTACKER,
        startingBaseFee: "0",
        baseInput: {
          token: WETH,
          startAmount: "1",
          curve,
          maxAmount: "9",
          adjustmentPerGweiBaseFee: "0",
        },
        baseOutputs: [
          {
            token: USDC,
            startAmount: "2000000",
            curve,
            recipient: SIGNER,
            minAmount: "1000000",
            adjustmentPerGweiBaseFee: "0",
          },
        ],
      },
      { spender: V3_REACTOR_8453 },
    );
    expect(orderOf(doc)).toBeUndefined();
    expect(decode(doc).warnings).toHaveLength(1);
  });

  it("a witness subtree too large to show blinds as oversize, approvals and warning kept", () => {
    const doc = permitDoc("ExclusiveDutchOrder", exclusiveWitness(ATTACKER), { spender: ATTACKER });
    const intent = decode(doc);
    expect(intent.blind).toBe("typed-data-oversize");
    expect(intent.approvals).toHaveLength(1);
    expect(intent.warnings).toStrictEqual([
      { kind: "permit2-witness", message: "the permit carries a witness with further terms" },
    ]);
  });

  it("a small unrecognised witness shows its leaves under witness.* with the warning", () => {
    const doc = {
      types: {
        EIP712Domain: fields("string name,uint256 chainId,address verifyingContract"),
        TokenPermissions: fields("address token,uint256 amount"),
        PermitWitnessTransferFrom: [
          ...fields("TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline"),
          { name: "witness", type: "MockWitness" },
        ],
        MockWitness: fields("uint256 value,string note"),
      },
      primaryType: "PermitWitnessTransferFrom",
      domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2_ADDRESS },
      message: {
        permitted: { token: WETH, amount: "1" },
        spender: ATTACKER,
        nonce: "0",
        deadline: "2000000000",
        witness: { value: "5", note: "hello" },
      },
    };
    const intent = decode(doc);
    expect(intent.blind).toBeUndefined();
    expect(intent.approvals).toHaveLength(1);
    expect(intent.warnings).toHaveLength(1);
    expect(fieldsOf(doc)).toStrictEqual([
      { path: "witness.value", value: "5" },
      { path: "witness.note", value: "hello" },
    ]);
  });

  it("a commitment leaf inside an unrecognised witness blinds the permit", () => {
    const doc = {
      types: {
        EIP712Domain: fields("string name,uint256 chainId,address verifyingContract"),
        TokenPermissions: fields("address token,uint256 amount"),
        PermitWitnessTransferFrom: [
          ...fields("TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline"),
          { name: "witness", type: "MockWitness" },
        ],
        MockWitness: fields("uint256 value,bytes32 digest"),
      },
      primaryType: "PermitWitnessTransferFrom",
      domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2_ADDRESS },
      message: {
        permitted: { token: WETH, amount: "1" },
        spender: ATTACKER,
        nonce: "0",
        deadline: "2000000000",
        witness: { value: "5", digest: `0x${"42".repeat(32)}` },
      },
    };
    const intent = decode(doc);
    expect(intent.blind).toBe("typed-data-commitment");
    expect(intent.approvals).toHaveLength(1);
    expect(fieldsOf(doc)).toStrictEqual([
      { path: "witness.value", value: "5" },
      { path: "witness.digest", value: `0x${"42".repeat(32)}` },
    ]);
  });

  it("a real UniswapX order with an extra type in the document falls back", () => {
    const doc = permitDoc("ExclusiveDutchOrder", exclusiveWitness(EXCLUSIVE_REACTOR_1), {
      spender: EXCLUSIVE_REACTOR_1,
    });
    const withExtra = { ...doc, types: { ...doc.types, Extra: fields("uint256 a") } };
    expect(orderOf(withExtra)).toBeUndefined();
    expect(decode(withExtra).warnings).toHaveLength(1);
  });

  it("a zero output token is the native asset; the eeee… pseudo-address is an ordinary token", () => {
    const pseudo = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const doc = permitDoc(
      "ExclusiveDutchOrder",
      exclusiveWitness(EXCLUSIVE_REACTOR_1, {
        outputs: [
          { token: ZERO, startAmount: "2000000", endAmount: "1000000", recipient: SIGNER },
          { token: pseudo, startAmount: "3", endAmount: "2", recipient: SIGNER },
        ],
      }),
      { spender: EXCLUSIVE_REACTOR_1 },
    );
    const order = orderOf(doc);
    expect(order?.receive[0]?.amount).toStrictEqual({
      asset: EVM_NATIVE_ASSET,
      amount: "1000000",
      decimals: 18,
      symbol: "ETH",
    });
    expect(order?.receive[1]?.amount).toStrictEqual({
      asset: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      amount: "2",
    });
  });

  it("a zero input token is an ordinary token, not the native asset", () => {
    const doc = permitDoc(
      "ExclusiveDutchOrder",
      exclusiveWitness(EXCLUSIVE_REACTOR_1, { inputToken: ZERO }),
      { spender: EXCLUSIVE_REACTOR_1, token: ZERO },
    );
    expect(orderOf(doc)?.give).toStrictEqual({ asset: ZERO, amount: "1" });
  });

  it("a zero recipient is shown verbatim — no mapping to the swapper", () => {
    const doc = permitDoc(
      "ExclusiveDutchOrder",
      exclusiveWitness(EXCLUSIVE_REACTOR_1, {
        outputs: [{ token: USDC, startAmount: "2000000", endAmount: "1000000", recipient: ZERO }],
      }),
      { spender: EXCLUSIVE_REACTOR_1 },
    );
    expect(orderOf(doc)?.receive[0]?.recipient).toBe(ZERO);
  });

  it("the give line never claims more than the permit allows", () => {
    const doc = permitDoc(
      "ExclusiveDutchOrder",
      exclusiveWitness(EXCLUSIVE_REACTOR_1, {
        inputStartAmount: "1",
        inputEndAmount: "5",
      }),
      { spender: EXCLUSIVE_REACTOR_1, amount: "3" },
    );
    expect(orderOf(doc)?.give).toStrictEqual({ asset: WETH, amount: "3" });
  });

  it("an order with more outputs than the prompt lists is oversize-blind", () => {
    const outputs = Array.from({ length: 9 }, (_, i) => ({
      token: USDC,
      startAmount: `${1000000 + i}`,
      endAmount: `${500000 + i}`,
      recipient: SIGNER,
    }));
    const doc = permitDoc(
      "ExclusiveDutchOrder",
      exclusiveWitness(EXCLUSIVE_REACTOR_1, { outputs }),
      { spender: EXCLUSIVE_REACTOR_1 },
    );
    const intent = decode(doc);
    expect(intent.blind).toBe("typed-data-oversize");
    expect(orderOf(doc)).toBeUndefined();
  });
});
