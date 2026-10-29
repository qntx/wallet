// Android vault directory: <noBackupFilesDir>/qntx-wallet. Kotlin hands it over
// at module init when it can (noBackupFilesDir needs a Context); when package
// init did not run, the hook resolves the same path through the Application
// context itself, since that is always reachable from JNI.
#include "../host/VaultDirectory.hpp"

#ifdef __ANDROID__

#include <jni.h>
#include <mutex>
#include <stdexcept>
#include <string>
#include <sys/stat.h>

namespace qntx {
namespace {
std::mutex g_dirMutex;
std::string g_dir;
JavaVM* g_vm = nullptr;

std::string resolveVaultDirectory() {
  JNIEnv* env = nullptr;
  bool attached = false;
  if (g_vm == nullptr) {
    throw std::runtime_error("vault directory: no JavaVM");
  }
  if (g_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) == JNI_EDETACHED) {
    if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) {
      throw std::runtime_error("vault directory: cannot attach to the JVM");
    }
    attached = true;
  }
  std::string dir;
  do {
    jclass activityThread = env->FindClass("android/app/ActivityThread");
    if (activityThread == nullptr) break;
    jmethodID currentApplication = env->GetStaticMethodID(
        activityThread, "currentApplication", "()Landroid/app/Application;");
    if (currentApplication == nullptr) break;
    jobject app = env->CallStaticObjectMethod(activityThread, currentApplication);
    if (app == nullptr || env->ExceptionCheck()) break;
    jclass context = env->FindClass("android/content/Context");
    jmethodID noBackupFilesDir =
        env->GetMethodID(context, "getNoBackupFilesDir", "()Ljava/io/File;");
    if (noBackupFilesDir == nullptr) break;
    jobject file = env->CallObjectMethod(app, noBackupFilesDir);
    if (file == nullptr || env->ExceptionCheck()) break;
    jclass fileClass = env->FindClass("java/io/File");
    jmethodID getAbsolutePath =
        env->GetMethodID(fileClass, "getAbsolutePath", "()Ljava/lang/String;");
    jmethodID mkdirs = env->GetMethodID(fileClass, "mkdirs", "()Z");
    if (getAbsolutePath == nullptr || mkdirs == nullptr) break;
    jstring path = static_cast<jstring>(env->CallObjectMethod(file, getAbsolutePath));
    if (path == nullptr) break;
    const char* utf = env->GetStringUTFChars(path, nullptr);
    dir = std::string(utf) + "/qntx-wallet";
    env->ReleaseStringUTFChars(path, utf);
    jobject vaultFile = env->NewObject(
        fileClass,
        env->GetMethodID(fileClass, "<init>", "(Ljava/lang/String;)V"),
        env->NewStringUTF(dir.c_str()));
    env->CallBooleanMethod(vaultFile, mkdirs);
  } while (false);
  if (env->ExceptionCheck()) {
    env->ExceptionClear();
    dir.clear();
  }
  if (attached) {
    g_vm->DetachCurrentThread();
  }
  return dir;
}
} // namespace

void kernelFileDirectorySetFromJava(const char* path) {
  std::lock_guard<std::mutex> lock(g_dirMutex);
  g_dir = path;
}

void kernelFileDirectorySetJavaVm(JavaVM* vm) {
  g_vm = vm;
}

std::string platformVaultDirectory() {
  std::lock_guard<std::mutex> lock(g_dirMutex);
  if (g_dir.empty()) {
    g_dir = resolveVaultDirectory();
  }
  if (g_dir.empty()) {
    throw std::runtime_error("vault directory not configured — no usable Application context");
  }
  return g_dir;
}

} // namespace qntx

#endif // __ANDROID__
