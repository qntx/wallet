#include "HybridKernelHost.hpp"

#include "kernel.hpp"
#include "VaultDirectory.hpp"

#if defined(__ANDROID__)
#include <android/log.h>
#elif defined(__APPLE__)
#include <os/log.h>
#endif

namespace margelo::nitro::qntxwallet {

namespace {

// A kernel crash reaches JS only as "crashed"; the fact goes to the system log
// so field reports can tell crashes apart. The reason can carry third-party
// error text or an unhandled rejection's message, so it is private on iOS
// (redacted unless a debugger or profile unlocks it) and debug-only on
// Android, whose logcat has no redaction.
void logKernelCrash(const std::string& reason) {
#if defined(__ANDROID__)
#ifdef NDEBUG
  (void)reason;
  __android_log_print(ANDROID_LOG_ERROR, "QntxKernel", "kernel runtime crashed");
#else
  __android_log_print(ANDROID_LOG_ERROR, "QntxKernel", "kernel runtime crashed: %s", reason.c_str());
#endif
#elif defined(__APPLE__)
  os_log_error(OS_LOG_DEFAULT, "qntx kernel runtime crashed: %{private}s", reason.c_str());
#else
  (void)reason;
#endif
}

// Compare as doubles before converting: casting NaN or an out-of-range value
// to int is undefined behaviour.
int validBackgroundSeconds(double value) {
  if (value != 0 && value != 60 && value != 300 && value != 900) {
    throw std::runtime_error("backgroundLockSeconds must be one of 0, 60, 300, 900");
  }
  return static_cast<int>(value);
}

} // namespace

HybridKernelHost::~HybridKernelHost() {
  std::shared_ptr<qntx::KernelRuntime> runtime;
  qntx::KernelSlot::Claim claim;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    runtime = std::move(runtime_);
    claim = std::move(slotClaim_);
  }
  if (runtime) {
    runtime->destroy();
  }
  claim.release(runtime);
}

void HybridKernelHost::start(double backgroundLockSeconds) {
  const int seconds = validBackgroundSeconds(backgroundLockSeconds);
  qntx::KernelSlot::Claim claim;
  std::shared_ptr<qntx::KernelRuntime> predecessor;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (runtime_ || exited_) {
      return;
    }
    // One live kernel runtime per process: a second start throws, so two
    // kernels can never write the same vault file.
    claim = qntx::KernelSlot::shared().claim();
    predecessor = claim.predecessor();
  }
  try {
    startRuntime(seconds, claim, predecessor);
  } catch (...) {
    // Nothing runs: drop the lifecycle registration, and free the slot naming
    // the predecessor again — it may still be stopping, and the next start must
    // wait it out exactly as this one would have.
    qntx::KernelLifecycleDispatcher::shared().unregister(this);
    claim.release(predecessor);
    throw;
  }
}

