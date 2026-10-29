#include "WalletNativeOnLoad.hpp"
#include "runtime/platform/KernelPbkdf2.hpp"
#include <fbjni/fbjni.h>
#include <jni.h>

namespace qntx {
void kernelFileDirectorySetFromJava(const char* path);
}

// KernelFileModule.setVaultDirectory — Kotlin hands the computed
// <noBackupFilesDir>/qntx-wallet path to C++ once at module init.
extern "C" JNIEXPORT void JNICALL
Java_com_margelo_nitro_qntxwallet_KernelFileModule_setVaultDirectory(
    JNIEnv* env,
    jclass,
    jstring path) {
  const char* chars = env->GetStringUTFChars(path, nullptr);
  qntx::kernelFileDirectorySetFromJava(chars);
  env->ReleaseStringUTFChars(path, chars);
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, []() {
    margelo::nitro::qntxwallet::registerAllNatives();
    qntx::kernelPbkdf2OnLoad(
        facebook::jni::Environment::current(),
        "com/margelo/nitro/qntxwallet/KernelPbkdf2");
  });
}
