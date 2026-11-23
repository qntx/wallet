#pragma once

#include <cstdint>
#include <optional>
#include <vector>

namespace qntxTestAnchor {

// Forget the stored record and any scripted failure.
void reset();
// Every platform call from now on throws — the kernel sees `unavailable`.
void failAll();
// What the platform currently holds (nullopt = nothing stored).
std::optional<std::vector<uint8_t>> stored();

} // namespace qntxTestAnchor
