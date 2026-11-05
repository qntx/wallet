import { describe, expect, it } from "vite-plus/test";

import type {
  DisplayIntent,
  SafeTransaction,
  SeaportOrder,
  SignInParse,
} from "@qntx/wallet-chains";

import {
  assessApprovals,
  assessBitcoinPsbts,
  assessPermits,
  assessRecipients,
  assessSafe,
  assessSeaport,
  assessSignIn,
  assessSimulation,
  comparable,
  impersonatesBuiltIn,
  mergeRisk,
  originRisk,
} from "../src/requests/risk.ts";

const KNOWN = "0x52908400098527886E0F7030069857D2E4169EE7";
const LOOKALIKE = "0x5290aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9EE7";
const OTHER = "0x1111111111111111111111111111111111112222";

describe("assessRecipients", () => {
  it("flags a recipient nobody has paid or saved", () => {
    expect(assessRecipients("evm", [OTHER], [KNOWN])).toStrictEqual([
      { code: "first-recipient", level: "warning" },
    ]);
  });

  it("is silent for a known address, in any case", () => {
    expect(assessRecipients("evm", [KNOWN], [KNOWN])).toStrictEqual([]);
    expect(assessRecipients("evm", [KNOWN.toLowerCase()], [KNOWN])).toStrictEqual([]);
    expect(assessRecipients("evm", [`0X${KNOWN.slice(2).toUpperCase()}`], [KNOWN])).toStrictEqual(
      [],
    );
  });

  it("flags a lookalike as poisoning, danger first, alongside first-recipient", () => {
    expect(assessRecipients("evm", [LOOKALIKE], [KNOWN])).toStrictEqual([
      { code: "address-poisoning", level: "danger" },
      { code: "first-recipient", level: "warning" },
    ]);
  });

  it("matches first and last four exactly", () => {
    const sameStartOnly = "0x5290aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000";
    const sameEndOnly = "0x0000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9EE7";
    expect(assessRecipients("evm", [sameStartOnly], [KNOWN]).map((f) => f.code)).toStrictEqual([
      "first-recipient",
    ]);
    expect(assessRecipients("evm", [sameEndOnly], [KNOWN]).map((f) => f.code)).toStrictEqual([
      "first-recipient",
    ]);
  });

  it("compares EVM lookalikes without the 0x prefix and case", () => {
    expect(comparable("evm", "0xAbC")).toBe("abc");
    expect(comparable("solana", "AbC")).toBe("AbC");
    const upper = LOOKALIKE.toUpperCase().replace("0X", "0x");
    expect(assessRecipients("evm", [upper], [KNOWN]).map((f) => f.code)).toContain(
      "address-poisoning",
    );
  });

  it("deduplicates across several recipients", () => {
    const found = assessRecipients("evm", [OTHER, LOOKALIKE, OTHER], [KNOWN]);
    expect(found.map((f) => f.code)).toStrictEqual(["address-poisoning", "first-recipient"]);
  });

  it("has nothing to say about no recipients", () => {
    expect(assessRecipients("evm", [], [KNOWN])).toStrictEqual([]);
  });
});

describe("originRisk and mergeRisk", () => {
  it("maps trusted to a danger, unchecked to a warning and the rest to nothing", () => {
    expect(originRisk("trusted")).toStrictEqual([{ code: "phishing-origin", level: "danger" }]);
    expect(originRisk("unchecked")).toStrictEqual([
      { code: "phishing-unchecked", level: "warning" },
    ]);
    expect(originRisk("clear")).toStrictEqual([]);
    expect(originRisk("blocked")).toStrictEqual([]);
  });

  it("merges findings deduplicated by code with danger first", () => {
    const merged = mergeRisk(
      [{ code: "first-recipient", level: "warning" }],
      [
        { code: "phishing-origin", level: "danger" },
        { code: "first-recipient", level: "warning" },
      ],
    );
    expect(merged).toStrictEqual([
      { code: "phishing-origin", level: "danger" },
      { code: "first-recipient", level: "warning" },
    ]);
  });
});

