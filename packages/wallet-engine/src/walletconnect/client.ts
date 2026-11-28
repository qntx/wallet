import { utf8ToBytes } from "@noble/hashes/utils.js";
import { WalletKit } from "@reown/walletkit";
import { Core } from "@walletconnect/core";
import type {
  ICore,
  PendingRequestTypes,
  ProposalTypes,
  SessionTypes,
  SignClientTypes,
} from "@walletconnect/types";
import { getSdkError, parseUri } from "@walletconnect/utils";

import type { Wallet } from "@qntx/wallet";

import type { ConnectionScope, ConnectionSession, ConnectionState } from "../connect/controller.ts";
import { evmChainId } from "../connect/controller.ts";
import { MAX_MESSAGE_BYTES } from "../connect/index.ts";
import { Controller } from "../controller.ts";
import type { DeepReadonly, ReadonlyStore } from "../engine.ts";
import type { EngineLogger } from "../events.ts";
import type { RiskFinding } from "../requests/risk.ts";
import type { WalletConnectOrigin, WalletConnectVerify } from "../requests/types.ts";
import { walletConnectKey } from "../requests/types.ts";
import type { SessionAuthenticate } from "./authenticate.ts";
import { handleAuthenticate } from "./authenticate.ts";
import { bip122Addresses, bip122Row } from "./bip122.ts";
import { eip155Row } from "./eip155.ts";
import { WalletConnectError, requestError } from "./errors.ts";
import type { NamespaceRow, WalletConnectEngine } from "./namespaces.ts";
import { sameNamespaces, sessionNamespaces } from "./namespaces.ts";
import { judgeProposal, metadataOrigin, verifyOf } from "./proposals.ts";
import type { SessionRequestItem } from "./queue.ts";
import { SessionRequestQueue } from "./queue.ts";
import { solanaRow } from "./solana.ts";

export type WalletConnectStorage = {
  readonly getKeys: () => Promise<string[]>;
  readonly getEntries: () => Promise<Array<[string, unknown]>>;
  readonly getItem: (key: string) => Promise<unknown>;
  readonly setItem: (key: string, value: unknown) => Promise<void>;
  readonly removeItem: (key: string) => Promise<void>;
};

export type WalletConnectMetadata = {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly icons: ReadonlyArray<string>;
  readonly redirect?: { readonly native?: string; readonly universal?: string };
};

export type WalletConnectOptions = {
  readonly projectId: string;
  readonly metadata: WalletConnectMetadata;
  readonly storage: WalletConnectStorage;
  /** Overrides Reown's relay — tests and the gated e2e only. */
  readonly relayUrl?: string;
  readonly wallet: Pick<Wallet, "getSnapshot" | "subscribe">;
  readonly engine: WalletConnectEngine;
  readonly now: () => number;
  readonly logger: EngineLogger;
};

export type WalletConnectProposal = {
  readonly id: number;
  /** Self-declared by the peer — display only, never verified. */
  readonly peer: {
    readonly name: string;
    readonly url: string;
    readonly description: string;
    readonly icons: ReadonlyArray<string>;
  };
  readonly verify: WalletConnectVerify;
  readonly risk: ReadonlyArray<RiskFinding>;
  /** What the grant may contain: requested ∩ served by a namespace row ∩ enabled, in request order. */
  readonly networks: ReadonlyArray<string>;
  /** The required networks; a grant must keep them all. */
  readonly required: ReadonlyArray<string>;
  /** The WalletConnect methods the session will carry, per namespace. */
  readonly methods: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly expiresAt: number;
};

export type WalletConnectState = {
  readonly proposals: Readonly<Record<string, WalletConnectProposal>>;
};

export type WalletConnect = {
  readonly getState: () => WalletConnectState;
  readonly store: ReadonlyStore<WalletConnectState>;
  readonly pair: (uri: string) => Promise<void>;
  readonly approve: (
    id: number,
    grant: {
      readonly networks: ReadonlyArray<string>;
      readonly acknowledged?: ReadonlyArray<RiskFinding["code"]>;
    },
  ) => Promise<ConnectionSession>;
  readonly reject: (id: number) => Promise<void>;
  readonly dispose: () => Promise<void>;
};

/** One row per CAIP namespace the wallet serves. */
const ROWS: Readonly<Record<string, NamespaceRow>> = {
  eip155: eip155Row,
  solana: solanaRow,
  bip122: bip122Row,
};

