/**
 * The backup reconcile loop (design/backup.mdx "同步"): keeps the cloud file
 * `qntx-wallet-backup-<id>.json` in step with the vault. Single-flight — a trigger during a run
 * schedules exactly one rerun; `lock()` bumps a generation so a stale run never writes state, store
 * or cloud after that point.
 *
 * Security shape: the engine only ever moves ciphertext. The BEK stays in the enclave; the local
 * record is a digest/coverage baseline, not a key.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type {
  Wallet,
  BackupHeader,
  BackupInfo,
  WalletInfo,
  WalletSnapshot,
  UnlockFactor,
  InitialFactor,
} from "@qntx/wallet";
import { parseBackupHeader } from "@qntx/wallet";

import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { EngineStore } from "../store/port.ts";
import { BackupControllerError } from "./errors.ts";
import type { BackupErrorCategory } from "./errors.ts";
import type { CloudStore } from "./port.ts";

export type BackupControllerState = {
  readonly status: "locked" | "unavailable" | "off" | "syncing" | "synced" | "conflict" | "error";
  /** The retained backup key's public summary from the wallet snapshot. */
  // oxlint-disable-next-line typescript/no-restricted-types -- the snapshot contract is `null`
  readonly backup: BackupInfo | null;
  readonly uploadedAt: number | undefined;
  readonly unprotected: {
    readonly walletIds: ReadonlyArray<string>;
    readonly nostrKeyIds: ReadonlyArray<string>;
  };
  readonly error: BackupErrorCategory | undefined;
};

/** The EngineStore `backup/state` record — a baseline, never a key. */
type BackupRecord = {
  readonly id: string;
  readonly digest: string | undefined;
  readonly uploadedAt: number | undefined;
  readonly walletIds: ReadonlyArray<string>;
  readonly nostrKeyIds: ReadonlyArray<string>;
};

const COLLECTION = "backup";
const RECORD_KEY = "state";
const FILE_PREFIX = "qntx-wallet-backup-";
const FILE_SUFFIX = ".json";

function fileName(id: string): string {
  return `${FILE_PREFIX}${id}${FILE_SUFFIX}`;
}

function digestOf(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

function sorted(values: Iterable<string>): ReadonlyArray<string> {
  return [...values].sort();
}

function sameSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((e) => typeof e === "string");

/** Strict record validation — anything malformed reads as absent (and is logged). */
function parseRecord(bytes: Uint8Array | undefined): BackupRecord | undefined {
  if (bytes === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isObject(value)) {
      return undefined;
    }
    const o = value;
    const { id } = o;
    const { digest } = o;
    const { uploadedAt } = o;
    const { walletIds } = o;
    const { nostrKeyIds } = o;
    if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) {
      return undefined;
    }
    if (digest !== undefined && (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))) {
      return undefined;
    }
    if (
      uploadedAt !== undefined &&
      (typeof uploadedAt !== "number" || !Number.isSafeInteger(uploadedAt))
    ) {
      return undefined;
    }
    if (!isStringArray(walletIds) || !isStringArray(nostrKeyIds)) {
      return undefined;
    }
    return { id, digest, uploadedAt, walletIds, nostrKeyIds };
  } catch {
    return undefined;
  }
}

export type BackupControllerOptions = {
  readonly wallet: Wallet;
  readonly cloud: CloudStore | undefined;
  readonly now: () => number;
  readonly logger: EngineLogger;
};

export class BackupController extends Controller<BackupControllerState> {
  private readonly wallet: Wallet;
  private readonly cloud: CloudStore | undefined;
  private readonly now: () => number;
  private readonly logger: EngineLogger;

  private engineStore: EngineStore | undefined;
  private generation = 0;
  private current: Promise<void> | undefined;
  private rerun = false;
  /** Set by restore() before the store opens — written as a record on the first reconcile. */
  private pendingAdoption: { readonly id: string; readonly digest: string } | undefined;

