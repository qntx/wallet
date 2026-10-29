#include "HybridKernelHost.hpp"

#include "kernel.hpp"
#include "VaultDirectory.hpp"

namespace margelo::nitro::qntxwallet {

HybridKernelHost::~HybridKernelHost() {
  std::shared_ptr<qntx::KernelRuntime> runtime;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    runtime = std::move(runtime_);
  }
  if (runtime) {
    runtime->destroy();
  }
}

void HybridKernelHost::start(double backgroundLockSeconds) {
  // Compare as doubles before converting: casting NaN or an out-of-range value
  // to int is undefined behaviour.
  if (backgroundLockSeconds != 0 && backgroundLockSeconds != 60 &&
      backgroundLockSeconds != 300 && backgroundLockSeconds != 900) {
    throw std::runtime_error("backgroundLockSeconds must be one of 0, 60, 300, 900");
  }
  const int seconds = static_cast<int>(backgroundLockSeconds);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (runtime_ || exited_) {
      return;
    }
  }
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
  hooks.onPost = [weak](std::vector<uint8_t> bytes) {
    if (const auto self = weak.lock()) {
      std::function<void(const std::shared_ptr<ArrayBuffer>&)> listener;
      {
        std::lock_guard<std::mutex> lock(self->mutex_);
        listener = self->messageListener_;
      }
      if (listener) {
        listener(ArrayBuffer::copy(bytes.data(), bytes.size()));
      }
    }
  };
  hooks.onError = [weak](std::string) {
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
      // An exit (integrity hash check raced a lock) already fired — drop the
      // fresh runtime instead of resurrecting a dead host.
      runtime->destroy();
      return;
    }
    runtime_ = runtime;
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
    runtime->post(std::vector<uint8_t>(data, data + frame->size()));
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

void HybridKernelHost::lock() {
  exit(KernelExitReason::LOCKED);
}

void HybridKernelHost::exit(KernelExitReason reason) {
  std::shared_ptr<qntx::KernelRuntime> runtime;
  std::function<void(KernelExitReason)> listener;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (exited_) {
      return;
    }
    exited_ = true;
    runtime = std::move(runtime_);
    listener = exitListener_;
  }
  if (runtime) {
    runtime->destroy();
  }
  qntx::KernelLifecycleDispatcher::shared().unregister(this);
  if (listener) {
    listener(reason);
  }
}

} // namespace margelo::nitro::qntxwallet
