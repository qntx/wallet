#pragma once

#include <string>
#include <vector>

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

} // namespace qntxTestCardReader
