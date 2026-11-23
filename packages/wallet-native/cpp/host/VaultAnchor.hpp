#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

namespace qntx {

// Per-platform primitives the target supplies (iOS keychain, Android keystore
// aliases). Both throw on a platform failure; the shared compare-and-swap
// above them retries nothing — the kernel's updateAnchor owns the retry loop.
std::optional<std::vector<uint8_t>> platformAnchorLoad();
void platformAnchorStore(const std::vector<uint8_t>& bytes);

// nullopt when nothing is stored. Throws std::runtime_error on a platform
// failure.
std::optional<std::vector<uint8_t>> vaultAnchorRead();

// Compare-and-swap under one process-wide mutex (both kernel runtimes share
// it): writes `next` only when the stored bytes equal `expected` (nullopt =
// nothing stored); false otherwise, writing nothing.
bool vaultAnchorReplace(
    const uint8_t* next,
    size_t size,
    const std::optional<std::vector<uint8_t>>& expected);

} // namespace qntx
