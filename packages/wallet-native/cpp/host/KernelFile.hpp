#pragma once

#include <optional>
#include <string>
#include <vector>

namespace qntx {

// The vault image file lives under the platform-provided directory:
//   iOS     Application Support/qntx-wallet/vault.cbor
//   Android context.noBackupFilesDir/qntx-wallet/vault.cbor
//   tests   setKernelFileDirectory override
// The hook is supplied by a platform translation unit — KernelFile.mm on
// iOS, KernelFileAndroid.cpp which receives the path once at module init —
// and by the test override below everywhere else.
std::string kernelFileDirectory();

// Test override (and Android's Kotlin-side path injection): installs the
// directory the file primitive uses. Passing an empty string clears it.
void setKernelFileDirectory(std::string directory);

// The installed override, or "" — platform implementations of
// kernelFileDirectory() honour it before falling back to their own path.
std::string kernelFileDirectoryOverride();

// The whole file, or nullopt when it does not exist. Throws std::system_error
// on a real failure — the file store turns that into a typed rejection and
// never silently treats it as an empty vault.
std::optional<std::vector<uint8_t>> kernelFileRead();

// Atomic replace: write <name>.tmp in the same directory, fsync it, rename it
// over the target, then fsync the directory so the rename itself is durable.
// Throws std::system_error on any step's failure — nothing is committed.
void kernelFileWrite(const std::vector<uint8_t>& bytes);

} // namespace qntx