describe("assessSimulation", () => {
  const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const intent = (
    verifiability: "full" | "partial" | "opaque",
    outflows: Array<{ asset: string; amount: string }> = [],
  ) => ({
    verifiability,
    outflows: outflows.map((amount) => ({ to: "0xto", amount, verified: true })),
  });
  const change = (asset: string, amount: string) => ({
    status: "success" as const,
    changes: [{ asset, amount, verified: true }],
  });

  it("does nothing without a simulation", () => {
    expect(assessSimulation(intent("full"), undefined)).toStrictEqual({ checks: [], risk: [] });
  });

  it("turns unavailable into the simulation-unavailable check only", () => {
    expect(
      assessSimulation(intent("full"), { status: "unavailable", error: "timeout" }),
    ).toStrictEqual({ checks: ["simulation-unavailable"], risk: [] });
  });

  it("turns a revert into a danger", () => {
    expect(assessSimulation(intent("full"), { status: "reverted", error: "x" })).toStrictEqual({
      checks: [],
      risk: [{ code: "simulation-reverted", level: "danger" }],
    });
  });

  it("accepts an outflow equal to what the decode declares", () => {
    const declared = intent("full", [{ asset: "native", amount: "100" }]);
    expect(assessSimulation(declared, change("native", "-100")).risk).toStrictEqual([]);
    expect(assessSimulation(declared, change("native", "-99")).risk).toStrictEqual([]);
  });

  it("flags an outflow above the declared amount", () => {
    const declared = intent("full", [{ asset: "native", amount: "100" }]);
    expect(assessSimulation(declared, change("native", "-101")).risk).toStrictEqual([
      { code: "simulation-mismatch", level: "danger" },
    ]);
  });

  it("flags an outflow of an asset the decode does not declare", () => {
    expect(assessSimulation(intent("partial"), change(TOKEN, "-1")).risk).toStrictEqual([
      { code: "simulation-mismatch", level: "danger" },
    ]);
  });

  it("compares EVM token addresses case-insensitively and sums repeated flows", () => {
    const declared = intent("full", [
      { asset: TOKEN, amount: "40" },
      { asset: TOKEN.toLowerCase(), amount: "60" },
    ]);
    expect(assessSimulation(declared, change(TOKEN, "-100")).risk).toStrictEqual([]);
    expect(assessSimulation(declared, change(TOKEN, "-101")).risk).toHaveLength(1);
  });

  it("ignores inflows", () => {
    expect(assessSimulation(intent("full"), change(TOKEN, "500")).risk).toStrictEqual([]);
  });

  it("does not compare against an opaque decode", () => {
    expect(assessSimulation(intent("opaque"), change("native", "-1")).risk).toStrictEqual([]);
  });

  it("never compares Solana lamports", () => {
    expect(assessSimulation(intent("full"), change("lamports", "-5000")).risk).toStrictEqual([]);
  });
});

describe("impersonatesBuiltIn", () => {
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const OTHER_TOKEN = "0x1111111111111111111111111111111111111111";

  it("flags another address reporting a built-in symbol, in any case", () => {
    expect(impersonatesBuiltIn(1, OTHER_TOKEN, "USDC")).toBe(true);
    expect(impersonatesBuiltIn(1, OTHER_TOKEN, "usdt")).toBe(true);
  });

  it("does not flag the built-in token itself, an unrelated symbol or an unknown chain", () => {
    expect(impersonatesBuiltIn(1, USDC, "USDC")).toBe(false);
    expect(impersonatesBuiltIn(1, USDC.toLowerCase(), "USDC")).toBe(false);
    expect(impersonatesBuiltIn(1, OTHER_TOKEN, "DAI")).toBe(false);
    expect(impersonatesBuiltIn(999_999, OTHER_TOKEN, "USDC")).toBe(false);
  });

  it("only compares within the same chain", () => {
    expect(impersonatesBuiltIn(10, OTHER_TOKEN, "USDT")).toBe(false);
  });
});

