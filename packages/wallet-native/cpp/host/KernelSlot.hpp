#pragma once

#include <memory>
#include <mutex>
#include <stdexcept>

namespace qntx {

class KernelRuntime;

// One live kernel runtime per process: at most one Claim is outstanding, so
// two hosts can never run two kernels over the same vault file. The holder
// releases the slot when its runtime exits or is destroyed, handing the
// still-stopping runtime to the next claim as its predecessor — the successor
// waits on it (KernelRuntime::waitUntilStopped) inside Hooks.beforeEvaluate,
// so the successor's first file read follows the predecessor's last write and
// the JS thread never blocks.
class KernelSlot {
 public:
  KernelSlot() = default;
  KernelSlot(const KernelSlot&) = delete;
  KernelSlot& operator=(const KernelSlot&) = delete;

  // RAII admission token: while one is alive, claim() throws. Destruction
  // frees the slot with no predecessor; holders call release() instead, which
  // names their still-stopping runtime for the next claim.
  class Claim {
   public:
    Claim() = default;
    ~Claim() {
      release(nullptr);
    }
    Claim(Claim&& other) noexcept
        : slot_(other.slot_), predecessor_(std::move(other.predecessor_)) {
      other.slot_ = nullptr;
    }
    Claim& operator=(Claim&& other) noexcept {
      if (this != &other) {
        release(nullptr);
        slot_ = other.slot_;
        predecessor_ = std::move(other.predecessor_);
        other.slot_ = nullptr;
      }
      return *this;
    }
    Claim(const Claim&) = delete;
    Claim& operator=(const Claim&) = delete;

    // The runtime the previous holder left stopping, or nullptr.
    const std::shared_ptr<KernelRuntime>& predecessor() const {
      return predecessor_;
    }

    // Free the slot; `stopping` — the holder's runtime mid-teardown, or
    // nullptr — becomes the predecessor the next claim must wait out before
    // evaluating its script.
    void release(std::shared_ptr<KernelRuntime> stopping) {
      KernelSlot* slot = slot_;
      if (slot == nullptr) {
        return;
      }
      slot_ = nullptr;
      predecessor_.reset();
      std::lock_guard<std::mutex> lock(slot->mutex_);
      slot->held_ = false;
      if (stopping != nullptr) {
        slot->predecessor_ = std::move(stopping);
      }
    }

   private:
    friend class KernelSlot;
    Claim(KernelSlot* slot, std::shared_ptr<KernelRuntime> predecessor)
        : slot_(slot), predecessor_(std::move(predecessor)) {}
    KernelSlot* slot_ = nullptr;
    std::shared_ptr<KernelRuntime> predecessor_;
  };

  // Throws std::runtime_error while another claim is live; Nitro surfaces it
  // to JS as a start() failure and the caller's session fails closed. On
  // success the claim carries the previous holder's still-stopping runtime,
  // or nullptr.
  Claim claim() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (held_) {
      throw std::runtime_error("another kernel runtime is live in this process");
    }
    held_ = true;
    return Claim(this, std::move(predecessor_));
  }

  static KernelSlot& shared() {
    static KernelSlot slot;
    return slot;
  }

 private:
  std::mutex mutex_;
  bool held_ = false;
  std::shared_ptr<KernelRuntime> predecessor_;
};

} // namespace qntx
