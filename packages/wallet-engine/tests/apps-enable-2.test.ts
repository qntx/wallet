/**
 * The rest of the enablement matrix on the real Node kernel: independent EIP-712 recovery of every
 * user-signed action against the SDK's `…Types` constants, the builder approval flow, verify
 * timeout, createAgent failure, lock mid-flow, terms persistence across sessions, renew ordering,
 * the reconcile matrix, and posted transfer shapes.
 */
import { readFileSync } from "node:fs";

import {
  ApproveAgentTypes,
  ApproveBuilderFeeTypes,
  SpotSendTypes,
  UsdClassTransferTypes,
  UsdSendTypes,
  Withdraw3Types,
} from "@nktkas/hyperliquid/api/exchange";
import { concat, hashDomain, hashStruct, keccak256, recoverAddress } from "viem";

import { chains } from "@qntx/wallet/chains";
import { hyperliquid } from "@qntx/wallet/hyperliquid";

import type { HyperliquidProviderInternals } from "../src/apps/hyperliquid/provider.ts";
import {
  agentAddress,
  DAY,
  describe,
  expect,
  finishFlow,
  it,
  kernelAgents,
  pumpUntil,
  requestId,
  restartableStore,
  swallow,
  until,
  VERIFY,
  world,
} from "./apps-helpers.ts";
import type { World } from "./apps-helpers.ts";

const fixture = (name: string): { response: unknown } =>
  JSON.parse(
    readFileSync(new URL(`fixtures/hyperliquid/testnet/${name}.json`, import.meta.url), "utf8"),
  ) as { response: unknown };

const ZERO = "0x0000000000000000000000000000000000000000";
const EIP712_DOMAIN = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

const USER_SIGNED_TYPES: Record<
  string,
  Record<string, ReadonlyArray<{ name: string; type: string }>>
> = {
  approveAgent: ApproveAgentTypes,
  approveBuilderFee: ApproveBuilderFeeTypes,
  usdClassTransfer: UsdClassTransferTypes,
  usdSend: UsdSendTypes,
  spotSend: SpotSendTypes,
  withdraw3: Withdraw3Types,
};

const ownerOf = async (w: World): Promise<string> => {
  const account = await chains(w.wallet).account({
    walletId: w.walletId,
    groupIndex: w.group.groupIndex,
    template: "evm.bip44",
    network: "eip155:421614",
  });
  return "address" in account ? account.address : "";
};

/**
 * Rebuild the EIP-712 document from the POSTED action (never from our builder) using the SDK's own
 * type constants, and recover the signer — it must be the group's owner. viem's
 * `recoverTypedDataAddress` validates struct names and rejects the `:` in Hyperliquid's
 * `HyperliquidTransaction:*` primary types, so the digest is assembled manually with
 * `hashDomain`/`hashStruct`, which encode without validating the reference name.
 */
const recoverSigner = async (body: Record<string, unknown>): Promise<string> => {
  const action = body["action"] as Record<string, unknown>;
  const type = String(action["type"]);
  const types = USER_SIGNED_TYPES[type];
  expect(types).toBeDefined();
  const [primaryType] = Object.keys(types ?? {});
  const fields = types?.[primaryType ?? ""] ?? [];
  const message = Object.fromEntries(fields.map((f) => [f.name, action[f.name]]));
  const domainSeparator = hashDomain({
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 421614n,
      verifyingContract: ZERO,
    },
    types: { EIP712Domain: [...EIP712_DOMAIN] },
  });
  const structHash = hashStruct({
    data: message,
    primaryType: primaryType ?? "",
    types: { [primaryType ?? ""]: fields },
  });
  const digest = keccak256(concat(["0x1901", domainSeparator, structHash]));
  const signature = body["signature"] as { r: string; s: string; v: number };
  const hex = `0x${signature.r.slice(2)}${signature.s.slice(2)}${signature.v
    .toString(16)
    .padStart(2, "0")}` as `0x${string}`;
  return recoverAddress({ hash: digest, signature: hex });
};

