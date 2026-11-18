#pragma once

#include <cstddef>
#include <cstdint>
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

// Compare-and-swap whole-file replace of vault.cbor in `directory`. An
// exclusive flock on <directory>/vault.cbor.lock serializes writers across
// open file descriptions and processes; inside the lock the current file is
// re-read and byte-compared with `expected` (nullopt = the file must not
// exist). On a match the file is replaced atomically (vault.cbor.tmp + fsync +
// rename + directory fsync — the shared temp name is safe because writers are
// serialized) and true is returned. On a mismatch nothing is written and false
// is returned; the caller fails closed instead of clobbering a concurrent
// commit. Throws std::runtime_error naming the failing step and errno; a
// failed write leaves the previous file intact and unlinks the temp file.
bool kernelFileReplace(
    const std::string& directory,
    const uint8_t* next,
    size_t size,
    const std::optional<std::vector<uint8_t>>& expected);

} // namespace qntx
