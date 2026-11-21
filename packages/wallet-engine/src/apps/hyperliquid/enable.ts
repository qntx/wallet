/**
 * The Hyperliquid `AppProvider`: enable/renew/disable/reconcile as one resumable state machine.
 * Every step writes state through the flow the controller hands in, so a lock or a crash can pick
 * the flow back up; a bumped generation makes the flow stale and its writes are dropped.
 *
 * The flow never holds secrets: the agent private key stays in the kernel, the user-signed
 * approvals go through the request pipeline.
 */
import type { Wallet } from "@qntx/wallet";
import { hyperliquid } from "@qntx/wallet/hyperliquid";
import type { HyperliquidAgentInfo, HyperliquidNetwork } from "@qntx/wallet/protocol";

import type { EngineLogger } from "../../events.ts";
import type { RequestController } from "../../requests/controller.ts";
import type { SetTimer } from "../../timer.ts";
import type { AppFlow, AppGroup, AppProvider } from "../types.ts";
import { HyperliquidError } from "./errors.ts";
import type { HyperliquidErrorCategory } from "./errors.ts";
import type { HyperliquidProvider, HyperliquidProviderInternals } from "./provider.ts";
import type { HyperliquidUserSigned } from "./user-signed.ts";

/** Hyperliquid's own bound is 180 days; 179 keeps a day of slack inside it (research §Agents). */
const AGENT_VALID_MS = 179 * 24 * 60 * 60 * 1000;
/** A disabled-with-revoke throwaway only exists to deregister; 10 minutes is enough. */
const REVOKE_VALID_MS = 10 * 60 * 1000;
/** ExtraAgents/maxBuilderFee converge within seconds; poll 1 s for up to 30 s. */
const VERIFY_POLL_MS = 1000;
const VERIFY_TIMEOUT_MS = 30_000;
/** A kernel agent not yet listed on HL this long after creation is an orphan, not an in-flight one. */
const ORPHAN_AGE_MS = 10 * 60 * 1000;
/** The host surfaces a renew prompt when less than this remains. */
const RENEWAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Canonical percent string for `maxFeeRate` — `feeRateTenthsBps` hundredths of a percent
 * thousandth: f=10 → "0.01%", f=1 → "0.001%", f=100 → "0.1%" (perps cap).
 */
const feeRate = (tenthsBps: number): string => {
  const whole = Math.floor(tenthsBps / 1000);
  const frac = String(tenthsBps % 1000)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return `${whole}${frac === "" ? "" : `.${frac}`}%`;
};

export type HyperliquidEnableOptions = {
  readonly wallet: Wallet;
  readonly provider: HyperliquidProvider & HyperliquidProviderInternals;
  readonly userSigned: HyperliquidUserSigned;
  readonly requests: Pick<RequestController, "reject">;
  readonly network: HyperliquidNetwork;
  /** The agent name — `^[A-Za-z0-9._-]{1,16}$`, validated by `createApps`. */
  readonly agentName: string;
  /** Optional builder the trades attach once `maxBuilderFee` confirms `feeRateTenthsBps`. */
  readonly builder?: { readonly address: string; readonly feeRateTenthsBps: number };
  readonly now: () => number;
  readonly setTimer: SetTimer;
  readonly logger: EngineLogger;
};

const errorOf = (error: unknown): { category: string; message: string } =>
  error instanceof HyperliquidError
    ? { category: error.category, message: error.message }
    : {
        category: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      };

const fail = (flow: AppFlow, category: HyperliquidErrorCategory, message: string): never => {
  flow.write({ error: { category, message } });
  throw new HyperliquidError(category, message);
};

/** Run `body`; a stale flow stops writing but a thrown error still surfaces to the caller. */
const guard = async (flow: AppFlow, body: () => Promise<void>): Promise<void> => {
  try {
    await body();
  } catch (error) {
    if (!flow.stale() && flow.current().status === "enabling") {
      flow.write({ error: errorOf(error), requestId: undefined });
    }
    throw error;
  }
};

