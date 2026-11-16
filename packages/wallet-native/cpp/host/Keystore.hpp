#pragma once

#include <functional>
#include <string>
#include <vector>

#include "../runtime/KernelBuffer.hpp"

namespace qntx {

// The platform keystore behind `__qntx.keystore` (W5): a hardware key per
// vault factor. A `presence` key seals and opens the factor's KEK behind a
// system user verification; a `device` key seals and opens with no UI and is
// the silent unlock factor. iOS: Secure Enclave P-256 + ECIES; Android:
// Keystore AES-256-GCM (presence behind BiometricPrompt). Each function has
// exactly one strong definition per platform (KeystoreIos.mm,
// KeystoreAndroid.cpp); host tests link a fake.

struct KeystorePrompt {
  std::string title;
  std::string description;
};

// Which kind of key a probe is about.
enum class KeyProtection { device, presence };

// How a keystore call ended. The binding maps each status to the kernel's
// error code: cancelled → "cancelled", invalidated → "factor-invalidated",
// unavailable → "unavailable", failed → "unavailable",
// noLockScreen → "verification-unavailable". The values are part of the
// Android JNI contract (Keystore.kt).
enum class KeystoreStatus {
  ok = 0,
  cancelled = 1,
  invalidated = 2,
  unavailable = 3,
  failed = 4,
  noLockScreen = 5,
};

struct KeystoreResult {
  KeystoreStatus status = KeystoreStatus::failed;
  // seal: the platform ciphertext; open: the KEK; empty otherwise.
  SecretBytes bytes;
  // A "<domain>:<code>" diagnostic (e.g. "LAErrorDomain:-5"), empty when none.
  std::string detail;
};

// Completion callbacks run exactly once, on any thread.
using KeystoreDone = std::function<void(KeystoreResult)>;

// Creates the presence key for vault factor `id` and encrypts `secret` under
// it. Android prompts (encryption needs the authenticated cipher); iOS does
// not (ECIES encrypts with the public key).
void keystoreSeal(
    const std::string& id,
    SecretBytes secret,
    KeystorePrompt prompt,
    KeystoreDone done);

// Decrypts `sealed` with factor `id`'s presence key after a fresh system
// verification that shows `prompt`. A key the system removed (lock screen
// disabled, device restored) completes `invalidated`.
void keystoreOpen(
    const std::string& id,
    std::vector<uint8_t> sealed,
    KeystorePrompt prompt,
    KeystoreDone done);

// Creates the device key for vault factor `id` and encrypts `secret` under
// it. Never shows UI.
void keystoreSealDevice(const std::string& id, SecretBytes secret, KeystoreDone done);

// Decrypts `sealed` with factor `id`'s device key. Never shows UI; a gone key
// completes `invalidated`.
void keystoreOpenDevice(const std::string& id, std::vector<uint8_t> sealed, KeystoreDone done);

// Reports `ok` when key `id` is alive and `invalidated` when it is gone for
// good (deleted, permanently invalidated, or — presence — no lock screen).
// Never shows UI; any other outcome is a failure.
void keystoreProbe(const std::string& id, KeyProtection protection, KeystoreDone done);

// Deletes key `id`; a missing key is `ok`. Never shows UI.
void keystoreRemove(const std::string& id, KeystoreDone done);

// A device-owner check with no key involved (vault reset, WD-055).
void keystoreAuthenticate(KeystorePrompt prompt, KeystoreDone done);

// Deletes every vault key this app created.
void keystoreClear(KeystoreDone done);

// Dismisses the system prompt of an in-flight call, if any; that call still
// completes (normally `cancelled`). Called when a kernel runtime tears down.
void keystoreCancel();

// The platform's preferred language as a BCP 47 tag, read natively so the
// main runtime cannot choose the prompt language.
std::string keystoreLocale();

} // namespace qntx
