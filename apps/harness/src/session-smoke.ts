/**
 * Session-factor smoke: drives the public wallet API through the real native
 * kernel on relaunches selected by launch URL (`<scheme>://session/<phase>`).
 * Every step prints `SMOKE_RESULT <step> <ok|fail> <detail>`; steps that may
 * show a system verification first print `SMOKE_WAITING <step>` so the driver
 * can satisfy the prompt. Prompt observance is measured, never assumed: each
 * step records `verify=<n>` (snapshot `verifying` transitions during the step)
 * and `vms=<ms>` (time spent inside `verifying` — the flag wraps whole calls,
 * so an instant kernel rejection flips it without a prompt, while a real
 * prompt cannot complete under 500ms).
 *
 * Phases: a1 create | a2 silent unlock + guarded calls | a3 app-lock off |
 * auto background auto-lock | b1 no-lock-screen create | b2 enrol verification
 * | b3 dead hardware cleanup | silent plain silent unlock | phys
 * snapshot-derived device run (create when uninitialized, else silent unlock +
 * sign).
 */
import { Linking, Platform } from "react-native";

import { File, FileMode, Paths } from "expo-file-system";

import { report } from "@qntx/v1-probe";
import type { VerifyFactor, WalletSnapshot } from "@qntx/wallet";
import { WalletError } from "@qntx/wallet";
import { nostr } from "@qntx/wallet/nostr";
import type { NativeWallet } from "@qntx/wallet-native";
import { createNativeWallet } from "@qntx/wallet-native";

import { PASSKEY } from "./passkey";
import { verifyEvent } from "./verify";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const HARDWARE: VerifyFactor = { kind: "hardware" };
// Deliberately not a VerifyFactor: the call must fail client-side.
const DEVICE = { kind: "device" } as unknown as VerifyFactor;

// iOS stderr reaches nothing observable when the app is launched through
// openurl, so every smoke line is also appended to a file the driver reads
// through the simulator's data container.
export const SMOKE_LOG = "session-smoke.log";
let sink: { writeBytesSync(b: Uint8Array): void } | null = null;
try {
  const file = new File(Paths.document, SMOKE_LOG);
  if (!file.exists) {
    file.create();
  }
  sink = file.open(FileMode.Append);
} catch {
  sink = null;
}
const emit = (probe: string, ok: boolean, detail: string): void => {
  report(`smoke-${probe}`, "release", ok, JSON.stringify(detail));
  try {
    sink?.writeBytesSync(
      new TextEncoder().encode(`${probe} ${ok ? 1 : 0} ${detail.replaceAll("\n", " ")}\n`),
    );
  } catch {
    // reporting must never break the smoke
  }
};

const result = (name: string, ok: boolean, detail: string): void => {
  emit(name, ok, detail);
};

const waiting = (name: string): void => {
  emit(`waiting-${name}`, true, "");
};

/** The launch URL's segment after `session/` selects the phase; no URL → null.
 * On iOS a cold `openurl` shows a SpringBoard "open in app" alert and never
 * reaches the app, so the driver drops a session-phase file into the app
 * container and launches the bundle directly instead. */
