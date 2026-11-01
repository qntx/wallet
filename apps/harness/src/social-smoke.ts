/**
 * Social-mode smoke on the hardware factor (W5): runs the real native kernel
 * end to end through `createNativeWallet` — mnemonic create + quiz (the
 * hardware key is created at confirm), Nostr sign + verify, vault lock — then
 * on relaunch drives the system verification: the first unlock prompt must be
 * cancelled by the tester (`cancelled`, vault stays locked), the second
 * approved; the mnemonic export and an EVM transfer each show their own
 * kernel-written prompt. Prints machine-readable result lines through the V1
 * report channel.
 */
import { AppState, Platform } from "react-native";
import { NitroModules } from "react-native-nitro-modules";

import { report } from "@qntx/v1-probe";
import { verifyEvent } from "@qntx/nostr";
import type { AutoLockPolicy, PasskeyConfig, Wallet, WalletSnapshot } from "@qntx/wallet";
import { WalletError } from "@qntx/wallet";
import { chains } from "@qntx/wallet/chains";
import { nostr } from "@qntx/wallet/nostr";
import { spark } from "@qntx/wallet/spark";
import type { KernelHostLike } from "@qntx/wallet-native";
import { createNativeWallet } from "@qntx/wallet-native";

const PASSKEY: PasskeyConfig = {
  // Served by apps/harness/relying-party (AASA + assetlinks for this app).
  rpId: "wallet-harness.qntx.org",
  rpName: "QNTX Wallet Harness",
  walletSalt: "wallet",
  vaultSalt: "vault",
  backupSalt: "backup",
};
// W7: the native host locks the enclave the moment the app backgrounds.
// A system verification sheet must not count as backgrounding: every prompt
// below runs with this policy armed.
const AUTOLOCK: AutoLockPolicy = { platform: "native", backgroundSeconds: 0 };
const HARDWARE = { kind: "hardware" } as const;

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
  const draft = await wallet.wallets.createMnemonic({ words: 12 });
  const words = new TextDecoder().decode(draft.words.read()).split(" ");
  const { walletId } = await draft.confirm(draft.quiz.map((i) => words[i]!));
  result(
    "hardware-factor",
    wallet.getSnapshot().factors.map((f) => f.kind).join(",") === "hardware",
    "",
  );

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

/** Relaunch: cancel the first unlock prompt, approve the second, then the guarded prompts. */
export async function smokeUnlock(): Promise<void> {
  const wallet = await createNativeWallet({ passkey: PASSKEY, autoLock: AUTOLOCK, host: host() });
  let cancelled = false;
  let outcome = "approved";
  try {
    await wallet.vault.unlock();
  } catch (error) {
    outcome = error instanceof WalletError ? error.code : String(error);
    if (error instanceof WalletError && error.code === "factor-invalidated") {
      // The hardware key is gone (lock screen removed, device restored): the
      // recovery entry is a device-owner-verified reset; the next launch
      // creates a fresh vault.
      result("factor-invalidated", true, "");
      await wallet.vault.reset();
      result("recovery-reset", wallet.getSnapshot().vault === "uninitialized", "");
      return;
    }
    cancelled = error instanceof WalletError && error.code === "cancelled";
  }
  result(
    "unlock-cancelled",
    cancelled && wallet.getSnapshot().vault === "locked",
    `outcome=${outcome}`,
  );

  await wallet.vault.unlock();
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

  // W4b: 100 event signs through the native Nostr backend, each verified —
  // the timing is the number the N-V1 decision asked for.
  const signer = api.signer(key.ref);
  const started = Date.now();
  let verified = 0;
  for (let i = 0; i < 100; i += 1) {
    const signed = await signer.signEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: `w4b nostr bench ${i}`,
      pubkey: key.publicKey,
    });
    if (verifyEvent(signed)) {
      verified += 1;
    }
  }
  result("nostr-bench", verified === 100, `verified=${verified} ms=${Date.now() - started}`);

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

  // W5 re-verification: one prompt for the export, one for an EVM transfer
  // whose prompt text the kernel renders from its own decode.
  const exported = await wallet.wallets.exportMnemonic(walletId, HARDWARE);
  const exportedWords = new TextDecoder().decode(exported.read()).split(" ").length;
  result("export-verified", exportedWords === 12, `words=${exportedWords}`);
  const signed = await chains(wallet).sign({
    request: {
      kind: "evm.transaction",
      network: "eip155:1",
      account: { kind: "hd", walletId, groupIndex: 0, template: "evm.bip44" },
      tx: {
        type: "eip1559",
        chainId: 1,
        nonce: 0,
        gas: "0x5208",
        value: "0xb1a2bc2ec50000",
        data: "0x",
        to: "0x00000000000000000000000000000000DeaDBeef",
        maxFeePerGas: "0x59682f00",
        maxPriorityFeePerGas: "0x1",
        accessList: [],
      },
    },
    verify: HARDWARE,
  });
  result("chain-verified", signed.kind === "evm.transaction", "");

  await smokePasskey(wallet);

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

/**
 * W6 native passkeys, run by the kernel itself: create a passkey wallet, protect the backup with
 * a passkey, delete the wallet and restore it from the passkey — the same walletId must come
 * back. iOS has no native passkey bridge yet (W6c), so it must report factor-unavailable.
 */
async function smokePasskey(wallet: Wallet): Promise<void> {
  if (Platform.OS !== "android") {
    let unavailable = false;
    try {
      await wallet.wallets.createWithPasskey({ name: "QNTX Harness" });
    } catch (error) {
      unavailable = error instanceof WalletError && error.code === "factor-unavailable";
    }
    result("passkey-unavailable", unavailable, "");
    return;
  }
  const created = await wallet.wallets.createWithPasskey({ name: "QNTX Harness" });
  result("passkey-create", created.origin === "passkey", `backup=${created.backup}`);
  await wallet.backup.enable({ verify: HARDWARE, factors: [{ kind: "passkey" }] });
  result("passkey-backup", true, "");
  await wallet.wallets.delete(created.walletId, HARDWARE);
  const restored = await wallet.wallets.restoreWithPasskey();
  result("passkey-restore", restored.walletId === created.walletId, "");
}
