/**
 * Eligibility gating: the controller fetches `/v1/eligibility` through the gateway client on every
 * unlock and on `refreshEligibility`, overlays `unavailable` on disabled groups in blocked
 * jurisdictions, and refuses `enable`/`renew` unless the app is `available` — `unknown`/`error`
 * refuse too (fail closed). `disable`/`cancel`/trading stay ungated: this is a UI boundary only.
 */
import type { EligibilityResponse } from "../src/gateway/contract/eligibility.ts";
import { describe, expect, finishFlow, it, swallow, until, world } from "./apps-helpers.ts";

const BLOCKED = (): EligibilityResponse => ({
  country: "US",
  region: null,
  apps: { hyperliquid: "blocked", polymarket: "available" },
});
const AVAILABLE = (): EligibilityResponse => ({
  country: "FR",
  region: null,
  apps: { hyperliquid: "available", polymarket: "available" },
});

describe("apps eligibility", () => {
  it("fetches eligibility on unlock and keeps the answer in state", async () => {
    const w = await world(0, { hl: { eligibility: AVAILABLE } });
    const { eligibility } = w.apps.getState();
    expect(eligibility.status).toBe("ready");
    expect(eligibility.country).toBe("FR");
    expect(eligibility.checkedAt).toBeTypeOf("number");
    await w.destroy();
  });

  it("refuses enable when the app is blocked — the group overlays to unavailable", async () => {
    const w = await world(0, { hl: { eligibility: BLOCKED } });
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    /* A would-be "disabled" write under a ready-blocked jurisdiction reads `unavailable`. */
    expect(w.state()?.status).toBe("unavailable");
    await expect(w.apps.enable(w.group, "hyperliquid")).rejects.toMatchObject({
      category: "unavailable",
    });
    await expect(w.apps.renew(w.group, "hyperliquid")).rejects.toMatchObject({
      category: "unavailable",
    });
    await w.destroy();
  });

  it("refuses enable while eligibility is error — fail closed", async () => {
    const w = await world(0, {
      hl: {
        eligibility: () => {
          throw new Error("gateway down");
        },
      },
    });
    expect(w.apps.getState().eligibility.status).toBe("error");
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    /* The overlay only applies under a ready answer — the group stays `disabled`. */
    expect(w.state()?.status).toBe("disabled");
    await expect(w.apps.enable(w.group, "hyperliquid")).rejects.toMatchObject({
      category: "unavailable",
    });
    await w.destroy();
  });

  it("an app absent from a ready answer is unknown — enable refused, no overlay", async () => {
    const w = await world(0, {
      hl: {
        eligibility: () => ({
          country: "FR",
          region: null,
          /* The gateway's config decides which apps appear — hyperliquid is simply absent. */
          apps: { polymarket: "available" },
        }),
      },
    });
    expect(w.apps.getState().eligibility.status).toBe("ready");
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    /* An absent app is not `blocked` — the overlay does not apply, the group stays disabled. */
    expect(w.state()?.status).toBe("disabled");
    await expect(w.apps.enable(w.group, "hyperliquid")).rejects.toMatchObject({
      category: "unavailable",
    });
    await expect(w.apps.renew(w.group, "hyperliquid")).rejects.toMatchObject({
      category: "unavailable",
    });
    await w.destroy();
  });

  it("a malformed gateway answer leaves eligibility in error", async () => {
    const w = await world(0, {
      hl: {
        eligibility: () =>
          ({ country: 42, apps: { hyperliquid: "yes" } }) as unknown as ReturnType<typeof BLOCKED>,
      },
    });
    expect(w.apps.getState().eligibility.status).toBe("error");
    await expect(w.apps.enable(w.group, "hyperliquid")).rejects.toMatchObject({
      category: "unavailable",
    });
    await w.destroy();
  });

  it("refreshEligibility sweeps the overlay on and off disabled groups", async () => {
    const w = await world(0, { hl: { eligibility: AVAILABLE } });
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    expect(w.state()?.status).toBe("disabled");
    /* Jurisdiction change: blocked answers now overlay the group. */
    w.hl.eligibility = BLOCKED;
    await w.apps.refreshEligibility();
    expect(w.state()?.status).toBe("unavailable");
    /* Back to available lifts the overlay again. */
    w.hl.eligibility = AVAILABLE;
    await w.apps.refreshEligibility();
    expect(w.state()?.status).toBe("disabled");
    await w.destroy();
  });

  it("never overlays enabled groups — the user can still disable under blocked", async () => {
    const w = await world(0, { hl: { eligibility: AVAILABLE } });
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    await finishFlow(w, done, "enabled");
    /* The jurisdiction turns blocked afterwards: status stays enabled, disable still runs. */
    w.hl.eligibility = BLOCKED;
    await w.apps.refreshEligibility();
    expect(w.state()?.status).toBe("enabled");
    /* No request needed without revoke — disable runs to completion under the overlay. */
    await w.apps.disable(w.group, "hyperliquid", { revoke: false });
    expect(w.state()?.status).toBe("unavailable");
    await w.destroy();
  });

  it("each app gates on its own enableWhen — the eligibility matrix", async () => {
    let eligibility: () => EligibilityResponse = () => ({
      country: "FR",
      region: null,
      apps: { hyperliquid: "close-only", polymarket: "close-only" },
    });
    const w = await world(0, {
      polymarket: {},
      hl: { eligibility: () => eligibility() },
    });
    const enable = async (app: "hyperliquid" | "polymarket") => w.apps.enable(w.group, app);
    /* close-only: the Polymarket definition admits it — `invalid-input` (unacknowledged terms)
       means the flow started; Hyperliquid's does not — the gate refuses before the flow runs. */
    await expect(enable("hyperliquid")).rejects.toMatchObject({ category: "unavailable" });
    await expect(enable("polymarket")).rejects.toMatchObject({ category: "invalid-input" });
    /* blocked refuses both — each in the app's own error category. */
    eligibility = () => ({
      country: "FR",
      region: null,
      apps: { hyperliquid: "blocked", polymarket: "blocked" },
    });
    await w.apps.refreshEligibility();
    await expect(enable("hyperliquid")).rejects.toMatchObject({ category: "unavailable" });
    await expect(enable("polymarket")).rejects.toMatchObject({ category: "blocked" });
    /* An app absent from a ready answer is unknown — refused like a non-ready answer. */
    eligibility = () => ({
      country: "FR",
      region: null,
      apps: { polymarket: "available" },
    });
    await w.apps.refreshEligibility();
    await expect(enable("hyperliquid")).rejects.toMatchObject({ category: "unavailable" });
    eligibility = () => ({
      country: "FR",
      region: null,
      apps: { hyperliquid: "available" },
    });
    await w.apps.refreshEligibility();
    await expect(enable("polymarket")).rejects.toMatchObject({ category: "blocked" });
    /* An eligibility error fails closed. */
    eligibility = () => {
      throw new Error("gateway down");
    };
    await w.apps.refreshEligibility();
    await expect(enable("hyperliquid")).rejects.toMatchObject({ category: "unavailable" });
    await expect(enable("polymarket")).rejects.toMatchObject({ category: "blocked" });
    /* `available` starts both: Hyperliquid proceeds to its approval request (then cancelled);
       Polymarket runs and refuses inside on unacknowledged terms. */
    eligibility = AVAILABLE;
    await w.apps.refreshEligibility();
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const started = w.apps.enable(w.group, "hyperliquid");
    void swallow(started);
    await until(() => w.state()?.requestId !== undefined);
    await w.apps.cancel(w.group, "hyperliquid");
    await swallow(started);
    await expect(enable("polymarket")).rejects.toMatchObject({ category: "invalid-input" });
    await w.destroy();
  }, 30000);

  it("a running flow isolates per group+app — the sibling is neither busy nor staled", async () => {
    const w = await world(0, { polymarket: {}, hl: { eligibility: AVAILABLE } });
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const started = w.apps.enable(w.group, "hyperliquid");
    void swallow(started);
    /* Parked at the approval request — a group-keyed `busy` would refuse the other app's flow. */
    await until(() => w.state()?.requestId !== undefined);
    await w.apps.disable(w.group, "polymarket", { revoke: false });
    /* A group-keyed `flowGen` bump would stale the Hyperliquid view — its writes must land. */
    await swallow(w.apps.cancel(w.group, "polymarket"));
    await finishFlow(w, started, "enabled");
    expect(w.state()?.status).toBe("enabled");
    await w.destroy();
  }, 30000);
});
