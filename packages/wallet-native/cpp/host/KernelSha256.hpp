#pragma once

#include <cstdint>
#include <vector>

namespace qntx {

// SHA-256 of `data`, 32 bytes. Self-contained so host tests and both platforms
// compute the KERNEL_SHA256 check identically — no crypto library dependency.
std::vector<uint8_t> kernelSha256(const uint8_t* data, size_t size);

std::string kernelSha256Hex(const uint8_t* data, size_t size);

} // namespace qntx