/** A session within this much of its expiry is extended on every reconcile. */
const EXTEND_WITHIN_MS = 6 * 24 * 60 * 60 * 1000;

type Kit = Awaited<ReturnType<typeof WalletKit.init>>;
type ProposalEvent = SignClientTypes.EventArguments["session_proposal"];
type RequestEvent = SignClientTypes.EventArguments["session_request"];
type StoredSession = DeepReadonly<ConnectionSession>;
type ResultAnswer = {
  readonly id: number;
  readonly jsonrpc: "2.0";
  readonly result: unknown;
};
type ErrorAnswer = {
  readonly id: number;
  readonly jsonrpc: "2.0";
  readonly error: { readonly code: number; readonly message: string };
};

type JudgedProposal = Extract<ReturnType<typeof judgeProposal>, { readonly ok: true }>["proposal"];

class WalletConnectController extends Controller<WalletConnectState> implements WalletConnect {
  private readonly queue: SessionRequestQueue;
  private readonly judged = new Map<number, JudgedProposal>();
  private readonly held = new Map<
    number,
    { readonly proposal: ProposalTypes.Struct; readonly verify: Promise<WalletConnectVerify> }
  >();
  private readonly heldAuths = new Map<number, SessionAuthenticate>();
  private readonly lastNetwork = new Map<string, string>();
  private readonly gone = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private reconcileScheduled = false;
  private establishing = 0;
  private disposed = false;
  private walletIds = new Set<string>();
  private readonly off: Array<() => void> = [];
  private readonly options: WalletConnectOptions;
  private readonly core: ICore;
  private readonly kit: Kit;

  constructor(options: WalletConnectOptions, core: ICore, kit: Kit) {
    super({ name: "walletconnect", defaultState: () => ({ proposals: {} }) });
    this.options = options;
    this.core = core;
    this.kit = kit;
    this.queue = new SessionRequestQueue({
      run: async (item) => this.runRequest(item),
      invalidate: (topic) => {
        this.options.engine.connections.invalidateOrigin(walletConnectKey(topic));
      },
      warn: (error) => this.options.logger.warn("walletconnect request failed", error),
    });
  }

