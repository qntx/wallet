/**
 * Consumer smoke (Release): create a hardware-factor vault through the published
 * `@qntx/wallet-native` entry, sign a nostr event through the kernel, verify it in plain JS, lock,
 * and report via a file in the app container — `console.log` does not reach the host reliably on
 * Release builds.
 */
import { File, Paths } from "expo-file-system";
import { NitroModules } from "react-native-nitro-modules";

import { verifyEvent } from "@qntx/nostr";
import type { AutoLockPolicy, PasskeyConfig } from "@qntx/wallet";
import type { KernelHostLike } from "@qntx/wallet-native";
import { createNativeWallet } from "@qntx/wallet-native";
import { nostr } from "@qntx/wallet/nostr";

const PASSKEY: PasskeyConfig = {
  rpId: "wallet-consumer.qntx.org",
  rpName: "Wallet Consumer",
  walletSalt: "wallet",
  vaultSalt: "vault",
  backupSalt: "backup",
};
const AUTOLOCK: AutoLockPolicy = { platform: "native", backgroundSeconds: 60 };

const host = (): KernelHostLike => NitroModules.createHybridObject<KernelHostLike>("KernelHost");

type Step = { readonly name: string; readonly ok: boolean; readonly detail: string };

export async function runConsumerSmoke(): Promise<void> {
  const steps: Step[] = [];
  const record = (name: string, ok: boolean, detail = ""): void => {
    steps.push({ name, ok, detail });
  };
  try {
    const wallet = await createNativeWallet({
      passkey: PASSKEY,
      autoLock: AUTOLOCK,
      host: host(),
    });
    const draft = await wallet.wallets.createMnemonic({ words: 12 });
    const words = new TextDecoder().decode(draft.words.read()).split(" ");
    const { walletId } = await draft.confirm(draft.quiz.map((i) => words[i]!));
    record("create", walletId.length > 0, `wallet=${walletId}`);
    record(
      "hardware-factor",
      wallet
        .getSnapshot()
        .factors.map((f) => f.kind)
        .join(",") === "hardware",
    );
    const api = nostr(wallet);
    const key = await api.deriveKey(walletId, 0);
    const event = await api.signer(key.ref).signEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: "consumer smoke",
      pubkey: key.publicKey,
    });
    record("sign-verify", verifyEvent(event), `pubkey=${key.publicKey}`);
    await wallet.vault.lock();
    record("lock", wallet.getSnapshot().vault === "locked");
  } catch (error) {
    record(
      "error",
      false,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
  const body = JSON.stringify({
    ok: steps.length > 0 && steps.every((s) => s.ok),
    steps,
  });
  await new File(Paths.document, "consumer-result.json").write(body);
}
