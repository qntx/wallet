// oxlint-disable vitest/no-conditional-in-test -- waits-for-either polls and flow-step drives are conditional
// oxlint-disable vitest/no-conditional-expect -- narrowing asserts only run where the state permits them
// oxlint-disable eslint/no-await-in-loop -- stage loops and poll pumps are sequential by design
/**
 * The Fiat24 flows over the real request pipeline: the SDK advances real states against the
 * scripted Arbitrum chain (support/fiat24-chain.ts) and the recorded api fixtures
 * (support/fiat24-api.ts), signing and broadcasting through the node kernel. Persistence is
 * `encodeFlowState` bytes under `flow/<id>`, drafts never land, and reconcile only polls the
 * `sending`/`submitted`/`unknown` phases — everything that can send is host-driven.
 */
import { keccak256 } from "viem";
import type { Address } from "viem";
import { describe, expect, it } from "vite-plus/test";

import { arbitrum as deployment } from "@qntx/fiat24";
import { transferCall } from "@qntx/fiat24/calls";
import { decodeFlowState, encodeFlowState } from "@qntx/fiat24/flows";
import type { FlowState } from "@qntx/fiat24/flows";

import type { Fiat24FlowEntry } from "../src/apps/fiat24/index.ts";
import type { RequestController } from "../src/requests/controller.ts";
import type { World } from "./apps-helpers.ts";
import { tick, until, VERIFY, world } from "./apps-helpers.ts";
import { fixtureBody, makeFiat24ApiFetch } from "./support/fiat24-api.ts";
import {
  accountByIdEntries,
  accountEntries,
  allowanceEntries,
  approveLog,
  availabilityEntries,
  balanceEntries,
  B,
  cardTable,
  exchangeLog,
  exchangeTable,
  honestStorage,
  makeFiat24Chain,
  mergeCalls,
  receiptPayload,
  mintLog,
  onboardingTable,
  payoutLog,
  payoutTable,
  proxyAdminEntry,
  SENDER_ID,
  topUpLog,
  topUpTable,
  transferCallTable,
  transferLog,
  txPayload,
} from "./support/fiat24-chain.ts";
import type { Fiat24Chain } from "./support/fiat24-chain.ts";

/**
 * Poll a store read until it answers, bounded by wall time rather than a tick count: a reconcile
 * runs owner derivation, chain probes and a store write behind fire-and-forget hops whose tick
 * count grows with runner load.
 */
const untilStored = async <T>(
  read: () => Promise<T | undefined>,
  budgetMs = 20_000,
): Promise<T> => {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls.
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("read never produced a value");
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls.
    await tick();
  }
};

const OWNER = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" as Address;
const RECIPIENT = "0x00000000000000000000000000000000000bb0aa" as Address;
const NONCE = 5;

/** The reads `loadAccount` needs for a live, owned account. */
const liveTable = (owner: Address, rounds = 4) =>
  mergeCalls(
    proxyAdminEntry(),
    availabilityEntries({}),
    accountEntries(owner, { owner, historic: SENDER_ID, rounds }),
    balanceEntries(owner),
    allowanceEntries(owner),
  );

const openRequests = (w: World) => Object.values(w.requests.getState().requests);

const lastTx = (state: object) =>
  "txs" in state && Array.isArray(state.txs)
    ? (state.txs.at(-1) as { phase: string; hash?: string; purpose?: string })
    : undefined;

const storedFlow = async (w: World, id: string) => {
  const bytes = await w.store.collection("apps.fiat24").get(`${w.walletId}/0/flow/${id}`);
  return bytes;
};

const storedText = async (w: World, id: string) => {
  const bytes = await storedFlow(w, id);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
};

const setup = async (options: {
  calls?: Parameters<typeof makeFiat24Chain>[0]["calls"];
  count?: { pending: number; latest: number };
  autoBlock?: boolean;
  api?: boolean;
  apiRoutes?: Record<string, string>;
  enable?: boolean;
  receipts?: Record<string, Record<string, unknown>>;
  transactions?: Record<string, Record<string, unknown>>;
}) => {
  const api = makeFiat24ApiFetch({ routes: options.apiRoutes ?? {} });
  const chain = makeFiat24Chain({
    calls: options.calls,
    storage: honestStorage(),
    autoBlock: options.autoBlock,
    count: options.count ?? { pending: NONCE, latest: NONCE },
    receipts: options.receipts,
    transactions: options.transactions,
  });
  const w = await world(0, {
    fiat24: options.api === false ? true : { fetch: api.fetch },
    arb1: chain.arb1,
  });
  if (options.enable !== false) {
    await w.apps.acknowledgeTerms(w.group, "fiat24");
    await w.apps.enable(w.group, "fiat24");
    expect(w.f24State()?.status).toBe("enabled");
  }
  return { w, chain, api };
};

/** Approves the next request a signer opens; returns the broadcast hash count when it settles. */
const approveNext = async (w: World): Promise<void> => {
  await until(() => openRequests(w).length > 0, 5000);
  const [request] = openRequests(w);
  await w.approve(request?.id ?? "");
};

