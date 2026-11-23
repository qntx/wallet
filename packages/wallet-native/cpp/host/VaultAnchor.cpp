// The vault anchor: a few bytes of kernel state kept outside the vault file —
// the revision floor and password-failure counters — where a host that puts an
// older vault image back cannot put this back too. This file owns the
// process-wide mutex and the compare: one load, one equality test, one store,
// all serialized so two kernel runtimes on the same anchor can never interleave
// a read-modify-write. Storage itself is per-platform.
#include "VaultAnchor.hpp"

#include <mutex>
#include <stdexcept>
#include <vector>

namespace qntx {
namespace {

std::mutex g_anchorMutex;

} // namespace

std::optional<std::vector<uint8_t>> vaultAnchorRead() {
  std::lock_guard<std::mutex> lock(g_anchorMutex);
  return platformAnchorLoad();
}

bool vaultAnchorReplace(
    const uint8_t* next,
    size_t size,
    const std::optional<std::vector<uint8_t>>& expected) {
  std::lock_guard<std::mutex> lock(g_anchorMutex);
  const auto current = platformAnchorLoad();
  if (expected.has_value() != current.has_value() ||
      (expected.has_value() && *current != *expected)) {
    return false;
  }
  platformAnchorStore(std::vector<uint8_t>(next, next + size));
  return true;
}

} // namespace qntx
