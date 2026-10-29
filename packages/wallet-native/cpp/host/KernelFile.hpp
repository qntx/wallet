#pragma once

#include <optional>
#include <string>
#include <vector>

namespace qntx {

// The vault image file lives in a platform-provided directory
// (platformVaultDirectory()): <directory>/vault.cbor.
//
// The whole file, or nullopt when it does not exist. Throws std::runtime_error
// naming the failing step and errno — the file store turns that into a typed
// rejection and never silently treats it as an empty vault.
std::optional<std::vector<uint8_t>> kernelFileRead(const std::string& directory);

// Atomic replace of vault.cbor in `directory`: write vault.cbor.tmp in the
// same directory, fsync it, rename it over the target, then fsync the
// directory so the rename itself is durable. Throws std::runtime_error naming
// the failing step and errno; a failed write leaves the previous file intact
// and unlinks the temp file.
void kernelFileWrite(const std::string& directory, const std::vector<uint8_t>& bytes);

} // namespace qntx
