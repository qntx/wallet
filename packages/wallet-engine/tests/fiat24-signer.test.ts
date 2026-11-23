// oxlint-disable vitest/no-conditional-in-test -- the differential oracle and the wait-for-either-opened-or-refused polls are inherently conditional
import { keccak256, parseTransaction, verifyMessage } from "viem";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vite-plus/test";

/**
 * The Fiat24 signer bridge against the real request pipeline and kernel: every SDK call builder
 * hands the bridge `{ chainId, from, to, data, value, nonce, intent }`, the engine rebuilds the
 * transaction with fresh fees at the pinned nonce, the kernel signs it, and the broadcast bytes —
 * parsed back — are the oracle the SDK call was built from. Refusal paths prove nothing crosses the
 * `signed` stage without the SDK's `signer-rejected` contract holding.
 */
import { arbitrum, Fiat24Error, isFiat24Error } from "@qntx/fiat24";
import type {
  Fiat24Call,
  Fiat24Intent,
  Fiat24SessionGrant,
  Fiat24TransactionRequest,
} from "@qntx/fiat24";
import { sessionLabel, sessionMessage } from "@qntx/fiat24/api";
import {
  approveCall,
  exchangeCall,
  mintAccountCall,
  mintAccountWithEthCall,
  payoutCall,
  payoutRefCall,
  topUpCall,
  transferCall,
  transferToAccountCall,
} from "@qntx/fiat24/calls";
import type { DisplayIntent } from "@qntx/wallet-chains";

import { createFiat24Signer } from "../src/apps/fiat24/signer.ts";
import type { Fiat24Refusal } from "../src/apps/fiat24/signer.ts";
import { REQUEST_TTL_MS } from "../src/requests/controller.ts";
import { RequestEndedError } from "../src/requests/types.ts";
import { arb1Error, until, world } from "./apps-helpers.ts";
import type { World } from "./apps-helpers.ts";

const OWNER = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" as Address;
const TOKEN_ID = 469709n;
const NONCE = 7;
const FIAT24 = { kind: "app" as const, id: "fiat24" };

const CASH_PROXY: Record<string, string> = {
  USD24: arbitrum.tokens.USD24.proxy,
  EUR24: arbitrum.tokens.EUR24.proxy,
  CHF24: arbitrum.tokens.CHF24.proxy,
  CNH24: arbitrum.tokens.CNH24.proxy,
};
const ASSET_ADDRESS: Record<string, string> = {
  ...CASH_PROXY,
  USDC: arbitrum.usdc,
  F24: arbitrum.f24.address,
};
const SPENDER_ADDRESS: Record<string, string> = {
  card: arbitrum.card.proxy,
  deposit: arbitrum.deposit.proxy,
  account: arbitrum.account.proxy,
};

const FEE_HISTORY = {
  baseFeePerGas: ["0x5f5e100", "0x5f5e100"],
  gasUsedRatio: [0.5],
  reward: [["0x1", "0x5f5e100", "0x3"]],
};

/** The arb1 answers a transaction build needs; `eth_call` fails so simulation stays unavailable. */
const arb1 =
  (raw: string[], nonce: number, sendError?: { code: number; message: string }) =>
  (body: { readonly method: string; readonly params?: unknown }): unknown => {
    switch (body.method) {
      case "eth_chainId":
        return "0xa4b1";
      case "eth_blockNumber":
        return "0x2a1b3c";
      case "eth_getTransactionCount":
        return `0x${nonce.toString(16)}`;
      case "eth_estimateGas":
        return "0x186a0";
      case "eth_feeHistory":
        return FEE_HISTORY;
      case "eth_gasPrice":
        return "0x5f5e100";
      case "eth_getBlockByNumber":
        return { number: "0x2a1b3c", baseFeePerGas: "0x5f5e100" };
      case "eth_getCode":
        return "0x6000";
      case "eth_getTransactionByHash":
      case "eth_getTransactionReceipt":
        return null;
      case "eth_call":
        throw new Error("simulation unavailable");
      case "eth_sendRawTransaction": {
        if (sendError !== undefined) {
          return arb1Error(sendError.code, sendError.message);
        }
        const [tx] = body.params as [Hex];
        raw.push(tx);
        return keccak256(tx);
      }
      default:
        throw new Error(`unexpected arb1 call ${body.method}`);
    }
  };

