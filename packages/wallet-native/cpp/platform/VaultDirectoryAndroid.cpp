// Android vault directory: <noBackupFilesDir>/qntx-wallet, handed to C++ once
// at module init by the Kotlin side (noBackupFilesDir needs a Context).
#include "../host/VaultDirectory.hpp"

#ifdef __ANDROID__

#include <mutex>
#include <stdexcept>
#include <string>

namespace qntx {
namespace {
std::mutex g_dirMutex;
std::string g_dir;
} // namespace

void kernelFileDirectorySetFromJava(const char* path) {
  std::lock_guard<std::mutex> lock(g_dirMutex);
  g_dir = path;
}

std::string platformVaultDirectory() {
  std::lock_guard<std::mutex> lock(g_dirMutex);
  if (g_dir.empty()) {
    throw std::runtime_error("vault directory not configured — module init did not run");
  }
  return g_dir;
}

} // namespace qntx

#endif // __ANDROID__
