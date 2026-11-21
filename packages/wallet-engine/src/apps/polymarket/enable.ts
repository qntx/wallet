import { toHex } from "viem";

/**
 * The Polymarket `AppProvider`: locate → deploy → credentials → approvals → verify as one resumable
 * state machine (design.md §启用状态机). Facts live in the kernel (`pm-creds`), the relayer
 * (`/deployed`) and the Data API (`/v2/approvals`); the engine persists only the terms flag. Every
 * step writes through the flow so a lock or crash resumes — each step is idempotent and re-derives
 * its precondition from the facts rather than trusting the recorded step.
 *
 * Secret hygiene: the `POST /auth/api-key` answer's `secret` is handed to
 * `polymarket(wallet).importCredentials` inside the credentials step and goes out of scope with it
 * — it never reaches controller state, the store, the logger, or an error.
 */
import type { Wallet } from "@qntx/wallet";
import { polymarket } from "@qntx/wallet/polymarket";

import type { EngineLogger } from "../../events.ts";
import { RequestEndedError } from "../../requests/controller.ts";
import type { RequestController } from "../../requests/controller.ts";
import type { SetTimer } from "../../timer.ts";
import type { AppFlow, AppGroup, AppGroupState, AppProvider } from "../types.ts";
import type { PolymarketAccountReads } from "./account.ts";
import {
  CONDITIONAL_TOKENS,
  CLOB_HOST,
  CTF_EXCHANGE_V2,
  CTF_EXCHANGE_V3,
  NEG_RISK_ADAPTER,
  NEG_RISK_EXCHANGE_V2,
  POSITION_MANAGER,
  PUSD,
} from "./constants.ts";
import { PolymarketError } from "./errors.ts";
import type { PolymarketErrorCategory } from "./errors.ts";
import { createPolymarketHttp } from "./http.ts";
import type { PolymarketBuilder } from "./provider.ts";
import { createPolymarketRelayer, batchTypedData } from "./relayer.ts";
import type { PolymarketRelayer, RelayerCall } from "./relayer.ts";
import { clobApiKeyResponse } from "./schemas.ts";
import { derivePolymarketWallets } from "./wallets.ts";
import type { PolymarketAccount } from "./wallets.ts";

const NETWORK = "eip155:137";
/** The SDK's batch deadline window (research.md §1 — `Ul = 600` seconds). */
const BATCH_DEADLINE_SECONDS = 600;
/** The kernel signing window — enable refuses to start on a device clock beyond it. */
const MAX_SKEW_MS = 30_000;

/**
 * The eight trading approvals a deposit wallet needs (docs trading/wallets-auth.md §Set Up Trading
 * Approvals): pUSD `approve(spender, maxUint256)` for the two exchanges + adapter, and
 * `setApprovalForAll(spender, true)` on the outcome-token ledgers. The batch is built only from
 * this table — never from API data — so a hostile `/v2/approvals` cannot inject a call.
 */
const UINT256_MAX = 2n ** 256n - 1n;
const pad32 = (hex: `0x${string}`): string => hex.slice(2).toLowerCase().padStart(64, "0");
const approveData = (spender: `0x${string}`): `0x${string}` =>
  `0x095ea7b3${pad32(spender)}${UINT256_MAX.toString(16).padStart(64, "0")}`;
const approveAllData = (operator: `0x${string}`): `0x${string}` =>
  `0xa22cb465${pad32(operator)}${"1".padStart(64, "0")}`;

const APPROVALS: ReadonlyArray<{
  readonly token: `0x${string}`;
  readonly spender: `0x${string}`;
  readonly data: `0x${string}`;
}> = [
  { token: PUSD, spender: CTF_EXCHANGE_V3, data: approveData(CTF_EXCHANGE_V3) },
  { token: PUSD, spender: CTF_EXCHANGE_V2, data: approveData(CTF_EXCHANGE_V2) },
  { token: PUSD, spender: NEG_RISK_EXCHANGE_V2, data: approveData(NEG_RISK_EXCHANGE_V2) },
  { token: PUSD, spender: NEG_RISK_ADAPTER, data: approveData(NEG_RISK_ADAPTER) },
  {
    token: POSITION_MANAGER,
    spender: CTF_EXCHANGE_V3,
    data: approveAllData(CTF_EXCHANGE_V3),
  },
  {
    token: CONDITIONAL_TOKENS,
    spender: CTF_EXCHANGE_V2,
    data: approveAllData(CTF_EXCHANGE_V2),
  },
  {
    token: CONDITIONAL_TOKENS,
    spender: NEG_RISK_EXCHANGE_V2,
    data: approveAllData(NEG_RISK_EXCHANGE_V2),
  },
  {
    token: CONDITIONAL_TOKENS,
    spender: NEG_RISK_ADAPTER,
    data: approveAllData(NEG_RISK_ADAPTER),
  },
];

