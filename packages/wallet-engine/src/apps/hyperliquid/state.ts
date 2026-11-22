/**
 * Hyperliquid's own group-state fields and the enablement hints the flows persist between sessions:
 * the last agent that reached `enabled` (reconcile's needs-reauthorization signal) and the builder
 * approval the user declined (so renew and re-enable never re-ask). Both live in one `enablement`
 * record in collection `apps.hyperliquid` under `<walletId>/<groupIndex>` — strict parse, a
 * malformed record reads as empty.
 */
import type { EngineLogger } from "../../events.ts";
import { readJson } from "../../store/json.ts";
import type { AppFlow, AppGroup, AppGroupState, AppStorage } from "../types.ts";

/** The resumable enablement step a group is in; absent when `status` is terminal. */
export type HyperliquidStep =
  | "create-agent"
  | "approve-agent"
  | "approve-builder"
  | "verify"
  | "revoke";

export type HyperliquidGroupAgent = {
  readonly address: string;
  readonly name: string;
  readonly validUntil: number;
  readonly network: string;
};

/** Hyperliquid's own group-state fields on top of the controller's base. */
export type HyperliquidDetail = {
  /** The agent the group is enabling or enabled with. */
  readonly agent?: HyperliquidGroupAgent;
  /** The step an `enabling` flow is at — `verify` also marks a lost-POST re-check. */
  readonly step?: HyperliquidStep;
  /** `validUntil - now < 14 days` — the host surfaces a renew prompt. */
  readonly renewalDue?: boolean;
  /**
   * `approved` once `maxBuilderFee(owner, builder) >= f` was confirmed on Hyperliquid; `declined`
   * when the user refused the approval — trades go out without a builder either way the fee is
   * unconfirmed.
   */
  readonly builder?: "approved" | "declined";
};

/** One wallet group's Hyperliquid app state. */
export type HyperliquidGroupState = AppGroupState<HyperliquidDetail>;

/**
 * The flow the enable machine runs on: the controller's `AppFlow` plus the session's enablement
 * hints — `wasEnabledAgent` is reconcile's needs-reauthorization signal, `wasBuilderDeclined` the
 * persisted decline that keeps a renew or re-enable from re-asking.
 */
export type HyperliquidFlow = AppFlow<HyperliquidDetail> & {
  /** The address of the last agent a previous session enabled, when the record persisted one. */
  readonly wasEnabledAgent: () => string | undefined;
  /** Whether the persisted record saw the builder approval declined. */
  readonly wasBuilderDeclined: () => boolean;
};

/** The `enablement` record's fields — both hints in one record. */
type Hints = {
  /** The last agent that reached `enabled` — reconcile's status hint. */
  enabledAgent?: string;
  /** The user declined the builder approval — persisted while `builder` is `declined`. */
  builderDeclined?: true;
};

export type HyperliquidHints = {
  /**
   * Load the group's hints once per session and wrap `flow` so its writes keep them current —
   * `wasEnabledAgent`/`wasBuilderDeclined` read the live hints, and every status/agent/builder
   * write derives and persists the change.
   */
  readonly track: (group: AppGroup, flow: AppFlow<HyperliquidDetail>) => Promise<HyperliquidFlow>;
  /** Drop the session cache — the app calls this on lock, with its other session marks. */
  readonly reset: () => void;
};

/** Exact keys only — a record with anything else reads as absent (logged by the caller). */
const parseHints = (raw: Uint8Array): Hints | undefined => {
  const value: unknown = readJson(raw);
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if (Object.keys(value).some((k) => k !== "enabledAgent" && k !== "builderDeclined")) {
    return undefined;
  }
  if (
    "enabledAgent" in value &&
    (typeof value.enabledAgent !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.enabledAgent))
  ) {
    return undefined;
  }
  if ("builderDeclined" in value && value.builderDeclined !== true) {
    return undefined;
  }
  const hints: Hints = {};
  if ("enabledAgent" in value && typeof value.enabledAgent === "string") {
    hints.enabledAgent = value.enabledAgent;
  }
  if ("builderDeclined" in value && value.builderDeclined === true) {
    hints.builderDeclined = true;
  }
  return hints;
};

export function createHyperliquidHints(options: {
  readonly storage: AppStorage;
  readonly logger: EngineLogger;
}): HyperliquidHints {
  const name = "enablement";
  /* One load per group per session — the hints object lives in the cache and the tracked flow's
     writes mutate it, so `was*` always reads the freshest derivation. */
  const loaded = new Map<string, Promise<Hints>>();
  const loadOne = async (group: AppGroup): Promise<Hints> => {
    const raw = await options.storage.get(group, name);
    if (raw === undefined) {
      return {};
    }
    const hints = parseHints(raw);
    if (hints === undefined) {
      options.logger.warn(
        `hyperliquid ${name} ${group.walletId}/${group.groupIndex} skipped: malformed`,
      );
      return {};
    }
    return hints;
  };
  const load = async (group: AppGroup): Promise<Hints> => {
    const key = `${group.walletId}/${group.groupIndex}`;
    let pending = loaded.get(key);
    if (pending === undefined) {
      pending = loadOne(group);
      loaded.set(key, pending);
    }
    return pending;
  };
  /* Fire-and-forget like the controller's own record writes — a failed persist only means the
     next session re-derives from a staler hint. */
  const persist = (group: AppGroup, hints: Hints): void => {
    const key = `${group.walletId}/${group.groupIndex}`;
    const bytes = new TextEncoder().encode(JSON.stringify(hints));
    const put = async (): Promise<void> => {
      try {
        await options.storage.put(group, name, bytes);
      } catch (error) {
        options.logger.warn(`hyperliquid ${name} ${key} write failed`, error);
      }
    };
    void put();
  };
  return {
    track: async (group, flow) => {
      const hints = await load(group);
      return {
        current: flow.current,
        stale: flow.stale,
        wasEnabledAgent: () => hints.enabledAgent,
        wasBuilderDeclined: () => hints.builderDeclined === true,
        write: (patch) => {
          if (flow.stale()) {
            return;
          }
          flow.write(patch);
          /* Derive the hints from the state the write landed: `enabled` with an agent records
             its address; `disabled`/`unavailable` drops it; the decline survives `enabling`
             rewrites until an approval replaces it. */
          const state = flow.current();
          let changed = false;
          if (state.status === "enabled" && state.agent !== undefined) {
            if (hints.enabledAgent !== state.agent.address) {
              hints.enabledAgent = state.agent.address;
              changed = true;
            }
          } else if (
            (state.status === "disabled" || state.status === "unavailable") &&
            hints.enabledAgent !== undefined
          ) {
            delete hints.enabledAgent;
            changed = true;
          }
          if (state.builder === "declined") {
            if (hints.builderDeclined !== true) {
              hints.builderDeclined = true;
              changed = true;
            }
          } else if (state.builder === "approved" && hints.builderDeclined === true) {
            delete hints.builderDeclined;
            changed = true;
          }
          if (changed) {
            persist(group, hints);
          }
        },
      };
    },
    reset: () => loaded.clear(),
  };
}
