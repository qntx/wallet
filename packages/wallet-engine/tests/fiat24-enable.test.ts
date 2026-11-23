import { Fiat24AppError } from "../src/apps/fiat24/errors.ts";
/**
 * The Fiat24 enablement machine through `createApps` on the real node kernel: terms must be
 * acknowledged first; enable writes one `apps.fiat24` record and settles `enabled` with no request;
 * the state reconciles from the record across lock/unlock; disable deletes the record; the
 * controller's generic wallet-deletion prune drops foreign records; and eligibility `blocked`
 * refuses while `close-only` still enables.
 */
import type { EligibilityResponse } from "../src/gateway/contract/eligibility.ts";
import {
  describe,
  expect,
  it,
  until,
  untilGone,
  untilPresent,
  VERIFY,
  world,
} from "./apps-helpers.ts";

const enabledKey = (walletId: string, groupIndex: number): string =>
  `${walletId}/${groupIndex}/enabled`;

const record = async (w: Awaited<ReturnType<typeof world>>, walletId: string, groupIndex: number) =>
  w.store.collection("apps.fiat24").get(enabledKey(walletId, groupIndex));

const eligibility = (apps: Record<string, string>) => (): EligibilityResponse => ({
  country: "US",
  region: null,
  apps: { fiat24: "available", hyperliquid: "available", ...apps },
});

