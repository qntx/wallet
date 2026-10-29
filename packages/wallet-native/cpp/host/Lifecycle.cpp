#include "Lifecycle.hpp"

#if !defined(__APPLE__) && !defined(__ANDROID__)
#include <chrono>
#endif

namespace qntx {

#if !defined(__APPLE__) && !defined(__ANDROID__)
// Host-test fallback: the dispatcher's clock is always injected in tests, so
// this definition only satisfies the linker.
int64_t sleepInclusiveMonotonicMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}
#endif

KernelLifecycleDispatcher& KernelLifecycleDispatcher::shared() {
  static KernelLifecycleDispatcher dispatcher;
  return dispatcher;
}

void KernelLifecycleDispatcher::registerHost(
    const std::weak_ptr<LifecycleLockTarget>& host, int seconds) {
  std::lock_guard<std::mutex> lock(mutex_);
  entries_.push_back(Entry{host, seconds, 0});
}

void KernelLifecycleDispatcher::unregister(const LifecycleLockTarget* host) {
  std::lock_guard<std::mutex> lock(mutex_);
  std::erase_if(entries_, [&](const Entry& entry) {
    const auto target = entry.host.lock();
    return !target || target.get() == host;
  });
}

void KernelLifecycleDispatcher::onBackground() {
  std::vector<std::shared_ptr<LifecycleLockTarget>> immediate;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto now = clock_();
    for (auto& entry : entries_) {
      const auto host = entry.host.lock();
      if (!host) {
        continue;
      }
      if (entry.seconds == 0) {
        immediate.push_back(host);
      } else {
        entry.backgroundAtMs = now;
      }
    }
  }
  // Lock outside the registry mutex — the target's own lock may re-enter here
  // (unregister on exit).
  for (const auto& host : immediate) {
    host->lockForBackground();
  }
}

void KernelLifecycleDispatcher::onForeground() {
  std::vector<std::shared_ptr<LifecycleLockTarget>> expired;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto now = clock_();
    for (auto& entry : entries_) {
      const auto host = entry.host.lock();
      if (!host) {
        continue;
      }
      if (entry.backgroundAtMs != 0 &&
          backgroundExpired(entry.backgroundAtMs, now, entry.seconds)) {
        expired.push_back(host);
      }
      entry.backgroundAtMs = 0;
    }
  }
  for (const auto& host : expired) {
    host->lockForBackground();
  }
}

void KernelLifecycleDispatcher::setClock(std::function<int64_t()> clock) {
  std::lock_guard<std::mutex> lock(mutex_);
  clock_ = std::move(clock);
}

} // namespace qntx
