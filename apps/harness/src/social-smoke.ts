/**
 * W2b social-mode smoke: runs the real native kernel end to end through
 * `createNativeWallet` — mnemonic create + quiz, Nostr sign + verify, vault
 * lock — then on relaunch proves the vault persisted by unlocking with the
 * password (and rejecting a wrong one). Prints machine-readable
 * `SMOKE_RESULT <name> <ok|fail> <detail>` lines on the console, which Metro/
 * logcat forward like the V1 result lines.
 */
import { AppState } from "react-native";
import { NitroModules } from "react-native-nitro-modules";

import { report } from "@qntx/v1-probe";
import { verifyEvent } from "@qntx/nostr";
import type { AutoLockPolicy, PasskeyConfig, Wallet, WalletSnapshot } from "@qntx/wallet";
import { WalletError } from "@qntx/wallet";
import { nostr } from "@qntx/wallet/nostr";
import { spark } from "@qntx/wallet/spark";
import type { KernelHostLike } from "@qntx/wallet-native";
import { createNativeWallet } from "@qntx/wallet-native";

const PASSKEY: PasskeyConfig = {
  rpId: "harness.local",
  rpName: "Harness",
  walletSalt: "wallet",
  vaultSalt: "vault",
  backupSalt: "backup",
};
// W7: the native host locks the enclave the moment the app backgrounds.
const AUTOLOCK: AutoLockPolicy = { platform: "native", backgroundSeconds: 0 };
const PASSWORD = "smoke-password-1";
const WRONG = "smoke-password-2";

const result = (name: string, ok: boolean, detail: string): void => {
  // The native V1 report channel reaches stderr (iOS) and logcat (Android) on
  // Release builds — a bare console.log would not. detail goes into the
  // "result" field raw, so stringify strings to keep the line valid JSON.
  report(`smoke-${name}`, "release", ok, JSON.stringify(detail));
};

const host = (): KernelHostLike =>
  NitroModules.createHybridObject<KernelHostLike>("KernelHost");

/** Resolve the vault status on a fresh boot — picks create vs unlock phase. */
export async function smokePhase(): Promise<"create" | "unlock"> {
  const wallet = await createNativeWallet({ passkey: PASSKEY, autoLock: AUTOLOCK, host: host() });
  return wallet.getSnapshot().vault === "uninitialized" ? "create" : "unlock";
}

/** First boot: create the vault, run the ceremony, sign, lock. */
export async function smokeCreate(): Promise<void> {
  const wallet = await createNativeWallet({ passkey: PASSKEY, autoLock: AUTOLOCK, host: host() });
  const draft = await wallet.wallets.createMnemonic({
    words: 12,
    factor: { kind: "password", password: PASSWORD },
  });
  const words = new TextDecoder().decode(draft.words.read()).split(" ");
  const { walletId } = await draft.confirm(draft.quiz.map((i) => words[i]!));

  const api = nostr(wallet);
  const key = await api.deriveKey(walletId, 0);
  const event = await api.signer(key.ref).signEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: "w2b social smoke",
    pubkey: key.publicKey,
  });
  result("create-sign", verifyEvent(event), `wallet=${walletId} pubkey=${key.publicKey}`);
  await wallet.vault.lock();
  result("lock", wallet.getSnapshot().vault === "locked", "");
}

/** Relaunch: the persisted vault must unlock with the password and reject a wrong one. */
export async function smokeUnlock(): Promise<void> {
  const walletWrong = await createNativeWallet({ passkey: PASSKEY, autoLock: AUTOLOCK, host: host() });
  let wrongRejected = false;
  try {
    await walletWrong.vault.unlock({ kind: "password", password: WRONG });
  } catch (error) {
    wrongRejected = error instanceof WalletError && error.code === "wrong-password";
  }
  result("unlock-wrong", wrongRejected, "");

  const wallet = await createNativeWallet({ passkey: PASSKEY, autoLock: AUTOLOCK, host: host() });
  await wallet.vault.unlock({ kind: "password", password: PASSWORD });
  const snapshot = wallet.getSnapshot();
  const walletId = snapshot.wallets[0]?.walletId;
  result(
    "unlock-persisted",
    snapshot.vault === "unlocked" && walletId !== undefined,
    `wallets=${snapshot.wallets.length}`,
  );
  if (walletId === undefined) {
    return;
  }
  // The persisted key must still sign: the key record from run 1 lives in the
  // snapshot's nostr section (deriveKey would refuse it as already-exists).
  const api = nostr(wallet);
  const key = snapshot.nostr.keys[0];
  if (key === undefined) {
    result("persisted-sign", false, "no persisted nostr key");
    return;
  }
  const event = await api.signer(key.ref).signEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: "w2b social smoke relaunch",
    pubkey: key.publicKey,
  });
  result("persisted-sign", verifyEvent(event), `wallet=${walletId} pubkey=${key.publicKey}`);

  // W4a: newCommitments drives crypto.frostCommit through the native qs_*
  // bridge — the backend answers without any network access.
  const commitments = await spark(wallet)
    .signer({ walletId, groupIndex: 0, network: "regtest" })
    .newCommitments(1);
  const commitment = commitments[0];
  result(
    "spark-backend",
    commitments.length === 1 &&
      commitment !== undefined &&
      commitment.hiding.length === 33 &&
      commitment.binding.length === 33,
    `commitments=${commitments.length}`,
  );

  // W7: armed at backgroundSeconds=0 — backgrounding locks the enclave at the
  // platform layer; foreground must reveal vault=locked with the real reason.
  result("background-armed", true, "");
  const bg = await waitBackgroundLock(wallet);
  result(
    "background-lock",
    bg.vault === "locked" && bg.lockReason === "background",
    `vault=${bg.vault} reason=${String(bg.lockReason)}`,
  );
}

/** Waits for the driver to send the app to background and back; resolves the
 *  snapshot once AppState returns to "active" (or the current snapshot when
 *  the lock has already landed). Fails after 120 s. */
const waitBackgroundLock = async (wallet: Wallet): Promise<WalletSnapshot> => {
  const deadline = Date.now() + 120_000;
  let sawBackground = false;
  while (Date.now() < deadline) {
    const state = AppState.currentState;
    if (state === "background" || state === "inactive") {
      sawBackground = true;
    }
    const snapshot = wallet.getSnapshot();
    if (
      sawBackground &&
      state === "active" &&
      snapshot.vault === "locked" &&
      snapshot.lockReason === "background"
    ) {
      return snapshot;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  return wallet.getSnapshot();
};
