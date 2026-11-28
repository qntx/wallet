// oxlint-disable vitest/no-conditional-in-test -- mutation tables deliberately exercise guard branches
// oxlint-disable typescript/require-await -- protocol exchange fakes answer synchronously
/**
 * ERC-20 clear-signing descriptor binding and the Ledger driver path it opens. The committed CAL
 * payloads are real production descriptors: their signatures are verified here against the key
 * compiled into the pinned app, while every mutation must be dropped before any APDU is sent.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vite-plus/test";

import type { KeyPath, TaskKey } from "@qntx/wallet-chains";
import { parseTypedData, planEvm, typedDataSchemaHash } from "@qntx/wallet-chains/evm";
import type {
  ChainSignRequest,
  ChainTemplate,
  LedgerDescriptors,
  LedgerTypedDataFilters,
} from "@qntx/wallet/protocol";

import type { HardwarePin, SignContext } from "../src/modules/signers/driver.ts";
import { bindLedger, parseTokenDescriptor } from "../src/modules/signers/ledger/clear.ts";
import { LEDGER_DRIVER } from "../src/modules/signers/ledger/driver.ts";
import { LedgerError } from "../src/modules/signers/ledger/protocol/errors.ts";
import {
  ethProvideTokenInformation,
  ethSignTypedData,
} from "../src/modules/signers/ledger/protocol/ethereum.ts";
import { nodeAt } from "./signers-fake.ts";
import {
  hex,
  ok,
  publicKeyAt,
  scriptedLedger,
  SEED,
  unhex,
  vectorCase,
} from "./signers-ledger-fake.ts";

const H = 0x80_00_00_00;
const ACCOUNT_44: KeyPath = [H + 44, H, H];
const ETH_PATH: KeyPath = [H + 44, H + 60, H, 0, 0];
const EVM_KEY: TaskKey = { path: ETH_PATH, publicKey: publicKeyAt(ETH_PATH) };
const FINGERPRINT = unhex(vectorCase("bitcoin", "fingerprint").result as string);
const pin: HardwarePin = {
  fingerprint: FINGERPRINT,
  nodes: [nodeAt(SEED, ACCOUNT_44)],
  ed25519: [],
};

type TokenRow = { readonly chainId: number; readonly address: string; readonly descriptor: string };
const tokenRows = ((): ReadonlyArray<TokenRow> => {
  const parsed: unknown = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../vectors/ledger/cal/tokens.json", import.meta.url)),
      "utf8",
    ),
  );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("tokens" in parsed) ||
    !Array.isArray(parsed.tokens)
  ) {
    throw new Error("CAL token vector has no tokens");
  }
  return parsed.tokens as ReadonlyArray<TokenRow>;
})();

const token = (chainId: number, address: string): Uint8Array => {
  const row = tokenRows.find((t) => t.chainId === chainId && t.address === address.toLowerCase());
  if (row === undefined) {
    throw new Error("missing CAL token row");
  }
  return unhex(row.descriptor);
};

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const usdc = token(1, USDC);
const usdt = token(1, USDT);

const PRODUCTION_KEY = unhex(
  "045e6c1020c14dc46442fe89f97c0b68cdb15976dc24f24c316e7b30fe4e8cc76b1489150c21514ebf440ff5dea5393d83de5358cd098fce8fd0f81daa94979183",
);

const word = (hexTail: string): string => hexTail.padStart(64, "0");
const TRANSFER_DATA = `0xa9059cbb${word("00000000000000000000000000000000deadbeef")}${word("12d687")}`;
const APPROVE_DATA = `0x095ea7b3${word("00000000000000000000000000000000deadbeef")}${"f".repeat(64)}`;

const hd = (template: ChainTemplate) => ({
  kind: "hd" as const,
  walletId: "w",
  groupIndex: 0,
  template,
});

const evmTxRequest = (
  data = TRANSFER_DATA,
  to: string | null = USDC,
  value = "0x0",
  network = "eip155:1",
  type: "legacy" | "eip1559" | "eip7702" = "eip1559",
): Extract<ChainSignRequest, { kind: "evm.transaction" }> => {
  const base = {
    chainId: 1,
    nonce: 0,
    gas: "0x5208",
    value,
    data,
    ...(to === null ? {} : { to }),
  };
  const tx =
    type === "legacy"
      ? { ...base, type, gasPrice: "0x77359400" }
      : type === "eip1559"
        ? {
            ...base,
            type,
            maxFeePerGas: "0x77359400",
            maxPriorityFeePerGas: "0x3b9aca00",
            accessList: [],
          }
        : {
            ...base,
            type,
            to: to ?? USDC,
            maxFeePerGas: "0x77359400",
            maxPriorityFeePerGas: "0x3b9aca00",
            accessList: [],
            authorization: { address: USDC },
          };
  return { kind: "evm.transaction", network, account: hd("evm.bip44"), tx };
};

const USDC_ONLY: LedgerDescriptors = { tokens: [usdc] };

const boundCase = (request = evmTxRequest(), descriptors: LedgerDescriptors | null = USDC_ONLY) =>
  bindLedger(request, planEvm(request, EVM_KEY), descriptors ?? undefined);

const mutated = (payload: Uint8Array, offset: number, value: number): Uint8Array => {
  const out = Uint8Array.from(payload);
  out[offset] = value;
  return out;
};

const planAndContext = (
  request: Extract<ChainSignRequest, { kind: "evm.transaction" }>,
  descriptors: LedgerDescriptors | undefined,
  displayOverride?: "clear" | "blind",
): SignContext => {
  const stage = planEvm(request, EVM_KEY);
  const shown = LEDGER_DRIVER.display(request, stage, pin, descriptors);
  return {
    request,
    stage,
    pin,
    display: displayOverride ?? (shown === "unsupported" ? "blind" : shown),
    random: (length) => new Uint8Array(length).fill(0x42),
    ...(descriptors === undefined ? {} : { descriptors }),
  };
};

const code = async (job: () => Promise<unknown>): Promise<string> => {
  try {
    await job();
  } catch (error) {
    if (error instanceof LedgerError) {
      return error.code;
    }
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected the call to fail");
};

describe("CAL token vectors", () => {
  it("every committed production signature verifies against the pinned app key", () => {
    expect(tokenRows.length).toBeGreaterThanOrEqual(3);
    for (const row of tokenRows) {
      const payload = unhex(row.descriptor);
      const parsed = parseTokenDescriptor(payload);
      expect(parsed).toBeDefined();
      const fixed = 1 + (payload[0] ?? 0) + 20 + 4 + 4;
      const signed = payload.subarray(1, fixed);
      const signature = secp256k1.Signature.fromBytes(payload.subarray(fixed), "der");
      expect(
        secp256k1.verify(signature.toBytes(), sha256(signed), PRODUCTION_KEY, {
          prehash: false,
          lowS: false,
        }),
      ).toBe(true);
    }
  });
});

describe("parseTokenDescriptor", () => {
  it("parses the real USDC descriptor", () => {
    expect(parseTokenDescriptor(usdc)).toStrictEqual({
      ticker: "USDC",
      address: USDC.slice(2),
      decimals: 6,
      chainId: 1,
    });
  });

  it("rejects every form guard mutation", () => {
    const n = usdc[0] ?? 0;
    const decimalsAt = 1 + n + 20;
    const chainAt = decimalsAt + 4;
    const sigAt = chainAt + 4;
    expect(parseTokenDescriptor(mutated(usdc, 0, 0))).toBeUndefined();
    expect(parseTokenDescriptor(mutated(usdc, 0, 51))).toBeUndefined();
    expect(parseTokenDescriptor(mutated(usdc, 1, 0x7f))).toBeUndefined();
    expect(parseTokenDescriptor(mutated(usdc, 1, 0x1f))).toBeUndefined();
    expect(parseTokenDescriptor(mutated(usdc, decimalsAt, 1))).toBeUndefined(); // 256+
    expect(parseTokenDescriptor(mutated(usdc, chainAt, 0xff))).toBeDefined(); // chain form is u32
    expect(parseTokenDescriptor(mutated(usdc, sigAt, 0x31))).toBeUndefined();
    expect(parseTokenDescriptor(new Uint8Array([...usdc, 0]))).toBeUndefined();
    expect(parseTokenDescriptor(usdc.subarray(0, sigAt))).toBeUndefined();
  });
});

describe("bindLedger", () => {
  it("binds exactly one USDC payload to transfer and approve calldata", () => {
    expect(boundCase()?.tokens).toStrictEqual([usdc]);
    expect(boundCase(evmTxRequest(APPROVE_DATA))?.tokens).toStrictEqual([usdc]);
  });

  it("drops non-binding descriptors instead of failing", () => {
    expect(boundCase(evmTxRequest(), { tokens: [usdt] })).toBeUndefined();
    const wrongChain = mutated(usdc, 1 + 4 + 20 + 4 + 3, 2);
    expect(boundCase(evmTxRequest(), { tokens: [wrongChain] })).toBeUndefined();
    const wrongAddress = mutated(usdc, 1 + 4, (usdc[1 + 4] ?? 0) ^ 1);
    expect(boundCase(evmTxRequest(), { tokens: [wrongAddress] })).toBeUndefined();
  });

  it("enforces the kernel table's ticker and decimals for a listed token", () => {
    const decimalsAt = 1 + 4 + 20;
    const badDecimals = mutated(usdc, decimalsAt + 3, 7);
    expect(boundCase(evmTxRequest(), { tokens: [badDecimals] })).toBeUndefined();
    const badTicker = mutated(usdc, 4, "X".codePointAt(0) ?? 0);
    expect(boundCase(evmTxRequest(), { tokens: [badTicker] })).toBeUndefined();
  });

  it("refuses duplicates for the same token", () => {
    expect(boundCase(evmTxRequest(), { tokens: [usdc, usdc] })).toBeUndefined();
  });

  it("binds an unlisted token on form, chain and address alone", () => {
    const foreign = Uint8Array.from(usdc);
    foreign.fill(0x42, 1 + 4, 1 + 4 + 20);
    foreign[1] = "Z".codePointAt(0) ?? 0;
    foreign[2] = "Z".codePointAt(0) ?? 0;
    foreign[3] = "Z".codePointAt(0) ?? 0;
    foreign[4] = "Z".codePointAt(0) ?? 0;
    const target = `0x${"42".repeat(20)}`;
    expect(
      boundCase(evmTxRequest(TRANSFER_DATA, target), { tokens: [foreign] })?.tokens,
    ).toStrictEqual([foreign]);
  });

  it("rejects every request-shape guard mutation", () => {
    expect(boundCase(evmTxRequest(TRANSFER_DATA, USDC, "0x1"))).toBeUndefined();
    expect(boundCase(evmTxRequest(`${TRANSFER_DATA}00`))).toBeUndefined();
    expect(boundCase(evmTxRequest(TRANSFER_DATA.slice(0, -2)))).toBeUndefined();
    expect(boundCase(evmTxRequest(`0xdeadbeef${TRANSFER_DATA.slice(10)}`))).toBeUndefined();
    expect(boundCase(evmTxRequest(TRANSFER_DATA, null))).toBeUndefined();
    expect(
      boundCase(evmTxRequest(TRANSFER_DATA, USDC, "0x0", "eip155:1", "eip7702")),
    ).toBeUndefined();
    expect(boundCase(evmTxRequest(TRANSFER_DATA, USDC, "0x0", "eip155:8453"))).toBeUndefined();
    expect(boundCase(evmTxRequest(), null)).toBeUndefined();
  });
});

describe("ledger clear-signing driver path", () => {
  const signatureStep = { response: ok(`00${"11".repeat(64)}`) };

  it("display is clear only when the descriptor binds", () => {
    const request = evmTxRequest();
    const stage = planEvm(request, EVM_KEY);
    expect(LEDGER_DRIVER.display(request, stage, pin, { tokens: [usdc] })).toBe("clear");
    expect(LEDGER_DRIVER.display(request, stage, pin, { tokens: [usdt] })).toBe("blind");
    expect(LEDGER_DRIVER.display(request, stage, pin, undefined)).toBe("blind");
  });

  it("sends PROVIDE TOKEN before SIGN and never reads the configuration when bound", async () => {
    const request = evmTxRequest();
    const context = planAndContext(request, { tokens: [usdc] });
    expect(context.display).toBe("clear");
    const fake = scriptedLedger("ethereum", [{ response: ok("00") }, signatureStep]);
    const [signature] = await LEDGER_DRIVER.sign(fake.link, context);
    expect(signature).toStrictEqual(unhex("11".repeat(64)));
    expect(fake.sent[1]?.startsWith("e00a0000")).toBe(true);
    expect(fake.sent[1]?.slice(10)).toBe(hex(usdc));
    expect(fake.sent[2]?.startsWith("e0040000")).toBe(true);
    expect(fake.sent.some((apdu) => apdu.startsWith("e0060000"))).toBe(false);
    fake.done();
  });

  it("keeps the configuration read and blind check when no descriptor binds", async () => {
    const request = evmTxRequest();
    const context = planAndContext(request, { tokens: [usdt] });
    expect(context.display).toBe("blind");
    const fake = scriptedLedger("ethereum", [{ response: ok("01011800") }, signatureStep]);
    await LEDGER_DRIVER.sign(fake.link, context);
    expect(fake.sent[1]?.startsWith("e0060000")).toBe(true);
    expect(fake.sent[2]?.startsWith("e0040000")).toBe(true);
    expect(fake.sent.some((apdu) => apdu.startsWith("e00a0000"))).toBe(false);
    fake.done();
  });

  it("fails integrity when the prompt was clear but the sign-stage binding vanished", async () => {
    const request = evmTxRequest();
    const context = planAndContext(request, undefined, "clear");
    const fake = scriptedLedger("ethereum", []);
    await expect(code(async () => LEDGER_DRIVER.sign(fake.link, context))).resolves.toBe(
      "integrity",
    );
    expect(fake.sent.some((apdu) => apdu.startsWith("e00a0000"))).toBe(false);
    fake.done();
  });

  it("a refused bound descriptor fails closed as unsupported before any SIGN APDU", async () => {
    const request = evmTxRequest();
    const context = planAndContext(request, { tokens: [usdc] });
    const fake = scriptedLedger("ethereum", [{ response: "6a80" }]);
    await expect(code(async () => LEDGER_DRIVER.sign(fake.link, context))).resolves.toBe(
      "unsupported",
    );
    expect(fake.sent[1]?.startsWith("e00a0000")).toBe(true);
    expect(fake.sent.some((apdu) => apdu.startsWith("e0040000"))).toBe(false);
    fake.done();
  });

  it("ethProvideTokenInformation requires exactly one reply byte", async () => {
    await expect(ethProvideTokenInformation(async () => unhex(ok("00")), usdc)).resolves.toBe(0);
    await expect(
      code(async () => ethProvideTokenInformation(async () => unhex(ok("0000")), usdc)),
    ).resolves.toBe("invalid-response");
  });
});

/* EIP-712 V1 filtering binding. Payload bytes are dummy forms — the kernel checks binding only;
   the device verifies the signatures. */
