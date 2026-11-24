#pragma once

#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>

#include "../runtime/KernelBuffer.hpp"

namespace qntx {

// The process-wide hub between kernel `secureInput` requests and the native
// secure-input views (one per mounted field). Typed characters travel view →
// hub → kernel as bytes only; the main runtime sees the view's state, never
// the text. A request is editable only while pending, so every keystroke
// answers a request the kernel actually made. The platform views register a
// sink; the kernel registers a request; the hub matches them under a mutex
// and runs every callback outside the lock.
//
// Submit validation is the guard against a platform bug: accessCode is 1..64
// bytes, each 0x20..0x7E (protocol.md §7.1 — the 6/8 minimums are the card
// module's policy, not this seam's); shortId is exactly 8 bytes of [0-9A-F]
// (protocol.md §1 short ID — the view already uppercases and drops typed
// dashes, this is the recheck); backupPassword is 1..1024 bytes of valid
// UTF-8 (the cloud-backup password — the wire's own bound); sessionApproval
// is exactly 4 bytes of '0'..'9' (the confirmation code the label shows —
// not a secret, the label itself is the protected content).

enum class SecureInputKind { accessCode, shortId, backupPassword, sessionApproval };

// What every registered view shows: a pending request's prompt, or nothing
// (cleared, not editable).
struct SecureInputPrompt {
  SecureInputKind kind;
  std::string label;
};

using SecureInputSink = std::function<void(const std::optional<SecureInputPrompt>&)>;

enum class SecureInputFailure { cancelled, unavailable };

struct SecureInputResult {
  std::optional<SecureInputFailure> failure;
  SecretBytes value; // only when !failure
};

// Runs exactly once per request, on the requesting or a view thread.
using SecureInputDone = std::function<void(SecureInputResult)>;

enum class SecureInputArm {
  armed,
  busySelf,  // this owner already has a pending request
  busyOther, // another owner has one
};

class SecureInputHub {
 public:
  // The process instance; kernel runtimes share it, so at most one input
  // request exists at a time across runtimes.
  static SecureInputHub& shared();

  // Registers a view; calls `sink` once with the current prompt. Only a view
  // attached to a window calls this. Returns the view id for detach/submit.
  uint64_t attach(SecureInputSink sink);
  void detach(uint64_t view);

  // A view's completed input. False when nothing is pending or the bytes are
  // invalid for the kind — the value is dropped (and wiped) either way, and
  // the submitting view is cleared. True completes the request, then clears
  // every view back to idle.
  bool submit(uint64_t view, SecretBytes value);

  // `owner` is the KernelGlobalsState* of the requesting runtime — opaque
  // here, it only distinguishes whose pending request a cancel/release hits.
  SecureInputArm request(
      const void* owner,
      SecureInputKind kind,
      std::string label,
      SecureInputDone done);
  // Completes owner's pending request with `cancelled` and clears the views;
  // a no-op when owner has none.
  void cancel(const void* owner);
  // Drops owner's pending request WITHOUT calling done (runtime teardown) and
  // clears the views.
  void release(const void* owner);

 private:
  struct Pending {
    const void* owner;
    SecureInputKind kind;
    std::string label;
    SecureInputDone done;
  };

  std::mutex mutex_;
  std::unordered_map<uint64_t, SecureInputSink> sinks_;
  std::optional<Pending> pending_;
  uint64_t nextView_ = 0;
};

} // namespace qntx
