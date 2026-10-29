#pragma once

#include "HybridKernelHostSpec.hpp"

#include <functional>
#include <memory>
#include <mutex>

#include "Lifecycle.hpp"

#include "../runtime/KernelRuntime.hpp"

namespace margelo::nitro::qntxwallet {

// The only Nitro-registered object: drives one kernel runtime. `start`
// verifies the embedded bytecode's SHA-256 before loading; `post` enforces the
// 1 MiB frame cap (the inbound queue cap lives inside KernelRuntime::post and
// reports through the same integrity exit); `lock` destroys the runtime. Exit
// reasons reach JS through the `onExit` listener, at most once.
class HybridKernelHost final : public HybridKernelHostSpec,
                               public qntx::LifecycleLockTarget {
 public:
  HybridKernelHost() : HybridObject(TAG) {}
  ~HybridKernelHost() override;

  void start(double backgroundLockSeconds) override;
  // The platform's lifecycle dispatcher locks through here (main thread).
  void lockForBackground() override { exit(KernelExitReason::BACKGROUND); }
  void post(const std::shared_ptr<ArrayBuffer>& frame) override;
  void onMessage(const std::function<void(const std::shared_ptr<ArrayBuffer>&)>& listener)
      override;
  void onExit(const std::function<void(KernelExitReason)>& listener) override;
  void lock() override;

 private:
  static constexpr size_t kMaxFrameBytes = 1024 * 1024;

  // Reports `reason` through onExit once, then tears the runtime down unless
  // the exit was itself the lock report (the runtime is already gone).
  void exit(KernelExitReason reason);

  std::mutex mutex_;
  std::shared_ptr<qntx::KernelRuntime> runtime_;
  std::function<void(const std::shared_ptr<ArrayBuffer>&)> messageListener_;
  std::function<void(KernelExitReason)> exitListener_;
  bool exited_ = false;
};

} // namespace margelo::nitro::qntxwallet
