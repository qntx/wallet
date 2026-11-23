#include "SecureInput.hpp"

#include <utility>
#include <vector>

namespace qntx {

namespace {

// The kind contract the platform views are asked to enforce; rechecked here
// so a buggy view cannot feed the kernel out-of-shape bytes.
// Strict UTF-8 (RFC 3629): well-formed sequences only, no overlong forms,
// no surrogates, nothing past U+10FFFF.
bool validUtf8(const SecretBytes& value) {
  size_t i = 0;
  while (i < value.size()) {
    const uint8_t b = value.data()[i];
    size_t extra;
    uint32_t min;
    if (b < 0x80) {
      i += 1;
      continue;
    } else if ((b & 0xE0) == 0xC0) {
      extra = 1;
      min = 0x80;
      if (b < 0xC2) return false;
    } else if ((b & 0xF0) == 0xE0) {
      extra = 2;
      min = 0x800;
    } else if ((b & 0xF8) == 0xF0) {
      extra = 3;
      min = 0x10000;
      if (b > 0xF4) return false;
    } else {
      return false;
    }
    if (i + extra >= value.size()) {
      return false;
    }
    uint32_t cp = b & (0x7F >> (extra + 1));
    for (size_t j = 1; j <= extra; j++) {
      const uint8_t c = value.data()[i + j];
      if ((c & 0xC0) != 0x80) {
        return false;
      }
      cp = (cp << 6) | (c & 0x3F);
    }
    if (cp < min || (cp >= 0xD800 && cp <= 0xDFFF)) {
      return false;
    }
    i += extra + 1;
  }
  return true;
}

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
    case SecureInputKind::backupPassword: {
      return value.size() >= 1 && value.size() <= 1024 && validUtf8(value);
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
    if (pending_.has_value() && validFor(pending_->kind, value)) {
      done = std::move(pending_->done);
      pending_.reset();
      sinks.reserve(sinks_.size());
      for (const auto& [_, s] : sinks_) {
        sinks.push_back(s);
      }
    } else {
      // Nothing pending, or bad bytes: never complete — clear just the
      // submitting view. A live request stays pending for the others.
      const auto found = sinks_.find(view);
      if (found != sinks_.end()) {
        sink = found->second;
      }
    }
  }
  // The clear reaches the views before the completion: a re-request issued
  // from inside done() can never be overtaken by this clear.
  for (const auto& s : sinks) {
    s(std::nullopt);
  }
  if (done) {
    done(SecureInputResult{std::nullopt, std::move(value)});
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
  // Same ordering as submit: views learn the request is gone before the
  // requester's completion can arm the next one.
  for (const auto& s : sinks) {
    s(std::nullopt);
  }
  if (done) {
    done(SecureInputResult{SecureInputFailure::cancelled, {}});
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
