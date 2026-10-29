// Android vault directory: <noBackupFilesDir>/qntx-wallet, pulled from the
// Kotlin VaultDirectory.resolve() through fbjni — one supported-API path, no
// C++-side caching of the path.
#include "../host/VaultDirectory.hpp"

#ifdef __ANDROID__

#include <fbjni/fbjni.h>
#include <jni.h>
#include <stdexcept>
#include <string>

namespace qntx {
namespace {
facebook::jni::global_ref<jclass> g_vaultDirectoryClass;
} // namespace

void kernelVaultDirectoryInit(facebook::jni::alias_ref<jclass> clazz) {
  g_vaultDirectoryClass = facebook::jni::make_global(clazz);
}

std::string platformVaultDirectory() {
  facebook::jni::ThreadScope threadScope;
  if (!g_vaultDirectoryClass) {
    throw std::runtime_error("vault directory: JNI_OnLoad init did not run");
  }
  auto method = g_vaultDirectoryClass->getStaticMethod<facebook::jni::JString::javaobject()>(
      "resolve");
  auto path = method(g_vaultDirectoryClass.get());
  return path->toStdString();
}

} // namespace qntx

#endif // __ANDROID__
