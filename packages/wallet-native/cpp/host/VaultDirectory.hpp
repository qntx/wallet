#pragma once

#include <string>

#if defined(__ANDROID__)
#include <jni.h>
#endif

namespace qntx {

// The directory the vault image file lives in — resolved once per
// KernelRuntime::start and passed explicitly to kernelFileRead/kernelFileWrite:
//   iOS     <Application Support>/qntx-wallet
//   Android <noBackupFilesDir>/qntx-wallet
// Defined only by a platform translation unit (platform/VaultDirectory.mm on iOS,
// platform/VaultDirectoryAndroid.cpp on Android): a host that links neither fails
// at link time instead of misbehaving at runtime.
std::string platformVaultDirectory();

#if defined(__ANDROID__)
// Kotlin hands the resolved <noBackupFilesDir>/qntx-wallet path to C++ once at
// module init when package init runs; the hook also self-resolves through the
// Application context via the JavaVM captured at JNI_OnLoad, because a
// module-less package cannot rely on module init firing.
void kernelFileDirectorySetFromJava(const char* path);
void kernelFileDirectorySetJavaVm(JavaVM* vm);
#endif

} // namespace qntx