void HybridKernelHost::startRuntime(
    int seconds,
    qntx::KernelSlot::Claim& claim,
    const std::shared_ptr<qntx::KernelRuntime>& predecessor) {
  // The platform observer installs once; this host registers its deadline so
  // the dispatcher can stamp or lock it on background/foreground transitions.
  qntx::installLifecycleObserver();
  qntx::KernelLifecycleDispatcher::shared().registerHost(
      std::dynamic_pointer_cast<HybridKernelHost>(shared_from_this()), seconds);
  // Resolved once here: a platform failure rejects start() for the JS caller
  // instead of surfacing later as a store error inside the kernel.
  const std::string vaultDirectory = qntx::platformVaultDirectory();

  std::weak_ptr<HybridKernelHost> weak =
      std::dynamic_pointer_cast<HybridKernelHost>(shared_from_this());
  qntx::KernelRuntime::Hooks hooks;
  hooks.beforeEvaluate = [predecessor](facebook::jsi::Runtime&) {
    // The predecessor's runtime may still be tearing down: wait on this kernel
    // thread — never the JS thread — so the first file read follows its last
    // write. The wait has no deadline: a predecessor is itself held here until
    // its own predecessor stopped, so the wait covers the whole chain of
    // stopping runtimes, and giving up would either let two writers overlap or
    // leave the session dead until the app restarts.
    if (predecessor != nullptr) {
      while (!predecessor->waitUntilStopped(std::chrono::seconds(1))) {
      }
    }
  };
  hooks.onPost = [weak](qntx::SecretBytes bytes) {
    if (const auto self = weak.lock()) {
      std::function<void(const std::shared_ptr<ArrayBuffer>&)> listener;
      {
        std::lock_guard<std::mutex> lock(self->mutex_);
        listener = self->messageListener_;
      }
      if (listener) {
        // The listener's ArrayBuffer is a fresh copy — `bytes` wipes itself on
        // scope exit whether the listener ran or not.
        listener(ArrayBuffer::copy(bytes.data(), bytes.size()));
      }
    }
  };
  hooks.onError = [weak](std::string reason) {
    logKernelCrash(reason);
    if (const auto self = weak.lock()) {
      self->exit(KernelExitReason::CRASHED);
    }
  };
  hooks.onIntegrity = [weak] {
    if (const auto self = weak.lock()) {
      self->exit(KernelExitReason::INTEGRITY);
    }
  };

  const auto script = qntx::KernelScript{
      qntx::KernelScript::Kind::bytecode,
      std::make_shared<const std::vector<uint8_t>>(
          qntx::KERNEL_BYTECODE, qntx::KERNEL_BYTECODE + qntx::KERNEL_BYTECODE_SIZE)};
  const auto runtime =
      qntx::KernelRuntime::start(script, std::move(hooks), vaultDirectory);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (exited_) {
      // An exit raced start — drop the fresh runtime instead of resurrecting
      // a dead host, and release the slot naming it as the still-stopping
      // predecessor for the next start.
      runtime->destroy();
      claim.release(runtime);
      return;
    }
    runtime_ = runtime;
    slotClaim_ = std::move(claim);
  }
}

void HybridKernelHost::post(const std::shared_ptr<ArrayBuffer>& frame) {
  if (frame->size() > kMaxFrameBytes) {
    exit(KernelExitReason::INTEGRITY);
    return;
  }
  std::shared_ptr<qntx::KernelRuntime> runtime;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    runtime = runtime_;
  }
  if (runtime) {
    const auto* data = static_cast<const uint8_t*>(frame->data());
    runtime->post(qntx::SecretBytes(data, frame->size()));
  }
}

void HybridKernelHost::onMessage(
    const std::function<void(const std::shared_ptr<ArrayBuffer>&)>& listener) {
  std::lock_guard<std::mutex> lock(mutex_);
  messageListener_ = listener;
}

void HybridKernelHost::onExit(const std::function<void(KernelExitReason)>& listener) {
  std::lock_guard<std::mutex> lock(mutex_);
  exitListener_ = listener;
}

void HybridKernelHost::setBackgroundLock(double backgroundLockSeconds) {
  const int seconds = validBackgroundSeconds(backgroundLockSeconds);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!runtime_ || exited_) {
      return;
    }
  }
  qntx::KernelLifecycleDispatcher::shared().update(this, seconds);
}

void HybridKernelHost::lock() {
  exit(KernelExitReason::LOCKED);
}

void HybridKernelHost::exit(KernelExitReason reason) {
  std::shared_ptr<qntx::KernelRuntime> runtime;
  qntx::KernelSlot::Claim claim;
  std::function<void(KernelExitReason)> listener;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (exited_) {
      return;
    }
    exited_ = true;
    runtime = std::move(runtime_);
    claim = std::move(slotClaim_);
    listener = exitListener_;
  }
  if (runtime) {
    runtime->destroy();
  }
  // The slot frees for a successor here — the still-stopping runtime becomes
  // its predecessor, which it waits out on its kernel thread before
  // evaluating.
  claim.release(runtime);
  qntx::KernelLifecycleDispatcher::shared().unregister(this);
  if (listener) {
    listener(reason);
  }
}

} // namespace margelo::nitro::qntxwallet
