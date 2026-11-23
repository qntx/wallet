/**
 * The vault anchor: a 21-byte record the kernel keeps outside the record store, so a writer who can
 * only restore the store (an older sealed image put back wholesale, or the failure counters zeroed)
 * cannot restore this with it. `revision` is the floor — the highest vault revision the kernel
 * itself sealed or authenticated; a loaded image below it reads corrupted before any unlock.
 * `failedAttempts`/`lastFailureAt` are the password backoff counters, moved here from the vault
 * meta: the store no longer carries them at all.
 *
 * Record: `u8 version = 1 ‖ u64be revision ‖ u32be failedAttempts ‖ u64be lastFailureAt`. Hosts
 * persist it as opaque bytes behind a compare-and-swap; fixed vectors live in
 * vectors/vault-anchor.json.
 */
import { KernelError } from "../errors.ts";
import type { VaultAnchor } from "../platform.ts";

const ANCHOR_BYTES = 21;
const ANCHOR_VERSION = 1;
/** CAS retries before `updateAnchor`/`resetAnchor` give up with `conflict`. */
const MAX_ATTEMPTS = 8;
const ZERO: AnchorState = { revision: 0, failedAttempts: 0, lastFailureAt: 0 };

export type AnchorState = {
  readonly revision: number;
  readonly failedAttempts: number;
  readonly lastFailureAt: number;
};

/** U64be as two u32 words — bare Hermes has no BigInt reliance here. */
function writeU64(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, Math.floor(value / 0x1_00_00_00_00));
  view.setUint32(offset + 4, value % 0x1_00_00_00_00);
}

function readU64(view: DataView, offset: number): number {
  const high = view.getUint32(offset);
  if (high > 0x1f_ff_ff) {
    // high word past 0x001f ffff → value above Number.MAX_SAFE_INTEGER.
    throw new KernelError("integrity", "invalid vault anchor");
  }
  return high * 0x1_00_00_00_00 + view.getUint32(offset + 4);
}

export function encodeAnchor(state: AnchorState): Uint8Array {
  const out = new Uint8Array(ANCHOR_BYTES);
  const view = new DataView(out.buffer);
  view.setUint8(0, ANCHOR_VERSION);
  writeU64(view, 1, state.revision);
  view.setUint32(9, state.failedAttempts);
  writeU64(view, 13, state.lastFailureAt);
  return out;
}

export function decodeAnchor(bytes: Uint8Array): AnchorState {
  if (bytes.length !== ANCHOR_BYTES) {
    throw new KernelError("integrity", "invalid vault anchor");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== ANCHOR_VERSION) {
    throw new KernelError("integrity", "invalid vault anchor");
  }
  return {
    revision: readU64(view, 1),
    failedAttempts: view.getUint32(9),
    lastFailureAt: readU64(view, 13),
  };
}

/** Host rejections that are not KernelError map to `unavailable` — same class as store I/O. */
function unavailable(error: unknown): KernelError {
  if (error instanceof KernelError) {
    return error;
  }
  return new KernelError(
    "unavailable",
    `vault anchor: ${error instanceof Error ? error.message : "request failed"}`,
  );
}

async function readRaw(anchor: VaultAnchor): Promise<Uint8Array | undefined> {
  try {
    return await anchor.read();
  } catch (error) {
    throw unavailable(error);
  }
}

async function replaceRaw(
  anchor: VaultAnchor,
  next: Uint8Array,
  expected: Uint8Array | undefined,
): Promise<boolean> {
  try {
    return await anchor.replace(next, expected);
  } catch (error) {
    throw unavailable(error);
  }
}

/** Nothing stored reads as the zero state. */
export async function readAnchor(anchor: VaultAnchor): Promise<AnchorState> {
  const raw = await readRaw(anchor);
  return raw === undefined ? ZERO : decodeAnchor(raw);
}

/**
 * Read → change → CAS, retrying while another writer wins the race. Eight lost races in a row is
 * `conflict` — like a store precondition that can never hold.
 */
export async function updateAnchor(
  anchor: VaultAnchor,
  change: (current: AnchorState) => AnchorState,
): Promise<AnchorState> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- CAS retries are sequential by design
    const raw = await readRaw(anchor);
    const next = change(raw === undefined ? ZERO : decodeAnchor(raw));
    // oxlint-disable-next-line eslint/no-await-in-loop -- CAS retries are sequential by design
    if (await replaceRaw(anchor, encodeAnchor(next), raw)) {
      return next;
    }
  }
  throw new KernelError("conflict", "vault anchor changed underneath");
}

/**
 * The reset path: raises the floor past the image just erased and zeroes the counters. A stored
 * record that does not decode counts as base 0 — reset is the recovery path for a garbage anchor.
 */
export async function resetAnchor(anchor: VaultAnchor): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- CAS retries are sequential by design
    const raw = await readRaw(anchor);
    let base = 0;
    if (raw !== undefined) {
      try {
        base = decodeAnchor(raw).revision;
      } catch {
        base = 0;
      }
    }
    const next: AnchorState = { revision: base + 1, failedAttempts: 0, lastFailureAt: 0 };
    // oxlint-disable-next-line eslint/no-await-in-loop -- CAS retries are sequential by design
    if (await replaceRaw(anchor, encodeAnchor(next), raw)) {
      return;
    }
  }
  throw new KernelError("conflict", "vault anchor changed underneath");
}

/** In-memory VaultAnchor for the Node host's main thread and kernel tests; copies in and out. */
export function createMemoryAnchor(): VaultAnchor {
  let stored: Uint8Array | undefined;
  return {
    async read() {
      return stored === undefined ? undefined : Uint8Array.from(stored);
    },
    async replace(next, expected) {
      const match =
        stored === undefined
          ? expected === undefined
          : expected !== undefined &&
            stored.length === expected.length &&
            stored.every((byte, index) => byte === expected[index]);
      if (!match) {
        return false;
      }
      stored = Uint8Array.from(next);
      return true;
    },
  };
}