const postedAction = (w: World, type: string): Record<string, unknown> => {
  const post = w.posted.find(
    (p) =>
      p.endpoint === "exchange" && (p.body["action"] as Record<string, unknown>)["type"] === type,
  );
  expect(post).toBeDefined();
  return post?.body ?? {};
};

const hlKind = (w: World, id: string): unknown =>
  (
    w.requests.getState().requests[id] as {
      display?: { message?: { hyperliquid?: { kind?: string } }; verifiability?: string };
    }
  ).display?.message?.hyperliquid?.kind;

const verifiability = (w: World, id: string): unknown =>
  (w.requests.getState().requests[id] as { display?: { verifiability?: string } }).display
    ?.verifiability;

const userSigned = (w: World): HyperliquidProviderInternals["userSigned"] =>
  (w.provider as unknown as HyperliquidProviderInternals).userSigned;

/** The flow published `step` with a pending request id. */
const awaitStep = async (w: World, step: string): Promise<void> => {
  await until(() => w.state()?.step === step);
  await until(() => w.state()?.requestId !== undefined);
};

const pendingCleared = (w: World, id: string): boolean => {
  const record = w.requests.getState().requests[id];
  return record === undefined || record.stage !== "awaiting-approval";
};

const hasAgent = (
  agents: ReadonlyArray<{ address: string; groupIndex: number }>,
  address: string,
  groupIndex: number,
): boolean => agents.some((a) => a.address === address && a.groupIndex === groupIndex);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const actionOf = (body: Record<string, unknown>): Record<string, unknown> => {
  const { action } = body;
  return isRecord(action) ? action : {};
};

/** The typed-data fields the action must carry, in the SDK's declared order. */
const declaredFields = (type: string): string[] => {
  const fields = USER_SIGNED_TYPES[type];
  const [primary] = Object.keys(fields ?? {});
  return (primary === undefined ? [] : (fields?.[primary] ?? [])).map((f) => f.name);
};

/** Action keys = type + signatureChainId + exactly the declared fields, in order. */
const expectActionKeys = (action: Record<string, unknown>, type: string): void => {
  const declared = declaredFields(type);
  const seen = new Set<string>();
  const keys = ["type", "signatureChainId", ...declared];
  const expected = keys.filter((k) => {
    const fresh = !seen.has(k);
    seen.add(k);
    return fresh;
  });
  expect(Object.keys(action)).toStrictEqual(expected);
  for (const name of declared) {
    expect(action[name], `${type}.${name}`).toBeDefined();
  }
};

const BUILDER = {
  address: "0xABCDEF0123456789abCDEf0123456789abcdef01",
  feeRateTenthsBps: 10,
};