describe("fiat24 flows", () => {
  it("runs a transfer start → ready → submitted → confirmed with exactly one broadcast", async () => {
    const calls = transferCallTable({
      rounds: 8,
      sender: OWNER,
      recipient: RECIPIENT,
      amount: 100n,
    });
    for (const [key, entries] of liveTable(OWNER)) {
      calls.set(key, [...(calls.get(key) ?? []), ...entries]);
    }
    const { w, chain } = await setup({ calls });
    const started = await w.f24.flows.start(w.group, {
      flow: "transfer",
      currency: "EUR24",
      amount: 100n,
      to: { address: RECIPIENT },
    });
    expect(started.state.step).toBe("draft");

    const ready = await w.f24.flows.advance(w.group, started.id);
    expect(ready.state.step).toBe("ready");

    const sending = w.f24.flows.advance(w.group, started.id);
    await approveNext(w);
    const submitted = await sending;
    expect(submitted.state.step).toBe("tx");
    const record = lastTx(submitted.state);
    expect(record?.phase).toBe("submitted");
    expect(chain.sent).toHaveLength(1);

    const hash = keccak256(chain.sent[0]!);
    expect(record?.hash).toBe(hash);
    await chain.mine(hash, {
      logs: [
        transferLog({
          token: deployment.tokens.EUR24.proxy,
          from: OWNER,
          to: RECIPIENT,
          amount: 100n,
          blockNumber: chain.block,
          transactionHash: hash,
        }),
      ],
    });

    const confirmed = await w.f24.flows.advance(w.group, started.id);
    expect(confirmed.state.step).toBe("confirmed");
    expect(chain.sent).toHaveLength(1);

    const decoded = decodeFlowState((await storedText(w, started.id)) ?? "");
    expect(decoded.step).toBe("confirmed");
    const listed = await w.f24.flows.list(w.group);
    expect(listed.map((flow) => flow.id)).toContain(started.id);
    await w.destroy();
  }, 30_000);

  it("serialises concurrent advances — a second advance sees the first's persisted state", async () => {
    const calls = transferCallTable({
      rounds: 10,
      sender: OWNER,
      recipient: RECIPIENT,
      amount: 100n,
    });
    for (const [key, entries] of liveTable(OWNER)) {
      calls.set(key, [...(calls.get(key) ?? []), ...entries]);
    }
    const { w, chain } = await setup({ calls });
    const started = await w.f24.flows.start(w.group, {
      flow: "transfer",
      currency: "EUR24",
      amount: 100n,
      to: { address: RECIPIENT },
    });
    await w.f24.flows.advance(w.group, started.id);
    const first = w.f24.flows.advance(w.group, started.id);
    const second = w.f24.flows.advance(w.group, started.id);
    await approveNext(w);
    const [a, b] = await Promise.all([first, second]);
    expect(chain.sent).toHaveLength(1);
    expect(a.state.step).toBe("tx");
    expect(b.state.step).toBe("tx");
    await w.destroy();
  }, 30_000);

  it("refuses flow calls for a group that never enabled the app", async () => {
    const { w } = await setup({ enable: false });
    await expect(
      w.f24.flows.start(w.group, {
        flow: "transfer",
        currency: "EUR24",
        amount: 100n,
        to: { address: RECIPIENT },
      }),
    ).rejects.toMatchObject({ category: "not-enabled" });
    await expect(w.f24.flows.list(w.group)).rejects.toMatchObject({ category: "not-enabled" });
    await expect(w.f24.flows.advance(w.group, "deadbeef")).rejects.toMatchObject({
      category: "not-enabled",
    });
    await w.destroy();
  });

  it("refuses a payout or card flow while the group owns no live account", async () => {
    const calls = mergeCalls(
      proxyAdminEntry(),
      availabilityEntries({}),
      accountEntries(OWNER, { historic: 0n, balance: 0n, rounds: 4 }),
      balanceEntries(OWNER),
      allowanceEntries(OWNER),
    );
    const { w } = await setup({ calls });
    await expect(
      w.f24.flows.start(w.group, {
        flow: "payout",
        currency: "EUR24",
        amount: 100n,
        target: { kind: "contact", contactId: "EA-123456" },
      }),
    ).rejects.toMatchObject({ category: "no-account" });
    await expect(
      w.f24.flows.start(w.group, {
        flow: "card-setup",
        cap: { currency: "EUR24", amount: 500n },
      }),
    ).rejects.toMatchObject({ category: "no-account" });
    await w.destroy();
  });

  it("refuses advance and discard for unknown flow ids", async () => {
    const { w } = await setup({ calls: liveTable(OWNER) });
    await expect(w.f24.flows.advance(w.group, "0011223344556677")).rejects.toMatchObject({
      category: "unknown-flow",
    });
    await expect(w.f24.flows.discard(w.group, "0011223344556677")).rejects.toMatchObject({
      category: "unknown-flow",
    });
    await w.destroy();
  });

  it("refuses a start while a sending/unknown record is unresolved, and discard while in flight", async () => {
    const calls = mergeCalls(
      transferCallTable({ sender: OWNER, recipient: RECIPIENT }),
      liveTable(OWNER),
    );
    const { w } = await setup({ calls });
    const started = await w.f24.flows.start(w.group, {
      flow: "transfer",
      currency: "EUR24",
      amount: 100n,
      to: { address: RECIPIENT },
    });
    await w.f24.flows.advance(w.group, started.id);
    /* Forge a `sending` record: the bytes the persist hook wrote, with an unresolved tx. */
    const text = (await storedText(w, started.id)) ?? "";
    const state = decodeFlowState(text);
    const sending = {
      ...state,
      step: "tx" as const,
      txs: [
        {
          purpose: "main" as const,
          phase: "sending" as const,
          fromBlock: B,
          nonce: NONCE,
        },
      ],
    };
    const { encodeFlowState } = await import("@qntx/fiat24/flows");
    await w.store
      .collection("apps.fiat24")
      .put(
        `${w.walletId}/0/flow/${started.id}`,
        new TextEncoder().encode(encodeFlowState(sending)),
      );

    await expect(
      w.f24.flows.start(w.group, {
        flow: "transfer",
        currency: "EUR24",
        amount: 100n,
        to: { address: RECIPIENT },
      }),
    ).rejects.toMatchObject({ category: "flow-unresolved" });
    await expect(w.f24.flows.discard(w.group, started.id)).rejects.toMatchObject({
      category: "flow-unresolved",
    });
    await w.destroy();
  });

  it("auto-reconcile advances only sending/submitted/unknown — a ready record never signs", async () => {
    const calls = mergeCalls(
      transferCallTable({ rounds: 8, sender: OWNER, recipient: RECIPIENT }),
      liveTable(OWNER),
    );
    /* latest === the forged nonce at two different blocks means nonce 5 was never consumed →
       reconcile lands `not-sent`; pending 5 ≤ 5 too. The submitted record's hash binds to a
       mined broadcast whose transaction matches the rebuilt call, so it lands `confirmed`. */
    const minedHash: `0x${string}` = `0x${"c0".repeat(32)}`;
    const boundCall = transferCall({ currency: "EUR24", to: RECIPIENT, amount: 100n });
    const { w, chain } = await setup({
      calls,
      autoBlock: true,
      count: { pending: NONCE, latest: NONCE },
      transactions: {
        [minedHash]: txPayload({
          hash: minedHash,
          from: OWNER,
          to: boundCall.to,
          input: boundCall.data,
          value: boundCall.value,
          nonce: NONCE,
        }),
      },
      receipts: {
        [minedHash]: receiptPayload({
          transactionHash: minedHash,
          blockNumber: B + 1n,
          status: "success",
          logs: [
            transferLog({
              token: deployment.tokens.EUR24.proxy,
              from: OWNER,
              to: RECIPIENT,
              amount: 100n,
              blockNumber: B + 1n,
              transactionHash: minedHash,
            }),
          ],
        }),
      },
    });
    const started = await w.f24.flows.start(w.group, {
      flow: "transfer",
      currency: "EUR24",
      amount: 100n,
      to: { address: RECIPIENT },
    });
    const ready = await w.f24.flows.advance(w.group, started.id);
    expect(ready.state.step).toBe("ready");

    const { encodeFlowState } = await import("@qntx/fiat24/flows");
    const forge = async (
      id: string,
      phase: "sending" | "submitted" | "unknown",
      hash?: `0x${string}`,
    ) => {
      const base = decodeFlowState((await storedText(w, started.id)) ?? "");
      const forged = {
        ...base,
        step: "tx" as const,
        txs: [
          {
            purpose: "main" as const,
            phase,
            fromBlock: B,
            nonce: NONCE,
            ...(phase === "unknown" ? { error: "unknown-outcome" as const } : {}),
            ...(hash === undefined ? {} : { hash }),
          },
        ],
      };
      await w.store
        .collection("apps.fiat24")
        .put(`${w.walletId}/0/flow/${id}`, new TextEncoder().encode(encodeFlowState(forged)));
    };
    await forge("aaaa0001", "sending");
    await forge("aaaa0002", "submitted", minedHash);
    await forge("aaaa0003", "unknown");
    w.f24.setVisible(true);
    /* Reconcile runs on the 15 s poll — pump passes while the not-sent proof needs its second
       block read, then assert the record settled without a request or a broadcast. */
    let phase: string | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && phase !== "not-sent") {
      w.timers.pump();
      // oxlint-disable-next-line eslint/no-await-in-loop -- the reconcile poll needs real turns between pumps
      await new Promise((resolve) => setTimeout(resolve, 10));
      // oxlint-disable-next-line eslint/no-await-in-loop -- each poll reads the record the last pump persisted
      const text = await storedText(w, "aaaa0001");
      phase = text === undefined ? undefined : decodeFlowState(text).txs.at(-1)?.phase;
    }
    expect(phase).toBe("not-sent");
    /* The submitted record reconciled by its hash's receipt — same poll, no request opened. */
    let phase2: string | undefined;
    const deadline2 = Date.now() + 10_000;
    while (Date.now() < deadline2 && phase2 !== "confirmed") {
      w.timers.pump();
      // oxlint-disable-next-line eslint/no-await-in-loop -- the reconcile poll needs real turns between pumps
      await new Promise((resolve) => setTimeout(resolve, 10));
      // oxlint-disable-next-line eslint/no-await-in-loop -- each poll reads the record the last pump persisted
      const text = await storedText(w, "aaaa0002");
      phase2 = text === undefined ? undefined : decodeFlowState(text).txs.at(-1)?.phase;
    }
    expect(phase2).toBe("confirmed");
    /* The unknown record's nonce was never consumed at two heights — it lands `not-sent`. */
    let phase3: string | undefined;
    const deadline3 = Date.now() + 10_000;
    while (Date.now() < deadline3 && phase3 !== "not-sent") {
      w.timers.pump();
      // oxlint-disable-next-line eslint/no-await-in-loop -- the reconcile poll needs real turns between pumps
      await new Promise((resolve) => setTimeout(resolve, 10));
      // oxlint-disable-next-line eslint/no-await-in-loop -- each poll reads the record the last pump persisted
      const text = await storedText(w, "aaaa0003");
      phase3 = text === undefined ? undefined : decodeFlowState(text).txs.at(-1)?.phase;
    }
    expect(phase3).toBe("not-sent");
    expect(openRequests(w)).toStrictEqual([]);
    expect(chain.sent).toHaveLength(0);
    /* The ready flow is host-driven only: reconcile leaves it ready. */
    const untouched = decodeFlowState((await storedText(w, started.id)) ?? "");
    expect(untouched.step).toBe("ready");
    await w.destroy();
  }, 30_000);

  it("discards a settled flow and drops a draft", async () => {
    const calls = liveTable(OWNER);
    const { w } = await setup({ calls });
    const started = await w.f24.flows.start(w.group, {
      flow: "payout",
      currency: "EUR24",
      amount: 100n,
      target: { kind: "contact", contactId: "EA-123456" },
    });
    await expect(storedFlow(w, started.id)).resolves.toBeUndefined();
    const listed = await w.f24.flows.list(w.group);
    expect(listed.map((flow) => flow.id)).toContain(started.id);
    await w.f24.flows.discard(w.group, started.id);
    await expect(w.f24.flows.list(w.group)).resolves.toStrictEqual([]);
    await w.destroy();
  });

  it("persists a verified payout from the in-memory draft and keeps no payee PII", async () => {
    const calls = mergeCalls(liveTable(OWNER, 8), availabilityEntries({}));
    const { w, api } = await setup({
      calls,
      /* The recorded fixture's ref prefixes tokenId 690333 — rebind it to this account's. */
      apiRoutes: {
        "/verify": JSON.stringify({
          contactId: "EA-123456",
          purposeId: 2,
          ref: "469709-50fb0941-4f59-4a89-8735-dd78ba7d53a3",
        }),
      },
    });
    const request = {
      account: "PII-IBAN-SECRET",
      bankName: "PII-BANK",
      bic: "PIIBICXX",
      purpose: 2n,
      creditor: { name: "PII-PAYEE", street: "s", city: "c", zip: "z", country: "CH" },
    };
    const started = await w.f24.flows.start(w.group, {
      flow: "payout",
      currency: "EUR24",
      amount: 100n,
      target: { kind: "bank", request },
    });
    /* The draft is memory-only — nothing under flow/<id> yet. */
    await expect(storedFlow(w, started.id)).resolves.toBeUndefined();
    const advancing = w.f24.flows.advance(w.group, started.id);
    /* verifyBankPayment goes through the secured session — one grant request. */
    await approveNext(w);
    const verified = await advancing;
    expect(verified.state.step).toBe("verified");
    const stored = (await storedText(w, started.id)) ?? "";
    expect(decodeFlowState(stored).flow).toBe("payout");
    expect(stored).not.toContain("PII-IBAN-SECRET");
    expect(stored).not.toContain("PII-PAYEE");
    expect(stored).not.toContain("PII-BANK");
    expect(api.calls.length).toBeGreaterThan(0);
    await w.destroy();
  }, 30_000);

  it("ends the open request when the group disables the app", async () => {
    const calls = mergeCalls(
      transferCallTable({ rounds: 8, sender: OWNER, recipient: RECIPIENT }),
      liveTable(OWNER),
    );
    const { w } = await setup({ calls });
    const started = await w.f24.flows.start(w.group, {
      flow: "transfer",
      currency: "EUR24",
      amount: 100n,
      to: { address: RECIPIENT },
    });
    await w.f24.flows.advance(w.group, started.id);
    const advancing = w.f24.flows.advance(w.group, started.id);
    advancing.catch(() => undefined);
    await until(() => openRequests(w).length === 1, 5000);
    const [request] = openRequests(w);
    await w.apps.disable(w.group, "fiat24", { revoke: true });
    await until(
      () => w.requests.getState().requests[request?.id ?? ""]?.stage === "rejected",
      5000,
    );
    await expect(w.requests.outcome(request?.id ?? "")).rejects.toMatchObject({
      stage: "rejected",
    });
    /* The rejection is a signer refusal: the tx record lands back at `ready` with it captured. */
    const settled = await advancing;
    expect(settled.refusal).toBe("rejected");
    expect(lastTx(settled.state)?.phase).toBe("ready");
    await w.destroy();
  }, 30_000);
});

