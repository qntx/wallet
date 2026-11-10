#pragma once

#include <functional>
#include <string>

#include "../runtime/KernelBuffer.hpp"

namespace qntx {

// The platform passkey authenticator behind `__qntx.passkey` (W6). The kernel
// builds the WebAuthn request JSON and parses the response JSON itself; the
// platform only runs the system ceremony. Android: Credential Manager. iOS
// (W6c): ASAuthorization platform passkeys with the PRF extension on iOS 18+,
// unavailable below or without the associated domain. Each function has
// exactly one strong definition per platform (PasskeyAndroid.cpp,
// PasskeyIos.mm); host tests link a fake.

// The binding maps each status to the kernel's error code: cancelled →
// "cancelled", unavailable → "unavailable", failed → "unavailable",
// notConfigured → "passkey-not-configured", unsupported → "unsupported". The
// values are part of the Android JNI contract (Passkey.kt).
enum class PasskeyStatus {
  ok = 0,
  cancelled = 1,
  unavailable = 3,
  failed = 4,
  notConfigured = 5,
  unsupported = 6,
};

struct PasskeyResult {
  PasskeyStatus status = PasskeyStatus::failed;
  // The WebAuthn registration or authentication response JSON on success.
  std::string responseJson;
  // A "<domain>:<code>" diagnostic (e.g. "ASAuthorizationErrorDomain:1004").
  std::string detail;
  // The PRF outputs, which for a passkey wallet are the wallet entropy: delivered as wiped bytes,
  // never inside `responseJson`, and empty when the platform returned none. iOS fills them;
  // Android's Credential Manager returns PRF results only inside its response JSON string (a
  // platform limit), so there they stay empty and the kernel reads the JSON.
  SecretBytes prfFirst;
  SecretBytes prfSecond;
};

// Completion callbacks run exactly once, on any thread.
using PasskeyDone = std::function<void(PasskeyResult)>;

// Registers a discoverable credential from PublicKeyCredentialCreationOptions JSON.
void passkeyCreate(std::string requestJson, PasskeyDone done);

// Asserts a credential from PublicKeyCredentialRequestOptions JSON.
void passkeyGet(std::string requestJson, PasskeyDone done);

// Dismisses the system UI of an in-flight ceremony, if any; that call still
// completes (normally `cancelled`). Called when a kernel runtime tears down.
void passkeyCancel();

} // namespace qntx