export function createHyperliquidEnable(options: HyperliquidEnableOptions): AppProvider {
  const { provider, userSigned } = options;
  const wallet = (): ReturnType<typeof hyperliquid> => hyperliquid(options.wallet);
  const sleep = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
      options.setTimer(ms, resolve);
    });

  /** The group's kernel agents on this network, owner-verified (the registry's own read). */
  const kernelAgents = async (group: AppGroup): Promise<ReadonlyArray<HyperliquidAgentInfo>> => {
    const listed = await wallet().listAgents();
    const owner = await provider.agents.owner(group);
    return listed.filter(
      (agent) =>
        agent.network === options.network &&
        agent.walletId === group.walletId &&
        agent.groupIndex === group.groupIndex &&
        agent.owner.toLowerCase() === owner,
    );
  };

  const deleteAgent = async (address: string): Promise<void> => {
    try {
      await wallet().deleteAgent(address);
    } catch (error) {
      options.logger.warn(`hyperliquid agent ${address} delete failed`, error);
    }
  };

  /** Poll `extraAgents` until the agent address is listed or the verify window lapses. */
  const waitListed = async (owner: string, address: string): Promise<boolean> => {
    const deadline = options.now() + VERIFY_TIMEOUT_MS;
    while (options.now() <= deadline) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls are the protocol.
      const agents = await provider.account.extraAgents(owner);
      if (agents.some((a) => a.address.toLowerCase() === address)) {
        return true;
      }
      if (options.now() <= deadline) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls are the protocol.
        await sleep(VERIFY_POLL_MS);
      }
    }
    return false;
  };

  const waitBuilderFee = async (owner: string, builder: string, f: number): Promise<boolean> => {
    const deadline = options.now() + VERIFY_TIMEOUT_MS;
    while (options.now() <= deadline) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls are the protocol.
      const approved = await provider.account.maxBuilderFee(owner, builder);
      if (approved >= f) {
        return true;
      }
      if (options.now() <= deadline) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential polls are the protocol.
        await sleep(VERIFY_POLL_MS);
      }
    }
    return false;
  };

  /**
   * Preconditions shared by enable and renew: clock gate, then `userRole` — only a funded master
   * account ("user") may approve agents (research §Roles).
   */
  const preconditions = async (group: AppGroup, flow: AppFlow): Promise<string> => {
    if (!flow.current().termsAcknowledged) {
      fail(flow, "invalid-input", "Hyperliquid terms have not been acknowledged");
    }
    if (provider.clock.skew() === undefined) {
      await provider.markets.mids();
    }
    provider.clock.assertSkew();
    const owner = await provider.agents.owner(group);
    const { role } = await provider.account.role(owner);
    if (role === "missing") {
      fail(flow, "deposit-required", "deposit to Hyperliquid before enabling trading");
    }
    if (role !== "user") {
      fail(flow, "invalid-input", `a ${role} account cannot approve agents`);
    }
    return owner;
  };

  /** Approve the agent on Hyperliquid, then verify it is listed — resumable through `verify`. */
  const approveAgent = async (
    group: AppGroup,
    flow: AppFlow,
    owner: string,
    agent: HyperliquidAgentInfo,
  ): Promise<void> => {
    if (flow.current().step !== "verify" && flow.current().step !== "approve-builder") {
      flow.write({ step: "approve-agent" });
      /* The kernel binds validity by signing `"<name> valid_until <ms>"` in agentName — the
         exchange reads the suffix, not a separate field (docs §Approve an API wallet). The
         `valid_until` always comes from the kernel record, never a fresh clock read. */
      const pending = await userSigned.approveAgent(group, {
        agentAddress: agent.address,
        agentName: `${options.agentName} valid_until ${agent.validUntil}`,
      });
      flow.write({ requestId: pending.requestId });
      try {
        const outcome = await pending.outcome;
        flow.write({ requestId: undefined });
        /* A lost approve POST means the action may have committed — go to verify instead of
           treating it as a failure; the agent is kept while it may be live. */
        if (outcome.kind === "unknown") {
          options.logger.warn("hyperliquid approveAgent outcome unknown — verifying by listing");
        }
      } catch (error) {
        /* Refusal and `status:"err"` are definitive — the agent never commits: delete the
           orphan and leave the group disabled. Only `unknown` is uncertain. */
        flow.write({ requestId: undefined });
        if (
          error instanceof HyperliquidError &&
          (error.category === "approval-rejected" || error.category === "rejected")
        ) {
          await deleteAgent(agent.address);
          flow.write({
            status: "disabled",
            agent: undefined,
            step: undefined,
            error: errorOf(error),
          });
        }
        throw error;
      }
    }
    flow.write({ step: "verify" });
    if (!(await waitListed(owner, agent.address.toLowerCase()))) {
      flow.write({ status: "disabled", step: undefined });
      await deleteAgent(agent.address);
      fail(flow, "unavailable", "the agent never appeared on Hyperliquid");
    }
  };

  /** The builder step: request approveBuilderFee when HL has not confirmed `f` yet. */
  const approveBuilder = async (
    group: AppGroup,
    flow: AppFlow,
    owner: string,
  ): Promise<boolean> => {
    const { builder } = options;
    if (builder === undefined || flow.current().builder === "approved") {
      return true;
    }
    const fee = builder.feeRateTenthsBps;
    if ((await provider.account.maxBuilderFee(owner, builder.address.toLowerCase())) >= fee) {
      return true;
    }
    flow.write({ step: "approve-builder" });
    const pending = await userSigned.approveBuilderFee(group, {
      builder: builder.address,
      maxFeeRate: feeRate(fee),
    });
    flow.write({ requestId: pending.requestId });
    await pending.outcome;
    flow.write({ requestId: undefined });
    if (!(await waitBuilderFee(owner, builder.address.toLowerCase(), fee))) {
      /* The agent is live on Hyperliquid — keep it; the next enable resumes at this step. */
      fail(flow, "unavailable", "the builder fee approval never confirmed");
    }
    return true;
  };

  /** The enable state machine — every step writes; a failure leaves a resumable state. */
  const enableFlow = async (group: AppGroup, flow: AppFlow): Promise<void> => {
    const now = options.now();
    if (flow.current().status !== "enabling") {
      flow.write({ status: "enabling", step: "create-agent", error: undefined });
    }
    const owner = await preconditions(group, flow);
    let agents = await kernelAgents(group);
    /* Resume: the step already has an agent; create only when none exists or the recorded one is
       gone from the kernel. */
    let agent =
      flow.current().agent === undefined
        ? undefined
        : agents.find(
            (a) => a.address.toLowerCase() === flow.current().agent?.address.toLowerCase(),
          );
    if (agent === undefined) {
      const address = await wallet().createAgent({
        owner: group,
        network: options.network,
        name: options.agentName,
        validUntil: now + AGENT_VALID_MS,
      });
      agents = await kernelAgents(group);
      agent = agents.find((a) => a.address.toLowerCase() === address.toLowerCase());
    }
    if (agent === undefined) {
      return fail(flow, "unavailable", "the kernel created no agent");
    }
    flow.write({
      agent: {
        address: agent.address,
        name: agent.name,
        validUntil: agent.validUntil,
        network: agent.network,
      },
    });
    await approveAgent(group, flow, owner, agent);
    const builderOk = await approveBuilder(group, flow, owner);
    provider.agents.markEnabled(agent.address);
    flow.write({
      status: "enabled",
      step: undefined,
      requestId: undefined,
      ...(builderOk ? { builder: "approved" as const } : {}),
      renewalDue: agent.validUntil - options.now() < RENEWAL_WINDOW_MS,
      error: undefined,
    });
  };

  return {
    id: "hyperliquid",
    groups: async () => {
      const listed = await wallet().listAgents();
      const seen = new Map<string, AppGroup>();
      for (const agent of listed) {
        if (agent.network === options.network) {
          seen.set(`${agent.walletId}/${agent.groupIndex}`, {
            walletId: agent.walletId,
            groupIndex: agent.groupIndex,
          });
        }
      }
      return [...seen.values()];
    },
    enable: async (group, flow) =>
      guard(flow, async () => {
        await enableFlow(group, flow);
      }),
    renew: async (group, flow) => {
      const before = await kernelAgents(group);
      try {
        /* Same name ⇒ Hyperliquid deregisters the old agent when the new one is approved. The
           old kernel agent stays usable until the new one is enabled. */
        flow.write({
          status: "enabling",
          step: "create-agent",
          agent: undefined,
          error: undefined,
        });
        await enableFlow(group, flow);
        for (const old of before) {
          if (old.address.toLowerCase() !== flow.current().agent?.address.toLowerCase()) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- deletes are sequential cleanup.
            await deleteAgent(old.address);
          }
        }
      } catch (error) {
        /* The failed flow deleted its unenabled agent (approveAgent); restore the old agent's
           enabled state — it kept trading through the whole attempt. */
        const remaining = await kernelAgents(group);
        const old = remaining.find(
          (a) =>
            a.address.toLowerCase() !== flow.current().agent?.address.toLowerCase() &&
            a.validUntil > options.now(),
        );
        flow.write(
          old === undefined
            ? {
                status: "needs-reauthorization",
                step: undefined,
                requestId: undefined,
                error: errorOf(error),
              }
            : {
                status: "enabled",
                agent: {
                  address: old.address,
                  name: old.name,
                  validUntil: old.validUntil,
                  network: old.network,
                },
                step: undefined,
                requestId: undefined,
                renewalDue: old.validUntil - options.now() < RENEWAL_WINDOW_MS,
                error: errorOf(error),
              },
        );
        throw error;
      }
    },
    disable: async (group, { revoke }, flow) =>
      guard(flow, async () => {
        await provider.agents.refresh();
        const agents = await kernelAgents(group);
        /* Trading stops first: every kernel agent of the group on this network is deleted
           before the optional revoke runs. */
        for (const agent of agents) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- deletes are sequential cleanup.
          await deleteAgent(agent.address);
        }
        flow.write({ status: "disabled", agent: undefined, builder: undefined, error: undefined });
        if (revoke) {
          flow.write({ step: "revoke" });
          /* No revoke action exists: a same-name approval deregisters the old agent. A
             throwaway valid for ten minutes does it, and is deleted in every outcome. */
          let throwaway: string | undefined;
          try {
            const address = await wallet().createAgent({
              owner: group,
              network: options.network,
              name: options.agentName,
              validUntil: options.now() + REVOKE_VALID_MS,
            });
            throwaway = address;
            /* The kernel binding needs the record's own validUntil — a second clock read here
               could drift a millisecond and fail the check. */
            const records = await kernelAgents(group);
            const record = records.find((a) => a.address.toLowerCase() === address.toLowerCase());
            if (record === undefined) {
              throw new HyperliquidError("unavailable", "the kernel created no agent");
            }
            const pending = await userSigned.approveAgent(group, {
              agentAddress: address,
              agentName: `${options.agentName} valid_until ${record.validUntil}`,
            });
            flow.write({ requestId: pending.requestId });
            await pending.outcome;
            flow.write({ requestId: undefined, step: undefined });
          } catch (error) {
            flow.write({
              step: "revoke",
              requestId: undefined,
              error: errorOf(error),
            });
            throw error;
          } finally {
            if (throwaway !== undefined) {
              await deleteAgent(throwaway);
            }
          }
        }
      }),
    cancel: async (group, flow) => {
      const state = flow.current();
      if (state.status !== "enabling") {
        throw new HyperliquidError("invalid-input", "no enablement flow is running");
      }
      if (state.agent !== undefined && provider.agents.enabled(state.agent.address)) {
        throw new HyperliquidError("invalid-input", "the recorded agent is already enabled");
      }
      if (state.requestId !== undefined) {
        /* A request the flow opened but the host never approved just ends. */
        options.requests.reject(state.requestId);
      }
      const agents = await kernelAgents(group);
      for (const agent of agents) {
        /* Only the flow's own unenabled agent is an orphan — during a renew the old enabled
           agent names another address and is never touched. */
        if (
          agent.address.toLowerCase() === state.agent?.address.toLowerCase() &&
          !provider.agents.enabled(agent.address)
        ) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- one delete.
          await deleteAgent(agent.address);
        }
      }
      /* Restore what remains: a renew's old agent is still live and enabled — a fresh enable
           leaves nothing and the group goes disabled. */
      const [restored] = agents
        .filter(
          (a) =>
            a.address.toLowerCase() !== state.agent?.address.toLowerCase() &&
            a.validUntil > options.now(),
        )
        .sort((a, b) => b.validUntil - a.validUntil);
      if (restored === undefined) {
        flow.write({
          status: "disabled",
          step: undefined,
          requestId: undefined,
          agent: undefined,
          error: undefined,
        });
      } else {
        provider.agents.markEnabled(restored.address);
        flow.write({
          status: "enabled",
          agent: {
            address: restored.address,
            name: restored.name,
            validUntil: restored.validUntil,
            network: restored.network,
          },
          step: undefined,
          requestId: undefined,
          renewalDue: restored.validUntil - options.now() < RENEWAL_WINDOW_MS,
          error: undefined,
        });
      }
    },
    reconcile: async (group, flow) => {
      const now = options.now();
      const owner = await provider.agents.owner(group);
      const agents = await kernelAgents(group);
      const listed = await provider.account.extraAgents(owner);
      const onHl = new Set(listed.map((a) => a.address.toLowerCase()));
      const live = agents
        .filter((a) => a.validUntil > now)
        .sort((a, b) => b.validUntil - a.validUntil);
      const [newest] = live;
      if (newest === undefined) {
        /* Every kernel agent expired or none exist: a group whose persisted record names an
           enabled agent needs reauthorization; a group that never enabled is disabled. */
        for (const agent of agents) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- orphan cleanup is sequential.
          await deleteAgent(agent.address);
        }
        flow.write({
          status: flow.wasEnabledAgent() === undefined ? "disabled" : "needs-reauthorization",
          agent: undefined,
          builder: undefined,
        });
        return;
      }
      if (!onHl.has(newest.address.toLowerCase())) {
        /* Kernel agent Hyperliquid does not know: fresh → resume approve-agent; old → orphan. */
        if (now - newest.createdAt < ORPHAN_AGE_MS) {
          flow.write({
            status: "enabling",
            step: "approve-agent",
            agent: {
              address: newest.address,
              name: newest.name,
              validUntil: newest.validUntil,
              network: newest.network,
            },
          });
        } else {
          await deleteAgent(newest.address);
          flow.write({
            status: flow.wasEnabledAgent() === undefined ? "disabled" : "needs-reauthorization",
            agent: undefined,
            builder: undefined,
          });
        }
        return;
      }
      /* The newest live agent is listed: it is the enabled one; every other agent is an
         orphan and is deleted. */
      for (const agent of agents) {
        if (agent.address.toLowerCase() !== newest.address.toLowerCase()) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- orphan cleanup is sequential.
          await deleteAgent(agent.address);
        }
      }
      if (provider.agents.rejected(newest.address)) {
        /* Latched by the exchange path: Hyperliquid refuses this agent — renew, never reuse. */
        flow.write({ status: "needs-reauthorization", step: undefined, requestId: undefined });
        return;
      }
      const { builder } = options;
      const builderConfirmed =
        builder !== undefined &&
        (await provider.account.maxBuilderFee(owner, builder.address.toLowerCase())) >=
          builder.feeRateTenthsBps;
      if (builder !== undefined && !builderConfirmed) {
        flow.write({
          status: "enabling",
          step: "approve-builder",
          agent: {
            address: newest.address,
            name: newest.name,
            validUntil: newest.validUntil,
            network: newest.network,
          },
        });
        return;
      }
      provider.agents.markEnabled(newest.address);
      flow.write({
        status: "enabled",
        step: undefined,
        agent: {
          address: newest.address,
          name: newest.name,
          validUntil: newest.validUntil,
          network: newest.network,
        },
        ...(builder === undefined || builderConfirmed ? { builder: "approved" as const } : {}),
        renewalDue: newest.validUntil - now < RENEWAL_WINDOW_MS,
        error: undefined,
      });
    },
  };
}