const OWNER = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x2222222222222222222222222222222222222222";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

const permitDoc = (contract = USDC, chainId = 1): string =>
  JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    domain: { name: "USD Coin", version: "2", chainId, verifyingContract: contract },
    message: {
      owner: OWNER,
      spender: SPENDER,
      value: "1000000",
      nonce: "0",
      deadline: "1700000000",
    },
  });

const permit2Doc = (): string =>
  JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
      ],
      PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
      ],
    },
    primaryType: "PermitSingle",
    domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2 },
    message: {
      details: { token: USDC, amount: "1000000", expiration: "1700000000", nonce: "0" },
      spender: SPENDER,
      sigDeadline: "1700000000",
    },
  });

const permitBatchDoc = (): string =>
  JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
      ],
      PermitBatch: [
        { name: "details", type: "PermitDetails[]" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
      ],
    },
    primaryType: "PermitBatch",
    domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2 },
    message: {
      details: [{ token: USDC, amount: "1000000", expiration: "1700000000", nonce: "0" }],
      spender: SPENDER,
      sigDeadline: "1700000000",
    },
  });

const filt = {
  raw: (name: string): Uint8Array =>
    Uint8Array.from([name.length, ...Array.from(name, (c) => c.codePointAt(0) ?? 0), 1, 0x30]),
  joinToken: (join: number): Uint8Array => Uint8Array.from([join, 1, 0x30]),
  joinValue: (join: number): Uint8Array => Uint8Array.from([1, 0x41, join, 1, 0x30]),
};

