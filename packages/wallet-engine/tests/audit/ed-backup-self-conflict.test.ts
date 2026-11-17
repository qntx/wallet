/**
 * ED-PoC-8 — a failed read-back after our own successful write flips the backup status to `error`
 * without recording the digest; the next reconcile sees our own file as foreign and reports
 * `conflict`. No second device involved.
 *
 * Exercises src/backup/controller.ts `pass` (≈470-490): after `cloud.write`, a `readBack !==
 * envelope` (eventually-consistent cloud returning a stale value once) sets status `error` and
 * skips `writeRecord`. The same `error` path is taken when `write` throws after the bytes already
 * landed (the catch at the end of the try). Next pass: `remote !== undefined && digestOf(remote)
 * !== baseline` with baseline undefined (no record was written) → `conflict`.
 */
import { describe, expect, it } from "vite-plus/test";

import type { Wallet } from "@qntx/wallet";

import { BackupController } from "../../src/backup/controller.ts";
import { createMemoryCloudStore } from "../../src/backup/memory.ts";
import type { CloudStore } from "../../src/backup/port.ts";
import { createMemoryEngineStore } from "../../src/store/memory.ts";

const isWallet = (_v: unknown): _v is Wallet => true;
const stub = <T>(v: unknown, guard: (v: unknown) => v is T): T => {
  if (guard(v)) {
    return v;
  }
  throw new Error("unreachable");
};

const BACKUP_ID = "aa".repeat(16);
const FILE = `qntx-wallet-backup-${BACKUP_ID}.json`;
const ENVELOPE = "envelope-v1-bytes";

const wallet = () =>
  stub(
    {
      getSnapshot: () => ({
        vault: "unlocked",
        backup: { id: BACKUP_ID },
        wallets: [{ walletId: "w", backup: "cloud" }],
      }),
      backup: {
        update: async () => {
          await Promise.resolve();
          return ENVELOPE;
        },
      },
    },
    isWallet,
  );

const rig = (cloud: CloudStore) => {
  const backing = { collections: new Map<string, Map<string, Uint8Array>>() };
  const ctl = new BackupController({
    wallet: wallet(),
    cloud,
    now: () => 1_000_000,
    logger: { warn: () => undefined },
  });
  return { ctl, backing };
};

/** The read-back right after the write returns a stale miss once — everything else healthy. */
const staleReadOnceCloud = (files: Map<string, string>): CloudStore => {
  const inner = createMemoryCloudStore(files);
  let staleOnce = true;
  return {
    ...inner,
    read: async (name) => {
      if (staleOnce && files.has(name)) {
        staleOnce = false;
        return undefined;
      }
      return inner.read(name);
    },
  };
};

/** The first write lands the bytes, then reports failure — a timed-out response. */
const landThenThrowCloud = (files: Map<string, string>): CloudStore => {
  const inner = createMemoryCloudStore(files);
  let failNextWrite = true;
  return {
    ...inner,
    write: async (name, text) => {
      if (failNextWrite) {
        failNextWrite = false;
        files.set(name, text); // the write actually landed…
        throw new Error("gateway 504"); // …but the response says it did not
      }
      return inner.write(name, text);
    },
  };
};

describe("ED-PoC-8 backup reports conflict with itself", () => {
  it("ED-PoC-8a: one stale read-back → error, next sync → conflict with our own file", async () => {
    const files = new Map<string, string>();
    const { ctl, backing } = rig(staleReadOnceCloud(files));
    await ctl.init();
    ctl.setStore(createMemoryEngineStore(backing));

    // Pass 1: write lands, the stale read-back fails verification → status error, no record.
    await ctl.sync();
    expect(ctl.getState().status).toBe("error");
    expect(ctl.getState().error).toBe("cloud");
    expect(files.get(FILE)).toBe(ENVELOPE); // our envelope IS on the cloud

    // Pass 2: the remote is exactly the envelope we just wrote — but with no baseline record
    // it is declared foreign: a self-conflict with no other device ever writing.
    await ctl.sync();
    expect(ctl.getState().status).toBe("conflict");
  });

  it("ED-PoC-8b: write throws after the bytes landed → error, next sync → self-conflict", async () => {
    const files = new Map<string, string>();
    const { ctl, backing } = rig(landThenThrowCloud(files));
    await ctl.init();
    ctl.setStore(createMemoryEngineStore(backing));

    await ctl.sync();
    expect(ctl.getState().status).toBe("error");
    expect(files.get(FILE)).toBe(ENVELOPE);

    await ctl.sync();
    expect(ctl.getState().status).toBe("conflict");
  });
});