describe("assessApprovals", () => {
  type Approvals = Parameters<typeof assessApprovals>[0]["approvals"];
  const allowance = (change: "set" | "increase" | "decrease", amount: string, unlimited: boolean) =>
    ({
      kind: "allowance",
      spender: OTHER,
      amount: { asset: KNOWN, amount },
      change,
      unlimited,
      verified: false,
    }) as const;
  const operator = (approved: boolean) =>
    ({ kind: "operator", asset: KNOWN, spender: OTHER, approved, verified: false }) as const;
  const assess = (...approvals: Array<Approvals[number]>) => assessApprovals({ approvals });

  it("a collection approval is a danger", () => {
    expect(assess(operator(true))).toStrictEqual([
      { code: "collection-approval", level: "danger" },
    ]);
  });

  it("an unlimited allowance is a warning, set or increase", () => {
    expect(assess(allowance("set", "1", true))).toStrictEqual([
      { code: "unlimited-approval", level: "warning" },
    ]);
    expect(assess(allowance("increase", "1", true))).toStrictEqual([
      { code: "unlimited-approval", level: "warning" },
    ]);
  });

  it("revocations and limited allowances raise nothing", () => {
    expect(assess(operator(false))).toStrictEqual([]);
    expect(assess(allowance("set", "0", false))).toStrictEqual([]);
    expect(assess(allowance("decrease", "5", false))).toStrictEqual([]);
    expect(assess(allowance("set", "1000", false))).toStrictEqual([]);
  });

  it("lists the danger first and deduplicates", () => {
    expect(
      assess(allowance("set", "1", true), allowance("set", "2", true), operator(true)),
    ).toStrictEqual([
      { code: "collection-approval", level: "danger" },
      { code: "unlimited-approval", level: "warning" },
    ]);
  });
});

describe("assessSignIn", () => {
  const SIGNER = "0xe5A12547fe4E872D192E3eCecb76F2Ce1aeA4946";
  const NOW = Date.parse("2026-06-01T00:00:00Z");
  const valid = (over: Record<string, unknown> = {}): SignInParse => ({
    status: "valid",
    fields: {
      domain: "app.example",
      address: SIGNER,
      uri: "https://app.example/login",
      version: "1",
      chainId: "1",
      nonce: "12341234",
      issuedAt: "2026-05-31T00:00:00.000Z",
      ...over,
    },
  });
  const assess = (signIn: SignInParse, origin = "https://app.example", signer = SIGNER) =>
    assessSignIn({ signIn, origin, signer, family: "evm", now: NOW });

  it("an exact match raises nothing", () => {
    expect(assess(valid())).toStrictEqual({ risk: [] });
  });

  it("a subdomain, another host or a plain-http page is refused in production", () => {
    expect(assess(valid({ domain: "evil.app.example" })).reject).toContain("evil.app.example");
    expect(assess(valid(), "https://evil.example").reject).toContain("app.example");
    expect(assess(valid(), "http://app.example").reject).toBeDefined();
  });

  it("a local development page with its own domain raises nothing", () => {
    expect(assess(valid({ domain: "localhost:3000" }), "http://localhost:3000")).toStrictEqual({
      risk: [],
    });
    expect(assess(valid({ domain: "[::1]:3000" }), "http://[::1]:3000")).toStrictEqual({
      risk: [],
    });
  });

  it("a local page with another domain is a danger", () => {
    expect(assess(valid({ domain: "app.example" }), "http://localhost:3000").risk).toContainEqual({
      code: "sign-in-domain-mismatch",
      level: "danger",
    });
  });

  it("a port mismatch is a warning", () => {
    expect(assess(valid({ domain: "localhost:3000" }), "http://localhost:4000")).toStrictEqual({
      risk: [{ code: "sign-in-port-mismatch", level: "warning" }],
    });
  });

  it("a malformed origin is refused", () => {
    expect(assess(valid(), "not an origin").reject).toBeDefined();
  });

  it("the address must be the signer; EVM compares case-insensitively", () => {
    expect(assess(valid(), "https://app.example", SIGNER.toLowerCase())).toStrictEqual({
      risk: [],
    });
    expect(assess(valid(), "https://app.example", `0x${"1".repeat(40)}`).risk).toStrictEqual([
      { code: "sign-in-address-mismatch", level: "danger" },
    ]);
    const solana = assessSignIn({
      signIn: valid({ address: "AbC" }),
      origin: "https://app.example",
      signer: "abc",
      family: "solana",
      now: NOW,
    });
    expect(solana.risk).toStrictEqual([{ code: "sign-in-address-mismatch", level: "danger" }]);
  });

  it("an expired or not-yet-valid window is a warning", () => {
    expect(assess(valid({ expirationTime: "2026-05-31T12:00:00.000Z" })).risk).toStrictEqual([
      { code: "sign-in-expired", level: "warning" },
    ]);
    expect(assess(valid({ notBefore: "2026-06-02T00:00:00.000Z" })).risk).toStrictEqual([
      { code: "sign-in-not-yet-valid", level: "warning" },
    ]);
    expect(assess(valid({ expirationTime: "2026-07-01T00:00:00.000Z" })).risk).toStrictEqual([]);
  });

  it("a malformed sign-in text is a warning", () => {
    expect(assess({ status: "malformed" })).toStrictEqual({
      risk: [{ code: "sign-in-malformed", level: "warning" }],
    });
  });
});