const info = (count: number): Uint8Array =>
  Uint8Array.from([4, 0x55, 0x53, 0x44, 0x43, count, 1, 0x30]);

type FilterSpec = {
  readonly path: string;
  readonly kind: 0xfc | 0xfd | 0xfe | 0xff;
  readonly data: Uint8Array;
};

const typedFilters = (
  doc: string,
  filters: ReadonlyArray<FilterSpec>,
  overrides: Record<string, unknown> = {},
): LedgerTypedDataFilters => {
  const parsed = JSON.parse(doc) as {
    types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  };
  return {
    chainId: 1,
    verifyingContract: USDC,
    schemaHash: typedDataSchemaHash(parsed.types),
    info: info(filters.length),
    filters,
    ...overrides,
  };
};

const PERMIT_RAW_FILTER: FilterSpec = { path: "spender", kind: 0xff, data: filt.raw("Spender") };
const PERMIT2_RAW_FILTER: FilterSpec = { path: "spender", kind: 0xff, data: filt.raw("Spender") };

const PERMIT_FILTERS: ReadonlyArray<FilterSpec> = [
  PERMIT_RAW_FILTER,
  { path: "value", kind: 0xfe, data: filt.joinValue(0xff) },
  { path: "deadline", kind: 0xfc, data: filt.raw("Deadline") },
];