describe("apps fiat24 enablement on the node host", () => {
  it("refuses to enable before the terms are acknowledged", async () => {
    const w = await world(30, { hyperliquid: false, fiat24: true });
    await expect(w.apps.enable(w.group, "fiat24")).rejects.toBeInstanceOf(Fiat24AppError);
    expect(w.f24State()?.status).toBe("enabling");
    expect(w.f24State()?.error?.category).toBe("invalid-input");
    await expect(record(w, w.walletId, 30)).resolves.toBeUndefined();
    await w.destroy();
  });

  it("enables with no request and persists the provider record", async () => {
    const w = await world(31, { hyperliquid: false, fiat24: true });
    await w.apps.acknowledgeTerms(w.group, "fiat24");
    await w.apps.enable(w.group, "fiat24");
    expect(w.f24State()?.status).toBe("enabled");
    expect(w.f24State()?.requestId).toBeUndefined();
    const raw = await untilPresent(async () => record(w, w.walletId, 31));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    expect(parsed).toStrictEqual({});
    /* The generic record keeps only the terms flag. */
    const appRecord = await w.store.collection("apps").get(`${w.walletId}/31/fiat24`);
    const terms: unknown = JSON.parse(new TextDecoder().decode(appRecord));
    expect(terms).toStrictEqual({ termsAcknowledged: true });
    await w.destroy();
  });

  it("survives lock/unlock — the reconcile re-derives enabled from the record", async () => {
    const w = await world(32, { hyperliquid: false, fiat24: true });
    await w.apps.acknowledgeTerms(w.group, "fiat24");
    await w.apps.enable(w.group, "fiat24");
    await w.wallet.vault.lock();
    await until(() => w.apps.getState().locked, 2000);
    expect(w.f24State()).toBeUndefined();
    await expect(w.apps.enable(w.group, "fiat24")).rejects.toMatchObject({
      category: "unlock-required",
    });
    /* The owner derivation maps the kernel's `locked` the same way — never a kernel message. */
    await expect(w.f24.account(w.group)).rejects.toMatchObject({
      category: "unlock-required",
    });
    await w.wallet.vault.unlock(VERIFY);
    await until(() => w.f24State()?.status === "enabled", 2000);
    expect(await record(w, w.walletId, 32)).toBeDefined();
    await w.destroy();
  });

  it("a fresh session reconciles enabled from the persisted record", async () => {
    const w = await world(33, { hyperliquid: false, fiat24: true });
    await w.apps.acknowledgeTerms(w.group, "fiat24");
    await w.apps.enable(w.group, "fiat24");
    expect(await record(w, w.walletId, 33)).toBeDefined();
    /* A second world over the same store reconciles the same state — no flow ran. */
    const w2 = await world(33, { hyperliquid: false, fiat24: true, store: w.store });
    await until(() => w2.f24State()?.status === "enabled", 2000);
    await w2.destroy();
    await w.destroy();
  });

  it("disable deletes the record and settles disabled", async () => {
    const w = await world(34, { hyperliquid: false, fiat24: true });
    await w.apps.acknowledgeTerms(w.group, "fiat24");
    await w.apps.enable(w.group, "fiat24");
    expect(await record(w, w.walletId, 34)).toBeDefined();
    /* `revoke` has nothing to reach server-side — it disables the same way. */
    await w.apps.disable(w.group, "fiat24", { revoke: true });
    expect(w.f24State()?.status).toBe("disabled");
    await untilGone(async () => record(w, w.walletId, 34));
    await w.destroy();
  });

  it("a deleted wallet's enable records are pruned on the wallet event", async () => {
    const w = await world(35, { hyperliquid: false, fiat24: true });
    const second = await w.wallet.wallets.importMnemonic({
      mnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow",
    });
    const foreign = { walletId: second.walletId, groupIndex: 0 };
    await w.apps.acknowledgeTerms(foreign, "fiat24");
    await w.apps.enable(foreign, "fiat24");
    expect(await record(w, second.walletId, 0)).toBeDefined();
    await w.wallet.wallets.delete(second.walletId, VERIFY);
    await untilGone(async () => record(w, second.walletId, 0));
    await w.destroy();
  });

  it("blocked eligibility refuses enable; close-only still enables", async () => {
    const w = await world(36, {
      hyperliquid: false,
      fiat24: true,
      hl: { eligibility: eligibility({ fiat24: "blocked" }) },
    });
    await w.apps.acknowledgeTerms(w.group, "fiat24");
    expect(w.f24State()?.status).toBe("unavailable");
    await expect(w.apps.enable(w.group, "fiat24")).rejects.toMatchObject({
      category: "unavailable",
    });
    await w.destroy();

    const w2 = await world(37, {
      hyperliquid: false,
      fiat24: true,
      hl: { eligibility: eligibility({ fiat24: "close-only" }) },
    });
    await w2.apps.acknowledgeTerms(w2.group, "fiat24");
    await w2.apps.enable(w2.group, "fiat24");
    expect(w2.f24State()?.status).toBe("enabled");
    await w2.destroy();
  });

  it("a second enable on an enabled group is a no-op that stays enabled", async () => {
    const w = await world(38, { hyperliquid: false, fiat24: true });
    await w.apps.acknowledgeTerms(w.group, "fiat24");
    await w.apps.enable(w.group, "fiat24");
    await w.apps.enable(w.group, "fiat24");
    expect(w.f24State()?.status).toBe("enabled");
    await w.destroy();
  });

  it("renew re-runs enable and keeps the record and the enabled state", async () => {
    const w = await world(40, { hyperliquid: false, fiat24: true });
    await w.apps.acknowledgeTerms(w.group, "fiat24");
    await w.apps.enable(w.group, "fiat24");
    await w.apps.renew(w.group, "fiat24");
    expect(w.f24State()?.status).toBe("enabled");
    expect(await record(w, w.walletId, 40)).toBeDefined();
    await w.destroy();
  });

  it("cancel settles the flow disabled", async () => {
    const w = await world(41, { hyperliquid: false, fiat24: true });
    await w.apps.acknowledgeTerms(w.group, "fiat24");
    await w.apps.enable(w.group, "fiat24");
    await w.apps.cancel(w.group, "fiat24");
    expect(w.f24State()?.status).toBe("disabled");
    await w.destroy();
  });

  it("the group api reads the account over the configured arbitrum endpoint", async () => {
    const w = await world(39, { hyperliquid: false, fiat24: true });
    /* No arb1 answers are configured — the read must fail as a protocol rpc-error. */
    await expect(w.f24.account(w.group)).rejects.toBeInstanceOf(Fiat24AppError);
    /* A wallet the kernel does not know collapses to `unavailable` — not a kernel message. */
    await expect(w.f24.account({ walletId: "nope", groupIndex: 0 })).rejects.toMatchObject({
      category: "unavailable",
    });
    await w.destroy();
  });
});