describe("assessPermits", () => {
  const NOW = Date.parse("2026-06-01T00:00:00Z");
  const DAY = 86_400;
  const nowSeconds = NOW / 1000;
  type Intent = Parameters<typeof assessPermits>[0];
  const allowance = (over: Record<string, unknown> = {}) =>
    ({
      kind: "allowance",
      spender: OTHER,
      amount: { asset: KNOWN, amount: "1000" },
      change: "set",
      unlimited: false,
      verified: false,
      ...over,
    }) as Intent["approvals"][number];
  const assess = (...approvals: Array<Intent["approvals"][number]>) =>
    assessPermits({ approvals }, NOW);

  it("a limited allowance is a warning", () => {
    expect(assess(allowance())).toStrictEqual([{ code: "permit-approval", level: "warning" }]);
  });

  it("a revocation raises nothing", () => {
    expect(assess(allowance({ amount: { asset: KNOWN, amount: "0" } }))).toStrictEqual([]);
  });

  it("an unlimited allowance is a danger ahead of the warning", () => {
    expect(assess(allowance({ unlimited: true }))).toStrictEqual([
      { code: "permit-unlimited", level: "danger" },
      { code: "permit-approval", level: "warning" },
    ]);
  });

  it("a Permit2 allowance beyond 30 days is a danger; a shorter one is a warning only", () => {
    const long = allowance({ via: "permit2", expiration: nowSeconds + 31 * DAY });
    expect(assess(long)).toStrictEqual([
      { code: "permit-long-lived", level: "danger" },
      { code: "permit-approval", level: "warning" },
    ]);
    const short = allowance({ via: "permit2", expiration: nowSeconds + 29 * DAY });
    expect(assess(short)).toStrictEqual([{ code: "permit-approval", level: "warning" }]);
  });

  it("a one-time transfer right is never long-lived", () => {
    const transfer = allowance({
      via: "permit2",
      change: "transfer",
      expiration: nowSeconds + 365 * DAY,
    });
    expect(assess(transfer)).toStrictEqual([{ code: "permit-approval", level: "warning" }]);
  });

  it("operator approvals are not permits", () => {
    expect(
      assess({ kind: "operator", asset: KNOWN, spender: OTHER, approved: true, verified: false }),
    ).toStrictEqual([]);
  });
});

const SIGNER = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const NFT = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";
const MULTISEND_141 = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";

const seaportOrder = (overrides: Partial<SeaportOrder> = {}): SeaportOrder => ({
  offerer: SIGNER,
  zone: "0x0000000000000000000000000000000000000000",
  startTime: 1,
  endTime: 2,
  offer: [
    {
      kind: "erc721",
      token: NFT,
      identifier: "1",
      startAmount: { asset: NFT, amount: "1" },
      endAmount: { asset: NFT, amount: "1" },
    },
  ],
  consideration: [],
  ...overrides,
});

const paidItem = (recipient: string, amount = "500"): SeaportOrder["consideration"][number] => ({
  kind: "erc20",
  token: KNOWN,
  identifier: "1",
  startAmount: { asset: KNOWN, amount },
  endAmount: { asset: KNOWN, amount },
  recipient,
});

const safeTx = (overrides: Partial<SafeTransaction> = {}): SafeTransaction => ({
  safe: "0xD5Ffe748B45F5253fc9975fDd96Fddec052E6D52",
  nonce: "7",
  operation: "call",
  to: KNOWN,
  value: "0",
  data: "0x",
  calls: [],
  ...overrides,
});