const PERMIT2_FILTERS: ReadonlyArray<FilterSpec> = [
  PERMIT2_RAW_FILTER,
  { path: "details.token", kind: 0xfd, data: filt.joinToken(0) },
  { path: "details.amount", kind: 0xfe, data: filt.joinValue(0) },
  { path: "details.expiration", kind: 0xfc, data: filt.raw("Expiry") },
];

const typedRequest = (doc: string): Extract<ChainSignRequest, { kind: "evm.typed-data" }> => ({
  kind: "evm.typed-data",
  network: "eip155:1",
  account: hd("evm.bip44"),
  typedData: doc,
});

const boundTyped = (
  doc: string,
  filters: ReadonlyArray<FilterSpec>,
  overrides: Record<string, unknown> = {},
  tokens: ReadonlyArray<Uint8Array> = [usdc],
) => {
  const request = typedRequest(doc);
  const typedData = typedFilters(doc, filters, {
    verifyingContract: (JSON.parse(doc) as { domain: { verifyingContract: string } }).domain
      .verifyingContract,
    ...overrides,
  });
  return bindLedger(request, planEvm(request, EVM_KEY), { tokens, typedData });
};

describe("bindLedger typed-data filtering", () => {
  it("binds a Permit with join-value 0xff to the verifying contract token", () => {
    const bound = boundTyped(permitDoc(), PERMIT_FILTERS);
    expect(bound?.typedData).toBeDefined();
    expect(bound?.tokens).toHaveLength(1);
    expect(bound?.tokens.at(0)).toBe(usdc);
    const request = typedRequest(permitDoc());
    expect(
      LEDGER_DRIVER.display(request, planEvm(request, EVM_KEY), pin, {
        tokens: [usdc],
        typedData: typedFilters(permitDoc(), PERMIT_FILTERS),
      }),
    ).toBe("clear");
  });

  it("binds Permit2 join-token 0 through the message value at details.token", () => {
    const bound = boundTyped(permit2Doc(), PERMIT2_FILTERS);
    expect(bound?.typedData).toBeDefined();
    expect(bound?.tokens.at(0)).toBe(usdc);
  });

  it("binds a raw-only filter set with no token requirement", () => {
    const bound = boundTyped(permitDoc(), [PERMIT_RAW_FILTER], {}, []);
    expect(bound?.typedData).toBeDefined();
    expect(bound?.tokens).toHaveLength(0);
  });

  it("drops every claim mutation", () => {
    expect(boundTyped(permitDoc(), PERMIT_FILTERS, { chainId: 2 })).toBeUndefined();
    expect(boundTyped(permitDoc(), PERMIT_FILTERS, { verifyingContract: USDT })).toBeUndefined();
    expect(boundTyped(permitDoc(), PERMIT_FILTERS, { schemaHash: "0".repeat(56) })).toBeUndefined();
    expect(boundTyped(permitDoc(USDC, 2), PERMIT_FILTERS)).toBeUndefined();
  });

  it("drops an info count mismatch and an out-of-bounds count byte", () => {
    expect(boundTyped(permitDoc(), PERMIT_FILTERS, { info: info(4) })).toBeUndefined();
    expect(boundTyped(permitDoc(), PERMIT_FILTERS, { info: new Uint8Array(0) })).toBeUndefined();
    expect(
      boundTyped(permitDoc(), PERMIT_FILTERS, { info: Uint8Array.from([4, 1, 2, 3]) }),
    ).toBeUndefined();
  });

  it("drops duplicate paths, unknown paths, struct leaves and array paths", () => {
    const dupe = [...PERMIT_FILTERS, PERMIT_RAW_FILTER];
    expect(boundTyped(permitDoc(), dupe, { info: info(4) })).toBeUndefined();
    expect(
      boundTyped(permitDoc(), [{ path: "missing", kind: 0xff, data: filt.raw("x") }]),
    ).toBeUndefined();
    expect(
      boundTyped(permit2Doc(), [{ path: "details", kind: 0xff, data: filt.raw("x") }]),
    ).toBeUndefined();
    expect(
      boundTyped(permitBatchDoc(), [
        { path: "details.token", kind: 0xfd, data: filt.joinToken(0) },
      ]),
    ).toBeUndefined();
  });

  it("drops malformed joins and missing join targets", () => {
    const emptyJoinToken: FilterSpec = {
      path: "details.token",
      kind: 0xfd,
      data: new Uint8Array(0),
    };
    expect(boundTyped(permit2Doc(), [PERMIT2_RAW_FILTER, emptyJoinToken])).toBeUndefined();
    const truncatedValue: FilterSpec = { path: "value", kind: 0xfe, data: Uint8Array.from([1]) };
    expect(boundTyped(permitDoc(), [truncatedValue])).toBeUndefined();
    const dangling: FilterSpec = { path: "value", kind: 0xfe, data: filt.joinValue(7) };
    expect(boundTyped(permitDoc(), [dangling])).toBeUndefined();
    const batchAmount: FilterSpec = { path: "details.amount", kind: 0xfe, data: filt.joinValue(0) };
    expect(boundTyped(permit2Doc(), [batchAmount], {}, [])).toBeUndefined();
  });

  it("drops a join-token filter on a non-address leaf", () => {
    const bad: FilterSpec = { path: "details.amount", kind: 0xfd, data: filt.joinToken(0) };
    const amount: FilterSpec = { path: "details.amount", kind: 0xfe, data: filt.joinValue(0) };
    expect(boundTyped(permit2Doc(), [bad, amount])).toBeUndefined();
  });

  it("drops wrong-token and table-mismatched join token descriptors", () => {
    expect(boundTyped(permitDoc(), PERMIT_FILTERS, {}, [usdt])).toBeUndefined();
    const badDecimals = mutated(usdc, 1 + 4 + 20 + 3, 7);
    expect(boundTyped(permitDoc(), PERMIT_FILTERS, {}, [badDecimals])).toBeUndefined();
    expect(boundTyped(permitDoc(), PERMIT_FILTERS, {}, [])).toBeUndefined();
    expect(boundTyped(permitDoc(), PERMIT_FILTERS, {}, [usdc, usdc])).toBeUndefined();
  });

  it("does not bind without typedData descriptors and stays blind", () => {
    const request = typedRequest(permitDoc());
    expect(bindLedger(request, planEvm(request, EVM_KEY), { tokens: [usdc] })).toBeUndefined();
    expect(LEDGER_DRIVER.display(request, planEvm(request, EVM_KEY), pin, undefined)).toBe("blind");
  });
});

