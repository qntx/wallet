#include "HybridKernelHost.hpp"

#include "../generated/kernel.hpp"
#include "KernelSha256.hpp"

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

void HybridKernelHost::start() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (runtime_ || exited_) {
      return;
    }
  }
  // Verify before loading: the shipped hbc is only evaluated when its digest
  // matches the constant pinned at build time.
  const std::string actual =
      qntx::kernelSha256Hex(qntx::KERNEL_BYTECODE, qntx::KERNEL_BYTECODE_SIZE);
  if (actual != qntx::KERNEL_SHA256) {
    exit(KernelExitReason::INTEGRITY);
    return;
  }

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
  const auto runtime = qntx::KernelRuntime::start(script, std::move(hooks));
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
  if (listener) {
    listener(reason);
  }
}

} // namespace margelo::nitro::qntxwallet