describe("user-signed signatures recover to the owner", () => {
  it("approveAgent and approveBuilderFee sign with the owner key", async () => {
    const w = await world(30, { builder: BUILDER });
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    // approveAgent request → approve → POST.
    await until(() => w.state()?.requestId !== undefined);
    expect(hlKind(w, requestId(w))).toBe("approve-agent");
    expect(verifiability(w, requestId(w))).toBe("partial");
    await w.approve(requestId(w));
    // Builder step: maxBuilderFee 0 < f → approve-builder request.
    await awaitStep(w, "approve-builder");
    expect(hlKind(w, requestId(w))).toBe("approve-builder-fee");
    await w.approve(requestId(w));
    await pumpUntil(w.timers, () => w.state()?.status === "enabled", 80);
    await done;
    expect(w.state()?.builder).toBe("approved");
    const owner = await ownerOf(w);
    for (const type of ["approveAgent", "approveBuilderFee"]) {
      const body = postedAction(w, type);
      const action = body["action"] as Record<string, unknown>;
      // The envelope nonce equals the action's nonce (docs: must match).
      expect(body["nonce"]).toBe(action["nonce"]);
      expect(action["signatureChainId"]).toBe("0x66eee");
      // eslint-disable-next-line no-await-in-loop -- one recovery per kind.
      await expect(recoverSigner(body)).resolves.toBe(owner);
    }
    await w.destroy();
  });

  it("usdClassTransfer, usdSend, spotSend and withdraw3 sign with the owner key", async () => {
    const w = await world(31);
    const owner = await ownerOf(w);
    const cases: Array<{
      type: string;
      nonceField: string;
      kind: string;
      verifiability: string;
      run: () => Promise<{ requestId: string; outcome: Promise<unknown> }>;
    }> = [
      {
        type: "usdClassTransfer",
        nonceField: "nonce",
        kind: "usd-class-transfer",
        verifiability: "full",
        run: async () => userSigned(w).usdClassTransfer(w.group, { amount: "1.5", toPerp: false }),
      },
      {
        type: "usdSend",
        nonceField: "time",
        kind: "usd-send",
        verifiability: "full",
        run: async () => userSigned(w).usdSend(w.group, { destination: ZERO, amount: "2" }),
      },
      {
        type: "spotSend",
        nonceField: "time",
        kind: "spot-send",
        verifiability: "partial",
        run: async () =>
          userSigned(w).spotSend(w.group, {
            destination: ZERO,
            token: `PURR:0x${"c1".repeat(16)}`,
            amount: "3",
          }),
      },
      {
        type: "withdraw3",
        nonceField: "time",
        kind: "withdraw",
        verifiability: "partial",
        run: async () => userSigned(w).withdraw(w.group, { destination: ZERO, amount: "5" }),
      },
    ];
    for (const c of cases) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential approvals.
      const pending = await c.run();
      expect(hlKind(w, pending.requestId)).toBe(c.kind);
      expect(verifiability(w, pending.requestId)).toBe(c.verifiability);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential approvals.
      await w.approve(pending.requestId);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential approvals.
      await expect(pending.outcome).resolves.toStrictEqual({ kind: "ok" });
      const body = postedAction(w, c.type);
      const action = actionOf(body);
      expect(body["nonce"]).toBe(action[c.nonceField]);
      expectActionKeys(action, c.type);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential approvals.
      await expect(recoverSigner(body)).resolves.toBe(owner);
    }
    await w.destroy();
  });
});

/** Err|timeout both leave the HL-approved agent and a resumable approve-builder state. */
const builderFailure = async (group: number, mode: "err" | "timeout"): Promise<void> => {
  const w = await world(group, { builder: BUILDER });
  const modes: Record<string, () => void> = {
    err: () => {
      w.hl.exchange = (body) => {
        const { action } = body;
        return isRecord(action) && action["type"] === "approveBuilderFee"
          ? { status: "err", response: "bad fee" }
          : undefined;
      };
    },
    timeout: () => {
      // The POST commits but maxBuilderFee never confirms: the poll times out.
      w.hl.noAutoBuilderFee = true;
    },
  };
  modes[mode]?.();
  await w.apps.acknowledgeTerms(w.group, "hyperliquid");
  const done = w.apps.enable(w.group, "hyperliquid");
  void swallow(done);
  await until(() => w.state()?.requestId !== undefined);
  await w.approve(requestId(w));
  await awaitStep(w, "approve-builder");
  await w.approve(requestId(w));
  await (mode === "err"
    ? until(() => w.state()?.error !== undefined)
    : pumpUntil(w.timers, () => w.state()?.error !== undefined, 400));
  await expect(done).rejects.toBeInstanceOf(Error);
  expect(w.state()?.status).toBe("enabling");
  expect(w.state()?.step).toBe("approve-builder");
  // The HL-approved agent is kept — the flow is resumable, not torn down.
  await expect(kernelAgents(w)).resolves.toHaveLength(1);
  await w.destroy();
};

