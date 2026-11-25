/**
 * Sealed change marks: the highest change-chain index a wallet's own transactions have proven, per
 * (groupIndex, purpose, network). The mark — not anything in a PSBT — bounds which own-key outputs
 * a signing prompt may hide as change. One record per wallet, id = walletId, one marker byte as
 * the sealed body like `vault/policy.ts`; the marks live in the public header so the scan reach is
 * readable without opening the record.
 */
import type { KernelPlatform } from "../../platform.ts";
import type { Secret } from "../../secret/secret.ts";
import { wipe } from "../../secret/secret.ts";
import { KernelError } from "../../errors.ts";
import {
  asGroupIndex,
  asWalletId,
  expectKeys,
  headerFailure,
  headerObject,
} from "../../vault/header-codec.ts";
import type { StoredRecord, StoreOp, VaultImage } from "../../vault/store.ts";
import type { OpenedRecord } from "../../vault/vault.ts";
import { sealRecord } from "../../vault/vault.ts";

export const CHANGE_MARKS_KIND = "change-marks";

const MARKER = 0x01;

const CAIP2 = /^[a-z0-9-]{3,64}:[0-9a-zA-Z-]{1,128}$/;
const PURPOSES = new Set([44, 49, 84, 86]);

export type ChangeMark = {
  readonly groupIndex: number;
  readonly purpose: number;
  readonly network: string;
  readonly index: number;
};

export type ChangeMarksHeader = {
  readonly walletId: string;
  readonly marks: ReadonlyArray<ChangeMark>;
};

const before = (a: ChangeMark, b: ChangeMark): number =>
  a.groupIndex - b.groupIndex || a.purpose - b.purpose || (a.network < b.network ? -1 : 1);

export function parseChangeMarksHeader(text: string): ChangeMarksHeader {
  const object = headerObject(text);
  expectKeys(object, ["walletId", "marks"]);
  const list = object["marks"];
  if (!Array.isArray(list)) {
    throw headerFailure();
  }
  const marks = list.map((entry): ChangeMark => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw headerFailure();
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a record above
    const mark = entry as Record<string, unknown>;
    expectKeys(mark, ["groupIndex", "purpose", "network", "index"]);
    const purpose = asGroupIndex(mark["purpose"]);
    if (!PURPOSES.has(purpose)) {
      throw headerFailure();
    }
    const network = mark["network"];
    if (typeof network !== "string" || !CAIP2.test(network)) {
      throw headerFailure();
    }
    return {
      groupIndex: asGroupIndex(mark["groupIndex"]),
      purpose,
      network,
      index: asGroupIndex(mark["index"]),
    };
  });
  for (let i = 1; i < marks.length; i++) {
    if (before(marks[i - 1] as ChangeMark, marks[i] as ChangeMark) >= 0) {
      throw headerFailure();
    }
  }
  return { walletId: asWalletId(object["walletId"]), marks };
}

export function encodeChangeMarksHeader(header: ChangeMarksHeader): string {
  return JSON.stringify({
    walletId: header.walletId,
    marks: header.marks.map((mark) => ({
      groupIndex: mark.groupIndex,
      purpose: mark.purpose,
      network: mark.network,
      index: mark.index,
    })),
  });
}

const marksRecord = (image: VaultImage, walletId: string): StoredRecord | undefined =>
  image.records.find(
    (record) => record.kind === CHANGE_MARKS_KIND && record.id === walletId,
  );

/**
 * The sealed mark for (walletId, groupIndex, purpose, network) — read from the image's public
 * header on every call; 0 when the wallet has no marks record or no entry for the key.
 */
export const changeMark = (
  image: VaultImage,
  walletId: string,
  groupIndex: number,
  purpose: number,
  network: string,
): number => {
  const record = marksRecord(image, walletId);
  if (record === undefined) {
    return 0;
  }
  const { marks } = parseChangeMarksHeader(record.header);
  return (
    marks.find(
      (mark) =>
        mark.groupIndex === groupIndex &&
        mark.purpose === purpose &&
        mark.network === network,
    )?.index ?? 0
  );
};

/**
 * Raises the stored marks for (walletId, groupIndex, network) to `max(stored, raise)` per purpose
 * and commits the re-sealed record — only when at least one purpose actually increased. Called
 * right after the factor verifies and before signing starts: a commit failure must abort the
 * request before any signature exists.
 */
export const commitChangeMarks = async (
  ctx: {
    readonly platform: KernelPlatform;
    readonly image: VaultImage;
    readonly commit: (ops: ReadonlyArray<StoreOp>) => Promise<void>;
  },
  dek: Secret,
  walletId: string,
  groupIndex: number,
  network: string,
  raises: ReadonlyArray<{ readonly purpose: number; readonly index: number }>,
): Promise<void> => {
  const record = marksRecord(ctx.image, walletId);
  const stored =
    record === undefined ? [] : parseChangeMarksHeader(record.header).marks;
  const next = new Map<string, ChangeMark>(stored.map((mark) => [`${mark.groupIndex}/${mark.purpose}/${mark.network}`, mark]));
  let grew = false;
  for (const raise of raises) {
    const key = `${groupIndex}/${raise.purpose}/${network}`;
    const held = next.get(key);
    if (raise.index > (held?.index ?? -1)) {
      next.set(key, {
        groupIndex,
        purpose: raise.purpose,
        network,
        index: raise.index,
      });
      grew = true;
    }
  }
  if (!grew) {
    return;
  }
  const marks = [...next.values()].sort(before);
  const sealed = sealRecord(
    ctx.platform,
    dek,
    CHANGE_MARKS_KIND,
    walletId,
    encodeChangeMarksHeader({ walletId, marks }),
    new Uint8Array([MARKER]),
  );
  await ctx.commit([{ op: "put-record", record: sealed }]);
};

/** The chains module's marks hooks, wired into its VaultHooks in index.ts. */
export const marksHooks = {
  ownsRecord: (kind: string): boolean => kind === CHANGE_MARKS_KIND,

  /**
   * Claims marks plaintexts — the body is one marker byte; a mismatch latches the record corrupt
   * exactly like the other sealed kinds do.
   */
  claimUnlocked: (records: ReadonlyArray<OpenedRecord>): ReadonlyArray<OpenedRecord> => {
    const unclaimed: OpenedRecord[] = [];
    for (const record of records) {
      if (record.kind !== CHANGE_MARKS_KIND) {
        unclaimed.push(record);
        continue;
      }
      try {
        if (record.plaintext.length !== 1 || record.plaintext[0] !== MARKER) {
          throw new KernelError("integrity", "corrupt change-marks record");
        }
      } finally {
        wipe(record.plaintext);
      }
    }
    return unclaimed;
  },

  walletDeleteOps: (image: VaultImage, walletId: string): ReadonlyArray<StoreOp> =>
    marksRecord(image, walletId) === undefined
      ? []
      : [{ op: "delete-record", kind: CHANGE_MARKS_KIND, id: walletId }],

  /** Strict header check plus the id binding — a marks record must name its own wallet. */
  parseHeader: (record: StoredRecord): void => {
    if (parseChangeMarksHeader(record.header).walletId !== record.id) {
      throw new KernelError("integrity", "change-marks record id mismatch");
    }
  },
};
