// Test-only vault anchor: the host build has no keychain or Android Keystore,
// so this file supplies the platformAnchor* primitives with an in-memory
// record. Reads and writes copy the bytes; `failAll` scripts a platform
// failure for the kernel's `unavailable` path.
#include "HostVaultAnchor.hpp"

#include "host/VaultAnchor.hpp"

#include <mutex>
#include <stdexcept>
#include <vector>

namespace qntxTestAnchor {
namespace {

struct State {
  std::mutex mutex;
  std::optional<std::vector<uint8_t>> bytes;
  bool failing = false;
};

State& state() {
  static auto* s = new State();
  return *s;
}

} // namespace

void reset() {
  std::lock_guard<std::mutex> lock(state().mutex);
  state().bytes.reset();
  state().failing = false;
}

void failAll() {
  std::lock_guard<std::mutex> lock(state().mutex);
  state().failing = true;
}

std::optional<std::vector<uint8_t>> stored() {
  std::lock_guard<std::mutex> lock(state().mutex);
  return state().bytes;
}

} // namespace qntxTestAnchor

namespace qntx {

std::optional<std::vector<uint8_t>> platformAnchorLoad() {
  std::lock_guard<std::mutex> lock(qntxTestAnchor::state().mutex);
  if (qntxTestAnchor::state().failing) {
    throw std::runtime_error("vault anchor: platform failure (scripted)");
  }
  return qntxTestAnchor::state().bytes;
}

void platformAnchorStore(const std::vector<uint8_t>& bytes) {
  std::lock_guard<std::mutex> lock(qntxTestAnchor::state().mutex);
  if (qntxTestAnchor::state().failing) {
    throw std::runtime_error("vault anchor: platform failure (scripted)");
  }
  qntxTestAnchor::state().bytes = bytes;
}

} // namespace qntx