const signerWorld = async (
  options: { nonce?: number; tokenId?: bigint; sendError?: { code: number; message: string } } = {},
) => {
  const raw: string[] = [];
  const w = await world(0, { arb1: arb1(raw, options.nonce ?? NONCE, options.sendError) });
  const opened: string[] = [];
  const refused: Fiat24Refusal[] = [];
  const signer = createFiat24Signer({
    requests: {
      prepare: async (input) => w.requests.prepare(input, FIAT24),
      outcome: async (id) => w.requests.outcome(id),
    },
    group: w.group,
    owner: OWNER,
    ...(options.tokenId === undefined ? {} : { tokenId: options.tokenId }),
    opened: (id) => opened.push(id),
    refused: (reason) => refused.push(reason),
  });
  return { w, signer, opened, refused, raw };
};

const callRequest = (call: Fiat24Call, nonce = NONCE): Fiat24TransactionRequest => ({
  chainId: 42161,
  from: OWNER,
  to: call.to,
  data: call.data,
  value: call.value,
  nonce,
  intent: call.intent,
});

const expectSignerRejected = (error: unknown): void => {
  expect(isFiat24Error(error)).toBe(true);
  expect(error instanceof Fiat24Error ? error.code : undefined).toBe("signer-rejected");
};

/** The decoded display is the same transaction the SDK intent describes — field by field. */
const expectIntent = (display: DisplayIntent, intent: Fiat24Intent, call: Fiat24Call): void => {
  const [flow] = display.outflows;
  switch (intent.kind) {
    case "transfer":
      expect(display.outflows).toHaveLength(1);
      expect(flow?.amount).toMatchObject({
        asset: CASH_PROXY[intent.currency],
        amount: intent.amount.toString(10),
        symbol: intent.currency,
      });
      if ("address" in intent.to) {
        expect(flow?.to.toLowerCase()).toBe(intent.to.address.toLowerCase());
        expect(flow?.fiat24).toBeUndefined();
      } else {
        expect(flow?.fiat24).toStrictEqual({ account: intent.to.tokenId.toString(10) });
      }
      break;

    case "exchange":
      if (intent.side === "exact-in") {
        expect(display.fiat24).toMatchObject({
          kind: "exchange",
          side: "exact-in",
          receive: { asset: CASH_PROXY[intent.to], symbol: intent.to },
        });
        expect(flow?.to.toLowerCase()).toBe(arbitrum.deposit.proxy.toLowerCase());
        expect(flow?.amount).toMatchObject({
          asset: CASH_PROXY[intent.from],
          amount: intent.amount.toString(10),
          symbol: intent.from,
        });
      } else {
        expect(display.fiat24).toMatchObject({
          kind: "exchange",
          side: "exact-out",
          pay: { asset: CASH_PROXY[intent.from], symbol: intent.from },
          receive: {
            asset: CASH_PROXY[intent.to],
            symbol: intent.to,
            amount: intent.amount.toString(10),
          },
        });
        expect(display.outflows).toStrictEqual([]);
      }
      break;

    case "payout":
      expect(display.fiat24).toMatchObject({
        kind: "payout",
        contactId: intent.contactId,
        ...(intent.purposeId === undefined ? {} : { purposeId: intent.purposeId.toString(10) }),
        ...(intent.ref === undefined ? {} : { ref: intent.ref }),
      });
      expect(flow?.fiat24).toStrictEqual({ payee: intent.contactId });
      expect(flow?.amount).toMatchObject({
        asset: CASH_PROXY[intent.currency],
        amount: intent.amount.toString(10),
        symbol: intent.currency,
      });
      break;

    case "approve": {
      const [approval] = display.approvals;
      expect(approval?.kind).toBe("allowance");
      if (approval?.kind === "allowance") {
        expect(approval.amount).toMatchObject({
          asset: ASSET_ADDRESS[intent.asset],
          amount: intent.amount.toString(10),
        });
        expect(approval.spender.toLowerCase()).toBe(SPENDER_ADDRESS[intent.spender]?.toLowerCase());
        expect(approval.unlimited).toBe(false);
        expect(approval.fiat24Spender).toBe(
          intent.spender === "account" ? undefined : intent.spender,
        );
      }
      expect(display.outflows).toStrictEqual([]);
      break;
    }
    case "mint":
      expect(display.fiat24).toMatchObject({
        kind: "open-account",
        account: intent.tokenId.toString(10),
      });
      if (intent.payment === "f24") {
        expect(display.fiat24).toMatchObject({
          burn: { asset: arbitrum.f24.address, symbol: "F24" },
        });
        expect(display.outflows).toStrictEqual([]);
      } else {
        expect(flow?.amount).toMatchObject({ asset: "native", amount: call.value.toString(10) });
      }
      break;

    case "top-up":
      expect(display.fiat24).toMatchObject({
        kind: "top-up",
        receive: { asset: CASH_PROXY[intent.output], symbol: intent.output },
      });
      expect(flow?.to.toLowerCase()).toBe(arbitrum.deposit.proxy.toLowerCase());
      expect(flow?.amount).toMatchObject({
        asset: arbitrum.usdc,
        amount: intent.usdcAmount.toString(10),
      });
      break;
  }
};