const CLOB_AUTH_MESSAGE = "This message attests that I control the given wallet";

/**
 * The `ClobAuth` typed data — the L1 signature that creates or derives the group's CLOB API
 * credentials (getting-started/api.md §Authentication; phase-1 vectors' `ClobAuth` case). The
 * kernel's recognizer describes it (`kind: "auth"`) rather than blind-signing.
 */
const clobAuthTypedData = (signer: `0x${string}`, timestamp: string): string =>
  JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      ClobAuth: [
        { name: "address", type: "address" },
        { name: "timestamp", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "message", type: "string" },
      ],
    },
    primaryType: "ClobAuth",
    domain: { name: "ClobAuthDomain", version: "1", chainId: 137 },
    message: { address: signer, timestamp, nonce: 0, message: CLOB_AUTH_MESSAGE },
  });

/** Which table approvals `/v2/approvals` is missing — the batch's call list, in table order. */
const missingApprovals = (
  contracts: ReadonlyArray<{ token: string; spender: string; approved: boolean }>,
): ReadonlyArray<(typeof APPROVALS)[number]> => {
  const have = new Set(
    contracts
      .filter((c) => c.approved)
      .map((c) => `${c.token.toLowerCase()}/${c.spender.toLowerCase()}`),
  );
  return APPROVALS.filter((row) => !have.has(`${row.token}/${row.spender}`.toLowerCase()));
};

const accountRef = (group: AppGroup) => ({
  kind: "hd" as const,
  walletId: group.walletId,
  groupIndex: group.groupIndex,
  template: "evm.bip44" as const,
});

/** The state's `account` view of a locate result — positions reads scope to `wallet`. */
const stateAccount = (account: PolymarketAccount): NonNullable<AppGroupState["account"]> => ({
  wallet: account.wallet,
  kind: account.kind,
  deployed: account.deployed,
  ...(account.legacySafe === undefined ? {} : { legacySafe: account.legacySafe }),
});

const errorOf = (error: unknown): { category: string; message: string } =>
  error instanceof PolymarketError
    ? { category: error.category, message: error.message }
    : {
        category: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      };

