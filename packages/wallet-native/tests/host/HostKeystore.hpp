#pragma once

#include <string>
#include <vector>

#include "host/Keystore.hpp"

namespace qntxTestKeystore {

struct Call {
  std::string op; // seal | open | authenticate | clear
  std::string id;
  std::string title;
  std::string description;
  size_t bytes = 0;
};

// Every platform call so far, in order.
std::vector<Call> calls();
// Forget calls, keys, scripts, cancels and any held completion.
void reset();
// A prompt titled "fail:cancelled", "fail:invalidated", "fail:unavailable" or
// "fail:failed" completes with that status instead of succeeding.
// The next call's completion is held until `cancel` or `releaseHeld`.
void holdNext();
// Completes a held call (success, or its scripted failure) on a background
// thread; false when nothing is held.
bool releaseHeld();
// keystoreCancel invocations.
int cancels();

} // namespace qntxTestKeystore