  async init(): Promise<void> {
    const { engine, wallet } = this.options;
    this.walletIds = new Set(wallet.getSnapshot().wallets.map((w) => w.walletId));
    this.kit.on("session_proposal", this.onProposal);
    this.kit.on("proposal_expire", this.onProposalExpire);
    this.kit.on("session_request", this.onSessionRequest);
    this.kit.on("session_request_expire", this.onRequestExpire);
    this.kit.on("session_delete", this.onSessionDelete);
    this.kit.on("session_authenticate", this.onSessionAuthenticate);
    const { signClient } = this.kit.engine;
    signClient.events.on("session_expire", this.onSessionExpire);
    this.off.push(
      () => {
        this.kit.off("session_proposal", this.onProposal);
        this.kit.off("proposal_expire", this.onProposalExpire);
        this.kit.off("session_request", this.onSessionRequest);
        this.kit.off("session_request_expire", this.onRequestExpire);
        this.kit.off("session_delete", this.onSessionDelete);
        this.kit.off("session_authenticate", this.onSessionAuthenticate);
        signClient.events.off("session_expire", this.onSessionExpire);
      },
      engine.connections.store.subscribe(
        (state: DeepReadonly<ConnectionState>, previous: DeepReadonly<ConnectionState>) =>
          this.onConnections(state.ready, previous.ready),
      ),
      wallet.subscribe(() => this.onWallet()),
    );
    // Recovery: proposals left over from before the restart take the same validation path.
    for (const proposal of Object.values(this.kit.getPendingSessionProposals())) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- proposals are judged in order
      await this.offerProposal(proposal, async () => this.recoverVerify(proposal));
    }
    for (const pending of this.kit.getPendingSessionRequests()) {
      this.enqueue(pending);
    }
    // The auth store keeps pending authenticates across restarts; they take the same path —
    // a locked vault holds them until connections become ready, like proposals.
    for (const pending of signClient.auth.requests.getAll()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- requests are offered in order
      await this.offerAuth({
        id: pending.id,
        topic: pending.pairingTopic,
        params: {
          requester: pending.requester,
          authPayload: pending.authPayload,
          expiryTimestamp: pending.expiryTimestamp,
        },
        verifyContext: pending.verifyContext,
      });
    }
    this.syncReady();
    this.scheduleReconcile();
  }

  async destroy(): Promise<void> {
    await this.dispose();
  }

  /** Tears the transport down: unsubscribes, closes the relay connection, clears state. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const off of this.off) {
      off();
    }
    this.off.length = 0;
    try {
      await this.core.relayer.transportClose();
    } catch (error) {
      this.options.logger.warn("walletconnect transport close failed", error);
    }
    this.judged.clear();
    this.held.clear();
    this.heldAuths.clear();
    this.update(() => ({ proposals: {} }));
  }

  /** `wc:` pairing URI → an active pairing the dApp's proposal arrives on. */
  async pair(uri: string): Promise<void> {
    let parsed: ReturnType<typeof parseUri>;
    try {
      parsed = parseUri(uri);
    } catch {
      throw new WalletConnectError("invalid-uri", "not a WalletConnect pairing URI");
    }
    if (
      parsed.version !== 2 ||
      !/^[0-9a-f]{64}$/i.test(parsed.topic) ||
      typeof parsed.symKey !== "string" ||
      parsed.symKey === "" ||
      parsed.relay?.protocol === undefined
    ) {
      throw new WalletConnectError("invalid-uri", "not a v2 WalletConnect pairing URI");
    }
    if (
      parsed.expiryTimestamp !== undefined &&
      parsed.expiryTimestamp * 1000 <= this.options.now()
    ) {
      throw new WalletConnectError("expired-uri", "the pairing URI has expired");
    }
    // A URI's topic is consumed by the first pair() — any stored pairing means a re-use.
    if (this.core.pairing.getPairings().some((pairing) => pairing.topic === parsed.topic)) {
      throw new WalletConnectError("duplicate-pairing", "this pairing URI is already in use");
    }
    try {
      await this.kit.pair({ uri });
    } catch (error) {
      if (error instanceof Error && error.message.includes("Pairing already exists")) {
        throw new WalletConnectError("duplicate-pairing", "this pairing URI is already active");
      }
      throw error;
    }
  }

  /**
   * Grants `grant.networks` to the proposal: the session is settled on the relay inside the
   * connection store's write queue, then persisted under `walletconnect:<topic>`.
   */
  async approve(
    id: number,
    grant: {
      readonly networks: ReadonlyArray<string>;
      readonly acknowledged?: ReadonlyArray<RiskFinding["code"]>;
    },
  ): Promise<ConnectionSession> {
    const proposal = this.getState().proposals[id];
    const judged = this.judged.get(id);
    if (proposal === undefined || judged === undefined) {
      throw new WalletConnectError("unknown-proposal", `unknown proposal ${id}`);
    }
    if (this.options.now() >= proposal.expiresAt) {
      this.removeProposal(id);
      throw new WalletConnectError("expired", "the proposal has expired");
    }
    if (!this.ready()) {
      throw new WalletConnectError("locked", "the wallet is locked");
    }
    if (this.options.engine.phishing.check(proposal.peer.url) === "blocked") {
      await this.rejectProposal(id);
      throw new WalletConnectError("blocked", "the peer url is on the phishing list");
    }
    const acknowledged = new Set(grant.acknowledged);
    if (
      !proposal.risk
        .filter((finding) => finding.level === "danger")
        .every((finding) => acknowledged.has(finding.code))
    ) {
      throw new WalletConnectError("unacknowledged", "danger findings must be acknowledged");
    }
    const granted = new Set(grant.networks);
    if (
      grant.networks.length === 0 ||
      !proposal.required.every((network) => granted.has(network)) ||
      grant.networks.some((network) => !proposal.networks.includes(network))
    ) {
      throw new WalletConnectError("invalid-grant", "the granted networks are not in the offer");
    }
    const scopes: Record<string, Omit<ConnectionScope, "accounts">> = {};
    for (const network of grant.networks) {
      const key = network.split(":")[0] ?? "";
      const offered = judged.offer.namespaces[key];
      const row = ROWS[key];
      if (offered === undefined || row === undefined) {
        throw new WalletConnectError("invalid-grant", "the granted networks are not in the offer");
      }
      const methods = new Set<string>();
      for (const method of offered.methods) {
        for (const providerMethod of row.methods[method] ?? []) {
          methods.add(providerMethod);
        }
      }
      scopes[network] = { methods: [...methods], notifications: [...offered.events] };
    }
    this.establishing += 1;
    try {
      const session = await this.options.engine.connections.establishWalletConnect(
        scopes,
        async (bound) => this.settle(id, proposal, judged, bound),
      );
      if (
        session.origin.kind === "walletconnect" &&
        judged.offer.namespaces["bip122"]?.events.includes("bip122_addressesChanged") === true
      ) {
        for (const network of grant.networks.filter((n) => n.startsWith("bip122:"))) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- events go out in grant order
          await this.emitBip122Addresses(session.origin, session.origin.topic, network);
        }
      }
      this.removeProposal(id);
      return session;
    } finally {
      this.establishing -= 1;
      this.scheduleReconcile();
    }
  }

  /** One `bip122_addressesChanged` — failures are logged, never thrown. */
  private async emitBip122Addresses(
    origin: WalletConnectOrigin,
    topic: string,
    chainId: string,
  ): Promise<void> {
    try {
      const data = await bip122Addresses(this.options.engine, origin, chainId);
      await this.kit.emitSessionEvent({
        topic,
        event: { name: "bip122_addressesChanged", data },
        chainId,
      });
    } catch (error) {
      this.options.logger.warn("walletconnect event failed", error);
    }
  }

  /** Turns the proposal down; the peer learns the rejection. */
  async reject(id: number): Promise<void> {
    if (this.getState().proposals[id] === undefined) {
      throw new WalletConnectError("unknown-proposal", `unknown proposal ${id}`);
    }
    await this.rejectProposal(id);
  }

  /** Settles the session on the relay and hands the controller its walletconnect origin. */
  private async settle(
    id: number,
    proposal: WalletConnectProposal,
    judged: JudgedProposal,
    bound: Readonly<Record<string, ConnectionScope>>,
  ): Promise<WalletConnectOrigin> {
    const namespaces: SessionTypes.Namespaces = {};
    for (const [key, offered] of Object.entries(judged.offer.namespaces)) {
      const row = ROWS[key];
      const chains = offered.chains.filter((chain) => bound[chain] !== undefined);
      if (row === undefined || chains.length === 0) {
        continue;
      }
      namespaces[key] = {
        chains,
        accounts: chains.flatMap((chain) => {
          const scope = bound[chain];
          return scope === undefined ? [] : row.accounts(scope);
        }),
        methods: [...offered.methods],
        events: [...offered.events],
      };
    }
    const session = await this.kit.approveSession({ id, namespaces });
    return {
      kind: "walletconnect",
      origin: walletConnectKey(session.topic),
      topic: session.topic,
      url: proposal.peer.url,
      name: proposal.peer.name,
      verify: proposal.verify,
    };
  }

  private ready(): boolean {
    return this.options.engine.connections.getState().ready;
  }

  private removeProposal(id: number): void {
    this.judged.delete(id);
    this.update((state) => {
      const { [id]: _gone, ...proposals } = state.proposals;
      return { proposals };
    });
  }

  private async rejectProposal(id: number): Promise<void> {
    this.removeProposal(id);
    try {
      await this.kit.rejectSession({ id, reason: getSdkError("USER_REJECTED") });
    } catch (error) {
      this.options.logger.warn("walletconnect proposal rejection failed", error);
    }
  }

  /**
   * A proposal — live event or recovered from the store — judged end to end; rejected ones are
   * answered at once, servable ones enter the state until approved, rejected or expired.
   */
  private async offerProposal(
    proposal: ProposalTypes.Struct,
    resolveVerify: () => WalletConnectVerify | Promise<WalletConnectVerify>,
  ): Promise<void> {
    const { engine } = this.options;
    if (!this.ready()) {
      // Locked: the enabled set is empty, so judging now would wrongly refuse every chain. The
      // proposal waits — not rejected, not shown — until connections are ready; its Verify
      // resolution already runs.
      this.held.set(proposal.id, { proposal, verify: Promise.resolve(resolveVerify()) });
      return;
    }
    const verify = await resolveVerify();
    const verdict = judgeProposal(proposal, verify, {
      phishing: (url) => engine.phishing.check(url),
      isEnabled: (network) => engine.connections.isEnabled(network),
      rows: ROWS,
      userRejected: () => getSdkError("USER_REJECTED"),
    });
    if (!verdict.ok) {
      try {
        await this.kit.rejectSession({ id: proposal.id, reason: verdict.error });
      } catch (error) {
        this.options.logger.warn("walletconnect proposal rejection failed", error);
      }
      return;
    }
    const judged = verdict.proposal;
    this.judged.set(proposal.id, judged);
    this.update((state) => ({
      proposals: {
        ...state.proposals,
        [proposal.id]: {
          id: proposal.id,
          peer: judged.peer,
          verify: judged.verify,
          risk: judged.risk,
          networks: judged.offer.networks,
          required: judged.offer.required,
          methods: Object.fromEntries(
            Object.entries(judged.offer.namespaces).map(([key, offered]) => [key, offered.methods]),
          ),
          expiresAt: judged.expiresAt,
        },
      },
    }));
  }

  /** A recovered proposal re-resolves its attestation; a failed resolution stays UNKNOWN. */
  private async recoverVerify(proposal: ProposalTypes.Struct): Promise<WalletConnectVerify> {
    try {
      const { origin, isScam } = await this.core.verify.resolve({
        ...(proposal.attestation === undefined ? {} : { attestationId: proposal.attestation }),
        ...(proposal.encryptedId === undefined ? {} : { encryptedId: proposal.encryptedId }),
        ...(proposal.proposer.metadata.verifyUrl === undefined
          ? {}
          : { verifyUrl: proposal.proposer.metadata.verifyUrl }),
      });
      const url = metadataOrigin(proposal.proposer.metadata.url);
      return {
        validation:
          url !== undefined && origin === url
            ? "VALID"
            : typeof origin === "string" && origin.length > 0
              ? "INVALID"
              : "UNKNOWN",
        isScam: isScam === true,
      };
    } catch {
      // Verify is a hint; a resolution failure is a neutral UNKNOWN.
      return { validation: "UNKNOWN", isScam: false };
    }
  }

  private enqueue(
    request: Pick<PendingRequestTypes.Struct, "id" | "topic" | "params" | "verifyContext">,
  ): void {
    this.queue.enqueue({
      id: request.id,
      topic: request.topic,
      chainId: request.params.chainId,
      method: request.params.request.method,
      params: request.params.request.params,
      expiryTimestamp: request.params.request.expiryTimestamp,
      verify: verifyOf(request.verifyContext.verified),
    });
  }

  /** One queued request: validate, dispatch through the shared handler, answer. */
  private async runRequest(item: SessionRequestItem): Promise<void> {
    const { engine } = this.options;
    if (!this.ready()) {
      this.queue.requeue(item);
      return;
    }
    if (item.expiryTimestamp !== undefined && item.expiryTimestamp * 1000 <= this.options.now()) {
      await this.respond(item, {
        id: item.id,
        jsonrpc: "2.0",
        error: { code: 4100, message: "Request expired" },
      });
      return;
    }
    if (utf8ToBytes(JSON.stringify(item.params)).length > MAX_MESSAGE_BYTES) {
      await this.respond(item, {
        id: item.id,
        jsonrpc: "2.0",
        error: { code: -32005, message: "request params exceed the message size limit" },
      });
      return;
    }
    const session = engine.connections.session(walletConnectKey(item.topic));
    if (session === undefined || session.origin.kind !== "walletconnect") {
      await this.respond(item, {
        id: item.id,
        jsonrpc: "2.0",
        error: { code: 4100, message: "not authorized" },
      });
      return;
    }
    const row = ROWS[item.chainId.split(":")[0] ?? ""];
    if (row === undefined) {
      await this.respond(item, {
        id: item.id,
        jsonrpc: "2.0",
        error: { code: -32601, message: "unsupported namespace" },
      });
      return;
    }
    const origin: WalletConnectOrigin = { ...session.origin, verify: item.verify };
    try {
      const result = await row.dispatch(
        { origin, network: item.chainId, method: item.method, params: item.params },
        engine,
      );
      await this.respond(item, { id: item.id, jsonrpc: "2.0", result });
    } catch (error) {
      if (this.queue.wasExpired(item.id)) {
        return;
      }
      // A dispatch that failed because the vault locked goes back to the head — not answered.
      if (!this.ready()) {
        this.queue.requeue(item);
        return;
      }
      await this.respond(item, {
        id: item.id,
        jsonrpc: "2.0",
        error: requestError(error),
      });
    }
  }

  /** The peer gets its answer unless the request expired while it ran — then none is sent. */
  private async respond(
    item: SessionRequestItem,
    answer: ResultAnswer | ErrorAnswer,
  ): Promise<void> {
    if (this.queue.wasExpired(item.id)) {
      return;
    }
    try {
      await this.kit.respondSessionRequest({ topic: item.topic, response: answer });
    } catch (error) {
      this.options.logger.warn("walletconnect response failed", error);
    }
  }

  private readonly onProposal = (event: ProposalEvent): void => {
    this.serialized(async () => {
      try {
        await this.offerProposal(event.params, () => verifyOf(event.verifyContext.verified));
      } catch (error) {
        this.options.logger.warn("walletconnect proposal failed", error);
      }
    });
  };

  private readonly onProposalExpire = (event: { id: number }): void => {
    this.held.delete(event.id);
    this.removeProposal(event.id);
  };

  private readonly onSessionRequest = (event: RequestEvent): void => {
    this.enqueue(event);
  };

  private readonly onRequestExpire = (event: { id: number }): void => {
    this.queue.expire(event.id);
  };

  private readonly onSessionDelete = (event: { id: number; topic: string }): void => {
    this.sessionEnded(event.topic);
  };

  private readonly onSessionExpire = (event: { topic: string }): void => {
    this.sessionEnded(event.topic);
  };

  /** The peer or the expirer ended the session: drop its queue; the next reconcile revokes it. */
  private sessionEnded(topic: string): void {
    this.queue.drop(topic);
    this.lastNetwork.delete(topic);
    this.scheduleReconcile();
  }

  private syncReady(): void {
    this.queue.setReady(this.ready());
  }

  private onConnections(ready: boolean, wasReady: boolean): void {
    if (!ready) {
      this.queue.setReady(false);
      return;
    }
    if (!wasReady) {
      this.queue.setReady(true);
      this.drainHeld();
    }
    this.scheduleReconcile();
  }

  /** Proposals and auths held while locked get judged now, in arrival order. */
  private drainHeld(): void {
    for (const [id, held] of this.held) {
      this.held.delete(id);
      this.serialized(async () => this.offerProposal(held.proposal, async () => held.verify));
    }
    for (const [id, auth] of this.heldAuths) {
      this.heldAuths.delete(id);
      this.serialized(async () => this.offerAuth(auth));
    }
  }

  /**
   * A `session_authenticate` — live event or recovered from the auth store — handled end to end.
   * While locked it is held raw (the enabled set is empty); when ready it validates, signs the SIWE
   * through the pipeline and settles. Auth requests are short-lived, so a held one is never
   * re-emitted and an expired one is simply refused when it finally runs.
   */
  private async offerAuth(event: SessionAuthenticate): Promise<void> {
    if (!this.ready()) {
      this.heldAuths.set(event.id, event);
      return;
    }
    await handleAuthenticate(event, {
      kit: this.kit,
      engine: this.options.engine,
      now: this.options.now,
      warn: (message, error) => this.options.logger.warn(message, error),
      establish: async (work) => {
        this.establishing += 1;
        try {
          return await work();
        } finally {
          this.establishing -= 1;
          this.scheduleReconcile();
        }
      },
    });
  }

  private readonly onSessionAuthenticate = (event: SessionAuthenticate): void => {
    this.serialized(async () => {
      try {
        await this.offerAuth(event);
      } catch (error) {
        this.options.logger.warn("walletconnect authenticate failed", error);
      }
    });
  };

  /** Async lifecycle work runs strictly serial so repoints and deletions never interleave. */
  private serialized(work: () => Promise<void>): void {
    const previous = this.chain;
    this.chain = (async () => {
      await previous;
      try {
        await work();
      } catch (error) {
        this.options.logger.warn("walletconnect lifecycle failed", error);
      }
    })();
  }

  private scheduleReconcile(): void {
    if (this.disposed || !this.ready()) {
      return;
    }
    if (this.reconcileScheduled) {
      return;
    }
    this.reconcileScheduled = true;
    this.serialized(async () => {
      this.reconcileScheduled = false;
      await this.reconcile();
    });
  }

  /**
   * Aligns the WalletKit session set with the controller's `walletconnect:` sessions — a session
   * only the peer still holds is disconnected, one only the wallet holds is revoked, and a session
   * both hold is re-pointed at the selected group's accounts and the session's current network.
   */
  private async reconcile(): Promise<void> {
    const { engine } = this.options;
    if (!this.ready()) {
      return;
    }
    const active = this.kit.getActiveSessions();
    const ours = new Map<string, StoredSession>();
    for (const session of Object.values(engine.connections.getState().sessions)) {
      if (session.origin.kind === "walletconnect") {
        ours.set(session.origin.topic, session);
      }
    }
    // A session being settled right now is neither side's yet — disconnects wait for it.
    if (this.establishing === 0) {
      for (const topic of Object.keys(active)) {
        if (!ours.has(topic) && !this.gone.has(topic)) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- sessions process one at a time
          await this.kit
            .disconnectSession({ topic, reason: getSdkError("USER_DISCONNECTED") })
            .catch((error: unknown) => {
              this.options.logger.warn("walletconnect disconnect failed", error);
            });
        }
      }
    }
    for (const [topic, session] of ours) {
      if (this.gone.has(topic)) {
        continue;
      }
      const live = active[topic];
      if (live === undefined) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sessions process one at a time
        await engine.connections.revoke(session.origin.origin).catch((error: unknown) => {
          this.options.logger.warn("walletconnect revoke failed", error);
        });
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- sessions process one at a time
      await this.repoint(topic, live, session);
    }
  }

  /** One live session: re-advertise scopes, push account/chain changes, keep its expiry alive. */
  private async repoint(
    topic: string,
    live: SessionTypes.Struct,
    session: StoredSession,
  ): Promise<void> {
    const recomputed = sessionNamespaces(session.scopes, live.namespaces, ROWS);
    if (recomputed === undefined) {
      await this.kit
        .disconnectSession({ topic, reason: getSdkError("USER_DISCONNECTED") })
        .catch((error: unknown) => {
          this.options.logger.warn("walletconnect disconnect failed", error);
        });
      await this.options.engine.connections
        .revoke(session.origin.origin)
        .catch((error: unknown) => {
          this.options.logger.warn("walletconnect revoke failed", error);
        });
      return;
    }
    if (!sameNamespaces(live.namespaces, recomputed)) {
      const changed = changedAccounts(live.namespaces, recomputed);
      try {
        await this.kit.updateSession({ topic, namespaces: recomputed });
      } catch (error) {
        this.options.logger.warn("walletconnect session update failed", error);
      }
      for (const [chainId, accounts] of changed) {
        const offered = recomputed[chainId.split(":")[0] ?? ""];
        if (offered !== undefined && offered.events.includes("accountsChanged")) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- events go out in chain order
          await this.kit
            .emitSessionEvent({
              topic,
              event: { name: "accountsChanged", data: [...accounts] },
              chainId,
            })
            .catch((error: unknown) => {
              this.options.logger.warn("walletconnect event failed", error);
            });
        }
        if (
          session.origin.kind === "walletconnect" &&
          chainId.startsWith("bip122:") &&
          offered !== undefined &&
          offered.events.includes("bip122_addressesChanged")
        ) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- events go out in chain order
          await this.emitBip122Addresses(session.origin, topic, chainId);
        }
      }
    }
    const previous = this.lastNetwork.get(topic);
    this.lastNetwork.set(topic, session.currentNetwork);
    const chainId = evmChainId(session.currentNetwork);
    const evm = recomputed["eip155"];
    if (
      previous !== undefined &&
      previous !== session.currentNetwork &&
      chainId !== undefined &&
      evm !== undefined &&
      evm.events.includes("chainChanged") &&
      (evm.chains ?? []).includes(session.currentNetwork)
    ) {
      await this.kit
        .emitSessionEvent({
          topic,
          event: { name: "chainChanged", data: chainId },
          chainId: session.currentNetwork,
        })
        .catch((error: unknown) => {
          this.options.logger.warn("walletconnect event failed", error);
        });
    }
    if (live.expiry * 1000 - this.options.now() < EXTEND_WITHIN_MS) {
      await this.kit.extendSession({ topic }).catch((error: unknown) => {
        this.options.logger.warn("walletconnect extend failed", error);
      });
    }
  }

  /** A deleted wallet's sessions die at once — before a repoint could serve another wallet's. */
  private onWallet(): void {
    const snapshot = this.options.wallet.getSnapshot();
    // A locked vault reports no wallets — that is the lock, not a deletion.
    if (snapshot.vault.status !== "unlocked") {
      return;
    }
    const ids = new Set(snapshot.wallets.map((w) => w.walletId));
    const removed = [...this.walletIds].filter((id) => !ids.has(id));
    this.walletIds = ids;
    if (removed.length === 0) {
      return;
    }
    this.serialized(async () => {
      const active = this.kit.getActiveSessions();
      for (const session of Object.values(this.options.engine.connections.getState().sessions)) {
        if (
          session.origin.kind !== "walletconnect" ||
          session.group === undefined ||
          !removed.includes(session.group.walletId)
        ) {
          continue;
        }
        const { topic } = session.origin;
        this.gone.add(topic);
        const live = active[topic];
        if (live !== undefined) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- sessions process one at a time
          await this.kit
            .disconnectSession({ topic, reason: getSdkError("USER_DISCONNECTED") })
            .catch((error: unknown) => {
              this.options.logger.warn("walletconnect disconnect failed", error);
            });
          // oxlint-disable-next-line eslint/no-await-in-loop -- sessions process one at a time
          await this.core.pairing
            .disconnect({ topic: live.pairingTopic })
            .catch((error: unknown) => {
              this.options.logger.warn("walletconnect pairing disconnect failed", error);
            });
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- sessions process one at a time
        await this.options.engine.connections
          .revoke(session.origin.origin)
          .catch((error: unknown) => {
            this.options.logger.warn("walletconnect revoke failed", error);
          });
      }
    });
  }
}