const pendingRequests = (w: World) => Object.values(w.requests.getState().requests);

const PAYOUT_REF = `469709-50fb0941-4f59-4a89-8735-dd78ba7d53a3\0\0`;

const OTHER: Address = "0x00000000000000000000000000000000deadc0de";

const CASES: ReadonlyArray<readonly [string, () => Fiat24Call]> = [
  ["transferCall", () => transferCall({ currency: "EUR24", to: OTHER, amount: 1234n })],
  [
    "transferToAccountCall",
    () => transferToAccountCall({ currency: "CHF24", tokenId: 111_111n, amount: 500n }),
  ],
  [
    "exchangeCall exact-in",
    () => exchangeCall({ side: "exact-in", from: "USD24", to: "EUR24", amount: 1000n }),
  ],
  [
    "exchangeCall exact-out",
    () => exchangeCall({ side: "exact-out", from: "EUR24", to: "CHF24", amount: 2500n }),
  ],
  ["payoutCall", () => payoutCall({ currency: "EUR24", amount: 9900n, contactId: "ACME" })],
  [
    "payoutRefCall",
    () =>
      payoutRefCall({
        currency: "CHF24",
        amount: 5000n,
        contactId: "ACME-123",
        purposeId: 42n,
        ref: PAYOUT_REF,
        tokenId: TOKEN_ID,
      }),
  ],
  ["topUpCall", () => topUpCall({ output: "USD24", usdcAmount: 123_456n })],
  ["mintAccountCall", () => mintAccountCall({ tokenId: 333_444n })],
  [
    "mintAccountWithEthCall",
    () => mintAccountWithEthCall({ tokenId: 333_445n, value: 10n ** 15n }),
  ],
  ...(
    [
      ["USD24", "card", 500n],
      ["USD24", "deposit", 0n],
      ["EUR24", "card", 100n],
      ["EUR24", "deposit", 1n],
      ["CHF24", "card", 42n],
      ["CHF24", "deposit", 0n],
      ["CNH24", "card", 77n],
      ["CNH24", "deposit", 9n],
      ["USDC", "deposit", 999_999n],
      ["F24", "account", 1n],
    ] as const
  ).map(
    ([asset, spender, amount]) =>
      [
        `approveCall ${asset}→${spender}${amount === 0n ? " (revoke)" : ""}`,
        () => approveCall({ asset, spender, amount }),
      ] as const,
  ),
];