/* A reactive fake for typed-data filtering: token info answers one byte, SIGN answers the
   signature, everything else an empty 9000 — the scripted fake cannot know which step index a
   token lands on. */
const filteringFake = () => {
  const sent: string[] = [];
  const link = {
    exchange: async (request: {
      readonly kind: string;
      readonly data?: Uint8Array;
    }): Promise<{ readonly kind: "message"; readonly data: Uint8Array }> => {
      const apdu = hex(request.data ?? new Uint8Array(0));
      sent.push(apdu);
      if (apdu === "b001000000") {
        return { kind: "message", data: unhex(ok("0108457468657265756d06312e32342e3000")) };
      }
      if (apdu.startsWith("e006")) {
        return { kind: "message", data: unhex(ok("01011800")) };
      }
      if (apdu.startsWith("e00a")) {
        return { kind: "message", data: unhex(ok("00")) };
      }
      if (apdu.startsWith("e00c")) {
        return { kind: "message", data: unhex(ok(`00${"11".repeat(64)}`)) };
      }
      return { kind: "message", data: unhex(ok("")) };
    },
  };
  return { link: link as never, sent };
};

const typedContext = (
  doc: string,
  descriptors: LedgerDescriptors | undefined,
  displayOverride?: "clear" | "blind",
): SignContext => {
  const request = typedRequest(doc);
  const stage = planEvm(request, EVM_KEY);
  const shown = LEDGER_DRIVER.display(request, stage, pin, descriptors);
  return {
    request,
    stage,
    pin,
    display: displayOverride ?? (shown === "unsupported" ? "blind" : shown),
    random: (length) => new Uint8Array(length).fill(0x42),
    ...(descriptors === undefined ? {} : { descriptors }),
  };
};