describe("builder approval flow", () => {
  const withMeta = (w: World): void => {
    w.hl.exchange = (body) => {
      const action = body["action"] as Record<string, unknown>;
      return action["type"] === "order"
        ? {
            status: "ok",
            response: { type: "order", data: { statuses: [{ resting: { oid: 987654321 } }] } },
          }
        : undefined;
    };
    w.hl.info = (body) =>
      body["type"] === "metaAndAssetCtxs"
        ? fixture("metaAndAssetCtxs").response
        : body["type"] === "spotMetaAndAssetCtxs"
          ? fixture("spotMetaAndAssetCtxs").response
          : body["type"] === "allMids"
            ? { BTC: "57957.5" }
            : undefined;
  };

  it("confirmed builder lands on trade actions; rejection stays resumable", async () => {
    const w = await world(32, { builder: BUILDER });
    withMeta(w);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    void swallow(done);
    await until(() => w.state()?.requestId !== undefined);
    await w.approve(requestId(w));
    // Reject the builder request: the agent is HL-approved and kept; the flow errors resumably.
    await awaitStep(w, "approve-builder");
    w.requests.reject(requestId(w));
    await until(() => w.state()?.error !== undefined);
    await expect(done).rejects.toBeInstanceOf(Error);
    expect(w.state()?.status).toBe("enabling");
    expect(w.state()?.step).toBe("approve-builder");
    // The HL-approved agent is still in the kernel — not deleted on a builder failure.
    await expect(kernelAgents(w)).resolves.toHaveLength(1);
    // Trading is still refused — the builder step never confirmed.
    await expect(
      w.provider.trade.place(w.group, {
        coin: "BTC",
        side: "buy",
        size: "0.01",
        order: { kind: "limit", price: "57900", tif: "Gtc" },
      }),
    ).rejects.toMatchObject({ category: "not-enabled" });
    // Resume: enable again re-requests only the builder step (no new agent).
    const resumed = w.apps.enable(w.group, "hyperliquid");
    await until(() => w.state()?.requestId !== undefined);
    await w.approve(requestId(w));
    await pumpUntil(w.timers, () => w.state()?.status === "enabled", 80);
    await resumed;
    await expect(kernelAgents(w)).resolves.toHaveLength(1);
    expect(w.state()?.builder).toBe("approved");
    // The next trade carries the confirmed builder field.
    await w.provider.trade.place(w.group, {
      coin: "BTC",
      side: "buy",
      size: "0.01",
      order: { kind: "limit", price: "57900", tif: "Gtc" },
    });
    const orderPost = postedAction(w, "order");
    expect((orderPost["action"] as Record<string, unknown>)["builder"]).toStrictEqual({
      b: BUILDER.address.toLowerCase(),
      f: BUILDER.feeRateTenthsBps,
    });
    await w.destroy();
  }, 20000);

  it("builder already confirmed at reconcile → enabled without a request", async () => {
    const w = await world(33, { builder: BUILDER });
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    // Pre-create the kernel agent and mark it listed on HL with maxBuilderFee >= f.
    const owner = await ownerOf(w);
    const address = await hyperliquid(w.wallet).createAgent({
      owner: w.group,
      network: "Testnet",
      name: "qntx-test",
      validUntil: w.timers.time + 179 * DAY,
    });
    w.hl.listed.set(address, {
      address,
      name: "qntx-test",
      validUntil: w.timers.time + 179 * DAY,
    });
    w.hl.maxBuilderFee = BUILDER.feeRateTenthsBps;
    const pendingBefore = Object.keys(w.requests.getState().requests).length;
    await w.apps.reconcile(w.group);
    await until(() => w.state()?.status === "enabled", 1000);
    expect(w.state()?.builder).toBe("approved");
    expect(Object.keys(w.requests.getState().requests).length).toBe(pendingBefore);
    void owner;
    await w.destroy();
  });

  it("builder POST err stays resumable (agent kept, error, not-enabled)", async () => {
    await builderFailure(70, "err");
  }, 20000);

  it("builder confirmation timeout stays resumable (agent kept, error, not-enabled)", async () => {
    await builderFailure(71, "timeout");
  }, 20000);

  it("fresh unlock does not attach the builder before this session's confirmation", async () => {
    const openStore = restartableStore();
    const w1 = await world(34, { builder: BUILDER, openStore });
    withMeta(w1);
    await w1.apps.acknowledgeTerms(w1.group, "hyperliquid");
    const done = w1.apps.enable(w1.group, "hyperliquid");
    await until(() => w1.state()?.requestId !== undefined);
    await w1.approve(requestId(w1));
    await awaitStep(w1, "approve-builder");
    await w1.approve(requestId(w1));
    await pumpUntil(w1.timers, () => w1.state()?.status === "enabled", 80);
    await done;
    await w1.destroy();
    // A new session with the same store: enabledAgent persists but builder must re-confirm —
    // the fresh reconcile sees the agent unlisted first, so `builder` stays absent.
    const w2 = await world(34, { builder: BUILDER, openStore });
    withMeta(w2);
    await until(() => w2.state()?.status === "enabling", 15000);
    expect(w2.state()?.builder).toBeUndefined();
    const agent = agentAddress(w2);
    w2.hl.listed.set(agent, {
      address: agent,
      name: "qntx-test",
      validUntil: w2.timers.time + 179 * DAY,
    });
    w2.hl.maxBuilderFee = BUILDER.feeRateTenthsBps;
    await w2.apps.reconcile(w2.group);
    await until(() => w2.state()?.status === "enabled", 15000);
    // Reconcile confirmed maxBuilderFee this session — the builder attaches.
    expect(w2.state()?.builder).toBe("approved");
    await w2.destroy();
  });

  it("a renew cancel restores the confirmed builder on the wire too", async () => {
    /* Renew → cancel restores the old agent's enabled state; this session already confirmed the
       fee, so `builder` survives the restore and keeps attaching to trades. */
    const w = await world(36, { builder: BUILDER });
    withMeta(w);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    void swallow(done);
    await until(() => w.state()?.requestId !== undefined);
    await w.approve(requestId(w));
    await awaitStep(w, "approve-builder");
    await w.approve(requestId(w));
    await pumpUntil(w.timers, () => w.state()?.status === "enabled", 80);
    await done;
    expect(w.state()?.builder).toBe("approved");
    // Renew stalls on the new agent's ApproveAgent request; cancel restores the old agent.
    const renewing = w.apps.renew(w.group, "hyperliquid");
    void swallow(renewing);
    await until(() => w.state()?.requestId !== undefined);
    const cancelled = w.apps.cancel(w.group, "hyperliquid");
    await pumpUntil(w.timers, () => w.state()?.status === "enabled", 80);
    await cancelled;
    expect(w.state()?.builder).toBe("approved");
    await w.provider.trade.place(w.group, {
      coin: "BTC",
      side: "buy",
      size: "0.01",
      order: { kind: "limit", price: "57900", tif: "Gtc" },
    });
    const orderPost = postedAction(w, "order");
    expect((orderPost["action"] as Record<string, unknown>)["builder"]).toEqual({
      b: BUILDER.address.toLowerCase(),
      f: BUILDER.feeRateTenthsBps,
    });
    await w.destroy();
  }, 20000);
});