describe("assessSeaport", () => {
  it("a listing that pays the offerer nothing is a danger; one that pays is not", () => {
    expect(assessSeaport(seaportOrder(), SIGNER)).toStrictEqual([
      { code: "order-receives-nothing", level: "danger" },
    ]);
    expect(assessSeaport(seaportOrder({ consideration: [paidItem(OTHER)] }), SIGNER)).toStrictEqual(
      [{ code: "order-receives-nothing", level: "danger" }],
    );
    expect(
      assessSeaport(seaportOrder({ consideration: [paidItem(SIGNER, "0")] }), SIGNER),
    ).toStrictEqual([{ code: "order-receives-nothing", level: "danger" }]);
    expect(
      assessSeaport(seaportOrder({ consideration: [paidItem(SIGNER)] }), SIGNER),
    ).toStrictEqual([]);
    expect(assessSeaport(seaportOrder({ offer: [] }), SIGNER)).toStrictEqual([]);
    expect(assessSeaport(undefined, SIGNER)).toStrictEqual([]);
  });

  it("an offerer other than the signer is a warning; the same address any case is fine", () => {
    expect(assessSeaport(seaportOrder({ offerer: OTHER }), SIGNER)).toStrictEqual([
      { code: "order-receives-nothing", level: "danger" },
      { code: "order-offerer-mismatch", level: "warning" },
    ]);
    expect(assessSeaport(seaportOrder({ offerer: SIGNER.toLowerCase() }), SIGNER)).toStrictEqual([
      { code: "order-receives-nothing", level: "danger" },
    ]);
  });
});

describe("assessSafe", () => {
  it("flags a delegatecall outside canonical MultiSendCallOnly, but not into one", () => {
    expect(assessSafe(safeTx({ operation: "delegatecall", to: OTHER }))).toStrictEqual([
      { code: "safe-delegatecall", level: "danger" },
    ]);
    expect(assessSafe(safeTx({ operation: "delegatecall", to: MULTISEND_141 }))).toStrictEqual([]);
    expect(assessSafe(safeTx())).toStrictEqual([]);
    expect(assessSafe(undefined)).toStrictEqual([]);
  });

  it("warns on a gas refund and surfaces inner-call approvals", () => {
    expect(
      assessSafe(safeTx({ refund: { gasPrice: "5", gasToken: KNOWN, refundReceiver: OTHER } })),
    ).toStrictEqual([{ code: "safe-gas-refund", level: "warning" }]);

    const inner = {
      family: "evm",
      network: "eip155:1",
      summary: "approve",
      outflows: [],
      approvals: [
        {
          kind: "allowance",
          spender: OTHER,
          amount: { asset: KNOWN, amount: (2n ** 256n - 1n).toString(10) },
          change: "set",
          unlimited: true,
          verified: false,
        },
      ],
      fee: undefined,
      warnings: [],
      verifiability: "opaque",
    } as DisplayIntent;
    expect(assessSafe(safeTx({ calls: [inner] }))).toStrictEqual([
      { code: "unlimited-approval", level: "warning" },
    ]);
  });
});

describe("assessBitcoinPsbts", () => {
  const input = (value: number, sigHash: "ALL" | "SINGLE|ANYONECANPAY") => ({ value, sigHash });

  it("a SINGLE|ANYONECANPAY input is a danger", () => {
    expect(assessBitcoinPsbts([input(100_000, "SINGLE|ANYONECANPAY")])).toStrictEqual([
      { code: "bitcoin-sighash-single", level: "danger" },
    ]);
  });

  it("postage-size inputs: a warning as a listing, a danger otherwise", () => {
    expect(assessBitcoinPsbts([input(546, "SINGLE|ANYONECANPAY")])).toStrictEqual([
      { code: "bitcoin-sighash-single", level: "danger" },
      { code: "bitcoin-inscription-input", level: "warning" },
    ]);
    expect(assessBitcoinPsbts([input(330, "ALL")])).toStrictEqual([
      { code: "bitcoin-inscription-input", level: "danger" },
    ]);
    expect(
      assessBitcoinPsbts([input(546, "SINGLE|ANYONECANPAY"), input(330, "ALL")]).map(
        (f) => `${f.code}:${f.level}`,
      ),
    ).toStrictEqual(["bitcoin-sighash-single:danger", "bitcoin-inscription-input:danger"]);
  });

  it("ordinary inputs raise nothing", () => {
    expect(assessBitcoinPsbts([input(100_000, "ALL"), input(547, "ALL")])).toStrictEqual([]);
  });
});