const permitDescriptors = (
  doc = permitDoc(),
  filters: ReadonlyArray<FilterSpec> = PERMIT_FILTERS,
): LedgerDescriptors => {
  const parsed = JSON.parse(doc) as {
    types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
    domain: { verifyingContract: string };
  };
  return {
    tokens: [usdc],
    typedData: {
      chainId: 1,
      verifyingContract: parsed.domain.verifyingContract,
      schemaHash: typedDataSchemaHash(parsed.types),
      info: info(filters.length),
      filters,
    },
  };
};

describe("ledger typed-data filtering driver path", () => {
  it("Permit: activation, info, token before the value filter, no configuration read", async () => {
    const context = typedContext(permitDoc(), permitDescriptors());
    expect(context.display).toBe("clear");
    const fake = filteringFake();
    const [signature] = await LEDGER_DRIVER.sign(fake.link, context);
    expect(signature).toStrictEqual(unhex("11".repeat(64)));
    const at = (prefix: string): number => fake.sent.findIndex((apdu) => apdu.startsWith(prefix));
    expect(at("e01e0000")).toBeGreaterThan(-1);
    expect(at("e01e000f")).toBeGreaterThan(at("e01e0000"));
    const tokenAt = at("e00a0000");
    const valueFilterAt = at("e01e00fe");
    expect(tokenAt).toBeGreaterThan(at("e01e000f"));
    expect(valueFilterAt).toBe(tokenAt + 1);
    expect(fake.sent.some((apdu) => apdu.startsWith("e0060000"))).toBe(false);
    expect(at("e00c0001")).toBe(fake.sent.length - 1);
  });

  it("Permit2: token info immediately before details.token's join-token filter", async () => {
    const context = typedContext(permit2Doc(), permitDescriptors(permit2Doc(), PERMIT2_FILTERS));
    expect(context.display).toBe("clear");
    const fake = filteringFake();
    await LEDGER_DRIVER.sign(fake.link, context);
    const tokenAt = fake.sent.findIndex((apdu) => apdu.startsWith("e00a0000"));
    const joinTokenAt = fake.sent.findIndex((apdu) => apdu.startsWith("e01e00fd"));
    expect(joinTokenAt).toBe(tokenAt + 1);
    expect(fake.sent.filter((apdu) => apdu.startsWith("e00a0000"))).toHaveLength(1);
  });

  it("the stream carries no filtering APDU without descriptors", async () => {
    const context = typedContext(permitDoc(), undefined);
    expect(context.display).toBe("blind");
    const fake = filteringFake();
    await LEDGER_DRIVER.sign(fake.link, context);
    expect(fake.sent.some((apdu) => apdu.startsWith("e01e"))).toBe(false);
    expect(fake.sent.some((apdu) => apdu.startsWith("e00a"))).toBe(false);
    expect(fake.sent[1]?.startsWith("e0060000")).toBe(true);
  });

  it("fails integrity when the prompt was clear but the typed-data binding vanished", async () => {
    const context = typedContext(permitDoc(), undefined, "clear");
    const fake = filteringFake();
    await expect(code(async () => LEDGER_DRIVER.sign(fake.link, context))).resolves.toBe(
      "integrity",
    );
    expect(fake.sent.some((apdu) => apdu.startsWith("e01e"))).toBe(false);
  });

  it("a filter path the walk never reaches refuses before any app APDU", async () => {
    const request = typedRequest(permitDoc());
    const stage = planEvm(request, EVM_KEY);
    const descriptors = permitDescriptors();
    const { typedData } = descriptors;
    if (typedData === undefined) {
      throw new Error("missing typedData");
    }
    const broken: LedgerDescriptors = {
      tokens: [usdc],
      typedData: { ...typedData, filters: [{ path: "never", kind: 0xff, data: filt.raw("x") }] },
    };
    expect(bindLedger(request, stage, broken)).toBeUndefined();
  });

  it("ethSignTypedData refuses a binding whose filter the walk never places, before any APDU", async () => {
    const request = typedRequest(permitDoc());
    const { json } = parseTypedData(request.typedData);
    const descriptors = permitDescriptors();
    const { typedData } = descriptors;
    if (typedData === undefined) {
      throw new Error("missing typedData");
    }
    let apdus = 0;
    const counting = async (): Promise<Uint8Array> => {
      apdus += 1;
      return unhex(ok(""));
    };
    await expect(
      ethSignTypedData(counting, ETH_PATH, json, {
        tokens: [usdc],
        typedData: { ...typedData, filters: [{ path: "never", kind: 0xff, data: filt.raw("x") }] },
        joinTokens: [],
      }),
    ).rejects.toThrow("never impl'd");
    expect(apdus).toBe(0);
  });
});
