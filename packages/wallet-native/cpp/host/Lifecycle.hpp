#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <vector>

namespace qntx {

/**
 * The background-expiry decision: a host whose lock deadline was
 * `backgroundAtMs + seconds*1000` on the sleep-inclusive monotonic clock is
 * expired when nowMs is past it. seconds==0 locks the moment the app
 * backgrounds — the caller never reaches this function for it.
 */
inline bool backgroundExpired(int64_t backgroundAtMs, int64_t nowMs, int seconds) {
  return nowMs >= backgroundAtMs + static_cast<int64_t>(seconds) * 1000;
}

/** Milliseconds on the clock that keeps running while the device sleeps —
 *  Apple CLOCK_MONOTONIC, Android CLOCK_BOOTTIME. */
int64_t sleepInclusiveMonotonicMs();

/** What the platform's lifecycle hooks lock; HybridKernelHost implements it
 *  (exit(BACKGROUND)). The interface keeps the dispatcher testable without a
 *  Nitro runtime. */
class LifecycleLockTarget {
 public:
  virtual ~LifecycleLockTarget() = default;
  virtual void lockForBackground() = 0;
};

/**
 * One process-wide registry of live kernel hosts with their
 * backgroundLockSeconds. `onBackground` stamps every registered host (or locks
 * it immediately when its seconds is 0); `onForeground` locks the hosts whose
 * deadline passed while backgrounded. All calls are main-thread safe and take
 * weak_ptr so a destroyed host is simply skipped.
 */
class KernelLifecycleDispatcher {
 public:
  static KernelLifecycleDispatcher& shared();

  void registerHost(const std::weak_ptr<LifecycleLockTarget>& host, int seconds);
  /** Drop the registration — called on every host exit. */
  void unregister(const LifecycleLockTarget* host);

  void onBackground();
  void onForeground();

  /** Test seam: the clock defaults to sleepInclusiveMonotonicMs. */
  void setClock(std::function<int64_t()> clock);

 private:
  struct Entry {
    std::weak_ptr<LifecycleLockTarget> host;
    int seconds;
    int64_t backgroundAtMs = 0;
  };
  std::mutex mutex_;
  std::vector<Entry> entries_;
  std::function<int64_t()> clock_ = sleepInclusiveMonotonicMs;
};

/** Install the platform's app-lifecycle observer exactly once — NSNotificationCenter
 *  on Apple, ProcessLifecycleOwner on Android. Called from KernelHost.start. */
void installLifecycleObserver();

} // namespace qntx