  constructor(options: BackupControllerOptions) {
    super({ name: "backup", defaultState: () => defaultState() });
    this.wallet = options.wallet;
    this.cloud = options.cloud;
    this.now = options.now;
    this.logger = options.logger;
  }

  async init(): Promise<void> {
    await Promise.resolve();
  }

  async destroy(): Promise<void> {
    this.generation += 1;
    await Promise.resolve();
  }

  /** The engine hands over the store on unlock and takes it back on lock. */
  setStore(store: EngineStore | undefined): void {
    this.engineStore = store;
  }

  /** Bumps the generation: an in-flight reconcile writes nothing after this point. */
  lock(): void {
    this.generation += 1;
    this.engineStore = undefined;
    this.update(() => defaultState());
  }

  trigger(): void {
    void this.triggerAsync();
  }

  private async triggerAsync(): Promise<void> {
    try {
      await this.reconcile();
    } catch (error) {
      this.logger.warn("backup reconcile trigger failed", error);
    }
  }

  /** Explicit sync — awaits the run so callers see its outcome. */
  async sync(): Promise<void> {
    await this.reconcile();
  }

  async enable(options: {
    readonly verify: UnlockFactor;
    readonly factors: ReadonlyArray<UnlockFactor>;
  }): Promise<void> {
    // Check before the ceremony: the user must not verify and retain a BEK when there is
    // nowhere to upload it.
    if (this.cloud === undefined || !(await this.cloud.available())) {
      throw new BackupControllerError("unavailable", "the cloud store is unavailable");
    }
    await this.wallet.backup.enable(options);
    await this.reconcileOrThrow();
  }

  async disable(): Promise<void> {
    await this.wallet.backup.disable();
    await this.reconcileOrThrow();
  }