describe("fiat24 signer — differential over every SDK call builder", () => {
  it.each(CASES)(
    "%s opens one app request, decodes like its intent and broadcasts its bytes",
    async (_name, build) => {
      const call = build();
      const { w, signer, opened, refused, raw } = await signerWorld({ tokenId: TOKEN_ID });
      const pending = signer.sendTransaction(callRequest(call));
      await until(() => opened.length === 1 || refused.length > 0, 2000);
      const open = pendingRequests(w);
      expect(open).toHaveLength(1);
      const [request] = open;
      expect(request?.origin).toStrictEqual(FIAT24);
      expect(request?.method).toBe("evm-sign");
      expectIntent(request?.display as DisplayIntent, call.intent, call);
      await w.approve(request?.id ?? "");
      const hash = await pending;
      expect(refused).toStrictEqual([]);
      expect(raw).toHaveLength(1);
      const tx = parseTransaction(raw[0] as Hex);
      expect(tx.to?.toLowerCase()).toBe(call.to.toLowerCase());
      expect(tx.data?.toLowerCase()).toBe(call.data.toLowerCase());
      expect(tx.value ?? 0n).toBe(call.value);
      expect(tx.nonce).toBe(NONCE);
      expect(tx.chainId).toBe(42161);
      expect(keccak256(raw[0] as Hex)).toBe(hash);
      await w.destroy();
    },
  );
});

