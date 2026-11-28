/**
 * Vectors/unsupported.json — the unsupported-direction cases per persisted artefact. A vault image
 * decides from `meta.format` alone: below VAULT_FORMAT is an older build's (no reader here), above
 * it a newer build's; content inside the current format no module owns can only be a newer build's.
 * The backup envelope decides from its wire version the same way. Every artefact is left untouched
 * — `vault.reset` stays the explicit exit.
 */
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue, WalletErrorCode } from "@qntx/wallet/protocol";
import type { StatusPayload } from "@qntx/wallet/types";

import { KernelError, UnsupportedFormatError } from "../src/errors.ts";
import type { StoreOp, StoredFactor, StoredRecord, VaultImage } from "../src/vault/store.ts";
import { formatReason, VAULT_FORMAT } from "../src/vault/store.ts";
import { assertVaultImage } from "../src/vault/validate.ts";
import { createHarness } from "./harness.ts";
import type { Harness, KernelResponse } from "./harness.ts";
import { loadVectors } from "./helpers.ts";

type Reason = "older" | "newer";
type Expect = "ok" | "integrity" | { status: "unsupported"; reason: Reason };

type VectorRecord = { kind: string; id: string; header: string; sealed: string };
type VectorImage = {
  meta: VaultImage["meta"] | Record<string, unknown>;
  records: VectorRecord[];
  factors: VectorRecord[];
};

const vectors = loadVectors("unsupported.json") as {
  vault: { current: number; cases: Array<{ name: string; image: VectorImage; expect: Expect }> };
  vaultDb: { current: number; cases: Array<{ name: string; version: number; expect: Expect }> };
  backup: { current: number; cases: Array<{ name: string; envelope: string; expect: Expect }> };
  engineDb: { current: number; cases: Array<{ name: string; version: number; expect: Expect }> };
  publicDb: { current: number; cases: Array<{ name: string; version: number; expect: Expect }> };
};

const row = (entry: VectorRecord): StoredRecord | StoredFactor => ({
  kind: entry.kind,
  id: entry.id,
  header: entry.header,
  sealed: hexToBytes(entry.sealed),
});

const image = (v: VectorImage): VaultImage => ({
  meta: v.meta as VaultImage["meta"],
  records: v.records.map(row),
  factors: v.factors.map(row),
});

/** The init + puts that write one vector image — every vector carries a meta. */
const imageOps = (v: VectorImage): StoreOp[] => {
  const { meta } = image(v);
  if (meta === undefined) {
    throw new Error("vector meta missing");
  }
  return [
    { op: "init", meta },
    ...v.records.map((record) => ({ op: "put-record", record: row(record) }) as const),
    ...v.factors.map((factor) => ({ op: "put-factor", factor: row(factor) }) as const),
  ];
};

/** The vault status payload a case must surface: locked / corrupted / the direction object. */
const wantedStatus = (expected: Expect): ProtocolValue =>
  expected === "ok"
    ? { status: "locked" }
    : expected === "integrity"
      ? { status: "corrupted" }
      : expected;

function ok(response: KernelResponse): ProtocolValue {
  if ("ok" in response) {
    return response.ok;
  }
  throw new Error(`expected ok, got ${JSON.stringify(response)}`);
}

function errCode(response: KernelResponse): WalletErrorCode {
  if ("err" in response) {
    return response.err.code;
  }
  throw new Error("expected err");
}

function field(value: ProtocolValue, key: string): ProtocolValue {
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) {
    const entry = (value as Record<string, ProtocolValue>)[key];
    if (entry !== undefined) {
      return entry;
    }
  }
  throw new Error(`missing field ${key}`);
}

function lastStatus(h: Harness): StatusPayload {
  for (let i = h.events.length - 1; i >= 0; i--) {
    const event = h.events[i];
    if (event !== undefined && event.event === "status") {
      return event.status;
    }
  }
  throw new Error("no status event yet");
}

/**
 * What the validate layer must say: it reads the format alone — a foreign integer format is
 * direction-specific unsupported, a non-integer is integrity; unowned content inside the current
 * format passes validation and is refused later by the status layer.
 */
const expectedValidate = (v: VectorImage, expected: Expect): Expect => {
  const format: unknown = image(v).meta?.format;
  if (typeof format === "number" && Number.isSafeInteger(format)) {
    return format === VAULT_FORMAT
      ? expected === "integrity"
        ? "integrity"
        : "ok"
      : { status: "unsupported", reason: formatReason(format) };
  }
  return "integrity";
};

/** The validate-layer verdict: assertVaultImage's throw (or pass) for one vector case. */
function validateVerdict(v: VectorImage): Expect {
  try {
    assertVaultImage(image(v));
    return "ok";
  } catch (error) {
    if (error instanceof UnsupportedFormatError) {
      return { status: "unsupported", reason: error.reason };
    }
    if (error instanceof KernelError && error.code === "integrity") {
      return "integrity";
    }
    throw error;
  }
}

describe("vectors/unsupported.json", () => {
  it.each(vectors.vault.cases)("vault image $name", async ({ image: v, expect: expected }) => {
    expect(validateVerdict(v)).toStrictEqual(expectedValidate(v, expected));
    // The same image through the kernel: an unsupported verdict carries the direction in the
    // status payload; a structural reject is corrupted; the readable one is an ordinary vault.
    const h = createHarness();
    await h.settle();
    await h.store.commit(imageOps(v));
    await h.settle();
    expect(lastStatus(h).vault).toStrictEqual(wantedStatus(expected));
  });

  it.each(
    vectors.backup.cases.filter(
      (
        c,
      ): c is {
        name: string;
        envelope: string;
        expect: { status: "unsupported"; reason: Reason };
      } => typeof c.expect === "object",
    ),
  )("backup.restore refuses a $name envelope with unsupported", async ({ envelope }) => {
    const h = createHarness();
    await h.settle();
    const res = await h.call("backup.restore", {
      envelope,
      backupFactor: { kind: "password", password: utf8ToBytes("backup password") },
      factor: { kind: "password", password: utf8ToBytes("vault password") },
    });
    // The wire code cannot carry the direction — parseBackupHeader does — but the envelope is
    // refused either way and the vault stays uninitialized.
    expect(errCode(res)).toBe("unsupported");
    expect(field(ok(await h.call("status")), "vault")).toStrictEqual({
      status: "uninitialized",
    });
  });
});
