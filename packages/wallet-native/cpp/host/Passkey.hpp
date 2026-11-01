#pragma once

#include <functional>
#include <string>

namespace qntx {

// The platform passkey authenticator behind `__qntx.passkey` (W6). The kernel
// builds the WebAuthn request JSON and parses the response JSON itself; the
// platform only runs the system ceremony. Android: Credential Manager. iOS:
// not yet available (W6c needs an associated domain) — every call completes
// `unavailable`. Each function has exactly one strong definition per platform
// (PasskeyAndroid.cpp, PasskeyIos.mm); host tests link a fake.

// The binding maps each status to the kernel's error code: cancelled →
// "cancelled", unavailable → "factor-unavailable", failed → "unavailable".
// The values are part of the Android JNI contract (Passkey.kt).
enum class PasskeyStatus { ok = 0, cancelled = 1, unavailable = 3, failed = 4 };

struct PasskeyResult {
  PasskeyStatus status = PasskeyStatus::failed;
  // The WebAuthn registration or authentication response JSON on success.
  std::string responseJson;
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