describe("fiat24 signer — refusals", () => {
  it("a nonce the engine cannot honour conflicts before any request exists", async () => {
    const call = transferCall({ currency: "EUR24", to: OTHER, amount: 100n });
    const { w, signer, opened, refused } = await signerWorld({ nonce: 0, tokenId: TOKEN_ID });
    const error = await signer
      .sendTransaction(callRequest(call, 5))
      .catch((error_: unknown) => error_);
    expectSignerRejected(error);
    expect(refused).toStrictEqual(["nonce-conflict"]);
    expect(opened).toStrictEqual([]);
    expect(pendingRequests(w)).toStrictEqual([]);
    await w.destroy();
  });

  it("a nonce held by an in-flight transaction conflicts before any request exists", async () => {
    const call = transferCall({ currency: "EUR24", to: OTHER, amount: 100n });
    const { w, signer, opened, refused } = await signerWorld({ nonce: 0, tokenId: TOKEN_ID });
    const first = signer.sendTransaction(callRequest(call, 0));
    await until(() => opened.length === 1 || refused.length > 0, 2000);
    await w.approve(opened[0] ?? "");
    await first;
    /* The broadcast row holds nonce 0 — the SDK asking for it again must refuse, not prompt. */
    const error = await signer
      .sendTransaction(callRequest(call, 0))
      .catch((error_: unknown) => error_);
    expectSignerRejected(error);
    expect(refused).toStrictEqual(["nonce-conflict"]);
    await w.destroy();
  });

  it("a rejected approval maps to `rejected` and `signer-rejected`", async () => {
    const call = transferCall({ currency: "EUR24", to: OTHER, amount: 100n });
    const { w, signer, opened, refused } = await signerWorld({ tokenId: TOKEN_ID });
    const pending = signer.sendTransaction(callRequest(call));
    await until(() => opened.length === 1 || refused.length > 0, 2000);
    w.requests.reject(opened[0] ?? "");
    const error = await pending.catch((error_: unknown) => error_);
    expectSignerRejected(error);
    expect(refused).toStrictEqual(["rejected"]);
    await w.destroy();
  });

  it("an expired request maps to `expired` and `signer-rejected`", async () => {
    const call = transferCall({ currency: "EUR24", to: OTHER, amount: 100n });
    const { w, signer, opened, refused } = await signerWorld({ tokenId: TOKEN_ID });
    const pending = signer.sendTransaction(callRequest(call));
    await until(() => opened.length === 1 || refused.length > 0, 2000);
    w.timers.time += REQUEST_TTL_MS;
    w.timers.pump();
    const error = await pending.catch((error_: unknown) => error_);
    expectSignerRejected(error);
    expect(refused).toStrictEqual(["expired"]);
    await w.destroy();
  });

  it("a vault lock while awaiting approval maps to `invalidated` and `signer-rejected`", async () => {
    const call = transferCall({ currency: "EUR24", to: OTHER, amount: 100n });
    const { w, signer, opened, refused } = await signerWorld({ tokenId: TOKEN_ID });
    const pending = signer.sendTransaction(callRequest(call));
    await until(() => opened.length === 1 || refused.length > 0, 2000);
    w.requests.lock();
    const error = await pending.catch((error_: unknown) => error_);
    expectSignerRejected(error);
    expect(refused).toStrictEqual(["invalidated"]);
    await w.destroy();
  });

  it("a nonce that moves between prepare and approve still broadcasts the pinned nonce", async () => {
    const call = transferCall({ currency: "EUR24", to: OTHER, amount: 100n });
    let count = NONCE;
    const raw: string[] = [];
    const w = await world(0, {
      arb1: (body) =>
        body.method === "eth_getTransactionCount"
          ? `0x${count.toString(16)}`
          : arb1(raw, count)(body),
    });
    const opened: string[] = [];
    const refused: Fiat24Refusal[] = [];
    const signer = createFiat24Signer({
      requests: {
        prepare: async (input) => w.requests.prepare(input, FIAT24),
        outcome: async (id) => w.requests.outcome(id),
      },
      group: w.group,
      owner: OWNER,
      tokenId: TOKEN_ID,
      opened: (id) => opened.push(id),
      refused: (reason) => refused.push(reason),
    });
    const pending = signer.sendTransaction(callRequest(call));
    void pending.catch(() => undefined);
    await until(() => opened.length === 1 || refused.length > 0, 2000);
    count = NONCE + 2;
    await w.approve(opened[0] ?? "");
    const hash = await pending;
    expect(refused).toStrictEqual([]);
    /* The pinned nonce was reserved at prepare: the request broadcasts it even though the
       pool's next free nonce has since moved — the SDK reconciles whatever lands. */
    expect(raw).toHaveLength(1);
    expect(parseTransaction(raw[0] as Hex).nonce).toBe(NONCE);
    expect(keccak256(raw[0] as Hex)).toBe(hash);
    await w.destroy();
  });

  it("a broadcast refused after `signed` is a non-rejection error, never `signer-rejected`", async () => {
    const call = transferCall({ currency: "EUR24", to: OTHER, amount: 100n });
    const { w, signer, opened, refused } = await signerWorld({
      tokenId: TOKEN_ID,
      sendError: { code: -32_003, message: "transaction rejected" },
    });
    const pending = signer.sendTransaction(callRequest(call));
    void pending.catch(() => undefined);
    await until(() => opened.length === 1 || refused.length > 0, 2000);
    /* The refusal rethrows through `approve` too — the bridge's contract is the outcome. */
    await w.approve(opened[0] ?? "").catch(() => undefined);
    const error = await pending.catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(Error);
    expect(isFiat24Error(error)).toBe(false);
    expect((error as Error).message).toBe("the request was signed but its outcome is unknown");
    expect(refused).toStrictEqual([]);
    await w.destroy();
  });

  it("a request that fails before signing maps to `failed-before-signing`", async () => {
    const call = transferCall({ currency: "EUR24", to: OTHER, amount: 100n });
    const { w, opened, refused } = await signerWorld({ tokenId: TOKEN_ID });
    const signer = createFiat24Signer({
      requests: {
        prepare: async (input) => w.requests.prepare(input, FIAT24),
        outcome: async () => Promise.reject(new RequestEndedError("failed", undefined, false)),
      },
      group: w.group,
      owner: OWNER,
      tokenId: TOKEN_ID,
      opened: (id) => opened.push(id),
      refused: (reason) => refused.push(reason),
    });
    const error = await signer
      .sendTransaction(callRequest(call))
      .catch((error_: unknown) => error_);
    expectSignerRejected(error);
    expect(opened).toHaveLength(1);
    expect(refused).toStrictEqual(["failed-before-signing"]);
    await w.destroy();
  });

  it.each<[string, (call: Fiat24Call) => Fiat24TransactionRequest]>([
    ["another chain", (call) => ({ ...callRequest(call), chainId: 1 as 42161 })],
    ["another sender", (call) => ({ ...callRequest(call), from: OTHER })],
    ["a contract outside the deployment", (call) => ({ ...callRequest(call), to: OTHER })],
    ["a negative nonce", (call) => ({ ...callRequest(call), nonce: -1 })],
    ["a fractional nonce", (call) => ({ ...callRequest(call), nonce: 1.5 })],
  ])("invalid-call: %s refuses without a request", async (_name, build) => {
    const call = transferCall({ currency: "EUR24", to: OTHER, amount: 100n });
    const { w, signer, opened, refused } = await signerWorld({ tokenId: TOKEN_ID });
    const error = await signer.sendTransaction(build(call)).catch((error_: unknown) => error_);
    expectSignerRejected(error);
    expect(refused).toStrictEqual(["invalid-call"]);
    expect(opened).toStrictEqual([]);
    expect(pendingRequests(w)).toStrictEqual([]);
    await w.destroy();
  });
});