const EUR24 = deployment.tokens.EUR24.proxy;
const DEPOSIT = deployment.deposit.proxy;
const CARD_PROXY = deployment.card.proxy;

/**
 * Drives a flow one advance at a time: whenever the advance parks on an `awaiting-approval` request
 * it is approved, and each `submitted` record's broadcast is mined with `logFor`'s receipt logs.
 * Stops when the state reaches `done` (or exhausts the step budget).
 */
const drive = async (
  w: World,
  chain: Fiat24Chain,
  id: string,
  logFor: (record: {
    readonly purpose?: string;
    readonly hash?: string;
  }) => ReadonlyArray<Record<string, unknown>>,
  done: (step: string) => boolean = (step) => step === "confirmed",
  maxSteps = 16,
) => {
  for (let i = 0; i < maxSteps; i += 1) {
    const advancing = w.f24.flows.advance(w.group, id);
    advancing.catch(() => undefined);
    const hit = await Promise.race([
      advancing.then(() => "settled" as const),
      until(() => openRequests(w).some((r) => r.stage === "awaiting-approval"), 5000).then(
        () => "request" as const,
      ),
    ]);
    if (hit === "request") {
      const pending = openRequests(w).find((r) => r.stage === "awaiting-approval");
      await w.approve(pending?.id ?? "");
    }
    const next = await advancing;
    const record = lastTx(next.state);
    if (next.state.step === "tx" && record?.phase === "submitted" && record.hash !== undefined) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each mine must land before the next confirm advance
      await chain.mine(record.hash as `0x${string}`, { logs: [...logFor(record)] });
    }
    if (done(next.state.step)) {
      return next;
    }
  }
  throw new Error("flow never reached the expected step");
};

describe("fiat24 flows — every flow e2e through the real SDK + pipeline", () => {
  it("runs an exact-out exchange: bounded approve then main — exactly two requests", async () => {
    const calls = exchangeTable({ side: "exact-out", owner: OWNER, rounds: 12 });
    let prepares = 0;
    const api = makeFiat24ApiFetch();
    const chain = makeFiat24Chain({
      calls,
      storage: honestStorage(),
      count: { pending: NONCE, latest: NONCE },
    });
    /* The deterministic id stream collides on the two sends — count prepares instead. */
    const w = await world(0, {
      fiat24: { fetch: api.fetch },
      arb1: chain.arb1,
      wrapRequests: (requests) => ({
        /* The facade's second argument is the app origin — forward it or the nonce gate refuses. */
        prepare: async (...args: Parameters<RequestController["prepare"]>) => {
          prepares += 1;
          return requests.prepare(...args);
        },
        outcome: async (...args: Parameters<RequestController["outcome"]>) =>
          requests.outcome(...args),
        reject: (...args: Parameters<RequestController["reject"]>) => requests.reject(...args),
      }),
    });
    await w.apps.acknowledgeTerms(w.group, "fiat24");
    await w.apps.enable(w.group, "fiat24");
    const started = await w.f24.flows.start(w.group, {
      flow: "exchange",
      side: "exact-out",
      from: "EUR24",
      to: "USD24",
      amount: 105n,
    });
    expect(started.state.step).toBe("draft");

    const done = await drive(w, chain, started.id, (record) => {
      if (record.purpose === "approve") {
        /* The mined bounded approve lifts the allowance to the quoted input — the main guard's
           re-quote reads exactly that. */
        chain.setCall(EUR24, "allowance", [OWNER, DEPOSIT], { result: 94n });
        return [
          approveLog({
            token: EUR24,
            owner: OWNER,
            spender: DEPOSIT,
            amount: 94n,
            blockNumber: chain.block,
            transactionHash: (record.hash ?? "0x0") as `0x${string}`,
          }),
        ];
      }
      return [
        exchangeLog({
          sender: OWNER,
          side: "exact-out",
          blockNumber: chain.block,
          transactionHash: (record.hash ?? "0x0") as `0x${string}`,
        }),
      ];
    });
    expect(done.state.step).toBe("confirmed");
    /* Approve + main — never a third request or broadcast. */
    expect(chain.sent).toHaveLength(2);
    expect(prepares).toBe(2);
    await w.destroy();
  }, 60_000);

  it("runs an exact-in exchange through the same two-transaction plan", async () => {
    const calls = exchangeTable({ side: "exact-in", owner: OWNER, rounds: 12 });
    const { w, chain } = await setup({ calls });
    const started = await w.f24.flows.start(w.group, {
      flow: "exchange",
      side: "exact-in",
      from: "EUR24",
      to: "USD24",
      amount: 100n,
    });
    const done = await drive(w, chain, started.id, (record) => {
      if (record.purpose === "approve") {
        chain.setCall(EUR24, "allowance", [OWNER, DEPOSIT], { result: 100n });
        return [
          approveLog({
            token: EUR24,
            owner: OWNER,
            spender: DEPOSIT,
            amount: 100n,
            blockNumber: chain.block,
            transactionHash: (record.hash ?? "0x0") as `0x${string}`,
          }),
        ];
      }
      return [
        exchangeLog({
          sender: OWNER,
          side: "exact-in",
          input: 100n,
          output: 108n,
          blockNumber: chain.block,
          transactionHash: (record.hash ?? "0x0") as `0x${string}`,
        }),
      ];
    });
    expect(done.state.step).toBe("confirmed");
    expect(chain.sent).toHaveLength(2);
    await w.destroy();
  }, 60_000);

  it("runs a USDC top-up to EUR24 — one deposit broadcast", async () => {
    const calls = topUpTable({ owner: OWNER, usdcAllowance: 0n, rounds: 8 });
    const { w, chain } = await setup({ calls });
    const started = await w.f24.flows.start(w.group, {
      flow: "top-up",
      output: "EUR24",
      usdcAmount: 100_000n,
    });
    const done = await drive(w, chain, started.id, (record) => {
      if (record.purpose === "approve") {
        chain.setCall(deployment.usdc, "allowance", [OWNER, DEPOSIT], { result: 100_000n });
        return [
          approveLog({
            token: deployment.usdc,
            owner: OWNER,
            spender: DEPOSIT,
            amount: 100_000n,
            blockNumber: chain.block,
            transactionHash: (record.hash ?? "0x0") as `0x${string}`,
          }),
        ];
      }
      return [
        topUpLog({
          sender: OWNER,
          input: 100_000n,
          output: 8n,
          blockNumber: chain.block,
          transactionHash: (record.hash ?? "0x0") as `0x${string}`,
        }),
      ];
    });
    expect(done.state.step).toBe("confirmed");
    expect(chain.sent).toHaveLength(2);
    await w.destroy();
  }, 60_000);

  it("runs onboarding with ETH payment to the kyc step", async () => {
    const calls = mergeCalls(
      onboardingTable({ owner: OWNER, tokenId: SENDER_ID }),
      accountByIdEntries({ owner: OWNER, tokenId: SENDER_ID, statusIndex: 2 }),
    );
    /* The account exists only after the mint — keep the `false` answer; the mine-time setCall
       flips it for the tourist/kyc reads. */
    const existsKey = `${deployment.account.proxy.toLowerCase()}:exists`;
    calls.set(existsKey, (calls.get(existsKey) ?? []).slice(0, 1));
    const { w, chain } = await setup({ calls });
    const started = await w.f24.flows.start(w.group, {
      flow: "onboarding",
      tokenId: SENDER_ID,
      payment: "eth",
    });
    expect(started.state.step).toBe("check");

    const done = await drive(
      w,
      chain,
      started.id,
      (record) => {
        /* The mint makes the account exist — the tourist/kyc reads see it after the mine. */
        chain.setCall(deployment.account.proxy, "exists", [SENDER_ID], { result: true });
        return [
          mintLog({
            from: "0x0000000000000000000000000000000000000000",
            to: OWNER,
            tokenId: SENDER_ID,
            blockNumber: chain.block,
            transactionHash: (record.hash ?? "0x0") as `0x${string}`,
          }),
        ];
      },
      (step) => step === "kyc" || step === "live",
    );
    expect(done.state.step).toBe("kyc");
    if ("kyc" in done.state) {
      expect(done.state.kyc).toBe("completed");
    }
    expect(chain.sent).toHaveLength(1);
    await w.destroy();
  }, 60_000);

  it("runs a contact payout to confirmed and reads the settlement", async () => {
    const calls = mergeCalls(payoutTable({ owner: OWNER, tokenId: SENDER_ID }), liveTable(OWNER));
    const { w, chain } = await setup({
      calls,
      apiRoutes: {},
    });
    const started = await w.f24.flows.start(w.group, {
      flow: "payout",
      currency: "EUR24",
      amount: 100n,
      target: { kind: "contact", contactId: "EA-123456" },
    });
    expect(started.state.step).toBe("draft");
    const done = await drive(w, chain, started.id, (record) => [
      payoutLog({
        sender: OWNER,
        tokenId: SENDER_ID,
        blockNumber: chain.block,
        transactionHash: (record.hash ?? "0x0") as `0x${string}`,
      }),
    ]);
    expect(done.state.step).toBe("confirmed");
    const settlement = await w.f24.flows.payoutSettlement(w.group, started.id);
    expect(settlement.txid).toBe("pacs.008.001.01-abc");
    await w.destroy();
  }, 60_000);

  it("runs card-setup (cap approve) then a block operation through the fixture fetch", async () => {
    const calls = mergeCalls(cardTable({ owner: OWNER, tokenId: SENDER_ID }), liveTable(OWNER));
    const { w, chain } = await setup({ calls });
    const setup2 = await w.f24.flows.start(w.group, {
      flow: "card-setup",
      cap: { currency: "EUR24", amount: 100n },
    });
    const done = await drive(w, chain, setup2.id, (record) => [
      approveLog({
        token: EUR24,
        owner: OWNER,
        spender: CARD_PROXY,
        amount: 100n,
        blockNumber: chain.block,
        transactionHash: (record.hash ?? "0x0") as `0x${string}`,
      }),
    ]);
    expect(done.state.step).toBe("confirmed");
    expect(chain.sent).toHaveLength(1);
    await w.destroy();
  }, 60_000);

  it("issues a card-status write exactly once and reconciles it through GET /cards", async () => {
    /* /cards serves the recorded card; once the write lands the fixture answers "Blocked". */
    const base = makeFiat24ApiFetch();
    let wrote = false;
    const fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const path = url.replace("https://api.fiat24.com", "").split("?")[0] ?? url;
      if (path === "/card-status" && (init?.method ?? "GET").toUpperCase() === "POST") {
        wrote = true;
      }
      if (path === "/cards" && wrote) {
        const body = JSON.parse(fixtureBody("secured/cards-ok.json")) as {
          body: { body: Array<{ status: string }> };
        };
        const [card] = body.body.body;
        if (card !== undefined) {
          card.status = "Blocked";
        }
        return Response.json(body.body);
      }
      return base.fetch(input as string, init);
    }) as typeof globalThis.fetch;
    const calls = mergeCalls(liveTable(OWNER), availabilityEntries({}));
    const chain = makeFiat24Chain({
      calls,
      storage: honestStorage(),
      count: { pending: NONCE, latest: NONCE },
    });
    const w = await world(0, { fiat24: { fetch }, arb1: chain.arb1 });
    await w.apps.acknowledgeTerms(w.group, "fiat24");
    await w.apps.enable(w.group, "fiat24");

    const started = await w.f24.flows.start(w.group, {
      flow: "card",
      operation: { kind: "block", externalId: "123456" },
    });
    const advancing = w.f24.flows.advance(w.group, started.id);
    advancing.catch(() => undefined);
    /* The session grant request comes first — approve it so cards()/write can run. */
    await until(() => openRequests(w).length > 0, 5000);
    await approveNext(w);
    const sent = await advancing;
    /* The write went out once and the same advance's observe read already sees it. */
    expect(base.calls.filter((c) => c.url.includes("/card-status"))).toHaveLength(1);
    expect(sent.state.step).toBe("confirmed");
    await w.destroy();
  }, 60_000);
});