export async function sessionSmokePhase(): Promise<string | null> {
  if (Platform.OS === "ios") {
    try {
      const phase = new File(Paths.document, "session-phase");
      if (phase.exists) {
        const name = phase.textSync().trim();
        phase.delete();
        emit("url", true, `file:${name}`);
        return name.length > 0 ? name : null;
      }
    } catch {
      // fall through to the URL path
    }
  }
  const url = await Linking.getInitialURL();
  emit("url", true, String(url));
  if (url == null || !url.includes("session/")) {
    return null;
  }
  return url.slice(url.indexOf("session/") + "session/".length).split(/[?#/]/)[0] ?? null;
}

type Smoke = {
  readonly wallet: NativeWallet;
  /** `verifying` false→true transitions since this context opened. */
  readonly verify: () => number;
  /** ms spent inside `verifying`; a real system prompt cannot clear <500ms. */
  readonly verifyMs: () => number;
};

const open = async (): Promise<Smoke> => {
  const wallet = await createNativeWallet({
    verifyEvent,
    passkey: PASSKEY,
    autoLock: { platform: "native", backgroundSeconds: 60 },
  });
  let count = 0;
  let heldMs = 0;
  let since = 0;
  let wasVerifying = wallet.getSnapshot().verifying;
  wallet.subscribe(() => {
    const verifying = wallet.getSnapshot().verifying;
    if (verifying && !wasVerifying) {
      count += 1;
      since = Date.now();
    } else if (!verifying && wasVerifying) {
      heldMs += Date.now() - since;
    }
    wasVerifying = verifying;
  });
  return {
    wallet,
    verify: () => count,
    verifyMs: () =>
      heldMs + (wallet.getSnapshot().verifying ? Date.now() - since : 0),
  };
};

const kinds = (snapshot: WalletSnapshot): string => snapshot.factors.map((f) => f.kind).join(",");
// factor rows keep insertion order (a re-added device row lands after
// hardware), so assertions compare the sorted set.
const kindSet = (snapshot: WalletSnapshot): string =>
  snapshot.factors.map((f) => f.kind).sort().join(",");

const codeOf = (error: unknown): string =>
  error instanceof WalletError ? error.code : String(error);

const sign = async (wallet: NativeWallet, tag: string, walletId?: string): Promise<void> => {
  const api = nostr(wallet);
  const snapshot = wallet.getSnapshot();
  const id = walletId ?? snapshot.wallets[0]?.walletId;
  if (id === undefined) {
    result(`${tag}-sign`, false, "no wallet");
    return;
  }
  let ref = snapshot.nostr.keys[0]?.ref;
  let publicKey = snapshot.nostr.keys[0]?.publicKey;
  if (ref === undefined || publicKey === undefined) {
    const key = await api.deriveKey(id, 0);
    ref = key.ref;
    publicKey = key.publicKey;
  }
  const event = await api.signer(ref).signEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: `session smoke ${tag}`,
    pubkey: publicKey,
  });
  result(`${tag}-sign`, verifyEvent(event), `wallet=${id} pubkey=${publicKey}`);
};

/** A1/B1 shared create path; returns the live context so B1 can keep going. */
const runCreate = async (
  tag: string,
  expectBoth: boolean,
): Promise<Smoke & { walletId: string }> => {
  const smoke = await open();
  waiting(`${tag}-create`);
  const started = Date.now();
  const info = await smoke.wallet.wallets.importMnemonic({ mnemonic: MNEMONIC });
  const snapshot = smoke.wallet.getSnapshot();
  const expected = expectBoth ? "device,hardware" : "device";
  result(
    `${tag}-factors`,
    kindSet(snapshot) === expected &&
      !snapshot.appLock &&
      snapshot.verification === (expectBoth ? "available" : "unavailable"),
    `factors=${kinds(snapshot)} appLock=${snapshot.appLock} verification=${snapshot.verification} verify=${smoke.verify()} ms=${Date.now() - started}`,
  );
  await sign(smoke.wallet, tag, info.walletId);
  return { ...smoke, walletId: info.walletId };
};

const runA1 = async (): Promise<void> => {
  const { wallet, walletId } = await runCreate("a1", true);
  await wallet.vault.lock();
  result("a1-lock", wallet.getSnapshot().vault.status === "locked", `wallet=${walletId}`);
};

const runA2 = async (): Promise<void> => {
  const { wallet, verify } = await open();
  const snapshot = wallet.getSnapshot();
  const walletId = snapshot.wallets[0]?.walletId;
  if (snapshot.vault.status !== "locked" || walletId === undefined) {
    result("a2-state", false, `vault=${snapshot.vault.status}`);
    return;
  }

  await wallet.vault.unlock();
  result(
    "a2-unlock",
    wallet.getSnapshot().vault.status === "unlocked" && verify() === 0,
    `verify=${verify()}`,
  );
  await sign(wallet, "a2", walletId);

  waiting("a2-export");
  const beforeExport = verify();
  const startedExport = Date.now();
  const exported = await wallet.wallets.exportMnemonic(walletId, HARDWARE);
  const words = new TextDecoder().decode(exported.mnemonic.read());
  result(
    "a2-export",
    words === MNEMONIC && verify() > beforeExport,
    `verify=${verify() - beforeExport} ms=${Date.now() - startedExport} matches=${words === MNEMONIC}`,
  );

  // Rejected inside the client's withVerifying wrapper before any kernel or
  // keystore call: the verify delta records the wrap, never a prompt.
  const beforeDevice = verify();
  const startedDevice = Date.now();
  let deviceOutcome = "resolved";
  try {
    (await wallet.wallets.exportMnemonic(walletId, DEVICE)).mnemonic.read();
  } catch (e) {
    deviceOutcome = codeOf(e);
  }
  result(
    "a2-export-device",
    deviceOutcome === "invalid-input",
    `outcome=${deviceOutcome} verify=${verify() - beforeDevice} ms=${Date.now() - startedDevice}`,
  );

  waiting("a2-applock");
  const beforeLock = verify();
  await wallet.vault.setAppLock(true, HARDWARE);
  const after = wallet.getSnapshot();
  result(
    "a2-applock",
    after.appLock && kinds(after) === "hardware" && verify() > beforeLock,
    `factors=${kinds(after)} verify=${verify() - beforeLock}`,
  );
};