const grant = (tokenId: bigint, deadline: bigint): Fiat24SessionGrant => {
  const args = { chainId: 42161 as const, tokenId, deadline };
  return { ...args, hash: sessionLabel(args), message: sessionMessage(args) };
};

describe("fiat24 signer — session grants", () => {
  it("the kernel signs a grant whose message recovers the owner", async () => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const { w, signer, opened, refused } = await signerWorld({ tokenId: TOKEN_ID });
    const sessionGrant = grant(TOKEN_ID, deadline);
    const pending = signer.signSessionGrant(sessionGrant);
    await until(() => opened.length === 1 || refused.length > 0, 2000);
    const [request] = pendingRequests(w);
    expect(request?.origin).toStrictEqual(FIAT24);
    expect(request?.method).toBe("evm-sign");
    expect(request?.display).toMatchObject({
      fiat24: {
        kind: "session-grant",
        account: TOKEN_ID.toString(10),
        deadline: Number(deadline),
      },
    });
    await w.approve(request?.id ?? "");
    const signature = await pending;
    expect(refused).toStrictEqual([]);
    await expect(
      verifyMessage({ address: OWNER, message: sessionGrant.message, signature }),
    ).resolves.toBe(true);
    await w.destroy();
  });

  it.each<[string, (deadline: bigint) => Fiat24SessionGrant]>([
    ["another chain", (deadline) => ({ ...grant(TOKEN_ID, deadline), chainId: 1 as 42161 })],
    ["another account", (deadline) => ({ ...grant(TOKEN_ID, deadline), tokenId: 42n })],
    [
      "a mismatched label",
      (deadline) => ({
        ...grant(TOKEN_ID, deadline),
        hash: sessionLabel({ chainId: 42161, tokenId: 42n, deadline }),
      }),
    ],
    [
      "a mismatched message",
      (deadline) => ({
        ...grant(TOKEN_ID, deadline),
        message: sessionMessage({ chainId: 42161, tokenId: TOKEN_ID, deadline: deadline + 1n }),
      }),
    ],
    [
      "a zero deadline",
      (deadline) => ({
        ...grant(TOKEN_ID, deadline),
        deadline: 0n,
      }),
    ],
    ["an unsafe deadline", () => grant(TOKEN_ID, BigInt(Number.MAX_SAFE_INTEGER) + 1n)],
  ])("invalid-call: %s refuses without a request", async (_name, build) => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const { w, signer, opened, refused } = await signerWorld({ tokenId: TOKEN_ID });
    const error = await signer.signSessionGrant(build(deadline)).catch((error_: unknown) => error_);
    expectSignerRejected(error);
    expect(refused).toStrictEqual(["invalid-call"]);
    expect(opened).toStrictEqual([]);
    expect(pendingRequests(w)).toStrictEqual([]);
    await w.destroy();
  });

  it("a signer bound to no account grants nothing", async () => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const { w, signer, opened, refused } = await signerWorld();
    const error = await signer
      .signSessionGrant(grant(TOKEN_ID, deadline))
      .catch((error_: unknown) => error_);
    expectSignerRejected(error);
    expect(refused).toStrictEqual(["invalid-call"]);
    expect(opened).toStrictEqual([]);
    await w.destroy();
  });

  it("a deadline past the kernel's twenty-minute window is refused", async () => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1300);
    const { w, signer, opened, refused } = await signerWorld({ tokenId: TOKEN_ID });
    const pending = signer.signSessionGrant(grant(TOKEN_ID, deadline));
    await until(() => opened.length === 1 || refused.length > 0, 2000);
    await w.approve(opened[0] ?? "").catch(() => undefined);
    const error = await pending.catch((error_: unknown) => error_);
    expect(isFiat24Error(error)).toBe(true);
    expect(error instanceof Fiat24Error ? error.code : undefined).toBe("signer-rejected");
    expect(refused).toStrictEqual(["rejected"]);
    await w.destroy();
  });
});
