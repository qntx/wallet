/**
 * W2b social-mode smoke: runs the real native kernel end to end through
 * `createNativeWallet` — mnemonic create + quiz, Nostr sign + verify, vault
 * lock — then on relaunch proves the vault persisted by unlocking with the
 * password (and rejecting a wrong one). Prints machine-readable
 * `SMOKE_RESULT <name> <ok|fail> <detail>` lines on the console, which Metro/
 * logcat forward like the V1 result lines.
 */
import { NitroModules } from "react-native-nitro-modules";

import { report } from "@qntx/v1-probe";
import { verifyEvent } from "@qntx/nostr";
import type { AutoLockPolicy, PasskeyConfig } from "@qntx/wallet";
import { WalletError } from "@qntx/wallet";
import { nostr } from "@qntx/wallet/nostr";
import { createNativeWallet } from "@qntx/wallet-native";

import type { KernelHost } from "@qntx/wallet-native/src/specs/kernel-host.nitro.ts";

const PASSKEY: PasskeyConfig = {
  rpId: "harness.local",
  rpName: "Harness",
  walletSalt: "wallet",
  vaultSalt: "vault",
  backupSalt: "backup",
};
const AUTOLOCK: AutoLockPolicy = { platform: "native", backgroundSeconds: 60 };
const PASSWORD = "smoke-password-1";
const WRONG = "smoke-password-2";

const result = (name: string, ok: boolean, detail: string): void => {
  // The native V1 report channel reaches stderr (iOS) and logcat (Android) on
  // Release builds — a bare console.log would not.
  report(`smoke-${name}`, "release", ok, detail);
};

const host = (): KernelHost => NitroModules.createHybridObject<KernelHost>("KernelHost");

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
  // The persisted key must still sign: same wallet, same index 0 derivation as
  // the create run — compare pubkeys across the two launches' result lines.
  const api = nostr(wallet);
  const key = await api.deriveKey(walletId, 0);
  const event = await api.signer(key.ref).signEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: "w2b social smoke relaunch",
    pubkey: key.publicKey,
  });
  result("persisted-sign", verifyEvent(event), `wallet=${walletId} pubkey=${key.publicKey}`);
}
