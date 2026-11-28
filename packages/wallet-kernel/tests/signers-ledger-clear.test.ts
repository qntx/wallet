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
import { planEvm } from "@qntx/wallet-chains/evm";
import type { ChainSignRequest, ChainTemplate, LedgerDescriptors } from "@qntx/wallet/protocol";

import type { HardwarePin, SignContext } from "../src/modules/signers/driver.ts";
import { bindLedger, parseTokenDescriptor } from "../src/modules/signers/ledger/clear.ts";
import { LEDGER_DRIVER } from "../src/modules/signers/ledger/driver.ts";
import { LedgerError } from "../src/modules/signers/ledger/protocol/errors.ts";
import { ethProvideTokenInformation } from "../src/modules/signers/ledger/protocol/ethereum.ts";
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
