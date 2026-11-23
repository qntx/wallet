/**
 * The backup reconcile loop (design/backup.mdx "同步"): keeps the cloud namespace in step with the
 * vault. Every upload is a new file `qntx-wallet-backup-<id>-<sha256(text)>.json` — the name binds
 * the content, so versions never overwrite each other, every read self-verifies, and a foreign
 * version's header coverage caches by name. Single-flight — a trigger during a run schedules
 * exactly one rerun; `lock()` bumps a generation so a stale run never writes state, store or cloud
 * after that point.
 *
 * Security shape: the engine only ever moves ciphertext. The BEK stays in the enclave; the local
 * record is a name/coverage baseline, not a key. A device deletes only versions it wrote or
 * adopted, and only once a newer own version is confirmed present.
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
  VerifyFactor,
  InitialFactor,
} from "@qntx/wallet";
import { parseBackupHeader } from "@qntx/wallet";

import { Controller } from "../controller.ts";
import type { EngineLogger } from "../events.ts";
import type { EngineStore } from "../store/port.ts";
import { BackupControllerError } from "./errors.ts";
import type { BackupErrorCategory } from "./errors.ts";
import { CloudStoreError } from "./port.ts";
import type { CloudStore } from "./port.ts";
import { backupPasswordStrength } from "./strength.ts";

export type BackupControllerState = {
  readonly status: "locked" | "unavailable" | "off" | "syncing" | "synced" | "conflict" | "error";
  /** The retained backup key's public summary from the wallet snapshot. */
  // oxlint-disable-next-line typescript/no-restricted-types -- the snapshot contract is `null`
  readonly backup: BackupInfo | null;
  readonly uploadedAt: number | undefined;
  readonly unprotected: {
    readonly walletIds: ReadonlyArray<string>;
  };
  readonly error: BackupErrorCategory | undefined;
};

/** Sorted id sets — `wallets` give walletIds, `importedKeys` give keyIds. */
type Coverage = {
  readonly walletIds: ReadonlyArray<string>;
  readonly keyIds: ReadonlyArray<string>;
};

/** A versioned file the record vouches for. */
type VersionedFile = {
  readonly name: string;
  readonly coverage: Coverage;
};

/** The EngineStore `backup/state` record — a baseline, never a key. */
type BackupRecord = {
  /** The confirmed head: a version this device wrote, or adopted through a verified restore. */
  readonly head?: VersionedFile;
  readonly uploadedAt?: number;
  /** An upload whose landing is not yet confirmed — promoted or superseded next pass. */
  readonly pending?: VersionedFile;
  /** Own/adopted versions to delete once a head is confirmed — any backup id. */
  readonly superseded: ReadonlyArray<string>;
};

const COLLECTION = "backup";
const RECORD_KEY = "state";
const FILE_NAME = /^qntx-wallet-backup-([0-9a-f]{32})-([0-9a-f]{64})\.json$/;

function fileName(id: string, digest: string): string {
  return `qntx-wallet-backup-${id}-${digest}.json`;
}