/** The chains whose advertised accounts differ between two namespace sets. */
const changedAccounts = (
  before: Readonly<Record<string, SessionTypes.Namespace>>,
  after: Readonly<Record<string, SessionTypes.Namespace>>,
): Array<[string, ReadonlyArray<string>]> => {
  const changed: Array<[string, ReadonlyArray<string>]> = [];
  for (const [key, next] of Object.entries(after)) {
    const previous = before[key];
    if (previous === undefined) {
      continue;
    }
    for (const chain of next.chains ?? []) {
      const now = next.accounts.filter((account) => account.startsWith(`${chain}:`));
      const then = previous.accounts.filter((account) => account.startsWith(`${chain}:`));
      if (now.length !== then.length || now.some((account) => !then.includes(account))) {
        changed.push([chain, now]);
      }
    }
  }
  return changed;
};

/**
 * The handles a test reaches for the SDK internals the public entry hides — emitting engine-side
 * events or inspecting the pairing store. The entry itself only exports `createWalletConnect`.
 */
export const createWalletConnectClient = async (
  options: WalletConnectOptions,
): Promise<{ walletConnect: WalletConnect; core: ICore; kit: Kit }> => {
  // `ICore` declares its fields `?:` while `Core` types them `| undefined`; the instance is one
  // all the same — exactOptionalPropertyTypes just refuses to see it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const core = new Core({
    projectId: options.projectId,
    ...(options.relayUrl === undefined ? {} : { relayUrl: options.relayUrl }),
    telemetryEnabled: false,
    logger: "silent",
    // Core's IKeyValueStorage is an abstract class from a transitive package; our narrower host
    // storage satisfies its contract — adapted here so the entry carries no extra dependency.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    storage: {
      getKeys: async () => options.storage.getKeys(),
      getEntries: async () => options.storage.getEntries(),
      getItem: async (key: string) => options.storage.getItem(key),
      setItem: async (key: string, value: unknown) => options.storage.setItem(key, value),
      removeItem: async (key: string) => options.storage.removeItem(key),
    } as unknown as NonNullable<NonNullable<ConstructorParameters<typeof Core>[0]>["storage"]>,
  }) as ICore;
  const kit = await WalletKit.init({
    core,
    metadata: { ...options.metadata, icons: [...options.metadata.icons] },
    signConfig: { disableRequestQueue: true },
  });
  const controller = new WalletConnectController(options, core, kit);
  await controller.init();
  return { walletConnect: controller, core, kit };
};

/** The `Core`/`WalletKit` pair plus the controller that drives them — one entry, one instance. */
export const createWalletConnect = async (
  options: WalletConnectOptions,
): Promise<WalletConnect> => {
  const { walletConnect } = await createWalletConnectClient(options);
  return walletConnect;
};
