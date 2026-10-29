// Android background-lock lifecycle: the Kotlin AppLifecycle object registers
// a ProcessLifecycleOwner observer on the main looper; its DefaultLifecycleObserver
// callbacks reach the dispatcher through the JNI exports below.
#include "../host/Lifecycle.hpp"

#ifdef __ANDROID__

#include <fbjni/fbjni.h>
#include <jni.h>
#include <stdexcept>

namespace qntx {
namespace {
facebook::jni::global_ref<jclass> g_appLifecycleClass;
} // namespace

void kernelLifecycleInit(facebook::jni::alias_ref<jclass> clazz) {
  g_appLifecycleClass = facebook::jni::make_global(clazz);
}

int64_t sleepInclusiveMonotonicMs() {
  // CLOCK_BOOTTIME counts suspend; CLOCK_MONOTONIC does not.
  struct timespec ts;
  ::clock_gettime(CLOCK_BOOTTIME, &ts);
  return static_cast<int64_t>(ts.tv_sec) * 1000 + ts.tv_nsec / 1000000;
}

void installLifecycleObserver() {
  static std::once_flag once;
  std::call_once(once, [] {
    facebook::jni::ThreadScope threadScope;
    if (!g_appLifecycleClass) {
      throw std::runtime_error("lifecycle: JNI_OnLoad init did not run");
    }
    auto install = g_appLifecycleClass->getStaticMethod<void()>("install");
    install(g_appLifecycleClass.get());
  });
}

} // namespace qntx

// The Kotlin object's DefaultLifecycleObserver dispatches here.
extern "C" JNIEXPORT void JNICALL
Java_com_margelo_nitro_qntxwallet_AppLifecycle_onAppBackground(
    JNIEnv*, jclass) {
  qntx::KernelLifecycleDispatcher::shared().onBackground();
}

extern "C" JNIEXPORT void JNICALL
Java_com_margelo_nitro_qntxwallet_AppLifecycle_onAppForeground(
    JNIEnv*, jclass) {
  qntx::KernelLifecycleDispatcher::shared().onForeground();
}

#endif // __ANDROID__