function parseFileName(name: string): { readonly id: string; readonly digest: string } | undefined {
  const match = FILE_NAME.exec(name);
  if (match === null) {
    return undefined;
  }
  const [, id, digest] = match;
  if (id === undefined || digest === undefined) {
    return undefined;
  }
  return { id, digest };
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

function isSubset(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.every((v) => b.includes(v));
}

function sameCoverage(a: Coverage, b: Coverage): boolean {
  return sameSet(a.walletIds, b.walletIds) && sameSet(a.keyIds, b.keyIds);
}

function coverageSubset(a: Coverage, b: Coverage): boolean {
  return isSubset(a.walletIds, b.walletIds) && isSubset(a.keyIds, b.keyIds);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((e) => typeof e === "string");

function parseCoverage(value: unknown): Coverage | undefined {
  if (
    !isObject(value) ||
    !Object.keys(value).every((k) => k === "walletIds" || k === "keyIds") ||
    !isStringArray(value["walletIds"]) ||
    !isStringArray(value["keyIds"])
  ) {
    return undefined;
  }
  return { walletIds: value["walletIds"], keyIds: value["keyIds"] };
}

function parseVersionedFile(value: unknown): VersionedFile | undefined {
  if (
    !isObject(value) ||
    !Object.keys(value).every((k) => k === "name" || k === "coverage") ||
    typeof value["name"] !== "string" ||
    parseFileName(value["name"]) === undefined
  ) {
    return undefined;
  }
  const coverage = parseCoverage(value["coverage"]);
  if (coverage === undefined) {
    return undefined;
  }
  return { name: value["name"], coverage };
}

/** Strict record validation — anything malformed reads as absent (and is logged). */
function parseRecord(bytes: Uint8Array | undefined): BackupRecord | undefined {
  if (bytes === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isObject(value) ||
      !Object.keys(value).every(
        (k) => k === "head" || k === "uploadedAt" || k === "pending" || k === "superseded",
      )
    ) {
      return undefined;
    }
    const { uploadedAt, head, pending, superseded } = value;
    if (
      uploadedAt !== undefined &&
      (typeof uploadedAt !== "number" || !Number.isSafeInteger(uploadedAt))
    ) {
      return undefined;
    }
    const parsedHead = head === undefined ? undefined : parseVersionedFile(head);
    if (head !== undefined && parsedHead === undefined) {
      return undefined;
    }
    const parsedPending = pending === undefined ? undefined : parseVersionedFile(pending);
    if (pending !== undefined && parsedPending === undefined) {
      return undefined;
    }
    if (!isStringArray(superseded) || !superseded.every((n) => parseFileName(n) !== undefined)) {
      return undefined;
    }
    return {
      ...(parsedHead === undefined ? {} : { head: parsedHead }),
      ...(uploadedAt === undefined ? {} : { uploadedAt }),
      ...(parsedPending === undefined ? {} : { pending: parsedPending }),
      superseded,
    };
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
  /**
   * Header coverage by file name — a versioned name binds its content, so entries never need
   * invalidation; the map is cleared on lock() with the rest of the session state.
   */
  private readonly remoteCoverage = new Map<string, Coverage>();
  /** Set by restore() before the kernel call — applied by the first pass that sees the record. */
  private pendingAdoption: { readonly name: string; readonly coverage: Coverage } | undefined;

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
    this.remoteCoverage.clear();
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
    readonly verify: VerifyFactor;
    readonly factors: ReadonlyArray<UnlockFactor>;
  }): Promise<void> {
    // Check before the ceremony: the user must not verify and retain a BEK when there is
    // nowhere to upload it.
    if (this.cloud === undefined) {
      throw new BackupControllerError("unavailable", "the cloud store is unavailable");
    }
    try {
      await this.cloud.list();
    } catch (error) {
      throw toBackupControllerError(error);
    }
    const strengths = await Promise.all(
      options.factors.flatMap((factor) =>
        factor.kind === "password" ? [backupPasswordStrength(factor.password)] : [],
      ),
    );
    if (strengths.some((strength) => !strength.acceptable)) {
      throw new BackupControllerError(
        "weak-password",
        "the backup password is too easy to guess for a file that leaves the device",
      );
    }
    await this.wallet.backup.enable(options);
    await this.reconcileOrThrow();
  }

  async disable(verify: VerifyFactor): Promise<void> {
    await this.wallet.backup.disable(verify);
    await this.reconcileOrThrow();
  }

  /** Every versioned file with a verified digest and a parseable header. */
  async list(): Promise<
    ReadonlyArray<{ readonly name: string; readonly id: string; readonly header: BackupHeader }>
  > {
    const { cloud } = this;
    if (cloud === undefined) {
      return [];
    }
    const listed = await cloud.list();
    const names = listed.filter((n) => parseFileName(n) !== undefined);
    const rows = await Promise.all(
      names.map(async (name) => {
        const parsed = parseFileName(name);
        if (parsed === undefined) {
          return undefined;
        }
        try {
          const text = await cloud.read(name);
          if (text === undefined || digestOf(text) !== parsed.digest) {
            this.logger.warn("backup file failed digest verification", new Error(name));
            return undefined;
          }
          return { name, id: parsed.id, header: parseBackupHeader(text) };
        } catch (error) {
          this.logger.warn("backup file failed to read or parse", error);
          return undefined;
        }
      }),
    );
    return rows.filter((row) => row !== undefined);
  }

  /**
   * Merges a cloud backup into the vault. Wallets with a BIP-39 passphrase restore only when
   * `passphrases` carries theirs; the rest come back in `passphraseRequired`.
   */
  async restore(options: {
    readonly name: string;
    readonly backupFactor: UnlockFactor;
    readonly passphrases?: ReadonlyArray<{
      readonly walletId: string;
      readonly passphrase: string;
    }>;
    readonly factor?: InitialFactor;
  }): Promise<{
    readonly wallets: ReadonlyArray<WalletInfo>;
    readonly passphraseRequired: ReadonlyArray<string>;
  }> {
    const { cloud } = this;
    if (cloud === undefined) {
      throw new BackupControllerError("cloud", "no cloud store configured");
    }
    const parsed = parseFileName(options.name);
    if (parsed === undefined) {
      throw new BackupControllerError("cloud", "unrecognized backup file name");
    }
    const text = await cloud.read(options.name);
    if (text === undefined) {
      throw new BackupControllerError("cloud", "backup file not found");
    }
    if (digestOf(text) !== parsed.digest) {
      throw new BackupControllerError("cloud", "backup file is corrupt");
    }
    // The file's name and header coverage ride into the next pass only after the kernel unwrap
    // succeeds — it is what authenticates the header. Parked any earlier, a pass triggered by the
    // ceremony itself would apply it against the pre-merge coverage.
    let adoption: { readonly name: string; readonly coverage: Coverage } | undefined;
    try {
      adoption = { name: options.name, coverage: headerCoverage(parseBackupHeader(text)) };
    } catch (error) {
      this.logger.warn("backup file header failed to parse", error);
    }
    const restored = await this.wallet.backup.restore({
      envelope: text,
      backupFactor: options.backupFactor,
      ...(options.passphrases === undefined ? {} : { passphrases: options.passphrases }),
      ...(options.factor === undefined ? {} : { factor: options.factor }),
    });
    this.pendingAdoption = adoption;
    // Converge now — the commit's snapshot trigger may have run before the adoption landed.
    // Restore already succeeded, so a failed reconcile only leaves its status behind.
    try {
      await this.reconcile();
    } catch {
      /* state carries the outcome */
    }
    return restored;
  }

  private async reconcileOrThrow(): Promise<void> {
    await this.reconcile();
    const { status, error } = this.getState();
    if (status === "error" || status === "conflict" || status === "unavailable") {
      const category = error ?? (status === "unavailable" ? "unavailable" : "cloud");
      throw new BackupControllerError(category, `backup sync failed: ${status}`);
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

  private coverage(snapshot: WalletSnapshot): Coverage {
    return {
      walletIds: sorted(snapshot.wallets.map((w) => w.walletId)),
      keyIds: sorted(snapshot.importedKeys.map((k) => k.keyId)),
    };
  }

  private unprotected(snapshot: WalletSnapshot, record: BackupRecord | undefined) {
    const head = record?.head;
    const headIds =
      snapshot.backup !== null &&
      head !== undefined &&
      parseFileName(head.name)?.id === snapshot.backup.id
        ? head.coverage.walletIds
        : [];
    const walletIds = snapshot.wallets
      .filter((w) => w.backup !== "mnemonic")
      .map((w) => w.walletId)
      .filter((id) => !headIds.includes(id));
    return { walletIds: sorted(walletIds) };
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

  /** Maps a thrown cloud call: `unavailable` stands alone, every other failure is `error`. */
  private setCloudError(generation: number, error: unknown, record?: BackupRecord): void {
    const category = cloudErrorCategory(error);
    if (category === "unavailable") {
      this.setStatus(generation, "unavailable", undefined, record);
    } else {
      this.setStatus(generation, "error", category, record);
    }
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
    const { cloud } = this;
    if (cloud === undefined) {
      this.setStatus(generation, "unavailable", undefined, record);
      return;
    }

    // A restore parked this adoption; it lands only when the vault's backup key is the file's.
    const adoption = this.pendingAdoption;
    if (adoption !== undefined) {
      this.pendingAdoption = undefined;
      if (snapshot.backup?.id === parseFileName(adoption.name)?.id) {
        const adopted = adopt(record, adoption, this.coverage(snapshot));
        if (adopted !== undefined && adopted !== record) {
          if (generation !== this.generation) {
            return;
          }
          await this.writeRecord(adopted);
          record = adopted;
        }
      } else {
        this.logger.warn(
          "backup adoption dropped — the vault's backup key is not the file's",
          new Error(adoption.name),
        );
      }
    }

    const { backup } = snapshot;
    if (backup === null) {
      // Backup off in the vault: remove our files + record, then report off.
      await this.passOff(generation, cloud, record);
      return;
    }

    const local = this.coverage(snapshot);
    try {
      // 1. The list pins down this backup id's versions.
      const names = await cloud.list();
      const versions = new Set(names.filter((n) => parseFileName(n)?.id === backup.id));

      // 2. A landed pending promotes to head; a pending of another id is just stale.
      const superseded = new Set(record?.superseded);
      let head = record?.head;
      let pending = record?.pending;
      let dirty = false;
      if (pending !== undefined) {
        if (parseFileName(pending.name)?.id !== backup.id) {
          superseded.add(pending.name);
          pending = undefined;
          dirty = true;
        } else if (versions.has(pending.name)) {
          if (head !== undefined && head.name !== pending.name) {
            superseded.add(head.name);
          }
          head = pending;
          pending = undefined;
          dirty = true;
        }
      }
      // 3. A head of another id means the BEK rotated — it is stale like any superseded file.
      if (head !== undefined && parseFileName(head.name)?.id !== backup.id) {
        superseded.add(head.name);
        head = undefined;
        dirty = true;
      }
      // 4. A head missing from the list gets one read-back before being declared gone — the
      // list is eventually consistent. A corrupt head is ours but worthless: supersede it.
      if (head !== undefined && !versions.has(head.name)) {
        const remote = await cloud.read(head.name);
        const parsed = parseFileName(head.name);
        if (remote === undefined || parsed === undefined || digestOf(remote) !== parsed.digest) {
          superseded.add(head.name);
          head = undefined;
          dirty = true;
        }
      }
      if (dirty) {
        const next: BackupRecord = {
          ...(head === undefined ? {} : { head }),
          ...(record?.uploadedAt === undefined ? {} : { uploadedAt: record.uploadedAt }),
          ...(pending === undefined ? {} : { pending }),
          superseded: [...superseded].sort(),
        };
        if (generation !== this.generation) {
          return;
        }
        await this.writeRecord(next);
        record = next;
      }

      // 5. Foreign versions: ours by id only — read, verify and parse each (cached by name).
      // A version the local coverage does not contain is a conflict; unreadable files are
      // logged and left alone — they hold nothing recoverable and are never deleted.
      const foreignNames = [...versions].filter(
        (n) => n !== head?.name && n !== pending?.name && !superseded.has(n),
      );
      const foreign = await Promise.all(
        foreignNames.map(async (n) => this.remoteCoverageOf(cloud, n)),
      );
      const conflict = foreign.some((c) => c !== undefined && !coverageSubset(c, local));

      // 6. Upload when the head is missing or no longer covers the vault — conflict never
      // blocks it: we overwrite nothing and delete nothing foreign, so it is always safe.
      if (head === undefined || !sameCoverage(head.coverage, local)) {
        this.setStatus(generation, "syncing", undefined, record);
        const envelope = await this.wallet.backup.update();
        if (generation !== this.generation) {
          return;
        }
        const name = fileName(backup.id, digestOf(envelope));
        if (pending !== undefined && pending.name !== name) {
          superseded.add(pending.name);
        }
        const staged: BackupRecord = {
          ...(head === undefined ? {} : { head }),
          ...(record?.uploadedAt === undefined ? {} : { uploadedAt: record.uploadedAt }),
          pending: { name, coverage: local },
          superseded: [...superseded].sort(),
        };
        if (generation !== this.generation) {
          return;
        }
        await this.writeRecord(staged);
        record = staged;
        if (generation !== this.generation) {
          return;
        }
        await cloud.write(name, envelope);
        const readBack = await cloud.read(name);
        if (readBack !== envelope) {
          // The landed write stays pending — the next pass confirms it instead of
          // conflicting with itself.
          this.setStatus(generation, "error", "cloud", record);
          return;
        }
        if (head !== undefined && head.name !== name) {
          superseded.add(head.name);
        }
        head = { name, coverage: local };
        pending = undefined;
        const confirmed: BackupRecord = {
          head,
          uploadedAt: this.now(),
          superseded: [...superseded].sort(),
        };
        if (generation !== this.generation) {
          return;
        }
        await this.writeRecord(confirmed);
        record = confirmed;
      }

      // 7. Superseded files go only once a head is confirmed present — best effort, the
      // survivors retry next pass.
      if (head !== undefined && superseded.size > 0) {
        const remaining: string[] = [];
        for (const name of superseded) {
          if (name === head.name) {
            continue;
          }
          try {
            if (generation !== this.generation) {
              return;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- deletes serialize so each failure lands in `remaining`
            await cloud.delete(name);
          } catch (error) {
            this.logger.warn("superseded backup file delete failed — retrying next pass", error);
            remaining.push(name);
          }
        }
        if (remaining.length !== superseded.size) {
          const next: BackupRecord = {
            ...(record?.head === undefined ? {} : { head: record.head }),
            ...(record?.uploadedAt === undefined ? {} : { uploadedAt: record.uploadedAt }),
            ...(record?.pending === undefined ? {} : { pending: record.pending }),
            superseded: remaining.sort(),
          };
          if (generation !== this.generation) {
            return;
          }
          await this.writeRecord(next);
          record = next;
        }
      }

      // 8. synced reports only what this device confirmed; foreign coverage only flags conflict.
      this.setStatus(
        generation,
        conflict ? "conflict" : "synced",
        conflict ? "conflict" : undefined,
        record,
      );
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.logger.warn("backup reconcile failed", error);
      this.setCloudError(generation, error, record);
    }
  }

  /** The header coverage of a foreign version — cached by name; undefined on any failure. */
  private async remoteCoverageOf(cloud: CloudStore, name: string): Promise<Coverage | undefined> {
    const cached = this.remoteCoverage.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const parsed = parseFileName(name);
    if (parsed === undefined) {
      return undefined;
    }
    try {
      const text = await cloud.read(name);
      if (text === undefined || digestOf(text) !== parsed.digest) {
        this.logger.warn("foreign backup file failed digest verification", new Error(name));
        return undefined;
      }
      const coverage = headerCoverage(parseBackupHeader(text));
      this.remoteCoverage.set(name, coverage);
      return coverage;
    } catch (error) {
      this.logger.warn("foreign backup file failed to read or parse", error);
      return undefined;
    }
  }

  /** Backup off: delete every recorded file, then the record itself; failures retry next pass. */
  private async passOff(
    generation: number,
    cloud: CloudStore,
    record: BackupRecord | undefined,
  ): Promise<void> {
    if (record === undefined) {
      this.setStatus(generation, "off", undefined, undefined);
      return;
    }
    const names = new Set(
      [record.head?.name, record.pending?.name, ...record.superseded].filter(
        (n) => n !== undefined,
      ),
    );
    const remaining: string[] = [];
    for (const name of names) {
      try {
        if (generation !== this.generation) {
          return;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- deletes serialize so each failure lands in `remaining`
        await cloud.delete(name);
      } catch (error) {
        this.logger.warn("backup cloud delete failed — retrying next pass", error);
        remaining.push(name);
      }
    }
    if (remaining.length > 0) {
      const next: BackupRecord = { superseded: remaining.sort() };
      if (generation !== this.generation) {
        return;
      }
      await this.writeRecord(next);
      this.setStatus(generation, "error", "cloud", next);
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    await this.deleteRecord();
    this.setStatus(generation, "off", undefined, undefined);
  }
}

/**
 * The restore adoption rules (design §3): C_R is the file's header coverage — authenticated by the
 * successful unwrap — and C_L the post-restore local coverage. Returns the record as-is when
 * nothing changes.
 */
function adopt(
  record: BackupRecord | undefined,
  adoption: { readonly name: string; readonly coverage: Coverage },
  local: Coverage,
): BackupRecord | undefined {
  if (!coverageSubset(adoption.coverage, local)) {
    // C_R ⊄ C_L: wallets were skipped — the file stays foreign and the conflict is reported.
    return record;
  }
  const superseded = new Set(record?.superseded);
  const head = record?.head;
  if (
    sameCoverage(adoption.coverage, local) &&
    (head === undefined || !sameCoverage(head.coverage, local))
  ) {
    // C_R = C_L without an equivalent head: adopt the file — no re-upload.
    if (head !== undefined && head.name !== adoption.name) {
      superseded.add(head.name);
    }
    return {
      head: { name: adoption.name, coverage: adoption.coverage },
      ...(record?.uploadedAt === undefined ? {} : { uploadedAt: record.uploadedAt }),
      ...(record?.pending === undefined ? {} : { pending: record.pending }),
      superseded: [...superseded].sort(),
    };
  }
  // Otherwise the file is redundant — it leaves once the head is confirmed.
  superseded.add(adoption.name);
  return {
    ...(head === undefined ? {} : { head }),
    ...(record?.uploadedAt === undefined ? {} : { uploadedAt: record.uploadedAt }),
    ...(record?.pending === undefined ? {} : { pending: record.pending }),
    superseded: [...superseded].sort(),
  };
}

function headerCoverage(header: BackupHeader): Coverage {
  return {
    walletIds: sorted(header.wallets.map((w) => w.walletId)),
    keyIds: sorted(header.keys.map((k) => k.keyId)),
  };
}

function defaultState(): BackupControllerState {
  return {
    status: "locked",
    backup: null,
    uploadedAt: undefined,
    unprotected: { walletIds: [] },
    error: undefined,
  };
}

function cloudErrorCategory(error: unknown): BackupErrorCategory {
  if (error instanceof CloudStoreError) {
    return error.code === "unavailable" || error.code === "auth-required" || error.code === "quota"
      ? error.code
      : "cloud";
  }
  return "cloud";
}

function toBackupControllerError(error: unknown): BackupControllerError {
  const message = error instanceof CloudStoreError ? error.message : "the cloud store check failed";
  return new BackupControllerError(cloudErrorCategory(error), message);
}
