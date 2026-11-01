#include "WalletNativeOnLoad.hpp"
#include "host/VaultDirectory.hpp"
#include "runtime/platform/KernelPbkdf2.hpp"
#include <fbjni/fbjni.h>
#include <jni.h>

namespace qntx {
void kernelVaultDirectoryInit(facebook::jni::alias_ref<jclass> clazz);
void kernelLifecycleInit(facebook::jni::alias_ref<jclass> clazz);
void kernelKeystoreInit(facebook::jni::alias_ref<jclass> clazz);
void kernelPasskeyInit(facebook::jni::alias_ref<jclass> clazz);
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, []() {
    qntx::kernelVaultDirectoryInit(
        facebook::jni::findClassLocal("com/margelo/nitro/qntxwallet/VaultDirectory"));
    qntx::kernelLifecycleInit(
        facebook::jni::findClassLocal("com/margelo/nitro/qntxwallet/AppLifecycle"));
    qntx::kernelKeystoreInit(
        facebook::jni::findClassLocal("com/margelo/nitro/qntxwallet/Keystore"));
    qntx::kernelPasskeyInit(
        facebook::jni::findClassLocal("com/margelo/nitro/qntxwallet/Passkey"));
    margelo::nitro::qntxwallet::registerAllNatives();
    qntx::kernelPbkdf2OnLoad(
        facebook::jni::Environment::current(),
        "com/margelo/nitro/qntxwallet/KernelPbkdf2");
  });
}
