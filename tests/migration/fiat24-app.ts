/**
 * MIGRATION.md §40 — the Fiat24 app: composition with an injected `fetch`, enable, the account
 * read, flow start/advance with `refusal` and `invalid` narrowing, the provider error category, the
 * new risk codes, the `RequestEndedError` signature and a custom `AppStorage` with `list`. Compiled
 * only.
 */
import type { Wallet } from "@qntx/wallet";
import type { RiskFinding } from "@qntx/wallet-engine";
import { RequestEndedError } from "@qntx/wallet-engine";
import type {
  AppGroup,
  AppGroupState,
  AppsController,
  AppStorage,
  CreateAppsOptions,
} from "@qntx/wallet-engine/apps";
import { createApps } from "@qntx/wallet-engine/apps";
import type {
  Fiat24AccountState,
  Fiat24App,
  Fiat24Flow,
  Fiat24FlowEntry,
  Fiat24AppErrorCategory,
} from "@qntx/wallet-engine/apps/fiat24";
import { fiat24, Fiat24AppError } from "@qntx/wallet-engine/apps/fiat24";

const random = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
const setTimer = (ms: number, fn: () => void): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/**
 * The Fiat24 REST api is reached only through the injected `fetch` (React Native: the platform
 * fetch, uninstrumented; Web: a host proxy that sees the bearer grant headers). Omit it for a
 * chain-only build — API-backed calls then throw `Fiat24AppError("api-unavailable")`.
 */
export function createFiat24Apps(
  options: Omit<CreateAppsOptions, "apps" | "setTimer" | "random"> & { readonly wallet: Wallet },
  fiat24Fetch: typeof globalThis.fetch,
): {
  readonly controller: AppsController<{ readonly fiat24: AppGroupState }>;
  readonly fiat24: Fiat24App;
  readonly destroy: () => Promise<void>;
} {
  return createApps({
    ...options,
    setTimer,
    random,
    apps: [fiat24({ fetch: fiat24Fetch })],
  });
}

/** Enable once per group — the terms flag first, then the eligibility-gated enable. */
export async function enableFiat24(
  apps: ReturnType<typeof createFiat24Apps>,
  group: AppGroup,
): Promise<void> {
  await apps.controller.acknowledgeTerms(group, "fiat24");
  await apps.controller.enable(group, "fiat24");
}

/** `account` narrows on `status`: the account view exists only for a real status. */
export function describeAccount(state: Fiat24AccountState): string {
  switch (state.status) {
    case "no-account":
      return "the group owns no Fiat24 account";
    case "contract-changed":
      return "the deployment drifted — writes fail closed";
    case "stale":
      return `stale view of account ${state.view.account.tokenId}`;
    default:
      return `account ${state.view.account.tokenId} is ${state.status}`;
  }
}

/**
 * One transfer: `start` persists the flow, `advance` opens the request (approve it on
 * `engine.requests` as usual); `refusal` on the returned entry says why nothing was sent. A `list`
 * entry that no longer decodes narrows to `{ invalid: true }` — only `discard` removes it, and it
 * can never be reconciled.
 */
export async function runTransfer(
  apps: ReturnType<typeof createFiat24Apps>,
  group: AppGroup,
): Promise<Fiat24FlowEntry> {
  const flow = await apps.fiat24.flows.start(group, {
    flow: "transfer",
    currency: "EUR24",
    amount: 1000n,
    to: { tokenId: 469709n },
  });
  const advanced = await apps.fiat24.flows.advance(group, flow.id);
  if (advanced.refusal !== undefined) {
    switch (advanced.refusal) {
      case "rejected":
      case "expired":
      case "invalidated":
        throw new Error(`the user did not approve: ${advanced.refusal}`);
      case "failed-before-signing":
      case "prepare-failed":
      case "invalid-call":
        throw new Error(`the send never happened: ${advanced.refusal}`);
      case "nonce-conflict":
        throw new Error("the pinned nonce is no longer the sender's next");
    }
  }
  const entries = await apps.fiat24.flows.list(group);
  const undecodable: ReadonlyArray<string> = entries
    .filter((entry): entry is Extract<Fiat24Flow, { readonly invalid: true }> => "invalid" in entry)
    .map((entry) => entry.id);
  if (undecodable.length > 0) {
    throw new Error(
      `stored flows no longer decode — inspect the account first: ${undecodable.join(", ")}`,
    );
  }
  return advanced;
}

