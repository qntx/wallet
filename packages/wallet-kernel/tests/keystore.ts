/**
 * The shared fake platform keystore for kernel tests. Keys live per id with their protection;
 * `seal` returns SHA-256(utf8(id)) as the opaque ciphertext and `open` checks both. Presence work
 * (seal/open/authenticate) needs the lock screen — with it off, seal/authenticate reject
 * `verification-unavailable` and probe answers `false`. `fail` scripts the next prompting call's
 * rejection, `gate` holds the next presence `open` until released, `invalidate`/`removeLockScreen`
 * model a key or the whole presence keyring going away for good.
 */
import { equalBytes } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

import { KernelError } from "../src/errors.ts";
import type { Keystore, KeystorePrompt } from "../src/platform.ts";

export type KeystoreCall =
  | {
      readonly op: "seal" | "open";
      readonly id: string;
      readonly protection: "device" | "presence";
      readonly prompt?: KeystorePrompt;
    }
  | { readonly op: "probe"; readonly id: string; readonly protection: "device" | "presence" }
  | { readonly op: "remove"; readonly id: string }
  | { readonly op: "authenticate"; readonly prompt: KeystorePrompt }
  | { readonly op: "clear" };

export type KeystoreOutcome = "cancelled" | "factor-invalidated" | "verification-unavailable";

export type FakeKeystore = {
  readonly keystore: Keystore;
  /** Every call the kernel made, in order (protection included for seal/open/probe). */
  readonly calls: KeystoreCall[];
  /** Id → KEK, exactly what the platform would hold. */
  readonly keys: Map<string, Uint8Array>;
  /** Whether the lock screen is on (presence work exists only while it is). */
  readonly lockScreen: () => boolean;
  /** Scripts the next prompting call's rejection. */
  readonly fail: (outcome: KeystoreOutcome) => void;
  /** Holds the next presence `open` until the returned release runs. */
  readonly hold: () => () => void;
  /** Runs `fn` at the start of the next presence `open` (one-shot, re-armable). */
  readonly watchOpen: (fn: () => void) => void;
  /** The key is gone for good, as if the platform deleted it. */
  readonly invalidate: (id: string) => void;
  /** Pre-populates a key — one the platform made before this fake started watching. */
  readonly adopt: (id: string, secret: Uint8Array, use: "device" | "presence") => void;
  /** Turns the lock screen off: every presence key dies with it. */
  readonly removeLockScreen: () => void;
  /** Turns the lock screen back on — dead presence keys stay dead, only new ones may be made. */
  readonly setLockScreen: (on: boolean) => void;
};

export function fakeKeystore(locale = "en-US", platform: "ios" | "android" = "ios"): FakeKeystore {
  const keys = new Map<string, Uint8Array>();
  const protection = new Map<string, "device" | "presence">();
  const calls: KeystoreCall[] = [];
  const failures: KeystoreOutcome[] = [];
  let locked = true;
  let gate: Promise<void> | undefined;
  let onOpen: (() => void) | undefined;
  const reject = (): void => {
    const outcome = failures.shift();
    if (outcome !== undefined) {
      throw new KernelError(outcome, "scripted keystore failure");
    }
  };
  const keystore: Keystore = {
    locale,
    platform,
    seal: async (id, secret, use) => {
      calls.push(
        use.protection === "presence"
          ? { op: "seal", id, protection: "presence", prompt: use.prompt }
          : { op: "seal", id, protection: "device" },
      );
      await Promise.resolve();
      if (use.protection === "presence") {
        reject();
        if (!locked) {
          throw new KernelError("verification-unavailable", "no lock screen");
        }
      }
      if (keys.has(id)) {
        throw new Error("duplicate key alias");
      }
      keys.set(id, new Uint8Array(secret));
      protection.set(id, use.protection);
      return sha256(utf8ToBytes(id));
    },
    open: async (id, sealed, use) => {
      calls.push(
        use.protection === "presence"
          ? { op: "open", id, protection: "presence", prompt: use.prompt }
          : { op: "open", id, protection: "device" },
      );
      if (use.protection === "presence") {
        onOpen?.();
        const held = gate;
        gate = undefined;
        await (held ?? Promise.resolve());
        reject();
      } else {
        await Promise.resolve();
      }
      const secret = keys.get(id);
      if (
        secret === undefined ||
        protection.get(id) !== use.protection ||
        !equalBytes(sealed, sha256(utf8ToBytes(id)))
      ) {
        throw new KernelError("factor-invalidated", "no such key");
      }
      return new Uint8Array(secret);
    },
    probe: async (id, want) => {
      calls.push({ op: "probe", id, protection: want });
      await Promise.resolve();
      return keys.has(id) && protection.get(id) === want && (want === "device" || locked);
    },
    remove: async (id) => {
      calls.push({ op: "remove", id });
      await Promise.resolve();
      keys.delete(id);
      protection.delete(id);
    },
    authenticate: async (prompt) => {
      calls.push({ op: "authenticate", prompt });
      await Promise.resolve();
      reject();
      if (!locked) {
        throw new KernelError("verification-unavailable", "no lock screen");
      }
    },
    clear: async () => {
      calls.push({ op: "clear" });
      await Promise.resolve();
      keys.clear();
      protection.clear();
    },
  };
  return {
    keystore,
    calls,
    keys,
    lockScreen: () => locked,
    fail: (outcome) => {
      failures.push(outcome);
    },
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    watchOpen: (fn) => {
      onOpen = fn;
    },
    invalidate: (id) => {
      keys.delete(id);
      protection.delete(id);
    },
    adopt: (id, secret, use) => {
      keys.set(id, new Uint8Array(secret));
      protection.set(id, use);
    },
    removeLockScreen: () => {
      locked = false;
      for (const [id, want] of protection) {
        if (want === "presence") {
          keys.delete(id);
          protection.delete(id);
        }
      }
    },
    setLockScreen: (on) => {
      locked = on;
    },
  };
}
