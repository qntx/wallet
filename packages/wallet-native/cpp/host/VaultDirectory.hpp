#pragma once

#include <string>

namespace qntx {

// The directory the vault image file lives in — resolved once per
// KernelRuntime::start and passed explicitly to kernelFileRead/kernelFileWrite:
//   iOS     <Application Support>/qntx-wallet
//   Android <noBackupFilesDir>/qntx-wallet
// Defined only by a platform translation unit (platform/KernelFile.mm on iOS,
// platform/KernelFileAndroid.cpp on Android): a host that links neither fails
// at link time instead of misbehaving at runtime.
std::string platformVaultDirectory();

#if defined(__ANDROID__)
// Kotlin hands the resolved <noBackupFilesDir>/qntx-wallet path to C++ once at
// module init — noBackupFilesDir needs a Context, which only exists in Java.
void kernelFileDirectorySetFromJava(const char* path);
#endif

} // namespace qntx