/** The provider's error category is a closed union — a host switch must name every member. */
export function categoryLabel(category: Fiat24AppErrorCategory): string {
  switch (category) {
    case "unlock-required":
      return "the vault is locked";
    case "not-enabled":
      return "the app is not enabled for the group";
    case "no-account":
      return "the group owns no live Fiat24 account";
    case "api-unavailable":
      return "no api.fiat24.com fetch was injected";
    case "busy":
      return "an enablement flow is running";
    case "close-only":
      return "the jurisdiction is wind-down only";
    case "flow-unresolved":
      return "a flow transaction is still in flight";
    case "unknown-flow":
      return "no such flow";
    case "unavailable":
      return "the read could not complete — retry";
    case "invalid-input":
      return "the caller input fails validation";
    case "protocol":
      return "the SDK reported the failure — read `code`";
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the never assignment is the exhaustiveness proof
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
}

export function isApiUnavailable(error: unknown): boolean {
  return error instanceof Fiat24AppError && error.category === "api-unavailable";
}

/** `RiskFinding["code"]` gained the seven fiat24 codes — an exhaustive switch must name them. */
export function riskLabel(code: RiskFinding["code"]): string {
  switch (code) {
    case "fiat24-internal-account":
      return "the counterparty is a Fiat24 internal desk";
    case "fiat24-card-pull":
      return "the card contract can pull up to the allowance";
    case "fiat24-unlimited-approval":
      return "an unbounded Fiat24 allowance";
    case "fiat24-exact-out-unbounded":
      return "an exact-out swap with an unbounded input";
    case "fiat24-payee-offchain":
      return "the payout payee is bound off chain";
    case "fiat24-account-move":
      return "the account NFT moves custody";
    case "fiat24-account-burn":
      return "the account NFT is burned";
    default:
      return code;
  }
}

/**
 * `RequestEndedError`'s constructor takes `signed` — `false` proves nothing it produced was
 * broadcast, `true` means a signature may already be out.
 */
export function ended(
  stage: RequestEndedError["stage"],
  message: string | undefined,
  signed: boolean,
): RequestEndedError {
  return new RequestEndedError(stage, message, signed);
}

/** A custom `AppStorage` implementation must provide `list` (and `groups`). */
export class MemoryAppStorage implements AppStorage {
  readonly #records = new Map<string, Uint8Array>();

  #key(group: AppGroup, name: string): string {
    return `${group.walletId}/${group.groupIndex}/${name}`;
  }

  // oxlint-disable-next-line typescript/require-await -- the store seam's signature is a promise
  async get(group: AppGroup, name: string): Promise<Uint8Array | undefined> {
    return this.#records.get(this.#key(group, name));
  }

  // oxlint-disable-next-line typescript/require-await -- the store seam's signature is a promise
  async put(group: AppGroup, name: string, bytes: Uint8Array): Promise<void> {
    this.#records.set(this.#key(group, name), bytes);
  }

  // oxlint-disable-next-line typescript/require-await -- the store seam's signature is a promise
  async delete(group: AppGroup, name: string): Promise<void> {
    this.#records.delete(this.#key(group, name));
  }

  // oxlint-disable-next-line typescript/require-await -- the store seam's signature is a promise
  async list(group: AppGroup): Promise<ReadonlyArray<string>> {
    const prefix = `${group.walletId}/${group.groupIndex}/`;
    return [...this.#records.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  // oxlint-disable-next-line typescript/require-await -- the store seam's signature is a promise
  async groups(): Promise<ReadonlyArray<AppGroup>> {
    const seen = new Map<string, AppGroup>();
    for (const key of this.#records.keys()) {
      const [walletId, groupIndex] = key.split("/");
      if (walletId !== undefined && groupIndex !== undefined) {
        seen.set(`${walletId}/${groupIndex}`, {
          walletId,
          groupIndex: Number(groupIndex),
        });
      }
    }
    return [...seen.values()];
  }
}