describe("enable failure and lifecycle gaps", () => {
  it("approve POST ok but never listed within the window → agent deleted, disabled", async () => {
    const w = await world(35, { hl: { noAutoList: true } });
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    let settled = false;
    void (async () => {
      await swallow(done);
      settled = true;
    })();
    await until(() => w.state()?.requestId !== undefined);
    await w.approve(requestId(w));
    await pumpUntil(w.timers, () => settled, 300);
    await expect(done).rejects.toBeInstanceOf(Error);
    await until(() => w.state()?.status === "disabled", 2000);
    await expect(kernelAgents(w)).resolves.toHaveLength(0);
    await w.destroy();
  });

  it("lost POST but the agent got listed within the window → enabled", async () => {
    const w = await world(36, { hl: { exchangeError: () => undefined } });
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    await until(() => w.state()?.requestId !== undefined);
    await w.approve(requestId(w));
    // The POST "failed" but the approval committed — the verify poll finds it listed.
    const agent = agentAddress(w);
    delete (w.hl as { exchangeError?: unknown }).exchangeError;
    w.hl.listed.set(agent, {
      address: agent,
      name: "qntx-test",
      validUntil: w.timers.time + 179 * DAY,
    });
    await pumpUntil(w.timers, () => w.state()?.status === "enabled", 80);
    await done;
    expect(w.state()?.status).toBe("enabled");
    await w.destroy();
  });

  it("createAgent failure leaves enabling + error, nothing posted, and retry succeeds", async () => {
    const w = await world(37);
    // Exhaust the kernel's per-wallet agent cap first so createAgent fails.
    const api = hyperliquid(w.wallet);
    const existing = await api.listAgents();
    for (let i = existing.length; i < 16; i++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential kernel calls.
      await api.createAgent({
        owner: { walletId: w.walletId, groupIndex: 0 },
        network: "Testnet",
        name: `cap-${i}`,
        validUntil: w.timers.time + DAY,
      });
    }
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    void swallow(done);
    await until(() => w.state()?.error !== undefined);
    await expect(done).rejects.toBeInstanceOf(Error);
    expect(w.state()?.status).toBe("enabling");
    expect(w.posted.filter((p) => p.endpoint === "exchange")).toHaveLength(0);
    // Free the cap, retry — the same group now enables.
    const victims = await api.listAgents();
    for (const a of victims) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- deletes are sequential.
      await api.deleteAgent(a.address);
    }
    const retry = w.apps.enable(w.group, "hyperliquid");
    await finishFlow(w, retry, "enabled");
    expect(w.state()?.status).toBe("enabled");
    await w.destroy();
  });

  it("lock mid-flow rejects the request, drops writes, closes the store; reconcile resumes", async () => {
    const openStore = restartableStore();
    const w = await world(38, { openStore });
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    const done = w.apps.enable(w.group, "hyperliquid");
    void swallow(done);
    await until(() => w.state()?.requestId !== undefined);
    const pending = requestId(w);
    await w.wallet.vault.lock();
    await until(() => w.apps.getState().locked, 2000);
    await expect(done).rejects.toBeInstanceOf(Error);
    // The pending request was rejected by the lock.
    expect(pendingCleared(w, pending)).toBe(true);
    // Unlock: reconcile sees the fresh unapproved kernel agent → resumable enabling.
    await w.wallet.vault.unlock(VERIFY);
    await until(() => !w.apps.getState().locked, 2000);
    await until(() => w.state()?.status === "enabling", 2000);
    expect(w.state()?.step).toBe("approve-agent");
    await expect(kernelAgents(w)).resolves.toHaveLength(1);
    // Resume re-requests ApproveAgent for the SAME agent.
    const same = agentAddress(w);
    const resume = w.apps.enable(w.group, "hyperliquid");
    await until(() => w.state()?.requestId !== undefined);
    await w.approve(requestId(w));
    await pumpUntil(w.timers, () => w.state()?.status === "enabled", 80);
    await resume;
    expect(agentAddress(w)).toBe(same);
    await w.destroy();
  }, 20000);

  it("terms survive a real lock/unlock on the same persisted store", async () => {
    const openStore = restartableStore();
    const w1 = await world(39, { openStore });
    await w1.apps.acknowledgeTerms(w1.group, "hyperliquid");
    await w1.wallet.vault.lock();
    await until(() => w1.apps.getState().locked, 15000);
    const w2 = await world(39, { openStore });
    await until(() => w2.state() !== undefined, 2000);
    expect(w2.state()?.termsAcknowledged).toBe(true);
    await w2.destroy();
  }, 20000);

  it("renew enables the new agent and deletes the old only after success", async () => {
    const w = await world(40);
    await w.apps.acknowledgeTerms(w.group, "hyperliquid");
    await finishFlow(w, w.apps.enable(w.group, "hyperliquid"), "enabled");
    const oldAddress = agentAddress(w);
    const done = w.apps.renew(w.group, "hyperliquid");
    await until(() => w.state()?.requestId !== undefined);
    // Mid-renew the old agent still signs — registry keeps it enabled.
    const owner = await ownerOf(w);
    expect(
      (w.provider as unknown as HyperliquidProviderInternals).agents.require(w.group),
    ).toMatchObject({ address: oldAddress, owner: owner.toLowerCase() });
    await w.approve(requestId(w));
    await pumpUntil(w.timers, () => w.state()?.status === "enabled", 80);
    await done;
    const newAddress = agentAddress(w);
    expect(newAddress).not.toBe(oldAddress);
    const remaining = await kernelAgents(w);
    expect(remaining.map((a) => a.address)).toStrictEqual([newAddress]);
    await w.destroy();
  });

  it("reconcile matrix: expired deletes to needs-reauthorization; latched rejected too", async () => {
    const openStore = restartableStore();
    // Persist an enabledAgent record by enabling once.
    const w1 = await world(41, { openStore });
    await w1.apps.acknowledgeTerms(w1.group, "hyperliquid");
    await finishFlow(w1, w1.apps.enable(w1.group, "hyperliquid"), "enabled");
    await w1.destroy();
    const w2 = await world(41, { openStore });
    // A never-enabled group gets an agent valid against the kernel clock but expired on ours
    // once the manual clock advances past it.
    const orphan = await hyperliquid(w2.wallet).createAgent({
      owner: { walletId: w2.walletId, groupIndex: 42 },
      network: "Testnet",
      name: "qntx-test",
      validUntil: w2.timers.time + DAY,
    });
    // Advance the clock past both agents' validity.
    w2.timers.time += 180 * DAY;
    await w2.apps.reconcile(w2.group);
    await until(() => w2.state()?.status === "needs-reauthorization", 15000);
    await expect(kernelAgents(w2)).resolves.toHaveLength(0);
    // The never-enabled expired agent is deleted and lands on `disabled`, not reauth.
    await w2.apps.reconcile({ walletId: w2.walletId, groupIndex: 42 });
    await until(() => {
      const rec = w2.apps.getState().groups[`${w2.walletId}/42`]?.["hyperliquid"];
      return rec?.status === "disabled";
    }, 15000);
    const remaining = await hyperliquid(w2.wallet).listAgents();
    expect(hasAgent(remaining, orphan, 42)).toBe(false);
    await w2.destroy();
  });

  it("reconcile: two kernel agents delete the older; >10min unlisted orphans are deleted", async () => {
    const w = await world(44);
    const api = hyperliquid(w.wallet);
    const owner = { walletId: w.walletId, groupIndex: w.group.groupIndex };
    const first = await api.createAgent({
      owner,
      network: "Testnet",
      name: "qntx-test",
      validUntil: w.timers.time + 178 * DAY,
    });
    const second = await api.createAgent({
      owner,
      network: "Testnet",
      name: "qntx-test",
      validUntil: w.timers.time + 179 * DAY,
    });
    // The newer (larger validUntil) is listed on HL; the older kernel record is a duplicate → deleted.
    w.hl.listed.set(second, {
      address: second,
      name: "qntx-test",
      validUntil: w.timers.time + 179 * DAY,
    });
    await w.apps.reconcile(w.group);
    await until(() => w.state()?.status === "enabled", 15000);
    let agents = await api.listAgents();
    expect(hasAgent(agents, first, w.group.groupIndex)).toBe(false);
    expect(agents.some((a) => a.address === second)).toBe(true);
    // A fresh-unapproved agent past the 10-minute orphan window is deleted by reconcile.
    w.timers.time += 11 * 60 * 1000;
    const stale = await api.createAgent({
      owner: { walletId: w.walletId, groupIndex: 45 },
      network: "Testnet",
      name: "qntx-test",
      validUntil: w.timers.time + 179 * DAY,
    });
    await w.apps.reconcile({ walletId: w.walletId, groupIndex: 45 });
    await until(() => {
      const rec = w.apps.getState().groups[`${w.walletId}/45`]?.["hyperliquid"];
      return rec?.status === "disabled";
    }, 15000);
    agents = await api.listAgents();
    expect(hasAgent(agents, stale, 45)).toBe(false);
    await w.destroy();
  }, 20000);
});