describe("fiat24 reconcile lifecycle", () => {
  /** Forge a persisted `sending` transfer record under `flow/<id>`. */
  const forgeSending = async (w: World, id: string): Promise<void> => {
    const state = {
      flow: "transfer" as const,
      version: 1 as const,
      owner: OWNER,
      step: "tx" as const,
      currency: "EUR24" as const,
      amount: 100n,
      to: { address: "0x00000000000000000000000000000000000bb0aa" as `0x${string}` },
      txs: [{ purpose: "main" as const, phase: "sending" as const, fromBlock: B, nonce: NONCE }],
    };
    await w.store
      .collection("apps.fiat24")
      .put(`${w.walletId}/0/flow/${id}`, new TextEncoder().encode(encodeFlowState(state)));
  };

  const storedPhase = async (w: World, id: string): Promise<string | undefined> => {
    const bytes = await storedFlow(w, id);
    if (bytes === undefined) {
      return undefined;
    }
    const state = decodeFlowState(new TextDecoder().decode(bytes));
    return "txs" in state ? (state.txs.at(-1) as { phase: string } | undefined)?.phase : undefined;
  };

  it("reconciles a persisted sending flow once after unlock — host never set visible", async () => {
    /* pending === latest === the forged nonce ⇒ the record lands `not-sent` (autoBlock gives the
       two-height proof). NO calls table entries: the nonce-only probe reads no contract state. */
    const { w, chain } = await setup({ calls: liveTable(OWNER), autoBlock: true });
    await forgeSending(w, "beef0001");
    await w.wallet.vault.lock();
    await w.wallet.vault.unlock(VERIFY);
    await untilStored(async () =>
      (await storedPhase(w, "beef0001")) === "not-sent" ? "not-sent" : undefined,
    );
    expect(openRequests(w)).toStrictEqual([]);
    expect(chain.sent).toHaveLength(0);
    await w.destroy();
  }, 30_000);

  it("keeps the host's visibility flag across a lock — the poll re-arms on unlock", async () => {
    const { w, chain } = await setup({ calls: liveTable(OWNER), autoBlock: true });
    w.f24.setVisible(true);
    await w.wallet.vault.lock();
    await w.wallet.vault.unlock(VERIFY);
    /* Let the unlock-time provider reconcile finish first — only an armed poll timer can run
       the pass that settles the record forged after it. */
    await new Promise((resolve) => setTimeout(resolve, 150));
    await forgeSending(w, "beef0002");
    /* First pump advances the clock to the armed 15 s timer, the second fires it. */
    w.timers.pump();
    w.timers.pump();
    await untilStored(async () =>
      (await storedPhase(w, "beef0002")) === "not-sent" ? "not-sent" : undefined,
    );
    expect(chain.sent).toHaveLength(0);
    await w.destroy();
  }, 30_000);

  it("enqueues a flow's reconcile once while an earlier one is still queued", async () => {
    const calls = mergeCalls(
      transferCallTable({ rounds: 12, sender: OWNER, recipient: RECIPIENT }),
      liveTable(OWNER),
    );
    const { w, chain } = await setup({ calls, autoBlock: true });
    /* Flow A parks on its send approval — the serial queue holds every reconcile behind it. */
    const started = await w.f24.flows.start(w.group, {
      flow: "transfer",
      currency: "EUR24",
      amount: 100n,
      to: { address: RECIPIENT },
    });
    await w.f24.flows.advance(w.group, started.id);
    const parked = w.f24.flows.advance(w.group, started.id);
    parked.catch(() => undefined);
    await until(() => openRequests(w).length === 1, 5000);

    await forgeSending(w, "beef0003");
    /* Several poll passes while the first reconcile still waits behind A — only one may be
       queued. Each off/on toggle cancels the armed timer and fires a fresh immediate pass;
       the settle lets the previous pass finish so `polling` is clear again. */
    for (let i = 0; i < 4; i += 1) {
      w.f24.setVisible(false);
      w.f24.setVisible(true);
      // oxlint-disable-next-line eslint/no-await-in-loop -- each pass needs a real turn to settle
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const pending = openRequests(w).find((r) => r.stage === "awaiting-approval");
    await w.approve(pending?.id ?? "");
    await parked;
    /* Flow A's broadcast consumed nonce 5 — the forged nonce-5 `sending` record lands `unknown`
       (a consumed nonce no own receipt explains). It still proves exactly one reconcile ran. */
    await untilStored(async () =>
      (await storedPhase(w, "beef0003")) === "unknown" ? "unknown" : undefined,
    );
    /* Stop the poll so only the work already queued drains, then let it finish: with no dedup
       guard the four toggle passes each enqueued an advance, and each runs the record's
       hash/receipt probes behind the serial queue — one probe pair per reconcile. */
    w.f24.setVisible(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    /* Exactly ONE reconcile probed the forged record's hash — a duplicated enqueue would
       each probe it again. */
    expect(chain.requests.filter((r) => r.method === "eth_getTransactionByHash")).toHaveLength(1);
    expect(chain.requests.filter((r) => r.method === "eth_getTransactionReceipt")).toHaveLength(1);
    expect(w.warns.filter((line) => line.includes("reconcile"))).toStrictEqual([]);
    await w.destroy();
  }, 30_000);

  it("rejects only the still-open request on disable — settled ids are dropped", async () => {
    const calls = mergeCalls(
      transferCallTable({ rounds: 16, sender: OWNER, recipient: RECIPIENT }),
      liveTable(OWNER),
    );
    /* Sequential ids — the deterministic fill would give both requests the same id — and the
       wrapped reject counts exactly which ids `dropGroup` tries to end. */
    let seq = 0;
    const rejected: string[] = [];
    const api = makeFiat24ApiFetch();
    const chain = makeFiat24Chain({
      calls,
      storage: honestStorage(),
      count: { pending: NONCE, latest: NONCE },
    });
    const w = await world(0, {
      fiat24: { fetch: api.fetch },
      arb1: chain.arb1,
      random: (length) => {
        seq += 1;
        const first = seq % 256;
        return new Uint8Array(length).map((_, i) => (i === 0 ? first : 0));
      },
      wrapRequests: (requests) => ({
        prepare: requests.prepare.bind(requests),
        outcome: requests.outcome.bind(requests),
        reject: (id) => {
          rejected.push(id);
          return requests.reject(id);
        },
      }),
    });
    await w.apps.acknowledgeTerms(w.group, "fiat24");
    await w.apps.enable(w.group, "fiat24");
    const first = await w.f24.flows.start(w.group, {
      flow: "transfer",
      currency: "EUR24",
      amount: 100n,
      to: { address: RECIPIENT },
    });
    await w.f24.flows.advance(w.group, first.id);
    const sendFirst = w.f24.flows.advance(w.group, first.id);
    sendFirst.catch(() => undefined);
    await until(() => openRequests(w).length === 1, 5000);
    const settledId = openRequests(w)[0]?.id ?? "";
    await w.approve(settledId);
    const submitted = await sendFirst;
    const record = lastTx(submitted.state);
    await chain.mine(record?.hash as `0x${string}`, {
      logs: [
        transferLog({
          token: EUR24,
          from: OWNER,
          to: RECIPIENT,
          amount: 100n,
          blockNumber: chain.block,
          transactionHash: (record?.hash ?? "0x0") as `0x${string}`,
        }),
      ],
    });
    await w.f24.flows.advance(w.group, first.id);

    /* Second transfer: its request stays open while the first is fully settled. */
    const second = await w.f24.flows.start(w.group, {
      flow: "transfer",
      currency: "EUR24",
      amount: 100n,
      to: { address: RECIPIENT },
    });
    await w.f24.flows.advance(w.group, second.id);
    const sendSecond = w.f24.flows.advance(w.group, second.id);
    sendSecond.catch(() => undefined);
    await until(() => openRequests(w).some((r) => r.stage === "awaiting-approval"), 5000);
    const openId = openRequests(w).find((r) => r.stage === "awaiting-approval")?.id ?? "";
    expect(openId).not.toBe(settledId);
    await w.apps.disable(w.group, "fiat24", { revoke: true });
    await until(() => w.requests.getState().requests[openId]?.stage === "rejected", 5000);
    /* The settled request was already dropped — disable rejected exactly the open one. */
    expect(rejected).toStrictEqual([openId]);
    expect(w.requests.getState().requests[settledId]?.stage).toBe("submitted");
    await sendSecond;
    await w.destroy();
  }, 60_000);

  it("reports, blocks, discards and skips an undecodable persisted record", async () => {
    const calls = mergeCalls(
      transferCallTable({ rounds: 12, sender: OWNER, recipient: RECIPIENT }),
      liveTable(OWNER),
    );
    const { w } = await setup({ calls, autoBlock: true });
    await w.store
      .collection("apps.fiat24")
      .put(`${w.walletId}/0/flow/dead0001`, new TextEncoder().encode("not-a-flow-state"));

    /* list reports it; start fails closed; advance is a protocol invalid-state. */
    const listed = await w.f24.flows.list(w.group);
    expect(listed).toContainEqual({ id: "dead0001", invalid: true });
    await expect(
      w.f24.flows.start(w.group, {
        flow: "transfer",
        currency: "EUR24",
        amount: 100n,
        to: { address: RECIPIENT },
      }),
    ).rejects.toMatchObject({ category: "flow-unresolved" });
    await expect(w.f24.flows.advance(w.group, "dead0001")).rejects.toMatchObject({
      category: "protocol",
      code: "invalid-state",
    });

    /* Auto-reconcile skips it with a category/code-only warn. */
    w.f24.setVisible(true);
    w.timers.pump();
    await until(() => w.warns.some((line) => line.includes("undecodable")), 10_000);

    /* discard drops it and start works again. */
    await w.f24.flows.discard(w.group, "dead0001");
    await expect(w.f24.flows.list(w.group)).resolves.toStrictEqual([]);
    const started = await w.f24.flows.start(w.group, {
      flow: "transfer",
      currency: "EUR24",
      amount: 100n,
      to: { address: RECIPIENT },
    });
    expect(started.state.step).toBe("draft");
    await w.destroy();
  }, 30_000);

  it("arms, re-arms and cancels the reconcile poll across visibility and lock", async () => {
    const { w, chain } = await setup({ calls: liveTable(OWNER), autoBlock: true });
    /* setVisible fires a pass immediately and re-arms the 15 s timer when it settles. */
    w.f24.setVisible(true);
    await forgeSending(w, "beef0004");
    const reconcile = async (id: string): Promise<string | undefined> => {
      const deadline = Date.now() + 10_000;
      let phase: string | undefined;
      while (Date.now() < deadline && phase !== "not-sent") {
        w.timers.pump();
        // oxlint-disable-next-line eslint/no-await-in-loop -- each pass needs a real turn to settle
        await new Promise((resolve) => setTimeout(resolve, 10));
        phase = await storedPhase(w, id);
      }
      return phase;
    };
    /* The armed timer alone drives the reconcile — the host never advanced anything. */
    await expect(reconcile("beef0004")).resolves.toBe("not-sent");
    expect(chain.sent).toHaveLength(0);

    /* Lock while the timer is armed — it is cancelled; the host flag stays for the unlock. */
    await forgeSending(w, "beef0005");
    await w.wallet.vault.lock();
    w.requests.lock();
    await w.wallet.vault.unlock(VERIFY);
    await w.requests.init();
    await until(() => w.f24State()?.status === "enabled", 5000);
    await expect(reconcile("beef0005")).resolves.toBe("not-sent");

    /* setVisible(false) cancels the timer — further pumps reconcile nothing. */
    w.f24.setVisible(false);
    await forgeSending(w, "beef0006");
    for (let i = 0; i < 3; i += 1) {
      w.timers.pump();
      // oxlint-disable-next-line eslint/no-await-in-loop -- each pump needs a real turn
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect(storedPhase(w, "beef0006")).resolves.toBe("sending");
    await w.destroy();
  }, 60_000);
});
describe("fiat24 lock, disable and removal at every transfer stage", () => {
  const STAGES = ["draft", "awaiting-approval", "submitted", "confirmed"] as const;
  type Stage = (typeof STAGES)[number];

  /* A second imported wallet — removal must not touch the shared `nodeWallet` singleton. Its
     group-0 bip44 address (mnemonicToAccount) is the flow owner for foreign-group drives. */
  const SECOND_MNEMONIC =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";
  const SECOND_OWNER = "0x58A57ed9d8d624cBD12e2C467D34787555bB1b25" as Address;
  type Group = { walletId: string; groupIndex: number };

  const transferCalls = (owner: Address) =>
    mergeCalls(
      transferCallTable({ rounds: 24, sender: owner, recipient: RECIPIENT }),
      liveTable(owner),
    );

  const transferReceipt = (owner: Address, record: { readonly hash?: string }, block: bigint) => [
    transferLog({
      token: deployment.tokens.EUR24.proxy,
      from: owner,
      to: RECIPIENT,
      amount: 100n,
      blockNumber: block,
      transactionHash: (record.hash ?? "0x0") as `0x${string}`,
    }),
  ];

  const storedPhaseOf = async (w: World, group: Group, id: string) => {
    const bytes = await w.store.collection("apps.fiat24").get(`${group.walletId}/0/flow/${id}`);
    if (bytes === undefined) {
      return undefined;
    }
    const state = decodeFlowState(new TextDecoder().decode(bytes));
    return "txs" in state ? (state.txs.at(-1) as { phase: string } | undefined)?.phase : undefined;
  };

  /** Builds a world and drives a transfer to `stage`. `awaiting-approval` parks the send. */
  const reach = async (
    stage: Stage,
    foreign = false,
  ): Promise<{
    w: World;
    chain: Fiat24Chain;
    group: Group;
    id: string;
    parked?: Promise<Fiat24FlowEntry>;
  }> => {
    const owner = foreign ? SECOND_OWNER : OWNER;
    const { w, chain } = await setup({ calls: transferCalls(owner), enable: !foreign });
    let { group } = w;
    if (foreign) {
      const second = await w.wallet.wallets.importMnemonic({ mnemonic: SECOND_MNEMONIC });
      group = { walletId: second.walletId, groupIndex: 0 };
      await w.apps.acknowledgeTerms(group, "fiat24");
      await w.apps.enable(group, "fiat24");
    }
    const started = await w.f24.flows.start(group, {
      flow: "transfer",
      currency: "EUR24",
      amount: 100n,
      to: { address: RECIPIENT },
    });
    if (stage === "draft") {
      return { w, chain, group, id: started.id };
    }
    await w.f24.flows.advance(group, started.id);
    const parked = w.f24.flows.advance(group, started.id);
    parked.catch(() => undefined);
    await until(() => openRequests(w).length === 1, 5000);
    /* The send persists `sending` the moment the request opens — this IS the after-`sending` stage. */
    await expect(storedPhaseOf(w, group, started.id)).resolves.toBe("sending");
    if (stage === "awaiting-approval") {
      return { w, chain, group, id: started.id, parked };
    }
    const [request] = openRequests(w);
    await w.approve(request?.id ?? "");
    const submitted = await parked;
    if (!("state" in submitted)) {
      throw new Error("advance returned an invalid record");
    }
    const record = lastTx(submitted.state);
    expect(record?.phase).toBe("submitted");
    if (stage === "submitted") {
      return { w, chain, group, id: started.id };
    }
    await chain.mine((record?.hash ?? "0x0") as `0x${string}`, {
      logs: [
        transferLog({
          token: deployment.tokens.EUR24.proxy,
          from: owner,
          to: RECIPIENT,
          amount: 100n,
          blockNumber: chain.block,
          transactionHash: (record?.hash ?? "0x0") as `0x${string}`,
        }),
      ],
    });
    const done = await w.f24.flows.advance(group, started.id);
    if (!("state" in done)) {
      throw new Error("advance returned an invalid record");
    }
    expect(done.state.step).toBe("confirmed");
    return { w, chain, group, id: started.id };
  };

  /** Drives `id` to confirmed for `group` — the same per-request approve/mine cadence as `drive`. */
  const resume = async (w: World, chain: Fiat24Chain, group: Group, id: string): Promise<void> => {
    for (let i = 0; i < 16; i += 1) {
      /* A `sending`/`unknown` reconcile reads no contract state — it may auto-advance the block
         for the two-height latest-nonce proof; every other phase needs a stable height for the
         dual-endpoint corroboration, so the flag tracks the persisted record. */
      const phase = await storedPhaseOf(w, group, id);
      chain.autoBlock = phase === "sending" || phase === "submitted" || phase === "unknown";
      const advancing = w.f24.flows.advance(group, id);
      advancing.catch(() => undefined);
      const hit = await Promise.race([
        advancing.then(() => "settled" as const),
        until(() => openRequests(w).some((r) => r.stage === "awaiting-approval"), 5000).then(
          () => "request" as const,
        ),
      ]);
      if (hit === "request") {
        const pending = openRequests(w).find((r) => r.stage === "awaiting-approval");
        await w.approve(pending?.id ?? "");
      }
      const next = await advancing;
      if (!("state" in next)) {
        throw new Error("advance returned an invalid record");
      }
      const record = lastTx(next.state);
      if (
        next.state.step === "tx" &&
        (record?.phase === "submitted" || record?.phase === "unknown") &&
        record.hash !== undefined
      ) {
        /* A `submitted` record re-checks as `unknown` while its receipt is still absent (the
           consumed nonce is unexplained) — the own-hash mine still proves it. */
        // oxlint-disable-next-line eslint/no-await-in-loop -- each mine must land before the next confirm advance
        await chain.mine(record.hash as `0x${string}`, {
          logs: transferReceipt(group === w.group ? OWNER : SECOND_OWNER, record, chain.block),
        });
      }
      if (next.state.step === "confirmed") {
        return;
      }
    }
    throw new Error("flow never reached confirmed");
  };

  it.each(STAGES)(
    "lock at %s: never resends and the flow resumes after unlock",
    async (stage) => {
      const { w, chain, group, id, parked } = await reach(stage);
      await w.wallet.vault.lock();
      /* engine.ts calls requests.lock() inside its lock transition — the world drives it by hand.
         The parked request is invalidated; its persist-back may fail on the closed store —
         either way nothing broadcast. */
      w.requests.lock();
      if (parked !== undefined) {
        await parked.catch(() => undefined);
      }
      expect(openRequests(w).filter((r) => r.stage === "awaiting-approval")).toStrictEqual([]);
      await w.wallet.vault.unlock(VERIFY);
      /* engine.ts re-inits the request controller on the unlock transition — the world does it
         by hand, then waits for the group state to derive `enabled`. */
      await w.requests.init();
      await until(() => w.f24State()?.status === "enabled", 5000);
      let resumeId = id;
      if (stage === "awaiting-approval") {
        /* The invalidated send never broadcast — the `sending` record reconciles to terminal
           `not-sent` on its own (the init reconcile pass beats a host advance); a fresh flow
           carries the intent forward. */
        chain.autoBlock = true;
        await untilStored(async () => {
          const bytes = await w.store
            .collection("apps.fiat24")
            .get(`${group.walletId}/0/flow/${id}`);
          if (bytes === undefined) {
            return undefined;
          }
          const stored = decodeFlowState(new TextDecoder().decode(bytes));
          return stored.step === "not-sent" ? "not-sent" : undefined;
        });
        chain.autoBlock = false;
        resumeId = await w.f24.flows
          .start(group, {
            flow: "transfer",
            currency: "EUR24",
            amount: 100n,
            to: { address: RECIPIENT },
          })
          .then((flow) => flow.id);
      }
      if (stage !== "confirmed") {
        await resume(w, chain, group, resumeId);
      }
      /* Exactly one broadcast across lock + resume — the rejected/persisted send never doubles. */
      expect(chain.sent).toHaveLength(1);
      await w.destroy();
    },
    60_000,
  );

  it.each(STAGES)(
    "disable at %s: rejects the open request and refuses the group",
    async (stage) => {
      const { w, chain, group, id, parked } = await reach(stage);
      await w.apps.disable(group, "fiat24", { revoke: true });
      if (parked !== undefined) {
        const settled = await parked;
        expect("state" in settled ? settled.refusal : undefined).toBe("rejected");
      }
      await expect(w.f24.flows.list(group)).rejects.toMatchObject({ category: "not-enabled" });
      /* Re-enable and resume — the persisted record survives a disable. */
      await w.apps.enable(group, "fiat24");
      if (stage !== "confirmed") {
        await resume(w, chain, group, id);
      }
      expect(chain.sent).toHaveLength(1);
      await w.destroy();
    },
    60_000,
  );

  it.each(STAGES)(
    "removal at %s: drops the group's sessions, drafts and open requests",
    async (stage) => {
      const { w, chain, group, parked } = await reach(stage, true);
      const sentBefore = chain.sent.length;
      await w.wallet.wallets.delete(group.walletId, VERIFY);
      if (parked !== undefined) {
        const settled: unknown = await parked.catch((error: unknown) => error);
        if (typeof settled === "object" && settled !== null && "state" in settled) {
          expect((settled as { refusal?: string }).refusal).toBe("rejected");
        }
      }
      /* The controller's group state is not pruned on removal — `dropMissing` cleans up the
         app's side: sessions end, drafts drop, open requests reject. */
      await until(() => openRequests(w).every((r) => r.stage !== "awaiting-approval"), 5000);
      expect(chain.sent).toHaveLength(sentBefore);
      await w.destroy();
    },
    60_000,
  );

  it("lock, disable and removal at the exchange approve step never resend the approve", async () => {
    /* One world per action — the parked advance is always the bounded-approve send. */
    for (const action of ["lock", "disable", "removal"] as const) {
      const foreign = action === "removal";
      const owner = foreign ? SECOND_OWNER : OWNER;
      const calls = exchangeTable({ side: "exact-out", owner, rounds: 24 });
      const { w, chain } = await setup({ calls, enable: !foreign });
      let { group } = w;
      if (foreign) {
        const second = await w.wallet.wallets.importMnemonic({ mnemonic: SECOND_MNEMONIC });
        group = { walletId: second.walletId, groupIndex: 0 };
        await w.apps.acknowledgeTerms(group, "fiat24");
        await w.apps.enable(group, "fiat24");
      }
      const started = await w.f24.flows.start(group, {
        flow: "exchange",
        side: "exact-out",
        from: "EUR24",
        to: "USD24",
        amount: 105n,
      });
      let parked: Promise<Fiat24FlowEntry> | undefined;
      for (let i = 0; i < 8 && parked === undefined; i += 1) {
        const advancing = w.f24.flows.advance(group, started.id);
        advancing.catch(() => undefined);
        const hit = await Promise.race([
          advancing.then(() => "settled" as const),
          until(() => openRequests(w).length > 0, 5000).then(() => "request" as const),
        ]);
        if (hit === "request") {
          parked = advancing;
        }
      }
      if (parked === undefined) {
        throw new Error("no send was parked");
      }
      let flowId = started.id;
      if (action === "lock") {
        await w.wallet.vault.lock();
        w.requests.lock();
        await parked.catch(() => undefined);
        await w.wallet.vault.unlock(VERIFY);
        await w.requests.init();
        await until(() => w.f24State()?.status === "enabled", 5000);
        /* The invalidated approve send never broadcast — the init reconcile lands it
           terminal `not-sent`; restart fresh. */
        chain.autoBlock = true;
        await untilStored(async () => {
          const bytes = await w.store
            .collection("apps.fiat24")
            .get(`${group.walletId}/0/flow/${flowId}`);
          if (bytes === undefined) {
            return undefined;
          }
          const stored = decodeFlowState(new TextDecoder().decode(bytes));
          return stored.step === "not-sent" ? "not-sent" : undefined;
        });
        chain.autoBlock = false;
        flowId = await w.f24.flows
          .start(group, {
            flow: "exchange",
            side: "exact-out",
            from: "EUR24",
            to: "USD24",
            amount: 105n,
          })
          .then((flow) => flow.id);
      } else if (action === "disable") {
        await w.apps.disable(group, "fiat24", { revoke: true });
        const settled = await parked;
        expect("state" in settled ? settled.refusal : undefined).toBe("rejected");
        await w.apps.enable(group, "fiat24");
      } else {
        await w.wallet.wallets.delete(group.walletId, VERIFY);
        await parked.catch(() => undefined);
        expect(chain.sent).toHaveLength(0);
        await w.destroy();
        continue;
      }
      /* Resume to confirmed — approve then main is exactly two broadcasts, never a third. */
      for (let i = 0; i < 16; i += 1) {
        const phase = await storedPhaseOf(w, group, started.id);
        chain.autoBlock = phase === "sending" || phase === "submitted" || phase === "unknown";
        const advancing = w.f24.flows.advance(group, flowId);
        advancing.catch(() => undefined);
        const hit = await Promise.race([
          advancing.then(() => "settled" as const),
          until(() => openRequests(w).some((r) => r.stage === "awaiting-approval"), 5000).then(
            () => "request" as const,
          ),
        ]);
        if (hit === "request") {
          const pending = openRequests(w).find((r) => r.stage === "awaiting-approval");
          await w.approve(pending?.id ?? "");
        }
        const next = await advancing;
        if (!("state" in next)) {
          throw new Error("advance returned an invalid record");
        }
        const record = lastTx(next.state);
        if (
          next.state.step === "tx" &&
          (record?.phase === "submitted" || record?.phase === "unknown") &&
          record.hash !== undefined
        ) {
          if (record.purpose === "approve") {
            chain.setCall(EUR24, "allowance", [owner, DEPOSIT], { result: 94n });
          }
          const logs =
            record.purpose === "approve"
              ? [
                  approveLog({
                    token: EUR24,
                    owner,
                    spender: DEPOSIT,
                    amount: 94n,
                    blockNumber: chain.block,
                    transactionHash: record.hash as `0x${string}`,
                  }),
                ]
              : [
                  exchangeLog({
                    sender: owner,
                    side: "exact-out",
                    blockNumber: chain.block,
                    transactionHash: record.hash as `0x${string}`,
                  }),
                ];
          // oxlint-disable-next-line eslint/no-await-in-loop -- each mine must land before the next confirm advance
          await chain.mine(record.hash as `0x${string}`, { logs });
        }
        if (next.state.step === "confirmed") {
          break;
        }
      }
      expect(chain.sent).toHaveLength(2);
      await w.destroy();
    }
  }, 120_000);

  it.each(["lock", "disable", "removal"] as const)(
    "drops the in-memory payout draft on %s — it was never persisted",
    async (action) => {
      const foreign = action === "removal";
      const owner = foreign ? SECOND_OWNER : OWNER;
      const { w } = await setup({
        calls: mergeCalls(payoutTable({ owner, tokenId: SENDER_ID }), liveTable(owner)),
        enable: !foreign,
      });
      let { group } = w;
      if (foreign) {
        const second = await w.wallet.wallets.importMnemonic({ mnemonic: SECOND_MNEMONIC });
        group = { walletId: second.walletId, groupIndex: 0 };
        await w.apps.acknowledgeTerms(group, "fiat24");
        await w.apps.enable(group, "fiat24");
      }
      const started = await w.f24.flows.start(group, {
        flow: "payout",
        currency: "EUR24",
        amount: 100n,
        target: { kind: "contact", contactId: "EA-123456" },
      });
      await expect(
        w.f24.flows.list(group).then((list) => list.map((flow) => flow.id)),
      ).resolves.toContain(started.id);
      if (action === "lock") {
        await w.wallet.vault.lock();
        w.requests.lock();
        await w.wallet.vault.unlock(VERIFY);
        await until(() => w.f24State()?.status === "enabled", 5000);
      } else if (action === "disable") {
        await w.apps.disable(group, "fiat24", { revoke: true });
        await w.apps.enable(group, "fiat24");
      } else {
        await w.wallet.wallets.delete(group.walletId, VERIFY);
      }
      /* `dropGroup` dropped the draft on every path — `list` proves it (it still answers for a
         removed wallet since the group state is not pruned). */
      await expect(
        w.f24.flows.list(group).then((list) => list.map((flow) => flow.id)),
      ).resolves.not.toContain(started.id);
      const bytes = await w.store
        .collection("apps.fiat24")
        .get(`${group.walletId}/0/flow/${started.id}`);
      expect(bytes).toBeUndefined();
      await w.destroy();
    },
    30_000,
  );

  it("ends the bearer session on lock and disable — the next secured read re-grants", async () => {
    /* Sequential ids so the grant requests are distinguishable. */
    let seq = 0;
    const calls = liveTable(OWNER, 12);
    const chain = makeFiat24Chain({
      calls,
      storage: honestStorage(),
      count: { pending: NONCE, latest: NONCE },
    });
    const api = makeFiat24ApiFetch();
    const w = await world(0, {
      fiat24: { fetch: api.fetch },
      arb1: chain.arb1,
      random: (length) => {
        seq += 1;
        const first = seq % 256;
        return new Uint8Array(length).map((_, i) => (i === 0 ? first : 0));
      },
    });
    await w.apps.acknowledgeTerms(w.group, "fiat24");
    await w.apps.enable(w.group, "fiat24");
    const approvePending = async (): Promise<void> => {
      await until(() => openRequests(w).some((r) => r.stage === "awaiting-approval"), 5000);
      const pending = openRequests(w).find((r) => r.stage === "awaiting-approval");
      await w.approve(pending?.id ?? "");
    };
    for (const action of ["lock", "disable"] as const) {
      const profile = w.f24.session(w.group).profile();
      profile.catch(() => undefined);
      await approvePending();
      await profile;
      if (action === "lock") {
        await w.wallet.vault.lock();
        w.requests.lock();
        await w.wallet.vault.unlock(VERIFY);
        await w.requests.init();
        await until(() => w.f24State()?.status === "enabled", 5000);
      } else {
        await w.apps.disable(w.group, "fiat24", { revoke: true });
        await w.apps.enable(w.group, "fiat24");
      }
      /* The session died with the action — the next secured read opens a new grant request
         (approvePending would time out if the old grant were simply reused). */
      const again = w.f24.session(w.group).profile();
      again.catch(() => undefined);
      await approvePending();
      await again;
      /* A third read inside the fresh session reuses its grant — resolves without a request. */
      const third = w.f24.session(w.group).profile();
      const raced = await Promise.race([
        third.then(() => "done" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 5000)),
      ]);
      expect(raced).toBe("done");
      w.f24.session(w.group).end();
    }
    await w.destroy();
  }, 60_000);
});

describe("fiat24 flow gates and settlement reads", () => {
  it("returns a refusal entry when the user rejects the send, then discards the settled record", async () => {
    const calls = mergeCalls(
      transferCallTable({ rounds: 8, sender: OWNER, recipient: RECIPIENT }),
      liveTable(OWNER),
    );
    const { w } = await setup({ calls });
    const started = await w.f24.flows.start(w.group, {
      flow: "transfer",
      currency: "EUR24",
      amount: 100n,
      to: { address: RECIPIENT },
    });
    /* draft → ready is chain reads only; the send — and its request — is the second advance. */
    await w.f24.flows.advance(w.group, started.id);
    const advancing = w.f24.flows.advance(w.group, started.id);
    advancing.catch(() => undefined);
    await until(() => openRequests(w).length > 0, 5000);
    w.requests.reject(openRequests(w)[0]?.id ?? "");
    const settled = await advancing;
    /* The SDK puts the tx record back to ready on a rejection — nothing was broadcast. */
    expect(settled.refusal).toBe("rejected");
    expect(lastTx(settled.state)?.phase).toBe("ready");
    /* ready is discardable — the persisted record is deleted, the list empties. */
    await w.f24.flows.discard(w.group, started.id);
    await expect(w.f24.flows.list(w.group)).resolves.toStrictEqual([]);
    await w.destroy();
  }, 30_000);

  it("refuses new-exposure flows under a restricted or an unknown jurisdiction", async () => {
    const calls = mergeCalls(onboardingTable({ owner: OWNER }), liveTable(OWNER));
    /* Jurisdiction flips to close-only between the init eligibility answer and the start. */
    let jurisdiction: "available" | "close-only" | "blocked" = "available";
    const api = makeFiat24ApiFetch({});
    const chain = makeFiat24Chain({
      calls,
      storage: honestStorage(),
      count: { pending: NONCE, latest: NONCE },
    });
    const w = await world(0, {
      fiat24: { fetch: api.fetch },
      arb1: chain.arb1,
      hl: {
        eligibility: () => ({
          country: "US",
          region: null,
          apps: { fiat24: jurisdiction },
        }),
      },
    });
    await w.apps.acknowledgeTerms(w.group, "fiat24");
    await w.apps.enable(w.group, "fiat24");
    jurisdiction = "close-only";
    await w.apps.refreshEligibility();
    await expect(
      w.f24.flows.start(w.group, { flow: "onboarding", tokenId: 469710n, payment: "eth" }),
    ).rejects.toMatchObject({ category: "close-only" });
    /* A blocked answer is an unknown availability for enable purposes — the flow gate reads
       `unavailable`, never `close-only`. */
    jurisdiction = "blocked";
    await w.apps.refreshEligibility();
    await expect(
      w.f24.flows.start(w.group, { flow: "onboarding", tokenId: 469710n, payment: "eth" }),
    ).rejects.toMatchObject({ category: "unavailable" });
    await w.destroy();
  }, 30_000);

  it("refuses settlement reads on unknown, undecodable and non-payout flows", async () => {
    const calls = mergeCalls(
      transferCallTable({ rounds: 4, sender: OWNER, recipient: RECIPIENT }),
      liveTable(OWNER),
    );
    const { w } = await setup({ calls });
    await expect(w.f24.flows.payoutSettlement(w.group, "deadbeef")).rejects.toMatchObject({
      category: "unknown-flow",
    });
    const started = await w.f24.flows.start(w.group, {
      flow: "transfer",
      currency: "EUR24",
      amount: 100n,
      to: { address: RECIPIENT },
    });
    await expect(w.f24.flows.payoutSettlement(w.group, started.id)).rejects.toMatchObject({
      category: "invalid-input",
    });
    await w.store
      .collection("apps.fiat24")
      .put(`${w.walletId}/0/flow/bad0bad0`, new TextEncoder().encode("{ corrupt"));
    await expect(w.f24.flows.payoutSettlement(w.group, "bad0bad0")).rejects.toMatchObject({
      category: "protocol",
      code: "invalid-state",
    });
    await w.destroy();
  }, 30_000);

  it("refuses a payout's first advance without the api — the SDK session is absent", async () => {
    const calls = mergeCalls(liveTable(OWNER, 8), availabilityEntries({}));
    const { w } = await setup({ calls, api: false });
    /* A bank target's first advance needs the secured session for `/verify`. */
    const started = await w.f24.flows.start(w.group, {
      flow: "payout",
      currency: "EUR24",
      amount: 100n,
      target: {
        kind: "bank",
        request: {
          account: "PII-IBAN-SECRET",
          bankName: "PII-BANK",
          bic: "PIIBICXX",
          purpose: 2n,
          creditor: { name: "PII-PAYEE", street: "s", city: "c", zip: "z", country: "CH" },
        },
      },
    });
    await expect(w.f24.flows.advance(w.group, started.id)).rejects.toMatchObject({
      category: "api-unavailable",
    });
    /* The draft stays in memory — the host can advance it again once the api exists. */
    await expect(w.f24.flows.list(w.group)).resolves.toHaveLength(1);
    await w.destroy();
  }, 30_000);
});

describe("fiat24 api-unavailable advances", () => {
  const MINT_HASH: `0x${string}` = `0x${"ab".repeat(32)}`;
  /** The Swiss QR bill payload from the SDK's own docs — CHF 1949.75 on a Liechtenstein IBAN. */
  const DOC_QR = decodeURIComponent(
    "SPC%0D%0A0200%0D%0A1%0D%0ALI7830174502999200012%0D%0AS%0D%0ARobert%20Schneider%20AG%0D%0A" +
      "Musterstrasse%0D%0A18%0D%0A9490%0D%0AVaduz%0D%0ALI%0D%0A%0D%0A%0D%0A%0D%0A%0D%0A%0D%0A" +
      "%0D%0A%0D%0A1949.75%0D%0ACHF%0D%0AS%0D%0AHans%20Mustermann%0D%0AMusterstrasse%0D%0A27a" +
      "%0D%0A9490%0D%0AVaduz%0D%0ALI%0D%0AQRR%0D%0A210000000003139471430009017%0D%0AAuftrag%20vom" +
      "%2015.06.2020%0D%0AEPD%0D%0A%2F%2FS1%2F11%2F200427%2F30%2F102673386%2F31%2F200427%2F32%2F" +
      "7.7%2F40%2F0%3A30",
  );

  const forge = async (w: World, id: string, state: FlowState): Promise<void> => {
    await w.store
      .collection("apps.fiat24")
      .put(`${w.walletId}/0/flow/${id}`, new TextEncoder().encode(encodeFlowState(state)));
  };

  it("refuses a payout draft's Swiss-QR verify without the api", async () => {
    const calls = mergeCalls(liveTable(OWNER, 4), availabilityEntries({}));
    const { w } = await setup({ calls, api: false });
    const started = await w.f24.flows.start(w.group, {
      flow: "payout",
      currency: "CHF24",
      amount: 194975n,
      target: { kind: "swiss-qr", qr: DOC_QR },
    });
    await expect(w.f24.flows.advance(w.group, started.id)).rejects.toMatchObject({
      category: "api-unavailable",
    });
    await w.destroy();
  }, 30_000);

  it("still verifies a contact payout draft without the api — no session involved", async () => {
    const calls = mergeCalls(liveTable(OWNER, 4), availabilityEntries({}));
    const { w } = await setup({ calls, api: false });
    const started = await w.f24.flows.start(w.group, {
      flow: "payout",
      currency: "EUR24",
      amount: 100n,
      target: { kind: "contact", contactId: "EA-123456" },
    });
    const verified = await w.f24.flows.advance(w.group, started.id);
    expect(verified.state.step).toBe("verified");
    const stored = await storedText(w, started.id);
    expect(decodeFlowState(stored ?? "").flow).toBe("payout");
    await w.destroy();
  }, 30_000);

  it("sends a verified payout without the api — the write leg is chain-only", async () => {
    const calls = mergeCalls(
      payoutTable({
        owner: OWNER,
        tokenId: SENDER_ID,
        purposeId: 2n,
        ref: "469709-50fb0941-4f59-4a89-8735-dd78ba7d53a3",
      }),
      liveTable(OWNER),
    );
    const { w, chain } = await setup({ calls, api: false });
    await forge(w, "apip0001", {
      flow: "payout",
      version: 1,
      owner: OWNER,
      txs: [],
      step: "verified",
      tokenId: SENDER_ID,
      currency: "EUR24",
      amount: 100n,
      contactId: "EA-123456",
      purposeId: 2n,
      ref: "469709-50fb0941-4f59-4a89-8735-dd78ba7d53a3",
    });
    const sending = w.f24.flows.advance(w.group, "apip0001");
    sending.catch(() => undefined);
    await until(() => openRequests(w).length === 1, 5000);
    await approveNext(w);
    const sent = await sending;
    expect(sent.state.step).toBe("tx");
    expect(chain.sent).toHaveLength(1);
    await w.destroy();
  }, 30_000);

  it("refuses a card API write at ready without the api", async () => {
    const { w } = await setup({ calls: liveTable(OWNER), api: false });
    await forge(w, "apic0001", {
      flow: "card",
      version: 1,
      owner: OWNER,
      txs: [],
      step: "ready",
      tokenId: SENDER_ID,
      operation: { kind: "block", externalId: "123456" },
    });
    await expect(w.f24.flows.advance(w.group, "apic0001")).rejects.toMatchObject({
      category: "api-unavailable",
    });
    await w.destroy();
  }, 30_000);

  it.each(["ready", "sending", "unknown"] as const)(
    "refuses a card %s write record without the api — the write reconciles by GET /cards",
    async (phase) => {
      const { w } = await setup({ calls: liveTable(OWNER), api: false });
      await forge(w, "apic0002", {
        flow: "card",
        version: 1,
        owner: OWNER,
        txs: [
          {
            purpose: "main",
            phase,
            ...(phase === "unknown" ? { error: "unknown-outcome" as const } : {}),
          },
        ],
        step: "tx",
        tokenId: SENDER_ID,
        operation: { kind: "block", externalId: "123456" },
      });
      await expect(w.f24.flows.advance(w.group, "apic0002")).rejects.toMatchObject({
        category: "api-unavailable",
      });
      await w.destroy();
    },
    30_000,
  );

  it("refuses the card write reached after a satisfied cap — the residual the SDK throws", async () => {
    /* `cap` is a chain leg `needsApi` cannot call statically: the SDK reads the allowance first
       and only then falls into `advanceApiWrite` → `session-required`, mapped to api-unavailable. */
    const calls = mergeCalls(
      cardTable({ owner: OWNER, tokenId: SENDER_ID, allowance: 100n }),
      liveTable(OWNER),
    );
    const { w } = await setup({ calls, api: false });
    await forge(w, "apic0003", {
      flow: "card",
      version: 1,
      owner: OWNER,
      txs: [],
      step: "ready",
      tokenId: SENDER_ID,
      operation: { kind: "create" },
      cap: { currency: "EUR24", amount: 100n },
    });
    await expect(w.f24.flows.advance(w.group, "apic0003")).rejects.toMatchObject({
      category: "api-unavailable",
    });
    await w.destroy();
  }, 30_000);

  it("sends the cap approve leg without the api when the allowance misses", async () => {
    const calls = mergeCalls(
      cardTable({ owner: OWNER, tokenId: SENDER_ID, allowance: 0n }),
      liveTable(OWNER),
    );
    const { w, chain } = await setup({ calls, api: false });
    await forge(w, "apic0004", {
      flow: "card",
      version: 1,
      owner: OWNER,
      txs: [],
      step: "ready",
      tokenId: SENDER_ID,
      operation: { kind: "create" },
      cap: { currency: "EUR24", amount: 100n },
    });
    const sending = w.f24.flows.advance(w.group, "apic0004");
    sending.catch(() => undefined);
    await until(() => openRequests(w).length === 1, 5000);
    await approveNext(w);
    const sent = await sending;
    expect(sent.state.step).toBe("tx");
    expect(chain.sent).toHaveLength(1);
    await w.destroy();
  }, 30_000);

  it("confirms a set-cap whose allowance already matches — no api, no request", async () => {
    const calls = mergeCalls(
      cardTable({ owner: OWNER, tokenId: SENDER_ID, allowance: 50n }),
      liveTable(OWNER),
    );
    const { w, chain } = await setup({ calls, api: false });
    await forge(w, "apic0005", {
      flow: "card",
      version: 1,
      owner: OWNER,
      txs: [],
      step: "ready",
      tokenId: SENDER_ID,
      operation: { kind: "set-cap", currency: "EUR24", amount: 50n },
    });
    const done = await w.f24.flows.advance(w.group, "apic0005");
    expect(done.state.step).toBe("confirmed");
    expect(openRequests(w)).toStrictEqual([]);
    expect(chain.sent).toHaveLength(0);
    await w.destroy();
  }, 30_000);

  it("reconciles an in-flight cap approve without the api", async () => {
    const { w, chain } = await setup({ calls: liveTable(OWNER), api: false, autoBlock: true });
    await forge(w, "apic0006", {
      flow: "card",
      version: 1,
      owner: OWNER,
      txs: [{ purpose: "approve", phase: "sending", fromBlock: B, nonce: NONCE }],
      step: "tx",
      tokenId: SENDER_ID,
      operation: { kind: "create" },
      cap: { currency: "EUR24", amount: 100n },
    });
    const done = await w.f24.flows.advance(w.group, "apic0006");
    expect(done.state.step).toBe("not-sent");
    expect(chain.sent).toHaveLength(0);
    await w.destroy();
  }, 30_000);

  it.each(["tourist", "kyc"] as const)(
    "refuses an onboarding %s poll without the api",
    async (step) => {
      const { w } = await setup({ calls: liveTable(OWNER), api: false });
      await forge(w, `apio${step === "tourist" ? "0001" : "0002"}`, {
        flow: "onboarding",
        version: 1,
        owner: OWNER,
        txs: [{ purpose: "main", phase: "confirmed", fromBlock: B, nonce: NONCE, hash: MINT_HASH }],
        step,
        tokenId: SENDER_ID,
        payment: "eth",
        quote: { input: 1000n, blockNumber: B },
        ...(step === "kyc" ? { kyc: "pending-scan" as const } : {}),
      });
      await expect(
        w.f24.flows.advance(w.group, `apio${step === "tourist" ? "0001" : "0002"}`),
      ).rejects.toMatchObject({ category: "api-unavailable" });
      await w.destroy();
    },
    30_000,
  );

  it("reconciles an in-flight onboarding mint without the api", async () => {
    const { w, chain } = await setup({ calls: liveTable(OWNER), api: false, autoBlock: true });
    await forge(w, "apio0003", {
      flow: "onboarding",
      version: 1,
      owner: OWNER,
      txs: [{ purpose: "main", phase: "sending", fromBlock: B, nonce: NONCE }],
      step: "tx",
      tokenId: SENDER_ID,
      payment: "eth",
      quote: { input: 1000n, blockNumber: B },
    });
    const done = await w.f24.flows.advance(w.group, "apio0003");
    expect(done.state.step).toBe("not-sent");
    expect(chain.sent).toHaveLength(0);
    await w.destroy();
  }, 30_000);
});
