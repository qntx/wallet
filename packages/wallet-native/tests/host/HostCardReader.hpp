#pragma once

#include <string>
#include <vector>

#include "host/CardReader.hpp"

namespace qntxTestCardReader {

struct Close {
  bool success;
  std::string text;
};

// Forget held completions, prompts, closes and call counts.
void reset();
// Every close(success, text) the fake has seen, in order.
std::vector<Close> closes();
// The prompt of the most recent open.
std::string lastPrompt();
// open calls so far.
int opens();
// transmit calls so far — a transmit that completed on the kernel side
// without reaching the platform leaves this unchanged.
int transmits();
// Fires one held completion ("hold" open / 0xEF transmit) on a detached
// thread; false when nothing is held.
bool fireHeld();
// Same, but completes with the given result instead of the held one —
// for stale-completion tests that pick the old call's answer.
bool fireHeldAs(qntx::CardReaderResult result);

} // namespace qntxTestCardReader