  /** Files under our prefix with a parseable header. */
  async list(): Promise<ReadonlyArray<{ readonly name: string; readonly header: BackupHeader }>> {
    if (this.cloud === undefined) {
      return [];
    }
    const all = await this.cloud.list();
    const names = all.filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith(FILE_SUFFIX));
    const { cloud } = this;
    const texts = await Promise.all(names.map(async (name) => cloud.read(name)));
    const out: Array<{ name: string; header: BackupHeader }> = [];
    for (const [index, name] of names.entries()) {
      const text = texts[index];
      if (text === undefined) {
        continue;
      }
      try {
        out.push({ name, header: parseBackupHeader(text) });
      } catch {
        this.logger.warn("backup file failed to parse", new Error(name));
      }
    }
    return out;
  }

  async restore(options: {
    readonly name: string;
    readonly backupFactor: UnlockFactor;
    readonly factor?: InitialFactor;
  }): Promise<ReadonlyArray<WalletInfo>> {
    if (this.cloud === undefined) {
      throw new BackupControllerError("cloud", "no cloud store configured");
    }
    const text = await this.cloud.read(options.name);
    if (text === undefined) {
      throw new BackupControllerError("cloud", "backup file not found");
    }
    const id = idFromName(options.name);
    if (id === undefined) {
      throw new BackupControllerError("cloud", "unrecognized backup file name");
    }
    const wasUninitialized = this.wallet.getSnapshot().vault === "uninitialized";
    if (wasUninitialized) {
      // Set before the kernel restore: the commit's status event can already trigger the
      // first reconcile once the engine store opens.
      this.pendingAdoption = { id, digest: digestOf(text) };
    }
    let wallets: ReadonlyArray<WalletInfo>;
    try {
      wallets = await this.wallet.backup.restore({
        envelope: text,
        backupFactor: options.backupFactor,
        ...(options.factor === undefined ? {} : { factor: options.factor }),
      });
    } catch (error) {
      this.pendingAdoption = undefined;
      throw error;
    }
    const { backup } = this.wallet.getSnapshot();
    if (!wasUninitialized && backup !== null && backup.id === id) {
      // Own-lineage merge: baseline to this file's digest, empty coverage forces the next
      // sync to upload the merged superset.
      const previous = await this.readRecord();
      await this.writeRecord({
        id,
        digest: digestOf(text),
        uploadedAt: previous?.uploadedAt,
        walletIds: [],
        nostrKeyIds: [],
      });
    }
    // Converge now — the commit's snapshot trigger may have run before the baseline landed.
    // Restore already succeeded, so a failed reconcile only leaves its status behind.
    try {
      await this.reconcile();
    } catch {
      /* state carries the outcome */
    }
    return wallets;
  }

  private async reconcileOrThrow(): Promise<void> {
    await this.reconcile();
    const { status, error } = this.getState();
    if (status === "error" || status === "conflict" || status === "unavailable") {
      throw new BackupControllerError(error ?? "cloud", `backup sync failed: ${status}`);
    }
  }

  private async readRecord(): Promise<BackupRecord | undefined> {
    const bytes = await this.engineStore?.collection(COLLECTION).get(RECORD_KEY);
    const record = parseRecord(bytes);
    if (bytes !== undefined && record === undefined) {
      this.logger.warn("backup record failed to parse — treating as absent", new Error(COLLECTION));
    }
    return record;
  }

  private async writeRecord(record: BackupRecord): Promise<void> {
    await this.engineStore
      ?.collection(COLLECTION)
      .put(RECORD_KEY, new TextEncoder().encode(JSON.stringify(record)));
  }

  private async deleteRecord(): Promise<void> {
    await this.engineStore?.collection(COLLECTION).delete(RECORD_KEY);
  }

  private snapshot(): WalletSnapshot {
    return this.wallet.getSnapshot();
  }

  private unprotected(snapshot: WalletSnapshot, record: BackupRecord | undefined) {
    const covered =
      snapshot.backup !== null &&
      record !== undefined &&
      record.id === snapshot.backup.id &&
      record.digest !== undefined;
    const wallets = snapshot.wallets.filter((w) => w.backup !== "mnemonic");
    const keys = snapshot.nostr.keys.filter(
      (k) => k.ref.kind === "standalone" && k.backedUp === false,
    );
    const walletIds = wallets
      .map((w) => w.walletId)
      .filter((id) => !covered || !record.walletIds.includes(id));
    const nostrKeyIds = keys
      .map((k) => k.publicKey)
      .filter((id) => !covered || !record.nostrKeyIds.includes(id));
    return { walletIds: sorted(walletIds), nostrKeyIds: sorted(nostrKeyIds) };
  }

  private coverage(snapshot: WalletSnapshot): {
    readonly walletIds: ReadonlyArray<string>;
    readonly nostrKeyIds: ReadonlyArray<string>;
  } {
    return {
      walletIds: sorted(snapshot.wallets.map((w) => w.walletId)),
      nostrKeyIds: sorted(
        snapshot.nostr.keys.filter((k) => k.ref.kind === "standalone").map((k) => k.publicKey),
      ),
    };
  }

  private setStatus(
    generation: number,
    status: BackupControllerState["status"],
    error?: BackupErrorCategory,
    record?: BackupRecord,
  ): void {
    if (generation !== this.generation) {
      return;
    }
    const snapshot = this.snapshot();
    this.update((state) => ({
      ...state,
      status,
      backup: snapshot.backup,
      uploadedAt: record?.uploadedAt,
      error,
      unprotected: this.unprotected(snapshot, record),
    }));
  }

  /**
   * Single-flight: a trigger during a run flags exactly one rerun inside the same promise, so
   * `sync()`/`enable()` await real convergence instead of a mid-run snapshot.
   */
  private async reconcile(): Promise<void> {
    if (this.current !== undefined) {
      this.rerun = true;
      return this.current;
    }
    this.current = (async () => {
      try {
        do {
          this.rerun = false;
          // The generation is read per pass: a lock invalidates the current pass, and a
          // trigger flagged under it still earns a fresh pass after unlock.
          // oxlint-disable-next-line eslint/no-await-in-loop -- passes must serialize: one rerun flag, one pass at a time
          await this.pass(this.generation);
        } while (this.rerun);
      } finally {
        this.current = undefined;
      }
    })();
    return this.current;
  }

  private async pass(generation: number): Promise<void> {
    const snapshot = this.snapshot();
    if (snapshot.vault !== "unlocked" || this.engineStore === undefined) {
      return;
    }
    let record = await this.readRecord();
    if (this.cloud === undefined || !(await this.cloud.available())) {
      this.setStatus(generation, "unavailable", undefined, record);
      return;
    }
    if (generation !== this.generation) {
      return;
    }

    // Pending adoption lands once — and only when the vault's backup key is the file's key.
    const adoption = this.pendingAdoption;
    if (adoption !== undefined) {
      this.pendingAdoption = undefined;
      if (snapshot.backup?.id === adoption.id) {
        record = {
          id: adoption.id,
          digest: adoption.digest,
          uploadedAt: undefined,
          walletIds: [],
          nostrKeyIds: [],
        };
        if (generation !== this.generation) {
          return;
        }
        await this.writeRecord(record);
      } else {
        this.logger.warn(
          "backup adoption dropped — the vault's backup key is not the file's",
          new Error(adoption.id),
        );
      }
    }

    const { backup } = snapshot;
    if (backup === null) {
      // Backup off in the vault: remove our file + record, then report off.
      if (record !== undefined) {
        try {
          if (generation !== this.generation) {
            return;
          }
          await this.cloud.delete(fileName(record.id));
          if (generation !== this.generation) {
            return;
          }
          await this.deleteRecord();
        } catch (error) {
          this.logger.warn("backup cloud delete failed — retrying next reconcile", error);
          this.setStatus(generation, "error", "cloud", record);
          return;
        }
      }
      this.setStatus(generation, "off", undefined, undefined);
      return;
    }

    const baseline = record !== undefined && record.id === backup.id ? record.digest : undefined;
    const cov = this.coverage(snapshot);
    if (
      baseline !== undefined &&
      record !== undefined &&
      sameSet(cov.walletIds, record.walletIds) &&
      sameSet(cov.nostrKeyIds, record.nostrKeyIds)
    ) {
      this.setStatus(generation, "synced", undefined, record);
      return;
    }

    this.setStatus(generation, "syncing", undefined, record);
    try {
      const envelope = await this.wallet.backup.update();
      if (generation !== this.generation) {
        return;
      }
      const name = fileName(backup.id);
      const remote = await this.cloud.read(name);
      const digest = digestOf(envelope);
      if (remote !== undefined && digestOf(remote) !== baseline) {
        this.setStatus(generation, "conflict", "conflict", record);
        return;
      }
      if (generation !== this.generation) {
        return;
      }
      await this.cloud.write(name, envelope);
      const readBack = await this.cloud.read(name);
      if (readBack !== envelope) {
        this.setStatus(generation, "error", "cloud", record);
        return;
      }
      const next: BackupRecord = {
        id: backup.id,
        digest,
        uploadedAt: this.now(),
        walletIds: cov.walletIds,
        nostrKeyIds: cov.nostrKeyIds,
      };
      if (generation !== this.generation) {
        return;
      }
      await this.writeRecord(next);
      if (record !== undefined && record.id !== backup.id) {
        try {
          if (generation !== this.generation) {
            return;
          }
          await this.cloud.delete(fileName(record.id));
        } catch (error) {
          this.logger.warn("stale backup file delete failed", error);
        }
      }
      this.setStatus(generation, "synced", undefined, next);
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.logger.warn("backup reconcile failed", error);
      this.setStatus(generation, "error", "cloud", record);
    }
  }
}

function defaultState(): BackupControllerState {
  return {
    status: "locked",
    backup: null,
    uploadedAt: undefined,
    unprotected: { walletIds: [], nostrKeyIds: [] },
    error: undefined,
  };
}

function idFromName(name: string): string | undefined {
  if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) {
    return undefined;
  }
  const id = name.slice(FILE_PREFIX.length, name.length - FILE_SUFFIX.length);
  return /^[0-9a-f]{32}$/.test(id) ? id : undefined;
}
