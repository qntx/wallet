// Test-only platform lifecycle: the host build has no platform TU, so this
// file supplies sleepInclusiveMonotonicMs + installLifecycleObserver with a
// steady clock. The dispatcher test injects its own clock via setClock, so the
// monotonic impl is only needed to satisfy the linker (and for the same reason
// installLifecycleObserver is a no-op — no platform to observe).
#include "../../cpp/host/Lifecycle.hpp"

#include <chrono>

namespace qntx {

int64_t sleepInclusiveMonotonicMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

void installLifecycleObserver() {}

} // namespace qntx