const runA3 = async (): Promise<void> => {
  const { wallet, verify } = await open();
  const snapshot = wallet.getSnapshot();
  if (snapshot.vault.status !== "locked" || !snapshot.appLock) {
    result("a3-state", false, `vault=${snapshot.vault.status} appLock=${snapshot.appLock}`);
    return;
  }

  waiting("a3-unlock");
  const before = verify();
  await wallet.vault.unlock();
  result(
    "a3-unlock",
    wallet.getSnapshot().vault.status === "unlocked" && verify() > before,
    `verify=${verify() - before}`,
  );

  waiting("a3-applock-off");
  const beforeOff = verify();
  await wallet.vault.setAppLock(false, HARDWARE);
  const off = wallet.getSnapshot();
  result(
    "a3-applock-off",
    !off.appLock && kindSet(off) === "device,hardware" && verify() > beforeOff,
    `factors=${kinds(off)} verify=${verify() - beforeOff}`,
  );

  await wallet.vault.lock();
  const beforeSilent = verify();
  await wallet.vault.unlock();
  result(
    "a3-silent-unlock",
    wallet.getSnapshot().vault.status === "unlocked" && verify() === beforeSilent,
    `verify=${verify() - beforeSilent}`,
  );
};

const runAuto = async (): Promise<void> => {
  const { wallet, verify } = await open();
  const before = verify();
  await wallet.vault.unlock();
  result(
    "auto-unlock",
    wallet.getSnapshot().vault.status === "unlocked" && verify() === before,
    `verify=${verify() - before}`,
  );

  wallet.setAutoLock({ platform: "native", backgroundSeconds: 0 });
  result("auto-armed", true, "");

  // The JS thread is suspended while the app is backgrounded, so the poll
  // only ever sees the post-foreground state — `lockReason` is the evidence
  // that the background timer fired.
  const deadline = Date.now() + 120_000;
  let snapshot = wallet.getSnapshot();
  while (Date.now() < deadline) {
    snapshot = wallet.getSnapshot();
    if (snapshot.vault.status === "locked" && snapshot.lockReason === "background") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  result(
    "auto-background-lock",
    snapshot.vault.status === "locked" && snapshot.lockReason === "background",
    `vault=${snapshot.vault.status} reason=${String(snapshot.lockReason)}`,
  );

  const beforeUnlock = verify();
  await wallet.vault.unlock();
  result(
    "auto-silent-unlock",
    wallet.getSnapshot().vault.status === "unlocked" && verify() === beforeUnlock,
    `verify=${verify() - beforeUnlock}`,
  );
};

const runB1 = async (): Promise<void> => {
  const smoke = await runCreate("b1", false);
  const { wallet, verify, verifyMs, walletId } = smoke;

  // `verifying` wraps the whole call, so a kernel-level rejection still flips
  // the flag — a real prompt is impossible under 500ms.
  const beforeExport = verify();
  const heldExport = verifyMs();
  let exportOutcome = "resolved";
  try {
    (await wallet.wallets.exportMnemonic(walletId, HARDWARE)).mnemonic.read();
  } catch (e) {
    exportOutcome = codeOf(e);
  }
  result(
    "b1-export",
    exportOutcome === "verification-unavailable" && verifyMs() - heldExport < 500,
    `outcome=${exportOutcome} verify=${verify() - beforeExport} vms=${verifyMs() - heldExport}`,
  );

  const beforeEnrol = verify();
  const heldEnrol = verifyMs();
  let enrolOutcome = "resolved";
  try {
    await wallet.vault.enrolVerification();
  } catch (e) {
    enrolOutcome = codeOf(e);
  }
  result(
    "b1-enrol",
    enrolOutcome === "verification-unavailable" && verifyMs() - heldEnrol < 500,
    `outcome=${enrolOutcome} verify=${verify() - beforeEnrol} vms=${verifyMs() - heldEnrol}`,
  );
};

const runB2 = async (): Promise<void> => {
  const { wallet, verify, verifyMs } = await open();
  const walletId = wallet.getSnapshot().wallets[0]?.walletId;
  const before = verify();
  await wallet.vault.unlock();
  result(
    "b2-unlock",
    wallet.getSnapshot().vault.status === "unlocked" && verify() === before && walletId !== undefined,
    `verify=${verify() - before}`,
  );
  if (walletId === undefined) {
    return;
  }

  waiting("b2-enrol");
  const beforeEnrol = verify();
  const heldEnrol = verifyMs();
  await wallet.vault.enrolVerification();
  const snapshot = wallet.getSnapshot();
  // Android enrols presence through BiometricPrompt; iOS creates the
  // Secure-Enclave presence key without a UI ceremony.
  const prompted = verify() > beforeEnrol && verifyMs() - heldEnrol >= 500;
  result(
    "b2-enrol",
    snapshot.verification === "available" &&
      kindSet(snapshot) === "device,hardware" &&
      prompted === (Platform.OS === "android"),
    `factors=${kinds(snapshot)} verify=${verify() - beforeEnrol} vms=${verifyMs() - heldEnrol}`,
  );

  waiting("b2-export");
  const beforeExport = verify();
  const exported = await wallet.wallets.exportMnemonic(walletId, HARDWARE);
  const words = new TextDecoder().decode(exported.mnemonic.read());
  result(
    "b2-export",
    words === MNEMONIC && verify() > beforeExport,
    `verify=${verify() - beforeExport} matches=${words === MNEMONIC}`,
  );
};

const runB3 = async (): Promise<void> => {
  const { wallet, verify } = await open();
  const before = verify();
  await wallet.vault.unlock();
  result(
    "b3-unlock",
    wallet.getSnapshot().vault.status === "unlocked" && verify() === before,
    `verify=${verify() - before}`,
  );

  // The dead hardware row is dropped by the post-unlock probe; give the async
  // commit a few seconds to land in the snapshot.
  const deadline = Date.now() + 15_000;
  let snapshot = wallet.getSnapshot();
  while (
    Date.now() < deadline &&
    !(kinds(snapshot) === "device" && snapshot.verification === "unavailable")
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    snapshot = wallet.getSnapshot();
  }
  result(
    "b3-hardware-dropped",
    kinds(snapshot) === "device" && snapshot.verification === "unavailable",
    `factors=${kinds(snapshot)} verification=${snapshot.verification}`,
  );
};

const runSilent = async (): Promise<void> => {
  const smoke = await open();
  const { wallet, verify } = smoke;
  const before = verify();
  await wallet.vault.unlock();
  const snapshot = wallet.getSnapshot();
  const walletId = snapshot.wallets[0]?.walletId;
  result(
    "silent-unlock",
    snapshot.vault.status === "unlocked" && verify() === before,
    `wallet=${walletId} npub=${snapshot.nostr.keys[0]?.publicKey} verify=${verify() - before}`,
  );
  await sign(smoke.wallet, "silent", walletId);
};

/** Physical-device run: no URL channel, so the snapshot picks the step. */
const runPhys = async (): Promise<void> => {
  const smoke = await open();
  const { wallet, verify } = smoke;
  if (wallet.getSnapshot().vault.status === "uninitialized") {
    waiting("phys-create");
    const before = verify();
    const info = await wallet.wallets.importMnemonic({ mnemonic: MNEMONIC });
    const snapshot = wallet.getSnapshot();
    result(
      "phys-create",
      true,
      `factors=${kinds(snapshot)} appLock=${snapshot.appLock} verification=${snapshot.verification} verify=${verify() - before} wallet=${info.walletId}`,
    );
    await sign(smoke.wallet, "phys", info.walletId);
    await wallet.vault.lock();
    result("phys-lock", wallet.getSnapshot().vault.status === "locked", "");
    return;
  }
  const before = verify();
  await wallet.vault.unlock();
  const snapshot = wallet.getSnapshot();
  result(
    "phys-unlock",
    snapshot.vault.status === "unlocked" && verify() === before,
    `factors=${kinds(snapshot)} verify=${verify() - before}`,
  );
  await sign(smoke.wallet, "phys");
};

export async function sessionSmoke(phase: string): Promise<void> {
  try {
    switch (phase) {
      case "a1":
        await runA1();
        break;
      case "a2":
        await runA2();
        break;
      case "a3":
        await runA3();
        break;
      case "auto":
        await runAuto();
        break;
      case "b1":
        await runB1();
        break;
      case "b2":
        await runB2();
        break;
      case "b3":
        await runB3();
        break;
      case "silent":
        await runSilent();
        break;
      case "phys":
        await runPhys();
        break;
      default:
        result("phase", false, `unknown=${phase}`);
        return;
    }
    result("done", true, `phase=${phase}`);
  } catch (e) {
    result(
      "done",
      false,
      `phase=${phase} error=${e instanceof Error ? `${e.name}:${e.message}` : String(e)}`,
    );
  }
}
