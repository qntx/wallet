// oxlint-disable vitest/no-conditional-in-test, vitest/no-conditional-expect, eslint/no-await-in-loop -- a property runner's op loop is inherently conditional, sequential and state-bearing
/**
 * Property test for the session-factor model: under arbitrary interleavings of unlocks, lock
 * events, keystore tampering and guarded calls, every call that produces a guarded effect (an
 * export that returned bytes, an app-lock state change, a reset that cleared the vault) contained
 * exactly one successful presence ceremony — and no device-verifier call ever produced one.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { createHarness } from "./harness.ts";
import type { KernelResponse } from "./harness.ts";
import { fakeKeystore } from "./keystore.ts";
import type { FakeKeystore } from "./keystore.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DEVICE = { kind: "device" } as const;
const HARDWARE = { kind: "hardware" } as const;

const OPS = [
  "unlock-device",
  "unlock-hardware",
  "lock",
  "toggle-lock-screen",
  "invalidate-hardware",
  "cancel-prompt",
  "enrol-verification",
  "app-lock-on",
  "app-lock-off",
  "export-hardware",
  "export-device",
  "keys-export-hardware",
  "keys-export-device",
  "nostr-export-hardware",
  "nostr-export-device",
  "reset",
] as const;

/** Presence ceremonies the keystore logged during one call (seal/open presence, authenticate). */
function presenceCalls(fake: FakeKeystore, since: number): number {
  return fake.calls
    .slice(since)
    .filter(
      (call) =>
        ((call.op === "open" || call.op === "seal") && call.protection === "presence") ||
        call.op === "authenticate",
    ).length;
}

const ok = (res: KernelResponse): boolean => "ok" in res;

function okField(res: KernelResponse, key: string): ProtocolValue {
  if (!("ok" in res)) {
    throw new Error("expected an ok response");
  }
  const payload = res.ok as Record<string, ProtocolValue>;
  const value = payload[key];
  if (value === undefined) {
    throw new Error(`missing ${key}`);
  }
  return value;
}

const okSession = (res: KernelResponse): string => okField(res, "session") as string;
const okWallet = (res: KernelResponse): { walletId: string } =>
  okField(res, "wallet") as { walletId: string };

