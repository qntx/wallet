import { HyperliquidError } from "../src/apps/hyperliquid/errors.ts";
import { createMemoryEngineStore } from "../src/store/memory.ts";
import {
  agentAddress,
  DAY,
  describe,
  expect,
  finishFlow,
  isApprovePost,
  it,
  kernelAgents,
  pumpUntil,
  requestId,
  restoredStatus,
  swallow,
  tick,
  until,
  VERIFY,
  world,
} from "./apps-helpers.ts";
import type { HlState } from "./apps-helpers.ts";

describe("apps hyperliquid enablement on the node host", () => {
  it("enables through the approval request and leaves no orphan", async () => {
    const w = await world(10);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    await finishFlow(w, done, "enabled");
    expect(w.state()?.status).toBe("enabled");
    expect(agentAddress(w)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // The kernel-held agent is listed and marked — trading would now sign.
    await expect(kernelAgents(w)).resolves.toHaveLength(1);
    // The approveAgent POST carried the kernel-bound agentName.
    const post = w.posted.find(isApprovePost);
    expect(post).toBeDefined();
    const action = post?.body["action"] as { agentName?: string } | undefined;
    expect(String(action?.agentName)).toContain("valid_until");
    await w.destroy();
  });

  it("request rejected: cleans the orphan agent and disables", async () => {
    const w = await world(11);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    void swallow(done);
    await until(() => w.state()?.requestId !== undefined);
    w.requests.reject(requestId(w));
    await until(() => w.state()?.status === "disabled");
    await expect(done).rejects.toBeInstanceOf(HyperliquidError);
    expect(w.state()?.agent).toBeUndefined();
    expect(w.state()?.error?.category).toBe("approval-rejected");
    // The definitive failure deleted the kernel agent Hyperliquid never approved.
    await expect(kernelAgents(w)).resolves.toHaveLength(0);
    await w.destroy();
  });

  it("POST status:err: cleans the orphan agent and disables", async () => {
    const w = await world(12, { hl: { exchange: () => ({ status: "err", response: "nope" }) } });
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    void swallow(done);
    await until(() => w.state()?.requestId !== undefined);
    await w.approve(requestId(w));
    await until(() => w.state()?.status === "disabled");
    await expect(done).rejects.toBeInstanceOf(HyperliquidError);
    await expect(kernelAgents(w)).resolves.toHaveLength(0);
    expect(w.state()?.error?.category).toBe("rejected");
    await w.destroy();
  });

  it(
    "lost POST + never listed: retries verify then cleans the orphan",
    { timeout: 30000 },
    async () => {
      const w = await world(13, { hl: { exchangeError: () => undefined } });
      await w.apps.acknowledgeTerms(w.group, "hyperliquid");
      const done = w.apps.enable(w.group, "hyperliquid");
      let settled = false;
      void (async () => {
        await swallow(done);
        settled = true;
      })();
      await until(() => w.state()?.requestId !== undefined);
      await w.approve(requestId(w));
      // The POST threw; the flow goes to verify — extraAgents stays empty for 30 s of polls.
      await pumpUntil(w.timers, () => settled, 300);
      await expect(done).rejects.toBeInstanceOf(HyperliquidError);
      await until(() => w.state()?.status === "disabled");
      await expect(kernelAgents(w)).resolves.toHaveLength(0);
      await w.destroy();
    },
  );

  it("cancel cannot delete the enabled agent; cancel mid-flow cleans the unenabled one", async () => {
    const w = await world(14);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    // Enable fully first.
    await finishFlow(w, w.apps.enable(w.group, "hyperliquid"), "enabled");
    const enabled = agentAddress(w);
    expect(enabled).not.toBe("");
    // Cancel against an enabled agent is invalid-input and deletes nothing.
    await expect(w.apps.cancel(w.group, "hyperliquid")).rejects.toMatchObject({
      category: "invalid-input",
    });
    await expect(kernelAgents(w)).resolves.toHaveLength(1);
    expect(w.state()?.status).toBe("enabled");
    // Cancel mid-enable (waiting on the request) aborts and cleans.
    const w2 = await world(15);
    await w2.apps.acknowledgeTerms(w2.group, "hyperliquid");
    const done = w2.apps.enable(w2.group, "hyperliquid");
    void swallow(done);
    await until(() => w2.state()?.requestId !== undefined);
    await w2.apps.cancel(w2.group, "hyperliquid");
    await expect(done).rejects.toBeInstanceOf(HyperliquidError);
    await until(() => w2.state()?.status === "disabled");
    await expect(kernelAgents(w2)).resolves.toHaveLength(0);
    await w.destroy();
    await w2.destroy();
  });

  it("a second flow while one runs is busy; acknowledging terms does not stale it", async () => {
    const w = await world(16);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    await until(() => w.state()?.requestId !== undefined);
    // Concurrent flows for the same group are busy.
    await expect(w.apps.enable(w.group, "hyperliquid")).rejects.toMatchObject({
      category: "busy",
    });
    await expect(w.apps.disable(w.group, "hyperliquid", { revoke: false })).rejects.toMatchObject({
      category: "busy",
    });
    // Acknowledging terms mid-flow must not supersede the running generation.
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    await finishFlow(w, done, "enabled");
    expect(w.state()?.status).toBe("enabled");
    await w.destroy();
  });

  it("disable without revoke deletes the kernel agent; revoke signs and cleans the throwaway", async () => {
    const w = await world(17);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    await finishFlow(w, w.apps.enable(w.group, "hyperliquid"), "enabled");
    /* Revoke: the throwaway ApproveAgent request must sign under the kernel binding — a second
       clock read for `valid_until` would make the kernel reject it. */
    const done = w.apps.disable(w.group, "hyperliquid", { revoke: true });
    await until(() => w.state()?.requestId !== undefined);
    await w.approve(requestId(w));
    await until(() => w.state()?.status === "disabled");
    await done;
    await expect(kernelAgents(w)).resolves.toHaveLength(0);
    expect(w.posted.filter(isApprovePost)).toHaveLength(2); // enable + revoke
    await w.destroy();
  });

  it("renew failure cleans the new agent and restores the old enabled state", async () => {
    const w = await world(18);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    await finishFlow(w, w.apps.enable(w.group, "hyperliquid"), "enabled");
    const oldAddress = agentAddress(w);
    w.hl.exchange = () => ({ status: "err", response: "renew denied" });
    const done = w.apps.renew(w.group, "hyperliquid");
    void swallow(done);
    await until(() => w.state()?.requestId !== undefined);
    await w.approve(requestId(w));
    await until(() => restoredStatus(w));
    await expect(done).rejects.toBeInstanceOf(HyperliquidError);
    expect(w.state()?.status).toBe("enabled");
    expect(agentAddress(w)).toBe(oldAddress);
    // Only the old agent survives — the failed renewal deleted its candidate.
    const agents = await kernelAgents(w);
    expect(agents.map((a) => a.address.toLowerCase())).toStrictEqual([oldAddress.toLowerCase()]);
    await w.destroy();
  });

  it("locked host methods throw unlock-required and lock closes the store", async () => {
    const w = await world(19);
    let closed = 0;
    const tracked = w.store as { close: () => Promise<void> };
    tracked.close = async () => {
      closed += 1;
      await Promise.resolve();
    };
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    await w.wallet.vault.lock();
    await until(() => w.apps.getState().locked, 2000);
    await expect(w.apps.acknowledgeTerms(w.group, "hyperliquid")).rejects.toMatchObject({
      category: "unlock-required",
    });
    await expect(w.apps.enable(w.group, "hyperliquid")).rejects.toMatchObject({
      category: "unlock-required",
    });
    expect(closed).toBe(1);
    await w.wallet.vault.unlock(VERIFY);
    await w.destroy();
  });

  it("persisted record keeps only termsAcknowledged and the last enabled agent", async () => {
    const w = await world(20);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    await finishFlow(w, w.apps.enable(w.group, "hyperliquid"), "enabled");
    const enabled = agentAddress(w);
    await tick();
    const key = `${w.walletId}/20/hyperliquid`;
    const raw = await w.store.collection("apps").get(key);
    expect(raw).toBeDefined();
    const record = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    expect(Object.keys(record).toSorted()).toStrictEqual(["enabledAgent", "termsAcknowledged"]);
    expect(record["termsAcknowledged"]).toBe(true);
    expect(record["enabledAgent"]).toBe(enabled);
    await w.destroy();
  });

  it("reconcile on unlock covers a kernel agent without a persisted record", async () => {
    // Enable on a first world, then a second world (fresh store) reconciles group 24's kernel
    // agent even though the store knows nothing about it.
    const w1 = await world(24);
    await w1.apps.acknowledgeTerms(w1.group, "hyperliquid");
    await finishFlow(w1, w1.apps.enable(w1.group, "hyperliquid"), "enabled");
    const agent = agentAddress(w1);
    await w1.destroy();
    const hl2: HlState = { listed: new Map(), maxBuilderFee: 0, role: "user" };
    hl2.listed.set(agent, {
      address: agent,
      name: "qntx-test",
      validUntil: Date.now() + 179 * DAY,
    });
    const w2 = await world(24, { store: createMemoryEngineStore(), hl: hl2 });
    // The kernel agent existed for group 24 — the union reconcile sees it (enabled on HL).
    await until(() => w2.state()?.status === "enabled", 2000);
    expect(w2.state()?.status).toBe("enabled");
    await w2.destroy();
  });

  it("user-signed POST: malformed answer and transport failure are unknown, never rejected", async () => {
    const w = await world(25, { hl: { exchange: () => ({ unexpected: true }) } });
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const pending = await w.provider.transfer.toPerp(w.group, "1");
    await w.approve(pending.requestId);
    await expect(pending.outcome).resolves.toStrictEqual({ kind: "unknown" });
    // A signed action was posted — a malformed answer may have committed.
    expect(w.posted.some((p) => p.endpoint === "exchange")).toBe(true);
    // Transport failure is unknown too.
    delete (w.hl as { exchange?: unknown }).exchange;
    w.hl.exchangeError = () => undefined;
    const pending2 = await w.provider.transfer.toPerp(w.group, "1");
    await w.approve(pending2.requestId);
    await expect(pending2.outcome).resolves.toStrictEqual({ kind: "unknown" });
    await w.destroy();
  });

  it("transfer typed-data is signed by the owner and the kernel describes it", async () => {
    const w = await world(26);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const pending = await w.provider.transfer.toSpot(w.group, "2.5");
    const request = w.requests.getState().requests[pending.requestId];
    expect(request).toBeDefined();
    // The kernel decoded the user-signed typed data — the display is not blind.
    const message = (request as { display?: { message?: { hyperliquid?: unknown } } }).display
      ?.message?.hyperliquid;
    expect(message).toBeDefined();
    await w.approve(pending.requestId);
    await expect(pending.outcome).resolves.toStrictEqual({ kind: "ok" });
    const post = w.posted.find((p) => p.endpoint === "exchange");
    const body = post?.body as
      | { action?: Record<string, unknown>; signature?: { r: string } }
      | undefined;
    expect(body?.action?.["type"]).toBe("usdClassTransfer");
    // The posted action carries the signed fields plus type and signatureChainId.
    expect(body?.action?.["signatureChainId"]).toBe("0x66eee");
    expect(body?.action?.["amount"]).toBe("2.5");
    expect(body?.signature?.r).toMatch(/^0x[0-9a-f]{64}$/);
    await w.destroy();
  });

  it("deposit rejects below 5 USDC and prepares a send to Bridge2", async () => {
    const w = await world(27);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    await expect(
      w.provider.fund.deposit(w.group, { amount: 4_999_999n, fee: "normal" }),
    ).rejects.toMatchObject({ category: "invalid-input" });
    const pending = await w.provider.fund.deposit(w.group, {
      amount: 5_000_000n,
      fee: "normal",
    });
    const request = w.requests.getState().requests[pending.requestId];
    expect(request).toBeDefined();
    const { display } = request as {
      display?: { outflows?: Array<{ to?: string; token?: string }> };
    };
    expect(display?.outflows?.[0]?.to?.toLowerCase()).toBe(
      "0x08cfc1b6b2dcf36a1480b99353a354aa8ac56f89",
    );
    await w.destroy();
  });
});
