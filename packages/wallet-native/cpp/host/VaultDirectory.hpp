#pragma once

#include <string>

namespace qntx {

// The directory the vault image file lives in — resolved once per
// KernelRuntime::start and passed explicitly to kernelFileRead/kernelFileWrite:
//   iOS     <Application Support>/qntx-wallet
//   Android <noBackupFilesDir>/qntx-wallet
// Defined only by a platform translation unit (platform/VaultDirectory.mm on iOS,
// platform/VaultDirectoryAndroid.cpp on Android): a host that links neither fails
// at link time instead of misbehaving at runtime.
std::string platformVaultDirectory();

} // namespace qntx