describe("session factor: presence ceremony invariants", () => {
  it(
    "guarded effects need exactly one presence ceremony; a device verifier never produces one",
    { timeout: 60_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.constantFrom(...OPS), { minLength: 10, maxLength: 40 }),
          async (ops) => {
            const fake = fakeKeystore();
            const h = createHarness({ keystore: fake.keystore });
            await h.settle();
            const established = await h.call("wallet.importMnemonic", {
              mnemonic: utf8ToBytes(MNEMONIC),
              factor: DEVICE,
            });
            expect(ok(established)).toBe(true);
            const { walletId } = okWallet(established);
            let session = okSession(established);
            let keyId = "";
            {
              const imported = await h.call(
                "keys.import",
                { family: "evm", secret: new Uint8Array(32).fill(3) },
                session,
              );
              if (ok(imported)) {
                keyId = okField(imported, "keyId") as string;
              }
            }
            let publicKey = "";
            {
              const derived = await h.call("nostr.deriveKey", { walletId, index: 0 }, session);
              if (ok(derived)) {
                publicKey = okField(derived, "publicKey") as string;
              }
            }

            const status = async (): Promise<ProtocolValue> => {
              const res = await h.call("status");
              return "ok" in res ? res.ok : {};
            };
            const appLocked = async (): Promise<boolean> =>
              ((await status()) as { appLock?: boolean }).appLock === true;
            const hardwareId = async (): Promise<string | undefined> =>
              (
                ((await status()) as { factors?: Array<{ kind: string; id: string }> }).factors ??
                []
              ).find((factor) => factor.kind === "hardware")?.id;

            const guarded = async (
              method: string,
              params: unknown,
            ): Promise<{ res: KernelResponse; presence: number }> => {
              const since = fake.calls.length;
              const res = await h.call(method, params, session);
              if ("err" in res && res.err.code === "locked") {
                session = "";
              }
              return { res, presence: presenceCalls(fake, since) };
            };

            for (const op of ops) {
              switch (op) {
                case "unlock-device": {
                  const since = fake.calls.length;
                  const res = await h.call("vault.unlock", { factor: DEVICE });
                  if (ok(res)) {
                    session = okSession(res);
                    expect(presenceCalls(fake, since)).toBe(0);
                  }
                  break;
                }
                case "unlock-hardware": {
                  const since = fake.calls.length;
                  const res = await h.call("vault.unlock", { factor: HARDWARE });
                  if (ok(res)) {
                    session = okSession(res);
                    expect(presenceCalls(fake, since)).toBe(1);
                  }
                  break;
                }
                case "lock":
                  h.advance(20 * 60_000);
                  session = "";
                  break;
                case "toggle-lock-screen":
                  if (fake.lockScreen()) {
                    fake.removeLockScreen();
                  } else {
                    fake.setLockScreen(true);
                  }
                  break;
                case "invalidate-hardware": {
                  const id = await hardwareId();
                  if (id !== undefined) {
                    fake.invalidate(id);
                  }
                  break;
                }
                case "cancel-prompt":
                  fake.fail("cancelled");
                  break;
                case "enrol-verification": {
                  const { res, presence } = await guarded("vault.enrolVerification", null);
                  if (ok(res)) {
                    expect(presence).toBe(1);
                  }
                  break;
                }
                case "app-lock-on":
                case "app-lock-off": {
                  const enabled = op === "app-lock-on";
                  const before = await appLocked();
                  const { res, presence } = await guarded("vault.setAppLock", {
                    enabled,
                    verify: HARDWARE,
                  });
                  if (ok(res)) {
                    const after = await appLocked();
                    // A state change is a guarded effect: exactly one presence ceremony ran.
                    expect(presence).toBe(after === before ? 0 : 1);
                  }
                  break;
                }
                case "export-hardware": {
                  const { res, presence } = await guarded("wallet.exportMnemonic", {
                    verify: HARDWARE,
                    walletId,
                  });
                  if (ok(res)) {
                    expect(presence).toBe(1);
                  }
                  break;
                }
                case "export-device": {
                  const { res, presence } = await guarded("wallet.exportMnemonic", {
                    verify: DEVICE,
                    walletId,
                  });
                  expect(ok(res)).toBe(false);
                  expect(presence).toBe(0);
                  break;
                }
                case "keys-export-hardware": {
                  if (keyId === "") {
                    break;
                  }
                  const { res, presence } = await guarded("keys.export", {
                    verify: HARDWARE,
                    keyId,
                  });
                  if (ok(res)) {
                    expect(presence).toBe(1);
                  }
                  break;
                }
                case "keys-export-device": {
                  if (keyId === "") {
                    break;
                  }
                  const { res, presence } = await guarded("keys.export", {
                    verify: DEVICE,
                    keyId,
                  });
                  expect(ok(res)).toBe(false);
                  expect(presence).toBe(0);
                  break;
                }
                case "nostr-export-hardware": {
                  if (publicKey === "") {
                    break;
                  }
                  const { res, presence } = await guarded("nostr.exportKey", {
                    verify: HARDWARE,
                    publicKey,
                    format: { kind: "nsec" },
                  });
                  if (ok(res)) {
                    expect(presence).toBe(1);
                  }
                  break;
                }
                case "nostr-export-device": {
                  if (publicKey === "") {
                    break;
                  }
                  const { res, presence } = await guarded("nostr.exportKey", {
                    verify: DEVICE,
                    publicKey,
                    format: { kind: "nsec" },
                  });
                  expect(ok(res)).toBe(false);
                  expect(presence).toBe(0);
                  break;
                }
                case "reset": {
                  const since = fake.calls.length;
                  const res = await h.call("vault.reset", null, session || undefined);
                  if (ok(res)) {
                    // A reset that ran proved presence exactly once (authenticate).
                    expect(presenceCalls(fake, since)).toBe(1);
                  }
                  session = "";
                  // Re-establish so the rest of the sequence keeps a vault to work against.
                  const again = await h.call("wallet.importMnemonic", {
                    mnemonic: utf8ToBytes(MNEMONIC),
                    factor: DEVICE,
                  });
                  if (ok(again)) {
                    session = okSession(again);
                  }
                  break;
                }
              }
            }
          },
        ),
        { numRuns: 15, seed: 20260214 },
      );
    },
  );
});
