#include "WalletNativeOnLoad.hpp"
#include "host/VaultDirectory.hpp"
#include "runtime/platform/KernelPbkdf2.hpp"
#include <fbjni/fbjni.h>
#include <jni.h>

namespace qntx {
void kernelVaultDirectoryInit(facebook::jni::alias_ref<jclass> clazz);
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, []() {
    qntx::kernelVaultDirectoryInit(
        facebook::jni::findClassLocal("com/margelo/nitro/qntxwallet/VaultDirectory"));
    margelo::nitro::qntxwallet::registerAllNatives();
    qntx::kernelPbkdf2OnLoad(
        facebook::jni::Environment::current(),
        "com/margelo/nitro/qntxwallet/KernelPbkdf2");
  });
}
