#pragma once

#include "../KernelBuffer.hpp"

#include <cstddef>
#include <cstdint>

namespace qntx {

// Synchronous Argon2id (version 0x13, no secret, no associated data) through
// the vendored reference implementation — neither iOS nor Android ships one.
// Callers run it on the KDF worker thread, never on the kernel thread. Throws
// std::runtime_error on failure. Inputs and the result are SecretBytes, so any
// path that drops them still wipes them.
SecretBytes kernelArgon2id(
    const SecretBytes& password,
    const SecretBytes& salt,
    uint32_t memoryKiB,
    uint32_t passes,
    uint32_t lanes,
    size_t length);

} // namespace qntx
