#include "SecureInput.hpp"

#include <utility>
#include <vector>

namespace qntx {

namespace {

// The kind contract the platform views are asked to enforce; rechecked here
// so a buggy view cannot feed the kernel out-of-shape bytes.
bool validFor(SecureInputKind kind, const SecretBytes& value) {
  switch (kind) {
    case SecureInputKind::accessCode: {
      if (value.size() < 1 || value.size() > 64) {
        return false;
      }
      for (size_t i = 0; i < value.size(); i++) {
        if (value.data()[i] < 0x20 || value.data()[i] > 0x7E) {
          return false;
        }
      }
      return true;
    }
    case SecureInputKind::shortId: {
      if (value.size() != 8) {
        return false;
      }
      for (size_t i = 0; i < value.size(); i++) {
        const uint8_t c = value.data()[i];
        const bool hex = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F');
        if (!hex) {
          return false;
        }
      }
      return true;
    }
  }
  return false;
}

} // namespace

SecureInputHub& SecureInputHub::shared() {
  static auto* hub = new SecureInputHub();
  return *hub;
}

uint64_t SecureInputHub::attach(SecureInputSink sink) {
  uint64_t view;
  std::optional<SecureInputPrompt> prompt;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    view = ++nextView_;
    sinks_.emplace(view, sink);
    if (pending_.has_value()) {
      prompt = SecureInputPrompt{pending_->kind, pending_->label};
    }
  }
  sink(prompt);
  return view;
}

void SecureInputHub::detach(uint64_t view) {
  std::lock_guard<std::mutex> lock(mutex_);
  sinks_.erase(view);
}

bool SecureInputHub::submit(uint64_t view, SecretBytes value) {
  SecureInputDone done;
  SecureInputSink sink;
  std::vector<SecureInputSink> sinks;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!pending_.has_value()) {
      return false;
    }
    if (!validFor(pending_->kind, value)) {
      // Never complete on bad bytes; clear just the offending view — the
      // request stays pending for the others.
      const auto found = sinks_.find(view);
      if (found != sinks_.end()) {
        sink = found->second;
      }
    } else {
      done = std::move(pending_->done);
      pending_.reset();
      sinks.reserve(sinks_.size());
      for (const auto& [_, s] : sinks_) {
        sinks.push_back(s);
      }
    }
  }
  if (done) {
    done(SecureInputResult{std::nullopt, std::move(value)});
    for (const auto& s : sinks) {
      s(std::nullopt);
    }
    return true;
  }
  if (sink) {
    sink(std::nullopt);
  }
  return false;
}

SecureInputArm SecureInputHub::request(
    const void* owner,
    SecureInputKind kind,
    std::string label,
    SecureInputDone done) {
  std::vector<SecureInputSink> sinks;
  SecureInputPrompt prompt{kind, label};
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (pending_.has_value()) {
      return pending_->owner == owner ? SecureInputArm::busySelf
                                      : SecureInputArm::busyOther;
    }
    pending_ = Pending{owner, kind, std::move(label), std::move(done)};
    sinks.reserve(sinks_.size());
    for (const auto& [_, s] : sinks_) {
      sinks.push_back(s);
    }
  }
  for (const auto& s : sinks) {
    s(prompt);
  }
  return SecureInputArm::armed;
}

void SecureInputHub::cancel(const void* owner) {
  SecureInputDone done;
  std::vector<SecureInputSink> sinks;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!pending_.has_value() || pending_->owner != owner) {
      return;
    }
    done = std::move(pending_->done);
    pending_.reset();
    sinks.reserve(sinks_.size());
    for (const auto& [_, s] : sinks_) {
      sinks.push_back(s);
    }
  }
  if (done) {
    done(SecureInputResult{SecureInputFailure::cancelled, {}});
  }
  for (const auto& s : sinks) {
    s(std::nullopt);
  }
}

void SecureInputHub::release(const void* owner) {
  std::vector<SecureInputSink> sinks;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!pending_.has_value() || pending_->owner != owner) {
      return;
    }
    pending_.reset();
    sinks.reserve(sinks_.size());
    for (const auto& [_, s] : sinks_) {
      sinks.push_back(s);
    }
  }
  for (const auto& s : sinks) {
    s(std::nullopt);
  }
}

} // namespace qntx