const fail = (flow: AppFlow, category: PolymarketErrorCategory, message: string): never => {
  flow.write({ error: { category, message } });
  throw new PolymarketError(category, message);
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

export type PolymarketEnableOptions = {
  readonly wallet: Wallet;
  readonly account: PolymarketAccountReads;
  readonly requests: Pick<RequestController, "prepare" | "outcome" | "reject">;
  readonly fetch: typeof globalThis.fetch;
  readonly setTimer: SetTimer;
  readonly now: () => number;
  /** The host's Remote Builder Signing oracle — deploy/approvals refuse without it. */
  readonly builder?: PolymarketBuilder;
  readonly logger: EngineLogger;
};

export function createPolymarketEnable(options: PolymarketEnableOptions): AppProvider {
  const api = (): ReturnType<typeof polymarket> => polymarket(options.wallet);
  const http = createPolymarketHttp({
    fetch: options.fetch,
    setTimer: options.setTimer,
    now: options.now,
  });
  const relayer: PolymarketRelayer = createPolymarketRelayer({
    http,
    ...(options.builder === undefined ? {} : { builder: options.builder }),
    now: options.now,
    setTimer: options.setTimer,
  });

  /** The group's kernel credential set — the engine's own fact for the credentials step. */
  const hasCredentials = async (group: AppGroup): Promise<boolean> =>
    (await options.account.credentials(group)) !== undefined;

  /**
   * Open an `evm-sign` request for `typedData` and await the 65-byte owner signature —
   * refused/expired requests are `approval-rejected`, a non-signature result `unavailable` (the
   * same contract `trade.ts` posts under).
   */
  const signTypedData = async (
    group: AppGroup,
    flow: AppFlow,
    typedData: string,
  ): Promise<`0x${string}`> => {
    const pending = await options.requests.prepare({
      method: "evm-sign",
      account: accountRef(group),
      network: NETWORK,
      request: {
        kind: "evm.typed-data",
        network: NETWORK,
        account: accountRef(group),
        typedData,
      },
    });
    flow.write({ requestId: pending.id });
    try {
      const result = await options.requests.outcome(pending.id);
      if (
        !("kind" in result) ||
        result.kind !== "evm.typed-data" ||
        result.signature.length !== 65
      ) {
        throw new PolymarketError(
          "unavailable",
          "the request resolved without a typed-data signature",
        );
      }
      return toHex(result.signature);
    } catch (error) {
      if (error instanceof RequestEndedError) {
        throw new PolymarketError("approval-rejected", `the request was ${error.stage}`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      flow.write({ requestId: undefined });
    }
  };

  /**
   * `POST /auth/api-key`, then `GET /auth/derive-api-key` under the same L1 headers when create
   * fails or answers without credentials — one user signature serves both (getting-started/api.md
   * §Create or Derive API Keys).
   */
  const createOrDeriveCredentials = async (
    signer: `0x${string}`,
    signature: `0x${string}`,
    timestamp: string,
  ): Promise<{ apiKey: string; secret: string; passphrase: string }> => {
    const headers = {
      POLY_ADDRESS: signer,
      POLY_SIGNATURE: signature,
      POLY_TIMESTAMP: timestamp,
      POLY_NONCE: "0",
    };
    let credentials;
    try {
      credentials = await http.request(
        { host: CLOB_HOST, method: "POST", path: "/auth/api-key", headers },
        clobApiKeyResponse,
      );
    } catch {
      /* Create failed (e.g. key already exists) — the same signature also derives. */
    }
    if (credentials !== undefined) {
      return credentials;
    }
    return http.request(
      { host: CLOB_HOST, method: "GET", path: "/auth/derive-api-key", headers },
      clobApiKeyResponse,
    );
  };

  /** The enable state machine — every step writes; a failure leaves a resumable state. */
  const enableFlow = async (group: AppGroup, flow: AppFlow): Promise<void> => {
    if (flow.current().status !== "enabling") {
      flow.write({ status: "enabling", step: "locate-wallet", error: undefined });
    }
    if (!flow.current().termsAcknowledged) {
      fail(flow, "invalid-input", "Polymarket terms have not been acknowledged");
    }
    /* The kernel's signing window gates L2 signatures — start refused when the clock is beyond
       it rather than failing the verify step minutes later. */
    const { skewMs } = await http.time();
    if (Math.abs(skewMs) > MAX_SKEW_MS) {
      fail(flow, "clock-skew", `the device clock is ${Math.round(skewMs)} ms off the CLOB's`);
    }

    flow.write({ step: "locate-wallet" });
    let account = await options.account.locate(group);
    flow.write({ account: stateAccount(account) });
    if (account.kind === "safe") {
      /* A legacy Safe cannot be enabled here — read-only until the user migrates on
         polymarket.com (design.md §locate). */
      flow.write({ status: "needs-migration", step: undefined, requestId: undefined });
      throw new PolymarketError(
        "needs-migration",
        "the group only has a legacy Safe — migrate it to a deposit wallet first",
      );
    }
    if (!account.deployed) {
      flow.write({ step: "deploy-wallet" });
      await relayer.deploy(account.signer, derivePolymarketWallets(account.signer).beacon);
      account = { ...account, deployed: true };
      flow.write({ account: stateAccount(account) });
    }

    if (!(await hasCredentials(group))) {
      flow.write({ step: "credentials" });
      const timestamp = String(Math.floor(options.now() / 1000));
      const signature = await signTypedData(
        group,
        flow,
        clobAuthTypedData(account.signer, timestamp),
      );
      const credentials = await createOrDeriveCredentials(account.signer, signature, timestamp);
      /* The secret is sealed into the vault here and drops out of scope with the step. */
      await api().importCredentials({
        owner: { walletId: group.walletId, groupIndex: group.groupIndex },
        apiKey: credentials.apiKey,
        secret: credentials.secret,
        passphrase: credentials.passphrase,
      });
    }

    const approvals = await options.account.approvals(account.wallet);
    const calls: RelayerCall[] = missingApprovals(approvals.contracts).map((row) => ({
      target: row.token,
      value: "0",
      data: row.data,
    }));
    if (calls.length > 0) {
      flow.write({ step: "approvals" });
      /* The batch submits through the builder-signed relayer — refuse before any request (the
         nonce read included) rather than after the user's signature. */
      if (options.builder === undefined) {
        fail(
          flow,
          "builder-required",
          "approving the trading contracts submits through the relayer, which needs the host's builder signer",
        );
      }
      const nonce = await relayer.nonce(account.signer);
      const deadline = Math.floor(options.now() / 1000) + BATCH_DEADLINE_SECONDS;
      const signature = await signTypedData(
        group,
        flow,
        batchTypedData({ wallet: account.wallet, nonce, deadline, calls }),
      );
      await relayer.submitBatch({
        signer: account.signer,
        wallet: account.wallet,
        calls,
        signature,
        nonce,
        deadline,
        metadata: "Approve trading",
      });
    }

    flow.write({ step: "verify" });
    await options.account.refreshAllowance(group, { assetType: "COLLATERAL" });
    flow.write({ status: "enabled", step: undefined, requestId: undefined, error: undefined });
  };

  /** The facts-only status reconcile derives — never opens a request. */
  const reconcileFlow = async (group: AppGroup, flow: AppFlow): Promise<void> => {
    const account = await options.account.locate(group);
    const written = stateAccount(account);
    if (account.kind === "safe") {
      flow.write({
        status: "needs-migration",
        step: undefined,
        requestId: undefined,
        account: written,
        error: undefined,
      });
      return;
    }
    if (!account.deployed || !(await hasCredentials(group))) {
      flow.write({
        status: "disabled",
        step: undefined,
        requestId: undefined,
        account: written,
        error: undefined,
      });
      return;
    }
    const approvals = await options.account.approvals(account.wallet);
    const missing = missingApprovals(approvals.contracts);
    if (missing.length > 0) {
      flow.write({
        status: "enabling",
        step: "approvals",
        account: written,
        error: undefined,
      });
      return;
    }
    flow.write({
      status: "enabled",
      step: undefined,
      requestId: undefined,
      account: written,
      error: undefined,
    });
  };

  return {
    id: "polymarket",
    error: (category, message) =>
      new PolymarketError(
        /* The controller's `unavailable` is the jurisdiction gate — Polymarket reports it as
           `blocked` so it is never confused with a server 5xx. */
        category === "unavailable" ? "blocked" : category,
        message,
      ),
    groups: async () => {
      const seen = new Map<string, AppGroup>();
      for (const creds of await api().listCredentials()) {
        seen.set(`${creds.walletId}/${creds.groupIndex}`, {
          walletId: creds.walletId,
          groupIndex: creds.groupIndex,
        });
      }
      return [...seen.values()];
    },
    reconcile: async (group, flow) => guard(flow, async () => reconcileFlow(group, flow)),
    enable: async (group, flow) => guard(flow, async () => enableFlow(group, flow)),
    renew: async () => {
      await Promise.resolve();
      throw new PolymarketError(
        "invalid-input",
        "Polymarket credentials do not expire — there is nothing to renew",
      );
    },
    disable: async (group, { revoke }, flow) =>
      guard(flow, async () => {
        if (revoke) {
          /* The CLOB-side revoke is an L2 action — a failure records `error` but cannot block
             the local delete, or a dead key would strand the disable. */
          try {
            await options.account.revokeApiKey(group);
          } catch (error) {
            flow.write({ error: errorOf(error) });
            options.logger.warn("polymarket api-key revoke failed", error);
          }
        }
        await api().deleteCredentials({
          walletId: group.walletId,
          groupIndex: group.groupIndex,
        });
        /* The wallet and its on-chain approvals stay — enabling again reuses them. Deriving with
           the same nonce returns the same credentials, so a local delete alone is no revoke. */
        flow.write({ status: "disabled", step: undefined, requestId: undefined });
      }),
    cancel: async (group, flow) => {
      const { requestId } = flow.current();
      if (requestId !== undefined) {
        options.requests.reject(requestId);
      }
      await reconcileFlow(group, flow);
    },
  };
}
